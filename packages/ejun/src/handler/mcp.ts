import { createHash } from 'crypto';
import { throttle } from 'lodash';
import { Handler } from '@ejunz/framework';
import { Context } from '../context';
import { ConnectionHandler, subscribe } from '../service/server';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import { BaseModel } from '../model/base';
import EdgeTokenModel from '../model/edge_token';
import McpModel, { type NormalizedMcpRow, type McpKind } from '../model/mcp';
import TokenModel from '../model/token';
import UserModel from '../model/user';
import { NotFoundError, ValidationError } from '../error';
import { randomstring } from '../utils';
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

function buildMcpConnectionInfo(h: Handler<Context>, domainId: string, token: string, pathId?: string, branch?: string, serverName?: string) {
    const { protocol, host } = detectOrigin(h);
    return h.ctx.mcp.buildConnectionInfo({ protocol, host, domainId, token, pathId, branch, serverName });
}

function userCanAuthorizeMcp(user: any, target: { domainId: string; baseDocId?: number }) {
    if (!user?._id || !user.hasPriv(PRIV.PRIV_USER_PROFILE)) return false;
    if (user._dudoc?.join || user.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)) return true;
    return target.domainId === 'system' && !target.baseDocId;
}

function detectKoaOrigin(c: any): { protocol: string; host: string } {
    const host = c.request.host || c.request.headers.host || 'localhost';
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    const forwarded = c.request.headers['x-forwarded-proto']
        || (c.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : '');
    const protocol = forwarded || (isLocal ? 'http' : 'https');
    return { protocol, host };
}

function sendJson(c: any, body: any, status = 200) {
    c.status = status;
    c.type = 'application/json';
    c.body = JSON.stringify(body);
}

function appendQuery(url: string, params: Record<string, string | undefined>) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) qs.set(key, value);
    const suffix = qs.toString();
    if (!suffix) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${suffix}`;
}

function currentRequestUrl(h: Handler<Context>) {
    const { protocol, host } = detectOrigin(h);
    const path = (h.context as any).originalPath || h.request.originalPath || h.request.path;
    const query = h.request.querystring ? `?${h.request.querystring}` : '';
    return `${protocol}://${host}${path}${query}`;
}

