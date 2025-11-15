import { ConnectionHandler, Handler } from '@ejunz/framework';
import { ObjectId } from 'mongodb';
import { throttle } from 'lodash';
import { Context } from '../context';
import { Logger } from '../logger';
import { ValidationError } from '../error';
import { PRIV } from '../model/builtin';
import { McpServerConnectionHandler } from './mcp';
import { ClientConnectionHandler } from './client';
import { NodeClientConnectionHandler } from './node';
import NodeModel from '../model/node';
import McpServerModel from '../model/mcp';
import ClientModel from '../model/client';
import EdgeTokenModel from '../model/edge_token';

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

// 跟踪正在进行的工具调用
const activeToolCalls = new Map<string, { type: 'mcp' | 'client' | 'node'; id: number | string; startTime: number }>();

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

// Edge 主页面处理器（列表页）
export class EdgeMainHandler extends Handler<Context> {
    async get() {
        // 获取所有连接状态
        const mcpServers = await McpServerModel.getByDomain(this.domain._id);
        const clients = await ClientModel.getByDomain(this.domain._id);
        const nodes = await NodeModel.getByDomain(this.domain._id);
        
        // 获取实时连接状态
        const mcpStatuses = mcpServers.map(server => {
            const isConnected = McpServerConnectionHandler.active.has(server.serverId);
            const callKey = `mcp:${server.serverId}`;
            const isWorking = activeToolCalls.has(callKey);
            return {
                ...server,
                status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
            };
        });
        
        const clientStatuses = clients.map(client => {
            const isConnected = ClientConnectionHandler.active.has(client.clientId);
            const callKey = `client:${client.clientId}`;
            const isWorking = activeToolCalls.has(callKey);
            return {
                ...client,
                status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
            };
        });
        
        const nodeStatuses = await Promise.all(nodes.map(async (node) => {
            const callKey = `node:${node.nodeId}`;
            const isWorking = activeToolCalls.has(callKey);
            const baseStatus = node.status === 'active' ? 'connected' : 'disconnected';
            return {
                ...node,
                status: isWorking ? 'working' : baseStatus,
            };
        }));
        
        // 排序
        mcpStatuses.sort((a, b) => (a.serverId || 0) - (b.serverId || 0));
        clientStatuses.sort((a, b) => (a.clientId || 0) - (b.clientId || 0));
        nodeStatuses.sort((a, b) => (a.nodeId || 0) - (b.nodeId || 0));
        
        this.response.template = 'edge_main.html';
        this.response.body = {
            mcpServers: mcpStatuses,
            clients: clientStatuses,
            nodes: nodeStatuses,
            domainId: this.domain._id,
        };
    }
}

// Edge 状态页面处理器（详情页）
export class EdgeStatusHandler extends Handler<Context> {
    async get() {
        this.response.template = 'edge_detail.html';
        
        // 获取所有连接状态
        const mcpServers = await McpServerModel.getByDomain(this.domain._id);
        const clients = await ClientModel.getByDomain(this.domain._id);
        const nodes = await NodeModel.getByDomain(this.domain._id);
        
        // 获取实时连接状态
        const mcpStatuses = mcpServers.map(server => {
            const isConnected = McpServerConnectionHandler.active.has(server.serverId);
            const callKey = `mcp:${server.serverId}`;
            const isWorking = activeToolCalls.has(callKey);
            return {
                ...server,
                status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
            };
        });
        
        const clientStatuses = clients.map(client => {
            const isConnected = ClientConnectionHandler.active.has(client.clientId);
            const callKey = `client:${client.clientId}`;
            const isWorking = activeToolCalls.has(callKey);
            return {
                ...client,
                status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
            };
        });
        
        const nodeStatuses = await Promise.all(nodes.map(async (node) => {
            // Node 的状态从数据库获取，但需要检查是否有活跃连接
            // 通过检查 node.status 和是否有对应的连接
            const callKey = `node:${node.nodeId}`;
            const isWorking = activeToolCalls.has(callKey);
            const baseStatus = node.status === 'active' ? 'connected' : 'disconnected';
            return {
                ...node,
                status: isWorking ? 'working' : baseStatus,
            };
        }));
        
        this.response.body = {
            mcpServers: mcpStatuses,
            clients: clientStatuses,
            nodes: nodeStatuses,
        };
    }
}

