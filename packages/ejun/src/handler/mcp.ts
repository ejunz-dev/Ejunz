import { Handler } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import EdgeTokenModel from '../model/edge_token';
import McpModel from '../model/mcp';
import { NotFoundError, ValidationError } from '../error';
import {
    MCP_BUILTIN_TOOLS_CATALOG, buildMcpInstructions,
    defaultMcpToolDescriptions, resolveMcpTools,
    type JsonRpcMessage, type McpServerMeta, type McpToolContext,
} from '../service/mcp';
import { McpMarketAddHandler, McpMarketHandler, McpMarketRemoveHandler } from './tool';

const logger = new Logger('handler/mcp');

const SSE_KEEPALIVE_MS = 25 * 1000;

function detectOrigin(h: Handler<Context>): { protocol: string; host: string } {
    const host = h.request.host || (h.request.headers.host as string) || 'localhost';
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    const forwarded = (h.request.headers['x-forwarded-proto'] as string)
        || (h.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : '');
    const protocol = forwarded || (isLocal ? 'http' : 'https');
    return { protocol, host };
}

function extractToken(h: Handler<Context>): { token: string; source: string } | null {
    const q = h.request.query.token as string;
    if (q) return { token: q, source: 'query' };
    const auth = h.request.headers.authorization as string;
    if (auth && /^bearer\s+/i.test(auth)) return { token: auth.replace(/^bearer\s+/i, '').trim(), source: 'header' };
    const x = h.request.headers['x-mcp-token'] as string;
    if (x) return { token: x, source: 'x-mcp-token' };
    return null;
}

function buildMcpConnectionInfo(h: Handler<Context>, domainId: string, token: string, pathId?: string) {
    const { protocol, host } = detectOrigin(h);
    return h.ctx.mcp.buildConnectionInfo({ protocol, host, domainId, token, pathId });
}

export class McpConnectionHandler extends Handler<Context> {
    noCheckPermView = true;
    notUsage = true;
    allowCors = true;

    async get() {
        const cred = extractToken(this);
        const token = cred?.token;
        const tokenDoc = token ? await EdgeTokenModel.getByToken(token) : null;
        if (!tokenDoc) {
            logger.warn(
                'MCP connect rejected: hasToken=%s, source=%s, tokenValid=false, ua=%s',
                !!token, cred?.source || 'none', this.request.headers['user-agent'] || '-',
            );
            this.response.status = 401;
            this.response.body = { error: 'Invalid or missing token' };
            return;
        }
        await EdgeTokenModel.markPermanent(token);
        const domainId = tokenDoc.domainId;
        await this.ctx.mcp.registerOutboundEdge(tokenDoc);

        const res = this.context.res;
        this.context.respond = false;
        this.context.compress = false;
        (this.context.EjunzContext as any).request.websocket = true;

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (this.context.req.socket) {
            this.context.req.socket.setTimeout(0);
            this.context.req.socket.setNoDelay(true);
            this.context.req.socket.setKeepAlive(true);
        }
        res.flushHeaders();

        const write = (event: string, data: string) => {
            if (res.writableEnded) return;
            res.write(`event: ${event}\ndata: ${data}\n\n`);
            if (typeof (res as any).flush === 'function') (res as any).flush();
        };
        const session = this.ctx.mcp.openSseSession({ domainId, token, write });
        const { sessionId } = session;
        logger.info(
            'MCP session opened: sessionId=%s, domainId=%s, base=%s/%s, owner=%s, tokenSource=%s, ua=%s',
            sessionId, domainId, tokenDoc.baseDocId ?? '-', tokenDoc.branch || 'main',
            tokenDoc.owner, cred?.source || '-', this.request.headers['user-agent'] || '-',
        );

        const messagePath = `/d/${domainId}/mcp/sse/message?sessionId=${sessionId}&token=${encodeURIComponent(token)}`;
        write('endpoint', messagePath);

        const keepAlive = setInterval(() => {
            if (res.writableEnded) return;
            try {
                res.write(': ping\n\n');
            } catch {
                /* ignore */
            }
        }, SSE_KEEPALIVE_MS);

        await new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
                if (settled) return;
                settled = true;
                clearInterval(keepAlive);
                session.dispose();
                try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
                void this.ctx.mcp.unregisterOutboundEdge(domainId, token);
                logger.info('MCP session closed: sessionId=%s', sessionId);
                resolve();
            };
            res.on('close', done);
            res.on('error', done);
            this.context.req.on('close', done);
            this.context.req.on('aborted', done);
        });
    }
}

