import { ObjectId } from 'mongodb';
import { ConnectionHandler, Handler, param, Types } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import EdgeModel from '../model/edge';
import ToolModel from '../model/tool';
import { PRIV } from '../model/builtin';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import type { EdgeDoc } from '../interface';

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

// Edge server WebSocket endpoint (for external edge servers to connect, using token authentication)
// 使用 token 作为标识，替代原 serverId
export class EdgeServerConnectionHandler extends ConnectionHandler<Context> {
    static active = new Map<string, EdgeServerConnectionHandler>(); // 使用 token 作为 key
    private token: string | null = null;
    private edgeDocId: ObjectId | null = null;
    private subscriptions: Array<{ dispose: () => void }> = [];
    private accepted = false;
    private pendingToolCalls = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
    
    static getConnection(token: string): EdgeServerConnectionHandler | null {
        return EdgeServerConnectionHandler.active.get(token) || null;
    }

    async prepare() {
        const { token } = this.request.query;
        
        if (!token || typeof token !== 'string') {
            this.close(4000, 'Token is required');
            return;
        }

        // 直接通过 token 查找 Edge
        const edge = await EdgeModel.getByToken(this.domain._id, token);
        
        if (!edge) {
            logger.warn('Edge Server WebSocket connection rejected: Invalid token');
            this.close(4000, 'Invalid token');
            return;
        }

        // Singleton pattern: reject new connection if one already exists
        if (EdgeServerConnectionHandler.active.has(token)) {
            try { 
                this.close(1000, 'Edge server singleton: connection already active'); 
            } catch { 
                /* ignore */ 
            }
            return;
        }

        this.token = token;
        this.edgeDocId = edge.docId;
        this.accepted = true;

        // Add to active connections (singleton pattern, one connection per token)
        EdgeServerConnectionHandler.active.set(token, this);

        logger.info('Edge Server WebSocket connected: %s (token: %s) from %s, totalActiveConnections=%d', 
            this.edgeDocId, token, this.request.ip, EdgeServerConnectionHandler.active.size);

        // 更新edge状态，标记为已使用
        const wasFirstConnection = !edge.tokenUsedAt;
        try {
            await EdgeModel.update(this.domain._id, edge.eid, {
                status: 'online',
                tokenUsedAt: edge.tokenUsedAt || new Date(),
            });
            
            // 如果是首次连接，发送 edge/connected 事件，让前端显示这个 edge
            if (wasFirstConnection) {
                const updatedEdge = await EdgeModel.getByToken(this.domain._id, token);
                if (updatedEdge) {
                    (this.ctx.emit as any)('edge/connected', updatedEdge);
                }
            }
            
            (this.ctx.emit as any)('edge/status/update', token, 'online');
        } catch (error) {
            logger.error('Failed to update edge status: %s', (error as Error).message);
        }

        // 不更新数据库状态，而是通过事件系统实时通知所有监听者
        (this.ctx.emit as any)('mcp/server/connection/update', token, 'connected');
        (this.ctx.emit as any)('mcp/server/status/update', token);

        // Wait for Edge server to send initialize request
        logger.debug('Connection established, waiting for Edge server to initialize: token=%s', token);
    }