// Edge 主页面 WebSocket 连接处理器（类似 RecordMainConnectionHandler）
export class EdgeMainConnectionHandler extends ConnectionHandler<Context> {
    private subscriptions: Array<{ dispose: () => void }> = [];
    private queue: Map<string, () => Promise<any>> = new Map();
    private throttleQueueClear: () => void;
    
    async prepare() {
        this.throttleQueueClear = throttle(this.queueClear.bind(this), 100, { trailing: true });
        
        // 发送初始状态
        await this.sendAllStatusUpdates();
        
        // 监听连接状态变化事件
        const dispose1 = this.ctx.on('mcp/server/connection/update' as any, async (...args: any[]) => {
            const [serverId] = args;
            await this.onStatusChange('mcp', serverId);
        });
        this.subscriptions.push({ dispose: dispose1 });
        
        const dispose2 = this.ctx.on('client/status/update' as any, async (...args: any[]) => {
            const [clientId] = args;
            await this.onStatusChange('client', clientId);
        });
        this.subscriptions.push({ dispose: dispose2 });
        
        const dispose3 = this.ctx.on('node/status/update' as any, async (...args: any[]) => {
            const [nodeId] = args;
            await this.onStatusChange('node', nodeId);
        });
        this.subscriptions.push({ dispose: dispose3 });
        
        // 定期发送状态更新（用于检测工具调用状态变化）
        const interval = setInterval(async () => {
            await this.sendAllStatusUpdates();
        }, 2000);
        
        this.subscriptions.push({ 
            dispose: () => clearInterval(interval) 
        });
    }
    
    async onStatusChange(type: 'mcp' | 'client' | 'node', id: number | ObjectId) {
        try {
            let item: any = null;
            if (type === 'mcp') {
                const server = await McpServerModel.getByServerId(this.domain._id, id as number);
                if (server) {
                    const isConnected = McpServerConnectionHandler.active.has(server.serverId);
                    const callKey = `mcp:${server.serverId}`;
                    const isWorking = activeToolCalls.has(callKey);
                    item = {
                        ...server,
                        status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
                    };
                }
            } else if (type === 'client') {
                const client = await ClientModel.getByClientId(this.domain._id, id as number);
                if (client) {
                    const isConnected = ClientConnectionHandler.active.has(client.clientId);
                    const callKey = `client:${client.clientId}`;
                    const isWorking = activeToolCalls.has(callKey);
                    item = {
                        ...client,
                        status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
                    };
                }
            } else if (type === 'node') {
                const node = await NodeModel.getByNodeId(this.domain._id, id as number);
                if (node) {
                    const callKey = `node:${node.nodeId}`;
                    const isWorking = activeToolCalls.has(callKey);
                    const baseStatus = node.status === 'active' ? 'connected' : 'disconnected';
                    item = {
                        ...node,
                        status: isWorking ? 'working' : baseStatus,
                    };
                }
            }
            
            if (item) {
                const itemId = type === 'mcp' ? item.serverId : (type === 'client' ? item.clientId : item.nodeId);
                const key = `${type}:${itemId}`;
                this.queueSend(key, async () => ({
                    html: await this.renderHTML('edge_main_tr.html', {
                        itemType: type,
                        itemId,
                        item,
                        domainId: this.domain._id,
                    }),
                }));
            }
        } catch (e) {
            logger.error('Failed to handle status change: %s', (e as Error).message);
        }
    }
    
    async sendAllStatusUpdates() {
        try {
            const mcpServers = await McpServerModel.getByDomain(this.domain._id);
            const clients = await ClientModel.getByDomain(this.domain._id);
            const nodes = await NodeModel.getByDomain(this.domain._id);
            
            // 发送所有 MCP 服务器状态
            for (const server of mcpServers) {
                const isConnected = McpServerConnectionHandler.active.has(server.serverId);
                const callKey = `mcp:${server.serverId}`;
                const isWorking = activeToolCalls.has(callKey);
                const item = {
                    ...server,
                    status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
                };
                const key = `mcp:${server.serverId}`;
                this.queueSend(key, async () => ({
                    html: await this.renderHTML('edge_main_tr.html', {
                        itemType: 'mcp',
                        itemId: server.serverId,
                        item,
                        domainId: this.domain._id,
                    }),
                }));
            }
            
            // 发送所有 Client 状态
            for (const client of clients) {
                const isConnected = ClientConnectionHandler.active.has(client.clientId);
                const callKey = `client:${client.clientId}`;
                const isWorking = activeToolCalls.has(callKey);
                const item = {
                    ...client,
                    status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
                };
                const key = `client:${client.clientId}`;
                this.queueSend(key, async () => ({
                    html: await this.renderHTML('edge_main_tr.html', {
                        itemType: 'client',
                        itemId: client.clientId,
                        item,
                        domainId: this.domain._id,
                    }),
                }));
            }
            
            // 发送所有 Node 状态
            for (const node of nodes) {
                const callKey = `node:${node.nodeId}`;
                const isWorking = activeToolCalls.has(callKey);
                const baseStatus = node.status === 'active' ? 'connected' : 'disconnected';
                const item = {
                    ...node,
                    status: isWorking ? 'working' : baseStatus,
                };
                const key = `node:${node.nodeId}`;
                this.queueSend(key, async () => ({
                    html: await this.renderHTML('edge_main_tr.html', {
                        itemType: 'node',
                        itemId: node.nodeId,
                        item,
                        domainId: this.domain._id,
                    }),
                }));
            }
        } catch (e) {
            logger.error('Failed to send all status updates: %s', (e as Error).message);
        }
    }
    