export class McpMessageHandler extends Handler<Context> {
    noCheckPermView = true;
    notUsage = true;
    allowCors = true;

    async post() {
        const sessionId = this.request.query.sessionId as string;
        const token = extractToken(this)?.token;
        const tokenDoc = token ? await EdgeTokenModel.getByToken(token) : null;
        if (!tokenDoc) {
            this.response.status = 401;
            this.response.type = 'application/json';
            this.response.body = JSON.stringify({ error: 'Invalid or missing token' });
            return;
        }
        if (!sessionId) {
            this.response.status = 400;
            this.response.type = 'application/json';
            this.response.body = JSON.stringify({ error: 'sessionId is required' });
            return;
        }

        const domainId = tokenDoc.domainId;

        // Session affinity guard. The SSE stream behind `sessionId` lives only in this process's
        // in-memory `mcpSessions` map. If it's gone — a `--watch`/deploy restart killed the process
        // that held it, or (multi-worker) it was opened on a different worker — tool results have
        // nowhere to be written back and the client would hang forever waiting on the SSE channel.
        // Outside pm2 cluster mode the broadcast fallback is a local no-op, so fail fast with 404 to
        // make the client tear down the dead session and reconnect (GET /mcp/sse) instead of hanging.
        const clusterMode = process.env.exec_mode === 'cluster_mode';
        if (!this.ctx.mcp.hasSession(sessionId) && !clusterMode) {
            logger.warn(
                'MCP message rejected: SSE session not found in this process '
                + '(likely closed by a server reload, or never established here); client must reconnect. '
                + 'sessionId=%s, domainId=%s, ua=%s',
                sessionId, domainId, this.request.headers['user-agent'] || '-',
            );
            this.response.status = 404;
            this.response.type = 'application/json';
            this.response.body = JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32001, message: 'SSE session not found or expired; please reconnect.' },
            });
            return;
        }

        const body = this.request.body;
        const messages: JsonRpcMessage[] = Array.isArray(body) ? body : [body];

        const toolCtx: McpToolContext = {
            domainId,
            baseDocId: tokenDoc.baseDocId as number,
            branch: tokenDoc.branch || 'main',
            owner: tokenDoc.owner,
            setting: (this.ctx as any).setting,
            embedding: (this.ctx as any).embedding,
        };

        const mcpDoc = await McpModel.getByToken(domainId, tokenDoc.token);
        const meta: McpServerMeta = {
            domainId,
            baseDocId: tokenDoc.baseDocId as number,
            branch: tokenDoc.branch || 'main',
            instructions: mcpDoc?.instructions,
            toolOverrides: mcpDoc?.tools,
        };

        const logCtx = `domainId=${domainId}, mid=${mcpDoc?.mid ?? '-'}, base=${toolCtx.baseDocId ?? '-'}/${toolCtx.branch}, `
            + `owner=${toolCtx.owner}, session=${sessionId}`;

        for (const msg of messages) {
            const response = await this.ctx.mcp.processMessage(msg, toolCtx, meta, mcpDoc, logCtx);
            if (response) this.ctx.mcp.deliverOrBroadcast(sessionId, JSON.stringify(response));
        }

        this.response.status = 202;
        this.response.type = 'text/plain';
        this.response.body = 'Accepted';
    }
}

