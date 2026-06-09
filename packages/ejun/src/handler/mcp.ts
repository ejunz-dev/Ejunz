import { Handler } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import EdgeModel from '../model/edge';
import EdgeTokenModel from '../model/edge_token';
import McpModel from '../model/mcp';
import { NotFoundError, ValidationError } from '../error';
import {
    MCP_BUILTIN_TOOLS_CATALOG, isMcpBuiltinTool, executeMcpBuiltinTool,
    buildMcpInstructions, defaultMcpToolDescriptions, resolveMcpTools,
} from '../lib/mcpBuiltinTools';
import { randomstring } from '../utils';
import type { EdgeTokenDoc } from '../model/edge_token';

const logger = new Logger('handler/mcp');

function clipForLog(value: unknown, max = 800): string {
    let s: string;
    try {
        s = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        s = String(value);
    }
    if (s === undefined || s === null) s = '';
    return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SSE_KEEPALIVE_MS = 25 * 1000;

const mcpTokenRefs: Map<string, number> = ((globalThis as any).__ejunzMcpTokenRefs ??= new Map<string, number>());

export function isMcpTokenConnected(token: string): boolean {
    return (mcpTokenRefs.get(token) || 0) > 0;
}

export function mcpActiveSessionCount(token: string): number {
    return mcpTokenRefs.get(token) || 0;
}

async function registerOutboundEdge(ctx: Context, tokenDoc: EdgeTokenDoc) {
    const { domainId, token, owner, baseDocId, branch } = tokenDoc;
    try {
        let edge = await EdgeModel.getByToken(domainId, token);
        if (!edge) {
            edge = await EdgeModel.add({ domainId, type: 'mcp', owner, token });
        }
        const mcp = await getOrCreateMcp(domainId, owner, token, baseDocId, branch);
        if (edge.mcpId !== mcp.mid) {
            await EdgeModel.update(domainId, edge.eid, { mcpId: mcp.mid });
        }
        const wasFirstConnection = !edge.tokenUsedAt;
        await EdgeModel.update(domainId, edge.eid, {
            status: 'online',
            tokenUsedAt: edge.tokenUsedAt || new Date(),
        });
        await McpModel.update(domainId, mcp.mid, {
            status: 'online',
            edgeId: edge.eid,
            lastConnectedAt: new Date(),
        });
        mcpTokenRefs.set(token, (mcpTokenRefs.get(token) || 0) + 1);
        if (wasFirstConnection) {
            const updated = await EdgeModel.getByToken(domainId, token);
            if (updated) (ctx.emit as any)('edge/connected', updated);
        }
        (ctx.emit as any)('edge/status/update', token, 'online');
        (ctx.emit as any)('mcp/status/update', domainId, mcp.mid, 'online');
    } catch (e) {
        logger.warn('Failed to register outbound MCP edge: domainId=%s, error=%s', domainId, (e as Error).message);
    }
}

async function unregisterOutboundEdge(ctx: Context, domainId: string, token: string) {
    const next = (mcpTokenRefs.get(token) || 1) - 1;
    if (next > 0) {
        mcpTokenRefs.set(token, next);
        return;
    }
    mcpTokenRefs.delete(token);
    try {
        const edge = await EdgeModel.getByToken(domainId, token);
        if (edge) {
            await EdgeModel.update(domainId, edge.eid, { status: 'offline' });
            (ctx.emit as any)('edge/status/update', token, 'offline');
        }
        const mcp = await McpModel.getByToken(domainId, token);
        if (mcp) {
            await McpModel.update(domainId, mcp.mid, { status: 'offline', lastDisconnectedAt: new Date() });
            (ctx.emit as any)('mcp/status/update', domainId, mcp.mid, 'offline');
        }
    } catch (e) {
        logger.warn('Failed to mark outbound MCP edge offline: domainId=%s, error=%s', domainId, (e as Error).message);
    }
}

interface McpSession {
    sessionId: string;
    domainId: string;
    token: string;
    write: (event: string, data: string) => void;
}

const mcpSessions: Map<string, McpSession> = ((globalThis as any).__ejunzMcpSessions ??= new Map<string, McpSession>());

function deliverToSession(sessionId: string, data: string): boolean {
    const session = mcpSessions.get(sessionId);
    if (!session) return false;
    try {
        session.write('message', data);
        return true;
    } catch (e) {
        logger.warn('Failed to deliver MCP message: sessionId=%s, error=%s', sessionId, (e as Error).message);
        return false;
    }
}

function deliverOrBroadcast(ctx: Context, sessionId: string, data: string) {
    if (deliverToSession(sessionId, data)) {
        logger.info('MCP deliver -> SSE session (local): sessionId=%s, bytes=%d', sessionId, data.length);
    } else {
        logger.warn('MCP deliver: session not local, broadcasting: sessionId=%s, bytes=%d', sessionId, data.length);
        (ctx as any).broadcast('mcp/deliver', { sessionId, data });
    }
}

function deliverToToken(token: string, data: string): number {
    let delivered = 0;
    for (const session of mcpSessions.values()) {
        if (session.token !== token) continue;
        try {
            session.write('message', data);
            delivered++;
        } catch (e) {
            logger.warn('Failed to push MCP notification: sessionId=%s, error=%s', session.sessionId, (e as Error).message);
        }
    }
    return delivered;
}

function notifyToolsListChanged(ctx: Context, token: string) {
    const data = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    const delivered = deliverToToken(token, data);
    (ctx as any).broadcast('mcp/notify', { token, data });
    logger.info('MCP tools/list_changed pushed: localSessions=%d (+broadcast to other processes)', delivered);
}

type JsonRpcMessage = {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: any;
};

interface McpServerMeta {
    domainId: string;
    baseDocId?: number;
    branch?: string;
    instructions?: string;
    toolOverrides?: { name: string; description: string }[];
}

async function handleJsonRpc(
    ctx: Context,
    domainId: string,
    msg: JsonRpcMessage,
    meta?: McpServerMeta,
): Promise<any | null> {
    if (!msg || typeof msg !== 'object' || !msg.method) return null;
    const { id, method } = msg;
    const hasId = id !== undefined && id !== null;

    switch (method) {
    case 'initialize': {
        const baseDocId = meta?.baseDocId;
        const instructions = meta?.instructions || await buildMcpInstructions({
            domainId,
            baseDocId,
            branch: meta?.branch,
        });
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: true } },
                serverInfo: {
                    name: baseDocId ? `ejunz-base-${baseDocId}` : 'ejunz-mcp',
                    version: '1.0.0',
                },
                instructions,
            },
        };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
        return null;
    case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: resolveMcpTools(meta?.toolOverrides) } };
    default:
        if (hasId) {
            return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
        }
        return null;
    }
}