    async message(msg: any) {
        if (!this.accepted || !this.token || !this.edgeDocId) return;

        logger.debug('Received message from Edge server: token=%s, msg=%j', this.token, msg);

        if (typeof msg === 'string') {
            try {
                msg = JSON.parse(msg);
            } catch {
                logger.warn('Failed to parse string message from Edge server: token=%s', this.token);
                return;
            }
        }

        if (!msg || typeof msg !== 'object') {
            logger.debug('Invalid message format from Edge server: token=%s, type=%s', this.token, typeof msg);
            return;
        }

        // Handle JSON-RPC format messages (reference edge.ts implementation)
        if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.id !== undefined) {
            const rec = this.pendingToolCalls.get(String(msg.id));
            if (rec) {
                this.pendingToolCalls.delete(String(msg.id));
                clearTimeout(rec.timeout);
                logger.debug('Tool call response received: token=%s, id=%s, hasError=%s', this.token, msg.id, !!msg.error);
                if ('error' in msg && msg.error) {
                    rec.reject(new Error(msg.error.message || 'Tool call failed'));
                } else {
                    rec.resolve(msg.result);
                }
                return;
            } else {
                logger.debug('Received JSON-RPC response with id=%s but no matching pending call: token=%s, pendingIds=%j', msg.id, this.token, Array.from(this.pendingToolCalls.keys()));
            }
            
            if (msg.error) {
                logger.warn('JSON-RPC error from Edge server: token=%s, error=%j', this.token, msg.error);
                if (msg.error.code === -32601 && msg.error.message?.includes('Method not found')) {
                    logger.debug('Method not found, MCP server may use different protocol');
                }
                return;
            }
            
            if (msg.method) {
                const requestId = msg.id;
                const reply = (result: any) => {
                    this.send({ jsonrpc: '2.0', id: requestId, result });
                };
                
                if (msg.method === 'initialize') {
                    // MCP protocol: handle initialization request
                    logger.info('Edge server sent initialize request: token=%s', this.token);
                    reply({
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: {},
                        },
                        serverInfo: {
                            name: 'ejunz-mcp-receiver',
                            version: '1.0.0',
                        },
                    });
                    setTimeout(() => {
                        if (this.accepted && this.token) {
                            const requestId = Date.now();
                            this.send({
                                jsonrpc: '2.0',
                                method: 'tools/list',
                                id: requestId,
                                params: {},
                            });
                        }
                    }, 100);
                    return;
                }
                
                if (msg.method === 'notifications/initialized') {
                    // MCP protocol: client initialization complete notification
                    logger.info('Edge server initialized: token=%s', this.token);
                    setTimeout(() => {
                        if (this.accepted && this.token) {
                            const requestId = Date.now();
                            this.send({
                                jsonrpc: '2.0',
                                method: 'tools/list',
                                id: requestId,
                                params: {},
                            });
                        }
                    }, 100);
                    return;
                }
                
                logger.debug('Unknown JSON-RPC method from Edge server: token=%s, method=%s', this.token, msg.method);
                if (msg.id !== undefined && msg.id !== null) {
                    this.send({
                        jsonrpc: '2.0',
                        id: msg.id,
                        error: { code: -32601, message: 'Method not found' },
                    });
                }
                return;
            }
            
