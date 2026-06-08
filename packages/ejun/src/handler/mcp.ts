import { Handler } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import EdgeTokenModel from '../model/edge_token';
import TaskModel from '../model/task';
import { randomstring } from '../utils';

const logger = new Logger('handler/mcp');

const MCP_PROTOCOL_VERSION = '2024-11-05';
const SSE_KEEPALIVE_MS = 25 * 1000;

interface McpSession {
    sessionId: string;
    domainId: string;
    token: string;
    write: (event: string, data: string) => void;
}

const mcpSessions = new Map<string, McpSession>();

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
    if (!deliverToSession(sessionId, data)) {
        (ctx as any).broadcast('mcp/deliver', { sessionId, data });
    }
}

type JsonRpcMessage = {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: any;
};

async function handleJsonRpc(ctx: Context, domainId: string, msg: JsonRpcMessage): Promise<any | null> {
    if (!msg || typeof msg !== 'object' || !msg.method) return null;
    const { id, method } = msg;
    const hasId = id !== undefined && id !== null;

    switch (method) {
    case 'initialize':
        return {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: MCP_PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'ejunz-mcp', version: '1.0.0' },
            },
        };
    case 'notifications/initialized':
    case 'notifications/cancelled':
        return null;
    case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list': {
        let tools: any[] = [];
        try {
            tools = (await (ctx as any).serial('mcp/tools/list/local', { domainId })) || [];
        } catch (e) {
            logger.warn('tools/list failed: domainId=%s, error=%s', domainId, (e as Error).message);
        }
        return { jsonrpc: '2.0', id, result: { tools } };
    }
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
        };
        mcpSessions.set(sessionId, { sessionId, domainId, token, write });
        logger.info('MCP session opened: sessionId=%s, domainId=%s', sessionId, domainId);

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

        for (const msg of messages) {
            if (msg && msg.method === 'tools/call' && msg.id !== undefined && msg.id !== null) {
                const name = msg.params?.name;
                const args = msg.params?.arguments || {};
                if (!name || typeof name !== 'string') {
                    deliverOrBroadcast(this.ctx, sessionId, JSON.stringify({
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: { code: -32602, message: 'Invalid params: name is required' },
                    }));
                    continue;
                }
                await TaskModel.add({
                    type: 'mcp',
                    subType: 'tool_call',
                    domainId,
                    sessionId,
                    rpcId: msg.id,
                    name,
                    args,
                    priority: 0,
                });
                continue;
            }

            const response = await handleJsonRpc(this.ctx, domainId, msg);
            if (!response) continue;
            deliverOrBroadcast(this.ctx, sessionId, JSON.stringify(response));
        }

        this.response.status = 202;
        this.response.type = 'text/plain';
        this.response.body = 'Accepted';
    }
}

export class McpTokenHandler extends Handler<Context> {
    notUsage = true;

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        const domainId = this.domain._id;

        let token: string | null = null;
        const existing = await EdgeTokenModel.coll.findOne({
            domainId,
            type: 'mcp_sse',
            owner: this.user._id,
        });
        if (existing) {
            const fresh = await EdgeTokenModel.getByToken(existing.token);
            if (fresh) token = fresh.token;
        }
        if (!token) {
            token = await EdgeTokenModel.generateToken();
            await EdgeTokenModel.add(domainId, 'mcp_sse', token, this.user._id);
        }

        const { protocol, host } = detectOrigin(this);
        const baseUrl = `${protocol}://${host}/d/${domainId}/mcp/sse`;
        const url = `${baseUrl}?token=${token}`;
        const command = `claude mcp add --transport sse ejunz-${domainId} ${baseUrl} --header "Authorization: Bearer ${token}"`;

        this.response.body = {
            success: true,
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

    ctx.Route('mcp', '/mcp/sse', McpConnectionHandler);
    ctx.Route('mcp_message', '/mcp/sse/message', McpMessageHandler);
    ctx.Route('mcp_token', '/mcp/sse/token', McpTokenHandler, PRIV.PRIV_USER_PROFILE);

    (ctx as any).on('mcp/deliver', ({ sessionId, data }: { sessionId: string; data: string }) => {
        deliverToSession(sessionId, data);
    });
}
