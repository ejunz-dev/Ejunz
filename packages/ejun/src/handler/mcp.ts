
import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import McpServerModel, { McpToolModel } from '../model/mcp';
import { PRIV } from '../model/builtin';
import type { McpTool } from '../model/agent';

const logger = new Logger('handler/mcp');

export class McpDomainHandler extends Handler<Context> {
    async get() {
        const servers = await McpServerModel.getByDomain(this.domain._id);
        servers.sort((a, b) => (a.serverId || 0) - (b.serverId || 0));
        
        const wsPath = `/d/${this.domain._id}/mcp/ws`;
        const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
        const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
        const host = this.request.host || this.request.headers.host || 'localhost';
        const wsEndpointBase = `${wsProtocol}://${host}${wsPath}`;
        
        this.response.template = 'mcp_domain.html';
        this.response.body = { 
            servers, 
            domainId: this.domain._id,
            wsEndpointBase,
        };
    }
}

export class McpEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { serverId } = this.request.params;
        
        let server = null;
        if (serverId) {
            const serverIdNum = parseInt(serverId, 10);
            if (!isNaN(serverIdNum) && serverIdNum >= 1) {
                server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
                if (server) {
                    if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
                        throw new PermissionError(PRIV.PRIV_USER_PROFILE);
                    }
                }
            }
        }

        this.response.template = 'mcp_edit.html';
        this.response.body = { server, domainId: this.domain._id };
    }

    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { name, description } = this.request.body;
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const wsToken = await McpServerModel.generateWsToken();
        const server = await McpServerModel.add({
            domainId: this.domain._id,
            name: name.trim(),
            description: description?.trim(),
            owner: this.user._id,
            wsToken,
            status: 'disconnected',
        });

        this.response.redirect = this.url('mcp_detail', { domainId: this.domain._id, serverId: server.serverId });
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { serverId } = this.request.params;
        const serverIdNum = parseInt(serverId, 10);
        
        if (isNaN(serverIdNum) || serverIdNum < 1) {
            throw new ValidationError('serverId');
        }

        const server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
        if (!server) {
            throw new NotFoundError('MCP Server');
        }

        if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const { name, description } = this.request.body;
        const update: any = {};
        if (name !== undefined) update.name = name.trim();
        if (description !== undefined) update.description = description?.trim();

        await McpServerModel.update(this.domain._id, serverIdNum, update);
        this.response.redirect = this.url('mcp_detail', { domainId: this.domain._id, serverId: serverIdNum });
    }
}

export class McpGenerateTokenHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        
        const { serverId } = this.request.body;
        const serverIdNum = parseInt(serverId, 10);
        
        if (isNaN(serverIdNum) || serverIdNum < 1) {
            throw new ValidationError('serverId');
        }

        const server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
        if (!server) {
            throw new NotFoundError('MCP Server');
        }

        if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const wsToken = await McpServerModel.generateWsToken();
        await McpServerModel.update(this.domain._id, serverIdNum, { wsToken });

        this.response.body = { wsToken };
    }
}

export class McpDeleteTokenHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        
        const { serverId } = this.request.body;
        const serverIdNum = parseInt(serverId, 10);
        
        if (isNaN(serverIdNum) || serverIdNum < 1) {
            throw new ValidationError('serverId');
        }

        const server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
        if (!server) {
            throw new NotFoundError('MCP Server');
        }

        if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await McpServerModel.update(this.domain._id, serverIdNum, { wsToken: null });

        this.response.body = { success: true };
    }
}

export class McpDetailHandler extends Handler<Context> {
    async get() {
        const { serverId } = this.request.params;
        const serverIdNum = parseInt(serverId, 10);
        
        if (isNaN(serverIdNum) || serverIdNum < 1) {
            throw new ValidationError('serverId');
        }

        const server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
        if (!server) {
            throw new NotFoundError('MCP Server');
        }

        if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const tools = await McpToolModel.getByServer(this.domain._id, serverIdNum);
        tools.sort((a, b) => (a.toolId || 0) - (b.toolId || 0));

        let wsEndpoint = null;
        if (server.wsToken) {
            const wsPath = `/d/${this.domain._id}/mcp/ws`;
            const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
            const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
            const host = this.request.host || this.request.headers.host || 'localhost';
            wsEndpoint = `${wsProtocol}://${host}${wsPath}?token=${server.wsToken}`;
        }

        this.response.template = 'mcp_detail.html';
        this.response.body = { server, tools, domainId: this.domain._id, wsEndpoint };
    }
}