            if (msg.result !== undefined) {
                if (msg.result && typeof msg.result === 'object') {
                    if (msg.result.tools && Array.isArray(msg.result.tools)) {
                        await this.handleToolsList(msg.result.tools);
                        return;
                    } else if (Array.isArray(msg.result)) {
                        await this.handleToolsList(msg.result);
                        return;
                    }
                }
            }
        }

        const { type } = msg;

        if (!type) {
            if (Array.isArray(msg)) {
                logger.debug('Received tools array directly from Edge server: token=%s, count=%d', this.token, msg.length);
                await this.handleToolsList(msg);
                return;
            } else if (msg.tools && Array.isArray(msg.tools)) {
                logger.debug('Received tools in tools field from Edge server: token=%s, count=%d', this.token, msg.tools.length);
                await this.handleToolsList(msg.tools);
                return;
            } else if (msg.data && Array.isArray(msg.data)) {
                logger.debug('Received tools in data field from Edge server: token=%s, count=%d', this.token, msg.data.length);
                await this.handleToolsList(msg.data);
                return;
            } else if (msg.result) {
                if (Array.isArray(msg.result)) {
                    logger.debug('Received tools in result array from Edge server: token=%s, count=%d', this.token, msg.result.length);
                    await this.handleToolsList(msg.result);
                    return;
                } else if (msg.result.tools && Array.isArray(msg.result.tools)) {
                    logger.debug('Received tools in result.tools from Edge server: token=%s, count=%d', this.token, msg.result.tools.length);
                    await this.handleToolsList(msg.result.tools);
                    return;
                }
            } else if (msg.content) {
                if (Array.isArray(msg.content)) {
                    logger.debug('Received tools in content field from Edge server: token=%s, count=%d', this.token, msg.content.length);
                    await this.handleToolsList(msg.content);
                    return;
                } else if (msg.content.tools && Array.isArray(msg.content.tools)) {
                    logger.debug('Received tools in content.tools from Edge server: token=%s, count=%d', this.token, msg.content.tools.length);
                    await this.handleToolsList(msg.content.tools);
                    return;
                }
            }
            logger.debug('Received message without recognized tools format from Edge server: token=%s, msg=%j', this.token, msg);
            return;
        }

        switch (type) {
        case 'ping':
            this.send({ type: 'pong' });
            break;
        case 'tools/list':
        case 'tools/list/response':
            await this.handleToolsList(msg.tools || msg.data || []);
            break;
        case 'status':
            try {
                // 不再更新数据库状态，状态由 WebSocket 连接本身管理
                // 如果 MCP 服务器发送了状态更新消息，可以通过事件系统通知前端
                const { status, errorMessage } = msg;
                if (status === 'connected' || status === 'disconnected' || status === 'error') {
                    // 只通过事件系统通知，不更新数据库
                    (this.ctx.emit as any)('mcp/server/connection/update', this.token, status);
                }
            } catch (error: any) {
                logger.error('Failed to update status: %s', error.message);
            }
            break;
        default:
            logger.debug('Unknown message type from Edge server: token=%s, type=%s', this.token, type);
        }
    }

    private async handleToolsList(tools: any[]) {
        if (!this.accepted || !this.token || !this.edgeDocId) return;
        
        try {
            if (!Array.isArray(tools)) {
                logger.warn('Invalid tools format from Edge server: token=%s, tools=%j', this.token, tools);
                return;
            }

            const edge = await EdgeModel.getByToken(this.domain._id, this.token);
            if (!edge) {
                logger.error('Edge not found: token=%s', this.token);
                return;
            }

            const validTools = tools.filter(tool => {
                if (!tool || typeof tool !== 'object') return false;
                if (!tool.name || typeof tool.name !== 'string') return false;
                return true;
            }).map(tool => ({
                name: tool.name,
                description: tool.description || '',
                inputSchema: tool.inputSchema || tool.input_schema || null,
            }));

            logger.info('Syncing %d tools from Edge server: token=%s', validTools.length, this.token);
            
            await ToolModel.syncToolsFromEdge(
                this.domain._id,
                this.token,
                this.edgeDocId,
                validTools,
                edge.owner,
            );
            
            this.send({ type: 'tools/synced', count: validTools.length });
            
            (this.ctx.emit as any)('mcp/server/status/update', this.token);
            (this.ctx.emit as any)('mcp/tools/update', this.token);
            
            logger.info('Tools synced successfully: token=%s, count=%d', this.token, validTools.length);
        } catch (error: any) {
            logger.error('Failed to sync tools: %s', error.message);
            this.send({ type: 'error', message: error.message });
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
        
        if (this.token && this.accepted) {
            const wasRemoved = EdgeServerConnectionHandler.active.delete(this.token);
            logger.info('Edge Server WebSocket cleanup: token=%s, wasRemoved=%s, remainingConnections=%d', 
                this.token, wasRemoved, EdgeServerConnectionHandler.active.size);
            
            // 更新edge状态为离线
            try {
                const edge = await EdgeModel.getByToken(this.domain._id, this.token);
                if (edge) {
                    await EdgeModel.update(this.domain._id, edge.eid, { status: 'offline' });
                    (this.ctx.emit as any)('edge/status/update', this.token, 'offline');
                }
            } catch (error) {
                logger.error('Failed to update edge status: %s', (error as Error).message);
            }
            
            // 不更新数据库状态，而是通过事件系统实时通知所有监听者
            (this.ctx.emit as any)('mcp/server/connection/update', this.token, 'disconnected');
        }
        
        for (const [id, pending] of this.pendingToolCalls.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Connection closed'));
        }
        this.pendingToolCalls.clear();

        if (this.accepted) {
            logger.info('Edge Server WebSocket disconnected: token=%s from %s', this.token, this.request.ip);
        }
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.accepted || !this.token) {
            throw new Error('Connection not ready');
        }

        // Use string ID (reference edge.ts implementation)
        const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const request = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'tools/call',
            params: {
                name,
                arguments: args,
            },
        };

        logger.debug('Sending tool call request: token=%s, tool=%s, id=%s, args=%j', this.token, name, requestId, args);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingToolCalls.has(requestId)) {
                    this.pendingToolCalls.delete(requestId);
                    logger.warn('Tool call timeout: token=%s, tool=%s, id=%s', this.token, name, requestId);
                    reject(new Error(`Tool call timeout: ${name}`));
                }
            }, 10000);

            this.pendingToolCalls.set(requestId, { resolve, reject, timeout });
            try {
                // send() automatically serializes to JSON, pass object directly
                // Do not use JSON.stringify, as send() will serialize again, causing double serialization
                this.send(request);
            } catch (e) {
                clearTimeout(timeout);
                this.pendingToolCalls.delete(requestId);
                reject(e);
            }
        });
    }
}