/**
 * MCP Streamable HTTP transport (single endpoint, request/response on the same connection).
 *
 * Unlike the SSE transport, the JSON-RPC response is returned inline on the POST response,
 * so there is no separate persistent stream to find and no per-process session affinity:
 * a server reload only fails the in-flight request (which the client retries) instead of
 * orphaning a long-lived SSE session. This is the recommended transport.
 */
export class McpStreamableHandler extends Handler<Context> {
    noCheckPermView = true;
    notUsage = true;
    allowCors = true;

    async get() {
        // We do not offer a server-initiated SSE stream on this endpoint; the spec allows 405.
        this.response.addHeader('Access-Control-Allow-Origin', '*');
        this.response.status = 405;
        this.response.type = 'application/json';
        this.response.body = JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Method Not Allowed: this endpoint does not offer an SSE stream' },
        });
    }

    async post() {
        this.response.addHeader('Access-Control-Allow-Origin', '*');
        const cred = extractToken(this);
        const token = cred?.token;
        const tokenDoc = token ? await EdgeTokenModel.getByToken(token) : null;
        if (!tokenDoc) {
            logger.warn(
                'MCP(http) connect rejected: hasToken=%s, source=%s, ua=%s',
                !!token, cred?.source || 'none', this.request.headers['user-agent'] || '-',
            );
            this.response.status = 401;
            this.response.type = 'application/json';
            this.response.body = JSON.stringify({ error: 'Invalid or missing token' });
            return;
        }
        await EdgeTokenModel.markPermanent(token);
        const domainId = tokenDoc.domainId;

        const body = this.request.body;
        const isBatch = Array.isArray(body);
        const messages: JsonRpcMessage[] = isBatch ? body : [body];

        const toolCtx: McpToolContext = {
            domainId,
            baseDocId: tokenDoc.baseDocId as number,
            branch: tokenDoc.branch || 'main',
            owner: tokenDoc.owner,
            setting: (this.ctx as any).setting,
            embedding: (this.ctx as any).embedding,
        };

        const mcpDoc = await McpModel.getByToken(domainId, tokenDoc.token);
        const meta: McpServerMeta = {
            domainId,
            baseDocId: tokenDoc.baseDocId as number,
            branch: tokenDoc.branch || 'main',
            instructions: mcpDoc?.instructions,
            toolOverrides: mcpDoc?.tools,
        };

        const logCtx = `domainId=${domainId}, mid=${mcpDoc?.mid ?? '-'}, base=${toolCtx.baseDocId ?? '-'}/${toolCtx.branch}, `
            + `owner=${toolCtx.owner}, transport=http`;

        const responses: any[] = [];
        for (const msg of messages) {
            const response = await this.ctx.mcp.processMessage(msg, toolCtx, meta, mcpDoc, logCtx);
            if (response) responses.push(response);
        }

        // Notifications/responses only → nothing to return.
        if (responses.length === 0) {
            this.response.status = 202;
            this.response.type = 'text/plain';
            this.response.body = 'Accepted';
            return;
        }

        this.response.status = 200;
        this.response.type = 'application/json';
        this.response.body = JSON.stringify(isBatch ? responses : responses[0]);
    }
}

export class McpTokenHandler extends Handler<Context> {
    notUsage = true;

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        const domainId = this.domain._id;
        const rawBaseId = this.request.body?.baseId ?? this.request.body?.baseDocId;
        const baseDocId = rawBaseId !== undefined && rawBaseId !== null && `${rawBaseId}` !== ''
            ? Number(rawBaseId) : undefined;
        const branch = this.request.body?.branch ? String(this.request.body.branch) : undefined;