export class McpDeleteHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { serverId } = this.request.body;
        const serverIdNum = parseInt(serverId, 10);
        
        if (isNaN(serverIdNum) || serverIdNum < 1) {
            throw new ValidationError('serverId');
        }

        const server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
        if (!server) {
            throw new NotFoundError('MCP Server');
        }

        if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await McpServerModel.del(this.domain._id, serverIdNum);
        this.response.redirect = this.url('mcp_domain', { domainId: this.domain._id });
    }
}

export class McpRefreshToolsHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { serverId } = this.request.params;
        const serverIdNum = parseInt(serverId, 10);
        
        if (isNaN(serverIdNum) || serverIdNum < 1) {
            throw new ValidationError('serverId');
        }

        const server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
        if (!server) {
            throw new NotFoundError('MCP Server');
        }

        if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // Step 1: Clean up existing duplicate tools first
        const deletedCount = await McpToolModel.cleanupDuplicates(this.domain._id, serverIdNum);
        let message = '';
        if (deletedCount > 0) {
            message = `已清理 ${deletedCount} 个重复工具。`;
        }

        // Find active WebSocket connection (singleton pattern, reference edge.ts)
        const connection = McpServerConnectionHandler.active.get(serverIdNum);
        if (!connection) {
            if (deletedCount > 0) {
                this.response.body = { 
                    success: true, 
                    message: message + 'MCP服务器未连接，无法获取最新工具列表。' 
                };
            } else {
                this.response.body = { success: false, error: 'MCP服务器未连接' };
            }
            return;
        }

        try {
            const requestId = Date.now();
            connection.send({
                jsonrpc: '2.0',
                method: 'tools/list',
                id: requestId,
                params: {},
            });
        } catch (error: any) {
            logger.error('Failed to send tools/list request: %s', error.message);
            this.response.body = { success: false, error: error.message };
            return;
        }

        logger.info('Manual tools refresh requested: serverId=%d, duplicates removed=%d', 
            serverIdNum, deletedCount);
        this.response.body = { 
            success: true, 
            message: message + '已向 MCP 服务器发送工具列表请求' 
        };
    }
}

// MCP server WebSocket endpoint (for external MCP servers to connect, using token authentication)
// Singleton pattern per serverId, reference edge.ts implementation
export class McpServerConnectionHandler extends ConnectionHandler<Context> {
    static active = new Map<number, McpServerConnectionHandler>();
    private serverId: number | null = null;
    private serverDocId: ObjectId | null = null;
    private subscriptions: Array<{ dispose: () => void }> = [];
    private accepted = false;
    private pendingToolCalls = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
    
    static getConnection(serverId: number): McpServerConnectionHandler | null {
        return McpServerConnectionHandler.active.get(serverId) || null;
    }