// Edge页面相关handler
export class EdgeDomainHandler extends Handler<Context> {
    async get() {
        const allEdges = await EdgeModel.getByDomain(this.domain._id);
        
        // 只显示已连接的 edge（有 tokenUsedAt 的）
        const connectedEdges = allEdges.filter(edge => edge.tokenUsedAt);
        
        // 计算实时状态：检查是否有Edge服务器在使用这个token
        const edgesWithStatus = await Promise.all(connectedEdges.map(async (edge) => {
            // 检查是否有Edge服务器在使用这个token
            const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
            
            let status: 'online' | 'offline' | 'working' = edge.status;
            if (isConnected) {
                // 检查是否有工具（工作中）
                const tools = await ToolModel.getByToken(this.domain._id, edge.token);
                status = tools.length > 0 ? 'working' : 'online';
            } else {
                status = 'offline';
            }
            
            return {
                ...edge,
                status,
            };
        }));
        
        edgesWithStatus.sort((a, b) => (a.eid || 0) - (b.eid || 0));
        
        const wsPath = `/d/${this.domain._id}/edge/status/ws`;
        const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
        const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
        const host = this.request.host || this.request.headers.host || 'localhost';
        const wsEndpointBase = `${wsProtocol}://${host}${wsPath}`;
        
        this.response.template = 'edge_main.html';
        this.response.body = { 
            edges: edgesWithStatus, 
            domainId: this.domain._id,
            wsEndpointBase,
        };
    }
}

export class EdgeDetailHandler extends Handler<Context> {
    edge: EdgeDoc;

    async get() {
        const { eid } = this.request.params;
        
        // 如果 eid 包含点号（如 .css.map）或不是纯数字，说明是静态资源或其他路由，不应该匹配这个路由
        if (eid && (eid.includes('.') || !/^\d+$/.test(eid))) {
            // 返回 404，让静态资源处理器或其他路由处理
            throw new NotFoundError(eid);
        }
        
        const eidNum = parseInt(eid, 10);
        if (isNaN(eidNum) || eidNum < 1) {
            throw new ValidationError('eid');
        }
        
        const edge = await EdgeModel.getByEdgeId(this.domain._id, eidNum);
        if (!edge || edge.domainId !== this.domain._id) {
            throw new ValidationError('Edge not found');
        }
        this.edge = edge;
        const tools = await ToolModel.getByEdgeDocId(this.domain._id, this.edge._id);
        const isConnected = EdgeServerConnectionHandler.active.has(this.edge.token);
        
        let status: 'online' | 'offline' | 'working' = this.edge.status;
        if (isConnected) {
            status = tools.length > 0 ? 'working' : 'online';
        } else {
            status = 'offline';
        }

        this.response.template = 'edge_detail.html';
        this.response.body = {
            edge: {
                ...this.edge,
                status,
            },
            tools: tools.map(tool => ({
                ...tool,
                edgeToken: this.edge.token,
                edgeName: this.edge.name || `Edge-${this.edge.eid}`,
                edgeStatus: status,
            })),
            domainId: this.domain._id,
        };
    }
}