        const token = await this.ctx.mcp.getOrCreateMcpToken(domainId, this.user._id, baseDocId, branch);
        const mcp = await this.ctx.mcp.getOrCreateMcp(domainId, this.user._id, token, baseDocId, branch);
        const pathId = await this.ctx.mcp.resolveBasePathId(domainId, baseDocId ?? mcp.baseDocId);
        this.response.body = {
            success: true,
            baseDocId,
            branch: branch || mcp.branch || 'main',
            ...this.ctx.mcp.buildStatus(domainId, mcp),
            ...buildMcpConnectionInfo(this, domainId, token, pathId),
        };
    }

    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        const domainId = this.domain._id;
        const rawBaseId = this.request.query.baseId ?? this.request.query.baseDocId;
        const baseDocId = rawBaseId !== undefined && rawBaseId !== null && `${rawBaseId}` !== ''
            ? Number(rawBaseId) : undefined;

        const query: any = { domainId, type: 'mcp_sse', owner: this.user._id };
        if (baseDocId !== undefined && !Number.isNaN(baseDocId)) query.baseDocId = baseDocId;
        const tokenDoc = await EdgeTokenModel.coll.findOne(query);
        if (!tokenDoc) {
            this.response.body = { success: true, exists: false };
            return;
        }
        const mcp = await McpModel.getByToken(domainId, tokenDoc.token);
        if (!mcp) {
            this.response.body = { success: true, exists: false };
            return;
        }
        this.response.body = { success: true, exists: true, ...this.ctx.mcp.buildStatus(domainId, mcp) };
    }
}

export class McpListHandler extends Handler<Context> {
    async get() {
        const domainId = this.domain._id;
        const mcps = await this.ctx.mcp.listDomainMcps(domainId, this.user);
        this.response.template = 'mcp_main.html';
        this.response.body = { domainId, mcps };
    }
}

export class McpDetailHandler extends Handler<Context> {
    async get() {
        const domainId = this.domain._id;
        const raw = this.request.params.mid;
        if (raw && (raw.includes('.') || !/^\d+$/.test(raw))) throw new NotFoundError(raw);
        const mid = parseInt(raw, 10);
        if (isNaN(mid) || mid < 1) throw new ValidationError('mid');

        const mcp = await McpModel.getByMcpId(domainId, mid);
        if (!mcp) throw new NotFoundError('Mcp not found');

        const normalized = await this.ctx.mcp.getNormalizedMcp(domainId, mid);
        if (!normalized) throw new NotFoundError('Mcp not found');

        const isOwner = this.user._id === mcp.owner || this.user.hasPriv(PRIV.PRIV_USER_PROFILE);
        const kind = this.ctx.mcp.mcpKind(mcp);
        const online = normalized.online;
        const edge = normalized.edge || null;

        let info: ReturnType<typeof buildMcpConnectionInfo> | null = null;
        if (kind === 'outbound' && isOwner && mcp.token) {
            const pathId = await this.ctx.mcp.resolveBasePathId(domainId, mcp.baseDocId);
            info = buildMcpConnectionInfo(this, domainId, mcp.token, pathId);
        }

        this.response.template = 'mcp_detail.html';
        this.response.body = {
            domainId,
            mcp: { ...mcp, status: normalized.status },
            kind,
            normalized,
            online,
            isOwner,
            canEdit: kind === 'outbound' && isOwner,
            edge,
            info,
            configJson: info ? JSON.stringify(info.config, null, 2) : '',
            instructions: kind === 'outbound' ? (mcp.instructions || '') : '',
            tools: normalized.tools || [],
        };
    }
}