    queueSend(key: string, fn: () => Promise<any>) {
        this.queue.set(key, fn);
        this.throttleQueueClear();
    }
    
    async queueClear() {
        await Promise.all([...this.queue.values()].map(async (fn) => this.send(await fn())));
        this.queue.clear();
    }
    
    async message(msg: any) {
        if (msg && typeof msg === 'object' && msg.type === 'ping') {
            this.send({ type: 'pong' });
        }
    }
    
    async cleanup() {
        for (const sub of this.subscriptions) {
            try {
                sub.dispose?.();
            } catch {
                // ignore
            }
        }
        this.subscriptions = [];
        this.queue.clear();
        logger.debug('Edge Main WebSocket disconnected');
    }
}

// Edge 状态 WebSocket 连接处理器（用于详情页）
export class EdgeStatusConnectionHandler extends ConnectionHandler<Context> {
    private subscriptions: Array<{ dispose: () => void }> = [];
    
    async prepare() {
        logger.debug('Edge Status WebSocket connected');
        
        // 发送初始状态
        await this.sendStatusUpdate();
        
        // 监听连接状态变化
        const dispose1 = this.ctx.on('mcp/server/connection/update' as any, async (...args: any[]) => {
            await this.sendStatusUpdate();
        });
        this.subscriptions.push({ dispose: dispose1 });
        
        const dispose2 = this.ctx.on('client/status/update' as any, async (...args: any[]) => {
            await this.sendStatusUpdate();
        });
        this.subscriptions.push({ dispose: dispose2 });
        
        const dispose3 = this.ctx.on('node/status/update' as any, async (...args: any[]) => {
            await this.sendStatusUpdate();
        });
        this.subscriptions.push({ dispose: dispose3 });
        
        // 定期发送状态更新
        const interval = setInterval(async () => {
            await this.sendStatusUpdate();
        }, 2000);
        
        this.subscriptions.push({ 
            dispose: () => clearInterval(interval) 
        });
    }
    
    async sendStatusUpdate() {
        try {
            const mcpServers = await McpServerModel.getByDomain(this.domain._id);
            const clients = await ClientModel.getByDomain(this.domain._id);
            const nodes = await NodeModel.getByDomain(this.domain._id);
            
            const mcpStatuses = mcpServers.map(server => {
                const isConnected = McpServerConnectionHandler.active.has(server.serverId);
                const callKey = `mcp:${server.serverId}`;
                const isWorking = activeToolCalls.has(callKey);
                return {
                    id: server.serverId,
                    name: server.name || `MCP ${server.serverId}`,
                    status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
                };
            });
            
            const clientStatuses = clients.map(client => {
                const isConnected = ClientConnectionHandler.active.has(client.clientId);
                const callKey = `client:${client.clientId}`;
                const isWorking = activeToolCalls.has(callKey);
                return {
                    id: client.clientId,
                    name: client.name || `Client ${client.clientId}`,
                    status: isWorking ? 'working' : (isConnected ? 'connected' : 'disconnected'),
                };
            });
            
            const nodeStatuses = await Promise.all(nodes.map(async (node) => {
                const callKey = `node:${node.nodeId}`;
                const isWorking = activeToolCalls.has(callKey);
                const baseStatus = node.status === 'active' ? 'connected' : 'disconnected';
                return {
                    id: node.nodeId,
                    name: node.name || `Node ${node.nodeId}`,
                    status: isWorking ? 'working' : baseStatus,
                };
            }));
            
            this.send({
                type: 'status/update',
                mcp: mcpStatuses,
                client: clientStatuses,
                node: nodeStatuses,
            });
        } catch (e) {
            logger.error('Failed to send status update: %s', (e as Error).message);
        }
    }
    