export class EdgeGenerateTokenHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        
        const edge = await EdgeModel.add({
            domainId: this.domain._id,
            type: 'provider',
            owner: this.user._id,
        });
        
        const wsPath = `/d/${this.domain._id}/mcp/ws`;
        const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
        const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
        const host = this.request.host || this.request.headers.host || 'localhost';
        const wsEndpoint = `${wsProtocol}://${host}${wsPath}?token=${edge.token}`;
        
        this.response.body = { 
            success: true, 
            token: edge.token,
            wsEndpoint,
        };
        
    }
}

export class EdgeStatusConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    private subscriptions: Array<{ dispose: () => void }> = [];
    private queue = new Map<string, () => Promise<any>>();

    async prepare() {
        const allEdges = await EdgeModel.getByDomain(this.domain._id);
        
        // 只显示已连接的 edge（有 tokenUsedAt 的）
        const connectedEdges = allEdges.filter(edge => edge.tokenUsedAt);
        
        // 计算实时状态
        const edgesWithStatus = await Promise.all(connectedEdges.map(async (edge) => {
            const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
            
            let status: 'online' | 'offline' | 'working' = edge.status;
            if (isConnected) {
                const tools = await ToolModel.getByToken(this.domain._id, edge.token);
                status = tools.length > 0 ? 'working' : 'online';
            } else {
                status = 'offline';
            }
            
            return {
                ...edge,
                status,
            };
        }));
        
        // 发送初始化的 HTML 行
        for (const edge of edgesWithStatus) {
            this.queueSend(edge._id.toString(), async () => ({
                html: await this.renderHTML('edge_main_tr.html', { edge }),
            }));
        }

        // 监听edge状态更新事件
        const dispose1 = this.ctx.on('edge/status/update' as any, async (...args: any[]) => {
            const [token, status] = args;
            const edge = await EdgeModel.getByToken(this.domain._id, token);
            if (edge && edge.tokenUsedAt) { // 只处理已连接的 edge
                // 更新edge状态
                await EdgeModel.updateStatus(this.domain._id, edge.eid, status);
                
                // 重新计算状态
                const isConnected = EdgeServerConnectionHandler.active.has(token);
                
                let finalStatus: 'online' | 'offline' | 'working' = status;
                if (isConnected) {
                    const tools = await ToolModel.getByToken(this.domain._id, token);
                    finalStatus = tools.length > 0 ? 'working' : 'online';
                } else {
                    finalStatus = 'offline';
                }
                
                const edgeWithStatus = {
                    ...edge,
                    status: finalStatus,
                };
                
                this.queueSend(edge._id.toString(), async () => ({
                    html: await this.renderHTML('edge_main_tr.html', { edge: edgeWithStatus }),
                }));
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        // 监听edge连接事件（首次连接时触发）
        const dispose2 = this.ctx.on('edge/connected' as any, async (...args: any[]) => {
            const [edge] = args;
            // 重新计算状态
            const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
            const tools = await ToolModel.getByToken(this.domain._id, edge.token);
            const status = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
            
            const edgeWithStatus = {
                ...edge,
                status,
            };
            
            this.queueSend(edge._id.toString(), async () => ({
                html: await this.renderHTML('edge_main_tr.html', { edge: edgeWithStatus }),
            }));
        });
        this.subscriptions.push({ dispose: dispose2 });

        // 监听MCP工具更新事件
        const dispose3 = this.ctx.on('mcp/tools/update' as any, async (...args: any[]) => {
            const [token] = args;
            const edge = await EdgeModel.getByToken(this.domain._id, token);
            if (edge && edge.tokenUsedAt) { // 只处理已连接的 edge
                const tools = await ToolModel.getByToken(this.domain._id, token);
                const isConnected = EdgeServerConnectionHandler.active.has(token);
                const status = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
                
                await EdgeModel.updateStatus(this.domain._id, edge.eid, status);
                
                const edgeWithStatus = {
                    ...edge,
                    status,
                };
                
                this.queueSend(edge._id.toString(), async () => ({
                    html: await this.renderHTML('edge_main_tr.html', { edge: edgeWithStatus }),
                }));
            }
        });
        this.subscriptions.push({ dispose: dispose3 });
    }

    queueSend(edgeId: string, fn: () => Promise<any>) {
        this.queue.set(edgeId, fn);
        if (this.queue.size === 1) {
            setTimeout(() => this.flushQueue(), 50);
        }
    }

    async flushQueue() {
        if (this.queue.size === 0) return;
        const queue = Array.from(this.queue.entries());
        this.queue.clear();
        for (const [, fn] of queue) {
            try {
                const data = await fn();
                this.send(data);
            } catch (e) {
                logger.error('Failed to send edge update: %s', (e as Error).message);
            }
        }
        if (this.queue.size > 0) {
            setTimeout(() => this.flushQueue(), 50);
        }
    }

    async message(msg: any) {
        if (msg && typeof msg === 'object') {
            const { type } = msg;
            switch (type) {
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'refresh':
                {
                    const allEdges = await EdgeModel.getByDomain(this.domain._id);
                    const connectedEdges = allEdges.filter(edge => edge.tokenUsedAt);
                    const edgesWithStatus = await Promise.all(connectedEdges.map(async (edge) => {
                        const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
                        
                        let status: 'online' | 'offline' | 'working' = edge.status;
                        if (isConnected) {
                            const tools = await ToolModel.getByToken(this.domain._id, edge.token);
                            status = tools.length > 0 ? 'working' : 'online';
                        } else {
                            status = 'offline';
                        }
                        
                        return {
                            ...edge,
                            status,
                        };
                    }));

                    for (const edge of edgesWithStatus) {
                        this.queueSend(edge._id.toString(), async () => ({
                            html: await this.renderHTML('edge_main_tr.html', { edge }),
                        }));
                    }
                }
                break;
            default:
                logger.debug('Unknown message type: %s', type);
            }
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
        logger.debug('Edge Status WebSocket disconnected: domainId=%s', this.domain._id);
    }
}

export async function apply(ctx: Context) {
    ctx.Route('edge_alive', '/edge', EdgeAliveHandler);
    ctx.Connection('edge_conn', '/edge/conn', EdgeConnectionHandler);
    ctx.Route('edge_rpc', '/edge/rpc', EdgeRpcHandler as any);
    ctx.Route('edge_domain', '/edge/list', EdgeDomainHandler);
    ctx.Route('edge_generate_token', '/edge/generate-token', EdgeGenerateTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('edge_detail', '/edge/:eid', EdgeDetailHandler);
    ctx.Connection('edge_status_conn', '/edge/status/ws', EdgeStatusConnectionHandler);
    ctx.Connection('edge_server_conn', '/mcp/ws', EdgeServerConnectionHandler);

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
    (ctx as any).on('mcp/tool/call', async ({ name, args }) => {
        try {
            return await edgeCallAny('tools/call', { name, arguments: args }, 8000);
        } catch (e) {
            logger.warn('mcp/tool/call failed: %s', (e as Error).message);
            throw e;
        }
    });
    (ctx as any).on('mcp/tool/call/edge', async ({ name, args }) => {
        try {
            return await edgeCallAny('tools/call', { name, arguments: args }, 8000);
        } catch (e) {
            logger.warn('mcp/tool/call/edge failed: %s', (e as Error).message);
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