function detectOrigin(h: Handler<Context>): { protocol: string; host: string } {
    const protocol = (h.request.headers['x-forwarded-proto'] as string)
        || (h.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
    const host = h.request.host || (h.request.headers.host as string) || 'localhost';
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
        await registerOutboundEdge(this.ctx, tokenDoc);

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

        const sessionId = randomstring(24);
        const write = (event: string, data: string) => {
            if (res.writableEnded) return;
            res.write(`event: ${event}\ndata: ${data}\n\n`);
            if (typeof (res as any).flush === 'function') (res as any).flush();
        };
        mcpSessions.set(sessionId, { sessionId, domainId, token, write });
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
                mcpSessions.delete(sessionId);
                try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
                void unregisterOutboundEdge(this.ctx, domainId, token);
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
        const body = this.request.body;
        const messages: JsonRpcMessage[] = Array.isArray(body) ? body : [body];

        const toolCtx = {
            domainId,
            baseDocId: tokenDoc.baseDocId as number,
            branch: tokenDoc.branch || 'main',
            owner: tokenDoc.owner,
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
            logger.info('MCP recv: %s, method=%s, id=%s', logCtx, msg?.method || '-', `${msg?.id ?? '-'}`);

            if (msg && msg.method === 'tools/call' && msg.id !== undefined && msg.id !== null) {
                const name = msg.params?.name;
                const args = msg.params?.arguments || {};
                if (!name || typeof name !== 'string') {
                    logger.warn('MCP tools/call rejected (missing name): %s, id=%s', logCtx, `${msg.id}`);
                    deliverOrBroadcast(this.ctx, sessionId, JSON.stringify({
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: { code: -32602, message: 'Invalid params: name is required' },
                    }));
                    continue;
                }
                if (!isMcpBuiltinTool(name)) {
                    logger.warn('MCP tools/call unknown tool: %s, tool=%s, id=%s', logCtx, name, `${msg.id}`);
                    deliverOrBroadcast(this.ctx, sessionId, JSON.stringify({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true },
                    }));
                    continue;
                }
                logger.info('MCP tools/call -> %s, tool=%s, id=%s, args=%s', logCtx, name, `${msg.id}`, clipForLog(args));
                const startedAt = Date.now();
                let response: any;
                try {
                    const result = await executeMcpBuiltinTool(toolCtx, name, args);
                    const text = typeof result === 'string' ? result : JSON.stringify(result);
                    response = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
                    logger.info(
                        'MCP tools/call OK: %s, tool=%s, id=%s, %dms, result=%s',
                        logCtx, name, `${msg.id}`, Date.now() - startedAt, clipForLog(text),
                    );
                } catch (e) {
                    response = {
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: { content: [{ type: 'text', text: (e as Error).message }], isError: true },
                    };
                    logger.warn(
                        'MCP tools/call ERROR: %s, tool=%s, id=%s, %dms, error=%s',
                        logCtx, name, `${msg.id}`, Date.now() - startedAt, (e as Error).message,
                    );
                }
                deliverOrBroadcast(this.ctx, sessionId, JSON.stringify(response));
                continue;
            }

            const response = await handleJsonRpc(this.ctx, domainId, msg, meta);
            if (!response) {
                logger.info('MCP handled (no response): %s, method=%s', logCtx, msg?.method || '-');
                continue;
            }
            if (response.error) {
                logger.warn('MCP %s ERROR: %s, code=%s, msg=%s', msg?.method || '-', logCtx, response.error.code, response.error.message);
            } else {
                logger.info('MCP %s OK: %s', msg?.method || '-', logCtx);
            }
            deliverOrBroadcast(this.ctx, sessionId, JSON.stringify(response));
        }

        this.response.status = 202;
        this.response.type = 'text/plain';
        this.response.body = 'Accepted';
    }
}