    async message(msg: any) {
        if (msg && typeof msg === 'object' && msg.type === 'ping') {
            this.send({ type: 'pong' });
        }
    }
    
    async cleanup() {
        for (const sub of this.subscriptions) {
            try {
                sub.dispose?.();
            } catch {
                // ignore
            }
        }
        this.subscriptions = [];
        logger.debug('Edge Status WebSocket disconnected');
    }
}

export async function apply(ctx: Context) {
    ctx.Route('edge_main', '/edge', EdgeMainHandler);
    ctx.Route('edge_alive', '/edge/alive', EdgeAliveHandler);
    ctx.Connection('edge_conn', '/edge/conn', EdgeConnectionHandler);
    ctx.Route('edge_rpc', '/edge/rpc', EdgeRpcHandler as any);
    ctx.Route('edge_status', '/edge/status', EdgeStatusHandler);
    ctx.Connection('edge_main_conn', '/edge-main-conn', EdgeMainConnectionHandler);
    ctx.Connection('edge_status_conn', '/edge/status/ws', EdgeStatusConnectionHandler);
    ctx.Route('edge_generate_token', '/edge/generate-token', EdgeGenerateTokenHandler, PRIV.PRIV_USER_PROFILE);

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
    (ctx as any).on('mcp/tools/list/edge', async () => {
        try {
            const res = await edgeCallAny('tools/list', undefined, 2000);
            return res?.tools || res || [];
        } catch (e) {
            logger.warn('mcp/tools/list/edge failed: %s', (e as Error).message);
            return [];
        }
    });
    (ctx as any).on('mcp/tool/call', async ({ name, args, serverId }) => {
        try {
            const callKey = serverId ? `mcp:${serverId}` : null;
            if (callKey) {
                activeToolCalls.set(callKey, { type: 'mcp', id: serverId, startTime: Date.now() });
            }
            try {
                const result = await edgeCallAny('tools/call', { name, arguments: args }, 8000);
                return result;
            } finally {
                if (callKey) {
                    activeToolCalls.delete(callKey);
                }
            }
        } catch (e) {
            if (serverId) {
                activeToolCalls.delete(`mcp:${serverId}`);
            }
            logger.warn('mcp/tool/call failed: %s', (e as Error).message);
            throw e;
        }
    });
    (ctx as any).on('mcp/tool/call/edge', async ({ name, args, serverId }) => {
        try {
            const callKey = serverId ? `mcp:${serverId}` : null;
            if (callKey) {
                activeToolCalls.set(callKey, { type: 'mcp', id: serverId, startTime: Date.now() });
            }
            try {
                const result = await edgeCallAny('tools/call', { name, arguments: args }, 8000);
                return result;
            } finally {
                if (callKey) {
                    activeToolCalls.delete(callKey);
                }
            }
        } catch (e) {
            if (serverId) {
                activeToolCalls.delete(`mcp:${serverId}`);
            }
            logger.warn('mcp/tool/call/edge failed: %s', (e as Error).message);
            throw e;
        }
    });
}

// 生成接入点 Token
export class EdgeGenerateTokenHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        
        const { type } = this.request.body;
        
        if (!type || !['provider', 'node', 'client'].includes(type)) {
            throw new ValidationError('type');
        }

        // 生成 token
        const token = await EdgeTokenModel.generateToken();
        await EdgeTokenModel.add(this.domain._id, type, token);

        this.response.body = { token };
    }
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
    logger.info('edgeCallAny invoke', { method, timeoutMs, clientCount: clients.length });
    const tasks = clients.map((c, idx) => c
        .sendRpc(method, params, timeoutMs)
        .then((res) => ({ ok: true, res, idx }))
        .catch((e) => ({ ok: false, err: e, idx })));
    const results = await Promise.all(tasks);
    for (const r of results) if ((r as any).ok) return (r as any).res;
    logger.warn('edgeCallAny all failed', { method, errors: results.map(r => (r as any).err?.message || String((r as any).err)) });
    throw (results[0] as any).err || new Error('edge rpc failed');
}

// (route registered inside apply)


