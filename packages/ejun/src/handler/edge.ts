import { ConnectionHandler, Handler } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';

const logger = new Logger('edge');

class EdgeAliveHandler extends Handler<Context> {
    async get() {
        this.response.body = { ok: 1 };
    }
}

type Subscription = {
    event: string;
    dispose: () => void;
};

export class EdgeConnectionHandler extends ConnectionHandler<Context> {
    static active = new Set<EdgeConnectionHandler>();
    private pending: Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout } > = new Map();
    private subscriptions: Subscription[] = [];
    private accepted = false;

    async prepare() {
        // 单例：已有连接则拒绝新连接，避免抖动
        if (EdgeConnectionHandler.active.size > 0) {
            try { this.close(1000, 'edge singleton: connection already active'); } catch { /* ignore */ }
            return;
        }
        this.accepted = true;
        logger.info('Edge client connected from %s', this.request.ip);
        this.send({ hello: 'edge', version: 1 });
        EdgeConnectionHandler.active.add(this);
        // 延迟到连接完全就绪（onmessage 已挂载）后再请求，避免竞态
        setTimeout(() => {
            if (!this.accepted) return;
            this.sendRpc('tools/list', undefined, 1500).then((tools) => {
                logger.info('Edge tools: %o', tools);
            }).catch((e) => {
                logger.warn('Fetch tools/list failed: %s', (e as Error).message);
            });
        }, 150);
    }

    private unsubscribeAll() {
        for (const sub of this.subscriptions) {
            try { sub.dispose?.(); } catch { /* ignore */ }
        }
        this.subscriptions = [];
    }

    async message(msg: any) {
        // Prefer handling JSON-RPC objects (framework already JSON.parse on message)
        if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.id !== undefined) {
            const rec = this.pending.get(String(msg.id));
            if (rec) {
                this.pending.delete(String(msg.id));
                clearTimeout(rec.timer);
                if ('error' in msg && msg.error) rec.reject(msg.error);
                else rec.resolve(msg.result);
                return;
            }
        }
        if (!msg || typeof msg !== 'object') return;
        const { key } = msg;
        switch (key) {
        case 'publish': {
            // publish to app event bus
            const { event, payload } = msg;
            if (typeof event === 'string') {
                try {
                    const args = [event, ...(Array.isArray(payload) ? payload : [payload])];
                    (app.parallel as any).apply(app, args);
                } catch (e) {
                    logger.warn('publish failed: %s', (e as Error).message);
                }
            }
            break; }
        case 'subscribe': {
            const { event } = msg;
            if (typeof event === 'string') {
                const handler = (...args: any[]) => {
                    try { this.send({ event, payload: args }); } catch { /* ignore */ }
                };
                const dispose = app.on(event as any, handler as any);
                this.subscriptions.push({ event, dispose });
                this.send({ ok: 1, event });
            }
            break; }
        case 'unsubscribe': {
            const { event } = msg;
            if (typeof event === 'string') {
                const rest: Subscription[] = [];
                for (const sub of this.subscriptions) {
                    if (sub.event === event) {
                        try { sub.dispose?.(); } catch { /* ignore */ }
                    } else rest.push(sub);
                }
                this.subscriptions = rest;
                this.send({ ok: 1, event });
            }
            break; }
        case 'ping':
            this.send('pong');
            break;
        default:
            // echo back for unknown keys
            this.send({ ok: 1, echo: msg });
        }
    }

    async cleanup() {
        this.unsubscribeAll();
        if (this.accepted) logger.info('Edge client disconnected from %s', this.request.ip);
        for (const [, p] of this.pending) { try { p.reject(new Error('connection closed')); } catch { /* ignore */ } }
        this.pending.clear();
        EdgeConnectionHandler.active.delete(this);
    }

    // Send JSON-RPC to this client
    sendRpc(method: string, params?: any, timeoutMs = 20000): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('edge rpc timeout'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(e);
            }
        });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('edge_alive', '/edge', EdgeAliveHandler);
    ctx.Connection('edge_conn', '/edge/conn', EdgeConnectionHandler);
    ctx.Route('edge_rpc', '/edge/rpc', EdgeRpcHandler as any);

    // Expose MCP via app events for Agent chat
    (ctx as any).on('mcp/tools/list', async () => {
        try {
            const res = await edgeCallAny('tools/list', undefined, 1500);
            return res?.tools || res || [];
        } catch (e) {
            logger.warn('mcp/tools/list failed: %s', (e as Error).message);
            return [];
        }
    });
    (ctx as any).on('mcp/tool/call', async ({ name, args }) => {
        try {
            return await edgeCallAny('tools/call', { name, arguments: args }, 8000);
        } catch (e) {
            logger.warn('mcp/tool/call failed: %s', (e as Error).message);
            throw e;
        }
    });
}

// Helper API to invoke MCP tools on any active edge client
class EdgeRpcHandler extends Handler<Context> {
    async post() {
        const method = this.request.body?.method;
        const params = this.request.body?.params;
        const timeout = Number(this.request.body?.timeout) || 20000;
        const client = EdgeConnectionHandler.active.values().next().value as EdgeConnectionHandler | undefined;
        if (!client) {
            this.response.status = 503;
            this.response.body = { error: 'no edge client connected' };
            return;
        }
        if (!method || typeof method !== 'string') {
            this.response.status = 400;
            this.response.body = { error: 'invalid method' };
            return;
        }
        try {
            const result = await client.sendRpc(method, params, timeout);
            this.response.body = { result };
        } catch (e) {
            this.response.status = 500;
            this.response.body = { error: (e as Error).message };
        }
    }
}

export function edgeCall(method: string, params?: any, timeoutMs = 20000) {
    const client = EdgeConnectionHandler.active.values().next().value as EdgeConnectionHandler | undefined;
    if (!client) throw new Error('no edge client connected');
    return client.sendRpc(method, params, timeoutMs);
}

export async function edgeCallAny(method: string, params?: any, timeoutMs = 2000) {
    const clients = Array.from(EdgeConnectionHandler.active.values());
    if (!clients.length) throw new Error('no edge client connected');
    const tasks = clients.map((c) => c
        .sendRpc(method, params, timeoutMs)
        .then((res) => ({ ok: true, res }))
        .catch((e) => ({ ok: false, err: e })));
    const results = await Promise.all(tasks);
    for (const r of results) if ((r as any).ok) return (r as any).res;
    throw (results[0] as any).err || new Error('edge rpc failed');
}

// (route registered inside apply)