async function getOrCreateMcpToken(
    domainId: string,
    owner: number,
    baseDocId?: number,
    branch?: string,
): Promise<string> {
    const query: any = { domainId, type: 'mcp_sse', owner };
    if (baseDocId !== undefined && baseDocId !== null) query.baseDocId = baseDocId;
    const existing = await EdgeTokenModel.coll.findOne(query);
    if (existing) {
        const fresh = await EdgeTokenModel.getByToken(existing.token);
        if (fresh) return fresh.token;
    }
    const token = await EdgeTokenModel.generateToken();
    await EdgeTokenModel.add(domainId, 'mcp_sse', token, owner, { baseDocId, branch });
    return token;
}

async function getOrCreateMcp(
    domainId: string,
    owner: number,
    token: string,
    baseDocId?: number,
    branch?: string,
) {
    let mcp = await McpModel.getByToken(domainId, token);
    if (!mcp) {
        const instructions = await buildMcpInstructions({ domainId, baseDocId, branch });
        mcp = await McpModel.add({
            domainId,
            owner,
            token,
            baseDocId,
            branch,
            name: baseDocId ? `MCP · base ${baseDocId}` : 'MCP',
            instructions,
            tools: defaultMcpToolDescriptions(),
        });
    }
    return mcp;
}

function buildMcpConnectionInfo(h: Handler<Context>, domainId: string, token: string) {
    const { protocol, host } = detectOrigin(h);
    const baseUrl = `${protocol}://${host}/d/${domainId}/mcp/sse`;
    const url = `${baseUrl}?token=${token}`;
    const command = `claude mcp add --transport sse ejunz-${domainId} ${baseUrl} --header "Authorization: Bearer ${token}"`;
    return {
        token,
        url,
        baseUrl,
        command,
        config: {
            mcpServers: {
                ejunz: {
                    type: 'sse',
                    url: baseUrl,
                    headers: { Authorization: `Bearer ${token}` },
                },
            },
        },
    };
}