export class McpEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const domainId = this.domain._id;
        const raw = this.request.params.mid;
        if (raw && (raw.includes('.') || !/^\d+$/.test(raw))) throw new NotFoundError(raw);
        const mid = parseInt(raw, 10);
        if (isNaN(mid) || mid < 1) throw new ValidationError('mid');

        const mcp = await McpModel.getByMcpId(domainId, mid);
        if (!mcp) throw new NotFoundError('Mcp not found');
        if (this.user._id !== mcp.owner && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            throw new ValidationError('You are not allowed to edit this MCP.');
        }
        if (this.ctx.mcp.mcpKind(mcp) !== 'outbound') {
            throw new ValidationError('Only outbound MCP endpoints can be edited here.');
        }

        this.response.template = 'mcp_edit.html';
        this.response.body = {
            domainId,
            mcp,
            instructions: mcp.instructions ?? (await buildMcpInstructions({
                domainId, baseDocId: mcp.baseDocId, branch: mcp.branch,
            })),
            tools: resolveMcpTools(mcp.tools),
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const domainId = this.domain._id;
        const raw = this.request.params.mid;
        if (raw && (raw.includes('.') || !/^\d+$/.test(raw))) throw new NotFoundError(raw);
        const mid = parseInt(raw, 10);
        if (isNaN(mid) || mid < 1) throw new ValidationError('mid');

        const mcp = await McpModel.getByMcpId(domainId, mid);
        if (!mcp) throw new NotFoundError('Mcp not found');
        if (this.user._id !== mcp.owner && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
            throw new ValidationError('You are not allowed to edit this MCP.');
        }
        if (this.ctx.mcp.mcpKind(mcp) !== 'outbound') {
            throw new ValidationError('Only outbound MCP endpoints can be edited here.');
        }

        const body = this.request.body || {};

        if (body.operation === 'reset') {
            const instructions = await buildMcpInstructions({
                domainId, baseDocId: mcp.baseDocId, branch: mcp.branch,
            });
            await McpModel.update(domainId, mid, {
                instructions,
                tools: defaultMcpToolDescriptions(),
            });
            if (mcp.token) this.ctx.mcp.notifyToolsListChanged(mcp.token);
            this.response.redirect = this.url('mcp_edit', { mid });
            return;
        }

        const tools = MCP_BUILTIN_TOOLS_CATALOG.map((t) => {
            const raw2 = body[`tool_${t.name}`];
            const desc = typeof raw2 === 'string' ? raw2.trim() : '';
            return { name: t.name, description: desc || t.description };
        });
        const update: Partial<typeof mcp> = { tools };
        if (typeof body.name === 'string') update.name = body.name.trim() || mcp.name;
        if (typeof body.description === 'string') update.description = body.description.trim();
        if (typeof body.instructions === 'string') update.instructions = body.instructions.trim();

        await McpModel.update(domainId, mid, update);
        if (mcp.token) this.ctx.mcp.notifyToolsListChanged(mcp.token);
        this.response.redirect = this.url('mcp_detail', { mid });
    }
}

function captureWellKnownNotFound(c: any) {
    c.status = 404;
    c.type = 'application/json';
    c.body = JSON.stringify({
        error: 'not_found',
        error_description: 'OAuth is not supported; authenticate via the token in the connection URL.',
    });
}

export async function apply(ctx: Context) {
    (ctx as any).server.addCaptureRoute('/.well-known/oauth-', captureWellKnownNotFound);
    (ctx as any).server.addCaptureRoute('/.well-known/openid-configuration', captureWellKnownNotFound);

    ctx.Route('mcp_main', '/mcp', McpListHandler);
    ctx.Route('mcp_market', '/mcp/market', McpMarketHandler);
    ctx.Route('mcp_market_add', '/mcp/market/add', McpMarketAddHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_market_remove', '/mcp/market/remove', McpMarketRemoveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_message', '/mcp/sse/message', McpMessageHandler);
    ctx.Route('mcp_token', '/mcp/sse/token', McpTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp', '/mcp/sse/:bid', McpConnectionHandler);
    // Streamable HTTP transport (recommended): request/response on the same connection.
    ctx.Route('mcp_http', '/mcp/http', McpStreamableHandler);
    ctx.Route('mcp_http_bid', '/mcp/http/:bid', McpStreamableHandler);
    ctx.Route('mcp_edit', '/mcp/:mid/edit', McpEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_detail', '/mcp/:mid', McpDetailHandler);

}