function sendMcpAuthChallenge(h: Handler<Context>, error = 'Invalid or missing token') {
    const { protocol, host } = detectOrigin(h);
    const resource = currentRequestUrl(h);
    const metadata = appendQuery(`${protocol}://${host}/.well-known/oauth-protected-resource`, { resource });
    h.response.addHeader('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`);
    h.response.status = 401;
    h.response.type = 'application/json';
    h.response.body = JSON.stringify({ error });
}

function parseMcpResource(resource: string): { domainId: string; basePathId?: string; branch?: string } {
    let parsed: URL;
    try {
        parsed = new URL(resource);
    } catch {
        throw new ValidationError('resource');
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    const offset = parts[0] === 'd' ? 2 : 0;
    const domainId = parts[0] === 'd' ? parts[1] : 'system';
    if (!domainId || parts[offset] !== 'mcp' || parts[offset + 1] !== 'http') throw new ValidationError('resource');
    return {
        domainId: decodeURIComponent(domainId),
        basePathId: parts[offset + 2] ? decodeURIComponent(parts[offset + 2]) : undefined,
        branch: parsed.searchParams.get('branch') || undefined,
    };
}

async function resolveMcpAuthResource(resource: string) {
    const parsed = parseMcpResource(resource);
    let baseDocId: number | undefined;
    if (parsed.basePathId) {
        const base = await BaseModel.getBybid(parsed.domainId, parsed.basePathId)
            || (/^\d+$/.test(parsed.basePathId) ? await BaseModel.get(parsed.domainId, Number(parsed.basePathId)) : null);
        if (!base) throw new NotFoundError('Base not found');
        baseDocId = base.docId;
    }
    return { domainId: parsed.domainId, baseDocId, branch: parsed.branch };
}

function isAllowedLoopbackRedirect(redirectUri: string) {
    try {
        const url = new URL(redirectUri);
        if (url.protocol !== 'http:') return false;
        return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
        return false;
    }
}

function verifyPkce(codeChallenge: string | undefined, method: string | undefined, verifier: string | undefined) {
    if (!codeChallenge) return true;
    if (!verifier) return false;
    if (!method || method === 'plain') return verifier === codeChallenge;
    if (method !== 'S256') return false;
    const digest = createHash('sha256').update(verifier).digest().toString('base64url');
    return digest === codeChallenge;
}

async function getRegisteredMcpClient(clientId: string) {
    const client = clientId ? await TokenModel.get(clientId, TokenModel.TYPE_OAUTH) : null;
    if (!client || client.kind !== 'mcp_client') return null;
    return client;
}

function clientAllowsRedirectUri(client: any, redirectUri: string) {
    const redirectUris = Array.isArray(client?.redirectUris) ? client.redirectUris : [];
    return redirectUris.includes(redirectUri) || (redirectUris.length === 0 && isAllowedLoopbackRedirect(redirectUri));
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
        await EdgeTokenModel.touchLastUsed(token);
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
        this.response.addHeader('Access-Control-Allow-Origin', '*');
        const token = extractToken(this)?.token;
        const tokenDoc = token ? await EdgeTokenModel.getByToken(token) : null;
        if (!tokenDoc) {
            sendMcpAuthChallenge(this);
            return;
        }
        // We do not offer a server-initiated SSE stream on this endpoint; the spec allows 405.
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
            sendMcpAuthChallenge(this);
            return;
        }
        await EdgeTokenModel.touchLastUsed(token);
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
        const serverName = this.request.body?.serverName ? String(this.request.body.serverName) : undefined;

        const token = await this.ctx.mcp.getOrCreateMcpToken(domainId, this.user._id, baseDocId, branch);
        const mcp = await this.ctx.mcp.getOrCreateMcp(domainId, this.user._id, token, baseDocId, branch);
        const pathId = await this.ctx.mcp.resolveBasePathId(domainId, baseDocId ?? mcp.baseDocId);
        this.response.body = {
            success: true,
            baseDocId,
            branch: branch || mcp.branch || 'main',
            ...this.ctx.mcp.buildStatus(domainId, mcp),
            ...buildMcpConnectionInfo(this, domainId, token, pathId, branch || mcp.branch, serverName),
        };
    }

    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        const domainId = this.domain._id;
        const rawBaseId = this.request.query.baseId ?? this.request.query.baseDocId;
        const baseDocId = rawBaseId !== undefined && rawBaseId !== null && `${rawBaseId}` !== ''
            ? Number(rawBaseId) : undefined;

        const branch = this.request.query.branch ? String(this.request.query.branch) : undefined;
        const normalizedBranch = branch && branch !== 'main' ? branch : undefined;
        const query: any = { domainId, type: 'mcp_sse', owner: this.user._id };
        if (baseDocId !== undefined && !Number.isNaN(baseDocId)) query.baseDocId = baseDocId;
        if (normalizedBranch) query.branch = normalizedBranch;
        else query.$or = [{ branch: { $exists: false } }, { branch: null }, { branch: 'main' }];
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

export class McpOAuthRegisterHandler extends Handler<Context> {
    noCheckPermView = true;
    notUsage = true;

    async post() {
        this.response.template = null;
        const clientId = `mcp_${randomstring(24)}`;
        const redirectUris = Array.isArray(this.request.body?.redirect_uris)
            ? this.request.body.redirect_uris.filter((uri: any) => typeof uri === 'string' && isAllowedLoopbackRedirect(uri))
            : [];
        await TokenModel.add(TokenModel.TYPE_OAUTH, 30 * 24 * 60 * 60, {
            kind: 'mcp_client',
            clientId,
            redirectUris,
            clientName: this.request.body?.client_name || 'MCP client',
        }, clientId);
        this.response.body = {
            client_id: clientId,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: redirectUris,
            token_endpoint_auth_method: 'none',
            grant_types: ['authorization_code'],
            response_types: ['code'],
        };
    }
}

export class McpOAuthAuthorizeHandler extends Handler<Context> {
    noCheckPermView = true;
    notUsage = true;

    async get() {
        if (!this.user?._id) {
            this.response.redirect = this.url('user_login', {
                query: { redirect: `${this.context.originalPath || this.request.path}${this.context.search || ''}` },
            });
            return;
        }

        const q = this.request.query;
        const responseType = String(q.response_type || '');
        const redirectUri = String(q.redirect_uri || '');
        const resource = String(q.resource || '');
        const client = await getRegisteredMcpClient(q.client_id ? String(q.client_id) : '');
        if (responseType !== 'code') throw new ValidationError('response_type');
        if (!client) throw new ValidationError('client_id');
        if (!redirectUri || !isAllowedLoopbackRedirect(redirectUri) || !clientAllowsRedirectUri(client, redirectUri)) {
            throw new ValidationError('redirect_uri');
        }
        if (!resource) throw new ValidationError('resource');

        const target = await resolveMcpAuthResource(resource);
        const owner = await UserModel.getById(target.domainId, this.user._id);
        if (!userCanAuthorizeMcp(owner, target)) throw new ValidationError('resource');
        const [code] = await TokenModel.add(TokenModel.TYPE_OAUTH, 10 * 60, {
            kind: 'mcp_auth_code',
            uid: this.user._id,
            clientId: q.client_id ? String(q.client_id) : '',
            redirectUri,
            resource,
            domainId: target.domainId,
            baseDocId: target.baseDocId,
            branch: target.branch,
            codeChallenge: q.code_challenge ? String(q.code_challenge) : undefined,
            codeChallengeMethod: q.code_challenge_method ? String(q.code_challenge_method) : undefined,
        });
        this.response.redirect = appendQuery(redirectUri, {
            code,
            state: q.state ? String(q.state) : undefined,
        });
    }
}

export class McpOAuthTokenHandler extends Handler<Context> {
    noCheckPermView = true;
    notUsage = true;

    async post() {
        this.response.template = null;
        const body = this.request.body || {};
        if (body.grant_type !== 'authorization_code') throw new ValidationError('grant_type');
        const code = String(body.code || '');
        const data = code ? await TokenModel.get(code, TokenModel.TYPE_OAUTH) : null;
        const client = await getRegisteredMcpClient(body.client_id ? String(body.client_id) : '');
        if (!data || data.kind !== 'mcp_auth_code' || !client || data.clientId !== client.clientId) {
            this.response.status = 400;
            this.response.body = { error: 'invalid_grant' };
            return;
        }
        if (String(body.redirect_uri || '') !== data.redirectUri) {
            this.response.status = 400;
            this.response.body = { error: 'invalid_grant' };
            return;
        }
        if (!verifyPkce(data.codeChallenge, data.codeChallengeMethod, body.code_verifier ? String(body.code_verifier) : undefined)) {
            this.response.status = 400;
            this.response.body = { error: 'invalid_grant' };
            return;
        }

        const owner = await UserModel.getById(data.domainId, data.uid);
        if (!userCanAuthorizeMcp(owner, data)) {
            this.response.status = 400;
            this.response.body = { error: 'invalid_grant' };
            return;
        }

        const token = await this.ctx.mcp.getOrCreateMcpToken(data.domainId, data.uid, data.baseDocId, data.branch);
        await this.ctx.mcp.getOrCreateMcp(data.domainId, data.uid, token, data.baseDocId, data.branch);
        await EdgeTokenModel.markAuthenticated(token);
        const tokenDoc = await EdgeTokenModel.getByToken(token);
        await TokenModel.del(code, TokenModel.TYPE_OAUTH);
        const response: any = {
            access_token: token,
            token_type: 'Bearer',
        };
        if (tokenDoc?.expireAt) {
            response.expires_in = Math.max(0, Math.floor((tokenDoc.expireAt.getTime() - Date.now()) / 1000));
        }
        this.response.body = response;
    }
}

function filterMcpsBySearchQuery(mcps: any[], q: string) {
    const keyword = String(q || '').trim().toLowerCase();
    if (!keyword) return mcps;
    return mcps.filter((mcp) => [
        mcp.mid,
        mcp.name,
        mcp.description,
        mcp.kind,
        mcp.kindLabel,
        mcp.sourceLabel,
        mcp.runtimeMode,
        mcp.runtimeVersion,
    ].filter(Boolean).join(' ').toLowerCase().includes(keyword));
}

type McpActivityRow = NormalizedMcpRow & { working: boolean; lastUsedAt?: Date };

function withMcpActivity(ctx: Context, domainId: string, row: NormalizedMcpRow): McpActivityRow {
    return {
        ...row,
        working: ctx.mcp.isMcpWorking(domainId, row.mid),
        lastUsedAt: row.lastUsedAt || row.tokenInfo?.lastUsedAt,
    };
}

function sortMcpsByActivity(rows: McpActivityRow[]) {
    const order = { outbound: 0, system: 1, ejunztools: 2, inbound: 3, plugin: 4 } as Record<McpKind, number>;
    rows.sort((a, b) => {
        if (a.working !== b.working) return a.working ? -1 : 1;
        const aLastUsed = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
        const bLastUsed = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
        if (aLastUsed !== bLastUsed) return bLastUsed - aLastUsed;
        if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
        return (a.mid || 0) - (b.mid || 0);
    });
    return rows;
}

class McpListConnectionHandler extends ConnectionHandler {
    queue: Map<number, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;

    async prepare() {
        try {
            const domainId = String(this.request.query.domainId || this.args.domainId || '');
            if (!domainId) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            this.args.domainId = domainId;
            this.args.q = String(this.request.query.q || '').trim();
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
        } catch (e: any) {
            try {
                this.close(4000, e.message || String(e));
            } catch {
                /* ignore */
            }
        }
    }

    async message(msg: { mids: number[] }) {
        if (!(msg.mids instanceof Array)) return;
        for (const rawMid of msg.mids) {
            const mid = Number(rawMid);
            if (!Number.isFinite(mid) || mid < 1) continue;
            await this.sendMcpRow(mid, true);
        }
    }

    @subscribe('mcp/change')
    async onMcpChange(domainId: string, mid: number) {
        if (domainId !== this.args.domainId) return;
        await this.sendMcpRow(mid);
    }

    @subscribe('mcp/status/update')
    async onMcpStatusUpdate(domainId: string, mid: number) {
        if (domainId !== this.args.domainId) return;
        await this.sendMcpRow(mid);
    }

    async sendMcpRow(mid: number, initial = false) {
        const normalized = await this.ctx.mcp.getNormalizedMcp(this.args.domainId, mid);
        const mcp = normalized ? withMcpActivity(this.ctx, this.args.domainId, normalized) : null;
        if (!mcp || !filterMcpsBySearchQuery([mcp], this.args.q)[0]) {
            this.queue.set(mid, async () => ({ mid, remove: true, initial }));
        } else {
            this.queue.set(mid, async () => ({
                initial,
                html: await this.renderHTML('partials/mcp_list_tr.html', { mcp }),
            }));
        }
        this.throttleQueueClear();
    }

    async queueClear() {
        await Promise.all([...this.queue.values()].map(async (fn) => this.send(await fn())));
        this.queue.clear();
    }

    async cleanup() {
        this.queue.clear();
    }
}

export class McpListHandler extends Handler<Context> {
    async get() {
        const domainId = this.domain._id;
        const rawPage = Number(this.request.query.page || 1);
        const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
        const q = String(this.request.query.q || '').trim();
        const pjax = this.request.query.pjax === 'true' || this.request.query.pjax === '1';
        const limit = this.ctx.setting.get('pagination.problem') || 20;
        const rows = (await this.ctx.mcp.listDomainMcps(domainId, this.user)).map((row) => withMcpActivity(this.ctx, domainId, row));
        const allMcps = sortMcpsByActivity(filterMcpsBySearchQuery(rows, q));
        const total = allMcps.length;
        const ppcount = Math.max(1, Math.ceil(total / limit));
        const page1 = Math.max(1, Math.min(page, ppcount));
        const mcps = allMcps.slice((page1 - 1) * limit, page1 * limit);
        const mcpConnQuery = `domainId=${encodeURIComponent(domainId)}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
        const body = { domainId, mcps, page: page1, ppcount, totalPages: ppcount, qs: q, mcpMids: mcps.map((mcp) => mcp.mid), mcpConnQuery, mcpPageSize: limit };
        this.response.template = 'mcp_main.html';
        if (pjax) {
            const html = await this.renderHTML('partials/mcp_list.html', body);
            this.response.body = {
                title: this.renderTitle(this.translate('MCP Dashboard')),
                fragments: [{ html: html || '' }],
            };
            return;
        }
        this.response.body = body;
    }

    async postDeleteSelected() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const domainId = this.domain._id;
        const mids: string[] = Array.isArray(this.request.body?.mids) ? this.request.body.mids : [];
        for (const raw of mids) {
            const mid = Number(raw);
            if (!Number.isFinite(mid) || mid < 1) continue;
            const mcp = await McpModel.getByMcpId(domainId, mid);
            if (!mcp) continue;
            if (this.ctx.mcp.mcpKind(mcp) !== 'outbound') {
                throw new ValidationError('Only outbound MCP endpoints can be deleted from this page.');
            }
            if (this.user._id !== mcp.owner && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) {
                throw new ValidationError('You are not allowed to delete this MCP.');
            }
            await McpModel.deleteOutboundAndInvalidateToken(domainId, mid);
        }
        this.response.body = { success: true };
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
            info = buildMcpConnectionInfo(this, domainId, mcp.token, pathId, mcp.branch);
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

async function captureOAuthProtectedResource(c: any) {
    const { protocol, host } = detectKoaOrigin(c);
    const resource = String(c.query.resource || `${protocol}://${host}/d/${c.domainId || 'system'}/mcp/http`);
    sendJson(c, {
        resource,
        authorization_servers: [`${protocol}://${host}`],
        bearer_methods_supported: ['header'],
        resource_documentation: `${protocol}://${host}/mcp`,
    });
}

async function captureOAuthAuthorizationServer(c: any) {
    const { protocol, host } = detectKoaOrigin(c);
    const issuer = `${protocol}://${host}`;
    sendJson(c, {
        issuer,
        authorization_endpoint: `${issuer}/mcp/oauth/authorize`,
        token_endpoint: `${issuer}/mcp/oauth/token`,
        registration_endpoint: `${issuer}/mcp/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256', 'plain'],
        token_endpoint_auth_methods_supported: ['none'],
    });
}

function captureWellKnownNotFound(c: any) {
    sendJson(c, {
        error: 'not_found',
        error_description: 'OAuth metadata is only available on the MCP protected-resource and authorization-server endpoints.',
    }, 404);
}

export async function apply(ctx: Context) {
    (ctx as any).server.addCaptureRoute('/.well-known/oauth-protected-resource', captureOAuthProtectedResource);
    (ctx as any).server.addCaptureRoute('/.well-known/oauth-authorization-server', captureOAuthAuthorizationServer);
    (ctx as any).server.addCaptureRoute('/.well-known/openid-configuration', captureWellKnownNotFound);

    ctx.Route('mcp_main', '/mcp', McpListHandler);
    ctx.Connection('mcp_conn', '/mcp-conn', McpListConnectionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_market', '/mcp/market', McpMarketHandler);
    ctx.Route('mcp_market_add', '/mcp/market/add', McpMarketAddHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_market_remove', '/mcp/market/remove', McpMarketRemoveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_oauth_register', '/mcp/oauth/register', McpOAuthRegisterHandler);
    ctx.Route('mcp_oauth_authorize', '/mcp/oauth/authorize', McpOAuthAuthorizeHandler);
    ctx.Route('mcp_oauth_token', '/mcp/oauth/token', McpOAuthTokenHandler);
    ctx.Route('mcp_message', '/mcp/sse/message', McpMessageHandler);
    ctx.Route('mcp_token', '/mcp/sse/token', McpTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp', '/mcp/sse/:bid', McpConnectionHandler);
    // Streamable HTTP transport (recommended): request/response on the same connection.
    ctx.Route('mcp_http', '/mcp/http', McpStreamableHandler);
    ctx.Route('mcp_http_bid', '/mcp/http/:bid', McpStreamableHandler);
    ctx.Route('mcp_edit', '/mcp/:mid/edit', McpEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_detail', '/mcp/:mid', McpDetailHandler);

}