function buildMcpStatus(domainId: string, mcp: { mid: number; token?: string; edgeId?: number }) {
    const online = mcpActiveSessionCount(mcp.token || '') > 0;
    const edgeId = mcp.edgeId || null;
    return {
        mid: mcp.mid,
        edgeId,
        used: !!edgeId,
        status: online ? 'online' : (edgeId ? 'offline' : 'pending'),
        edgeUrl: edgeId ? `/d/${domainId}/edge/${edgeId}` : null,
    };
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

        const token = await getOrCreateMcpToken(domainId, this.user._id, baseDocId, branch);
        const mcp = await getOrCreateMcp(domainId, this.user._id, token, baseDocId, branch);
        this.response.body = {
            success: true,
            baseDocId,
            branch: branch || mcp.branch || 'main',
            ...buildMcpStatus(domainId, mcp),
            ...buildMcpConnectionInfo(this, domainId, token),
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
        this.response.body = { success: true, exists: true, ...buildMcpStatus(domainId, mcp) };
    }
}

export class McpListHandler extends Handler<Context> {
    async get() {
        const domainId = this.domain._id;
        const all = await McpModel.getByDomain(domainId);
        const mcps = all
            .map((m) => ({
                ...m,
                online: mcpActiveSessionCount(m.token || '') > 0,
            }))
            .sort((a, b) => (a.mid || 0) - (b.mid || 0));
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

        const isOwner = this.user._id === mcp.owner || this.user.hasPriv(PRIV.PRIV_USER_PROFILE);
        const online = mcpActiveSessionCount(mcp.token || '') > 0;
        const edge = mcp.edgeId ? await EdgeModel.getByEdgeId(domainId, mcp.edgeId) : null;

        let info: ReturnType<typeof buildMcpConnectionInfo> | null = null;
        if (isOwner && mcp.token) info = buildMcpConnectionInfo(this, domainId, mcp.token);

        this.response.template = 'mcp_detail.html';
        this.response.body = {
            domainId,
            mcp: { ...mcp, status: online ? 'online' : 'offline' },
            online,
            isOwner,
            edge,
            info,
            configJson: info ? JSON.stringify(info.config, null, 2) : '',
            instructions: mcp.instructions || '',
            tools: resolveMcpTools(mcp.tools),
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

        const body = this.request.body || {};

        if (body.operation === 'reset') {
            const instructions = await buildMcpInstructions({
                domainId, baseDocId: mcp.baseDocId, branch: mcp.branch,
            });
            await McpModel.update(domainId, mid, {
                instructions,
                tools: defaultMcpToolDescriptions(),
            });
            if (mcp.token) notifyToolsListChanged(this.ctx, mcp.token);
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
        if (mcp.token) notifyToolsListChanged(this.ctx, mcp.token);
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
    ctx.Route('mcp', '/mcp/sse', McpConnectionHandler);
    ctx.Route('mcp_message', '/mcp/sse/message', McpMessageHandler);
    ctx.Route('mcp_token', '/mcp/sse/token', McpTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_edit', '/mcp/:mid/edit', McpEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_detail', '/mcp/:mid', McpDetailHandler);

    (ctx as any).on('mcp/deliver', ({ sessionId, data }: { sessionId: string; data: string }) => {
        deliverToSession(sessionId, data);
    });
    (ctx as any).on('mcp/notify', ({ token, data }: { token: string; data: string }) => {
        deliverToToken(token, data);
    });
}