    async prepare() {
        const { token } = this.request.query;
        
        if (!token || typeof token !== 'string') {
            this.close(4000, 'Token is required');
            return;
        }

        const servers = await McpServerModel.getByDomain(this.domain._id);
        const server = servers.find(s => s.wsToken === token);
        
        if (!server) {
            logger.warn('MCP Server WebSocket connection rejected: Invalid token');
            this.close(4000, 'Invalid token');
            return;
        }

        // Singleton pattern: reject new connection if one already exists (reference edge.ts)
        if (McpServerConnectionHandler.active.has(server.serverId)) {
            try { 
                this.close(1000, 'MCP server singleton: connection already active'); 
            } catch { 
                /* ignore */ 
            }
            return;
        }

        this.serverId = server.serverId;
        this.serverDocId = server.docId;
        this.accepted = true;

        // Add to active connections (singleton pattern, one connection per serverId)
        McpServerConnectionHandler.active.set(this.serverId, this);

        logger.info('MCP Server WebSocket connected: %s (serverId: %d) from %s', 
            this.serverDocId, this.serverId, this.request.ip);

        await McpServerModel.updateStatus(this.domain._id, this.serverId, 'connected');
        
        // Note: Do not send custom format messages, wait for MCP server to send initialize request
        // MCP protocol requires client (MCP server) to send initialize request first

        const dispose1 = this.ctx.on('mcp/server/status/update' as any, async (...args: any[]) => {
            const [updateServerId] = args;
            if (updateServerId === this.serverId) {
                const updatedServer = await McpServerModel.getByServerId(this.domain._id, this.serverId!);
                if (updatedServer) {
                    this.send({ type: 'status/update', server: updatedServer });
                }
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        (this.ctx.emit as any)('mcp/server/status/update', this.serverId);

        // Wait for MCP server to send initialize request
        // MCP protocol: server (client) should send initialize request first
        logger.debug('Connection established, waiting for MCP server to initialize: serverId=%d', this.serverId);
    }

    async message(msg: any) {
        if (!this.accepted || !this.serverId || !this.serverDocId) return;

        logger.debug('Received message from MCP server: serverId=%d, msg=%j', this.serverId, msg);

        if (typeof msg === 'string') {
            try {
                msg = JSON.parse(msg);
            } catch {
                logger.warn('Failed to parse string message from MCP server: serverId=%d', this.serverId);
                return;
            }
        }

        if (!msg || typeof msg !== 'object') {
            logger.debug('Invalid message format from MCP server: serverId=%d, type=%s', this.serverId, typeof msg);
            return;
        }

        // Handle JSON-RPC format messages (reference edge.ts implementation)
        if (msg && typeof msg === 'object' && msg.jsonrpc === '2.0' && msg.id !== undefined) {
            const rec = this.pendingToolCalls.get(String(msg.id));
            if (rec) {
                this.pendingToolCalls.delete(String(msg.id));
                clearTimeout(rec.timeout);
                logger.debug('Tool call response received: serverId=%d, id=%s, hasError=%s', this.serverId, msg.id, !!msg.error);
                if ('error' in msg && msg.error) {
                    rec.reject(new Error(msg.error.message || 'Tool call failed'));
                } else {
                    rec.resolve(msg.result);
                }
                return;
            } else {
                logger.debug('Received JSON-RPC response with id=%s but no matching pending call: serverId=%d, pendingIds=%j', msg.id, this.serverId, Array.from(this.pendingToolCalls.keys()));
            }
            
            if (msg.error) {
                logger.warn('JSON-RPC error from MCP server: serverId=%d, error=%j', this.serverId, msg.error);
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
                    logger.info('MCP server sent initialize request: serverId=%d', this.serverId);
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
                        if (this.accepted && this.serverId) {
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
                    logger.info('MCP server initialized: serverId=%d', this.serverId);
                    setTimeout(() => {
                        if (this.accepted && this.serverId) {
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
                
                logger.debug('Unknown JSON-RPC method from MCP server: serverId=%d, method=%s', this.serverId, msg.method);
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
                logger.debug('Received tools array directly from MCP server: serverId=%d, count=%d', this.serverId, msg.length);
                await this.handleToolsList(msg);
                return;
            } else if (msg.tools && Array.isArray(msg.tools)) {
                logger.debug('Received tools in tools field from MCP server: serverId=%d, count=%d', this.serverId, msg.tools.length);
                await this.handleToolsList(msg.tools);
                return;
            } else if (msg.data && Array.isArray(msg.data)) {
                logger.debug('Received tools in data field from MCP server: serverId=%d, count=%d', this.serverId, msg.data.length);
                await this.handleToolsList(msg.data);
                return;
            } else if (msg.result) {
                if (Array.isArray(msg.result)) {
                    logger.debug('Received tools in result array from MCP server: serverId=%d, count=%d', this.serverId, msg.result.length);
                    await this.handleToolsList(msg.result);
                    return;
                } else if (msg.result.tools && Array.isArray(msg.result.tools)) {
                    logger.debug('Received tools in result.tools from MCP server: serverId=%d, count=%d', this.serverId, msg.result.tools.length);
                    await this.handleToolsList(msg.result.tools);
                    return;
                }
            } else if (msg.content) {
                if (Array.isArray(msg.content)) {
                    logger.debug('Received tools in content field from MCP server: serverId=%d, count=%d', this.serverId, msg.content.length);
                    await this.handleToolsList(msg.content);
                    return;
                } else if (msg.content.tools && Array.isArray(msg.content.tools)) {
                    logger.debug('Received tools in content.tools from MCP server: serverId=%d, count=%d', this.serverId, msg.content.tools.length);
                    await this.handleToolsList(msg.content.tools);
                    return;
                }
            }
            logger.debug('Received message without recognized tools format from MCP server: serverId=%d, msg=%j', this.serverId, msg);
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
                const { status, errorMessage } = msg;
                if (status === 'connected' || status === 'disconnected' || status === 'error') {
                    await McpServerModel.updateStatus(this.domain._id, this.serverId, status, errorMessage);
                    (this.ctx.emit as any)('mcp/server/status/update', this.serverId);
                }
            } catch (error: any) {
                logger.error('Failed to update status: %s', error.message);
            }
            break;
        default:
            logger.debug('Unknown message type from MCP server: serverId=%d, type=%s', this.serverId, type);
        }
    }

    private async handleToolsList(tools: any[]) {
        if (!this.accepted || !this.serverId || !this.serverDocId) return;
        
        try {
            if (!Array.isArray(tools)) {
                logger.warn('Invalid tools format from MCP server: serverId=%d, tools=%j', this.serverId, tools);
                return;
            }

            const server = await McpServerModel.getByServerId(this.domain._id, this.serverId);
            if (!server) {
                logger.error('Server not found: serverId=%d', this.serverId);
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

            logger.info('Syncing %d tools from MCP server: serverId=%d', validTools.length, this.serverId);
            
            await McpToolModel.syncToolsFromServer(
                this.domain._id,
                this.serverId,
                this.serverDocId,
                validTools,
                server.owner,
            );
            
            this.send({ type: 'tools/synced', count: validTools.length });
            
            (this.ctx.emit as any)('mcp/server/status/update', this.serverId);
            (this.ctx.emit as any)('mcp/tools/update', this.serverId);
            
            logger.info('Tools synced successfully: serverId=%d, count=%d', this.serverId, validTools.length);
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
        
        if (this.serverId && this.accepted) {
            McpServerConnectionHandler.active.delete(this.serverId);
            
            try {
                await McpServerModel.updateStatus(this.domain._id, this.serverId, 'disconnected');
                (this.ctx.emit as any)('mcp/server/status/update', this.serverId);
            } catch (error: any) {
                logger.error('Failed to update server status on disconnect: %s', error.message);
            }
        }
        
        for (const [id, pending] of this.pendingToolCalls.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Connection closed'));
        }
        this.pendingToolCalls.clear();

        if (this.accepted) {
            logger.info('MCP Server WebSocket disconnected: serverId=%d from %s', this.serverId, this.request.ip);
        }
    }

    async callTool(name: string, args: any): Promise<any> {
        if (!this.accepted || !this.serverId) {
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

        logger.debug('Sending tool call request: serverId=%d, tool=%s, id=%s, args=%j', this.serverId, name, requestId, args);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingToolCalls.has(requestId)) {
                    this.pendingToolCalls.delete(requestId);
                    logger.warn('Tool call timeout: serverId=%d, tool=%s, id=%s', this.serverId, name, requestId);
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

export class McpStatusConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    private serverId: number | null = null;
    private subscriptions: Array<{ dispose: () => void }> = [];

    async prepare() {
        const { serverId } = this.request.query;
        const serverIdNum = parseInt(serverId as string, 10);
        
        if (isNaN(serverIdNum) || serverIdNum < 1) {
            logger.debug('MCP Status WebSocket rejected: Invalid serverId=%s', serverId);
            this.close(1000, 'Invalid serverId');
            return;
        }

        const server = await McpServerModel.getByServerId(this.domain._id, serverIdNum);
        if (!server) {
            logger.debug('MCP Status WebSocket rejected: MCP Server not found, serverId=%d', serverIdNum);
            this.close(1000, 'MCP Server not found');
            return;
        }

        if (!this.user || !this.user._id) {
            logger.debug('MCP Status WebSocket rejected: User not authenticated, serverId=%d', serverIdNum);
            this.close(1000, 'Authentication required');
            return;
        }
        
        if (server.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            logger.debug('MCP Status WebSocket rejected: Permission denied, serverId=%d, userId=%d, serverOwner=%d', 
                serverIdNum, this.user._id, server.owner);
            this.close(1000, 'Permission denied');
            return;
        }

        this.serverId = serverIdNum;

        logger.info('MCP Status WebSocket connected: serverId=%d', this.serverId);

        const tools = await McpToolModel.getByServer(this.domain._id, this.serverId);
        this.send({ type: 'init', server, tools });

        const dispose1 = this.ctx.on('mcp/server/status/update' as any, async (...args: any[]) => {
            const [updateServerId] = args;
            if (updateServerId === this.serverId) {
                const updatedServer = await McpServerModel.getByServerId(this.domain._id, this.serverId!);
                if (updatedServer) {
                    this.send({ type: 'server/status', server: updatedServer });
                }
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        const dispose2 = this.ctx.on('mcp/tools/update' as any, async (...args: any[]) => {
            const [updateServerId] = args;
            if (updateServerId === this.serverId) {
                const tools = await McpToolModel.getByServer(this.domain._id, this.serverId!);
                this.send({ type: 'tools/update', tools });
            }
        });
        this.subscriptions.push({ dispose: dispose2 });
    }

    async message(msg: any) {
        if (!this.serverId) return;

        if (msg && typeof msg === 'object') {
            const { type } = msg;
            switch (type) {
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'refresh':
                {
                    const server = await McpServerModel.getByServerId(this.domain._id, this.serverId);
                    const tools = await McpToolModel.getByServer(this.domain._id, this.serverId);
                    if (server) {
                        this.send({ type: 'refresh', server, tools });
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
        if (this.serverId) {
            logger.info('MCP Status WebSocket disconnected: serverId=%d', this.serverId);
        }
    }
}

export async function apply(ctx: Context) {
    ctx.Route('mcp_domain', '/mcp', McpDomainHandler);
    ctx.Route('mcp_create', '/mcp/create', McpEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_edit', '/mcp/:serverId/edit', McpEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_delete', '/mcp/delete', McpDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_detail', '/mcp/:serverId', McpDetailHandler);
    ctx.Route('mcp_generate_token', '/mcp/:serverId/generate-token', McpGenerateTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_delete_token', '/mcp/:serverId/delete-token', McpDeleteTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_refresh_tools', '/mcp/:serverId/refresh-tools', McpRefreshToolsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('mcp_server_conn', '/mcp/ws', McpServerConnectionHandler);
    ctx.Connection('mcp_status_conn', '/mcp/status/ws', McpStatusConnectionHandler);
    ctx.Connection('mcp_status_all_conn', '/mcp/status/ws/all', McpStatusAllConnectionHandler);
}

export class McpStatusAllConnectionHandler extends ConnectionHandler<Context> {
    private subscriptions: Array<{ dispose: () => void }> = [];

    async prepare() {
        const servers = await McpServerModel.getByDomain(this.domain._id);
        
        const serversWithTools: any[] = [];
        for (const server of servers) {
            const tools = await McpToolModel.getByServer(this.domain._id, server.serverId);
            serversWithTools.push({
                serverId: server.serverId,
                name: server.name,
                description: server.description,
                status: server.status || 'disconnected',
                toolsCount: server.toolsCount || 0,
                tools: tools.map(tool => ({
                    _id: tool._id,
                    toolId: tool.toolId,
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                })),
            });
        }
        this.send({ type: 'init', servers: serversWithTools });

        const dispose1 = this.ctx.on('mcp/server/status/update' as any, async (...args: any[]) => {
            const [updateServerId] = args;
            const updatedServer = await McpServerModel.getByServerId(this.domain._id, updateServerId);
            if (updatedServer) {
                const tools = await McpToolModel.getByServer(this.domain._id, updateServerId);
                this.send({ 
                    type: 'server/status', 
                    server: {
                        serverId: updatedServer.serverId,
                        name: updatedServer.name,
                        description: updatedServer.description,
                        status: updatedServer.status || 'disconnected',
                        toolsCount: updatedServer.toolsCount || 0,
                        tools: tools.map(tool => ({
                            _id: tool._id,
                            toolId: tool.toolId,
                            name: tool.name,
                            description: tool.description,
                            inputSchema: tool.inputSchema,
                        })),
                    }
                });
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        const dispose2 = this.ctx.on('mcp/tools/update' as any, async (...args: any[]) => {
            const [updateServerId] = args;
            const server = await McpServerModel.getByServerId(this.domain._id, updateServerId);
            if (server) {
                const tools = await McpToolModel.getByServer(this.domain._id, updateServerId);
                this.send({ 
                    type: 'tools/update', 
                    serverId: updateServerId,
                    tools: tools.map(tool => ({
                        _id: tool._id,
                        toolId: tool.toolId,
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                    }))
                });
            }
        });
        this.subscriptions.push({ dispose: dispose2 });

        logger.info('MCP Status All WebSocket connected: domainId=%s', this.domain._id);
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
                    const servers = await McpServerModel.getByDomain(this.domain._id);
                    const serversWithTools: any[] = [];
                    for (const server of servers) {
                        const tools = await McpToolModel.getByServer(this.domain._id, server.serverId);
                        serversWithTools.push({
                            serverId: server.serverId,
                            name: server.name,
                            description: server.description,
                            status: server.status || 'disconnected',
                            toolsCount: server.toolsCount || 0,
                            tools: tools.map(tool => ({
                                _id: tool._id,
                                toolId: tool.toolId,
                                name: tool.name,
                                description: tool.description,
                                inputSchema: tool.inputSchema,
                            })),
                        });
                    }
                    this.send({ type: 'refresh', servers: serversWithTools });
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
        logger.info('MCP Status All WebSocket disconnected: domainId=%s', this.domain._id);
    }
}

