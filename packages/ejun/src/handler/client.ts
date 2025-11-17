
import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import ClientModel from '../model/client';
import ClientChatModel, { apply as applyClientChat } from '../model/client_chat';
import EdgeModel from '../model/edge';
import EdgeTokenModel from '../model/edge_token';
import { EdgeServerConnectionHandler } from './edge';
import AgentModel, { McpClient } from '../model/agent';
import { processAgentChatInternal } from './agent';
import domain from '../model/domain';
import * as document from '../model/document';
import { PRIV } from '../model/builtin';
import WebSocket from 'ws';
import request from 'superagent';
import Agent from '../model/agent';

const logger = new Logger('handler/client');

// Get assigned tools (consistent with getAssignedTools in agent.ts)
// Enhanced to also fetch from real-time MCP connections to ensure all tools are available
// If mcpToolIds is empty, returns all available tools from database (since tools are synced from MCP servers to DB)
async function getAssignedTools(domainId: string, mcpToolIds?: ObjectId[]): Promise<any[]> {
    // If no mcpToolIds specified, get all available tools from database
    // Tools are synced from MCP servers to database, so we can get them from DB
    if (!mcpToolIds || mcpToolIds.length === 0) {
        logger.info('getAssignedTools: No mcpToolIds specified, fetching all available tools from database');
        try {
            // First try to get from database (tools are synced from MCP servers)
            const { default: McpServerModel, McpToolModel } = await import('../model/mcp');
            const servers = await McpServerModel.getByDomain(domainId);
            const allTools: any[] = [];
            for (const server of servers) {
                const tools = await McpToolModel.getByServer(domainId, server.serverId);
                for (const tool of tools) {
                    allTools.push({
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                    });
                }
            }
            logger.info('getAssignedTools: Got all tools from database', { 
                toolCount: allTools.length, 
                toolNames: allTools.map(t => t.name),
                serverCount: servers.length
            });
            
            // Also try to get from real-time connections to merge any new tools
            try {
                const mcpClient = new McpClient();
                const realtimeTools = await mcpClient.getTools();
                if (realtimeTools.length > 0) {
                    logger.info('getAssignedTools: Also found realtime tools', { 
                        realtimeCount: realtimeTools.length 
                    });
                    // Merge realtime tools with database tools (realtime takes priority)
                    const toolMap = new Map<string, any>();
                    // First add database tools
                    for (const tool of allTools) {
                        toolMap.set(tool.name, tool);
                    }
                    // Then add/override with realtime tools
                    for (const tool of realtimeTools) {
                        toolMap.set(tool.name, {
                            name: tool.name,
                            description: tool.description || '',
                            inputSchema: tool.inputSchema || null,
                        });
                    }
                    return Array.from(toolMap.values());
                }
            } catch (realtimeError: any) {
                logger.debug('Failed to fetch realtime tools (non-critical): %s', realtimeError.message);
            }
            
            return allTools;
        } catch (dbError: any) {
            logger.warn('Failed to fetch all tools from database: %s', dbError.message);
            // Last resort: try realtime connections
            try {
                const mcpClient = new McpClient();
                const realtimeTools = await mcpClient.getTools();
                logger.info('getAssignedTools: Got tools from realtime (fallback)', { 
                    toolCount: realtimeTools.length 
                });
                return realtimeTools.map(tool => ({
                    name: tool.name,
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || null,
                }));
            } catch (realtimeError: any) {
                logger.warn('Failed to fetch tools from realtime (fallback): %s', realtimeError.message);
        return [];
            }
        }
    }
    
    // First, get tools from database and build a map by tool name
    const dbToolsMap = new Map<string, any>();
    const assignedToolNames = new Set<string>();
    
    for (const toolId of mcpToolIds) {
        try {
            const tool = await document.get(domainId, document.TYPE_MCP_TOOL, toolId);
            if (tool) {
                dbToolsMap.set(tool.name, {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                });
                assignedToolNames.add(tool.name);
            }
        } catch (error) {
            logger.warn('Invalid tool ID: %s', toolId.toString());
        }
    }
    
    // Also fetch from real-time MCP connections to get tools that might not be in DB yet
    // or to get more up-to-date tool definitions
    try {
        const mcpClient = new McpClient();
        const realtimeTools = await mcpClient.getTools();
        
        // Merge realtime tools with database tools
        // Priority: realtime tools (more up-to-date) > database tools
        const finalTools: any[] = [];
        const processedNames = new Set<string>();
        
        // First, add realtime tools that match assigned tool names
        for (const realtimeTool of realtimeTools) {
            if (assignedToolNames.has(realtimeTool.name)) {
                finalTools.push({
                    name: realtimeTool.name,
                    description: realtimeTool.description || '',
                    inputSchema: realtimeTool.inputSchema || null,
                });
                processedNames.add(realtimeTool.name);
            }
        }
        
        // Then, add database tools that weren't found in realtime (fallback)
        for (const [toolName, dbTool] of dbToolsMap) {
            if (!processedNames.has(toolName)) {
                finalTools.push(dbTool);
            }
        }
        
        logger.info('getAssignedTools: dbTools=%d, realtimeTools=%d, matchedTools=%d, finalTools=%d', 
            dbToolsMap.size, realtimeTools.length, processedNames.size, finalTools.length);
        
        return finalTools;
    } catch (error: any) {
        logger.warn('Failed to fetch realtime tools, using DB tools only: %s', error.message);
        // Fallback to database tools only
        return Array.from(dbToolsMap.values());
    }
}

const logBuffer: Map<number, Array<{ time: string; level: string; message: string; clientId: number }>> = new Map();
const MAX_LOG_BUFFER = 1000;
const logConnections: Map<number, Set<any>> = new Map();

export function addClientLog(clientId: number, level: string, message: string) {
    if (!logBuffer.has(clientId)) {
        logBuffer.set(clientId, []);
    }
    const logs = logBuffer.get(clientId)!;
    const time = new Date().toISOString();
    const logEntry = { time, level, message, clientId };
    logs.push(logEntry);
    
    if (logs.length > MAX_LOG_BUFFER) {
        logs.shift();
    }
    
    broadcastClientLog(clientId, logEntry);
}

function broadcastClientLog(clientId: number, logData: any) {
    const connections = logConnections.get(clientId);
    if (!connections) return;
    
    const message = JSON.stringify({ type: 'log', data: logData });
    connections.forEach(ws => {
        try {
            if (ws.readyState === 1) {
                ws.send(message);
            }
        } catch (e) {
            // ignore
        }
    });
}

export class ClientDomainHandler extends Handler<Context> {
    async get() {
        const clients = await ClientModel.getByDomain(this.domain._id);
        clients.sort((a, b) => (a.clientId || 0) - (b.clientId || 0));
        
        // Update actual connection status for each client
        const clientsWithActualStatus = clients.map(client => {
            const isActuallyConnected = ClientConnectionHandler.active.has(client.clientId);
            const actualStatus = isActuallyConnected ? 'connected' : 'disconnected';
            return { ...client, status: actualStatus };
        });
        
        const wsPath = `/d/${this.domain._id}/client/ws`;
        const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
        const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
        const host = this.request.host || this.request.headers.host || 'localhost';
        const wsEndpointBase = `${wsProtocol}://${host}${wsPath}`;
        
        this.response.template = 'client_domain.html';
        this.response.body = { 
            clients: clientsWithActualStatus, 
            domainId: this.domain._id,
            wsEndpointBase,
        };
    }
}

export class ClientEditHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { clientId } = this.request.params;
        
        let client = null;
        if (clientId) {
            const clientIdNum = parseInt(clientId, 10);
            if (!isNaN(clientIdNum) && clientIdNum >= 1) {
                client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
                if (client) {
                    if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
                        throw new PermissionError(PRIV.PRIV_USER_PROFILE);
                    }
                }
            }
        }

        // Get all agents in domain for selection
        const agents = await AgentModel.getMulti(this.domain._id, {}).toArray();

        this.response.template = 'client_edit.html';
        this.response.body = { client, domainId: this.domain._id, agents };
    }

    async postCreate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { name, description } = this.request.body;
        if (!name || typeof name !== 'string') {
            throw new ValidationError('name');
        }

        const wsToken = await ClientModel.generateWsToken();
        const client = await ClientModel.add({
            domainId: this.domain._id,
            name: name.trim(),
            description: description?.trim(),
            owner: this.user._id,
            wsToken,
            status: 'disconnected',
        });

        this.response.redirect = this.url('client_detail', { domainId: this.domain._id, clientId: client.clientId });
    }

    async postUpdate() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { clientId } = this.request.params;
        const clientIdNum = parseInt(clientId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const { name, description } = this.request.body;
        const update: any = {};
        if (name !== undefined) update.name = name.trim();
        if (description !== undefined) update.description = description?.trim();

        await ClientModel.update(this.domain._id, clientIdNum, update);
        this.response.redirect = this.url('client_detail', { domainId: this.domain._id, clientId: clientIdNum });
    }
}

// Token 生成逻辑已迁移到 edge 模块

export class ClientDeleteTokenHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        
        const { clientId } = this.request.body;
        const clientIdNum = parseInt(clientId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await ClientModel.update(this.domain._id, clientIdNum, { wsToken: null });

        this.response.body = { success: true };
    }
}

export class ClientDetailHandler extends Handler<Context> {
    async get() {
        const { clientId } = this.request.params;
        const clientIdNum = parseInt(clientId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // Check actual connection status (based on WebSocket connection)
        const isActuallyConnected = ClientConnectionHandler.active.has(clientIdNum);
        const actualStatus = isActuallyConnected ? 'connected' : 'disconnected';
        const clientWithActualStatus = { ...client, status: actualStatus };

        let wsEndpoint = null;
        if (client.wsToken) {
            const wsPath = `/d/${this.domain._id}/client/ws`;
            const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
            const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
            const host = this.request.host || this.request.headers.host || 'localhost';
            wsEndpoint = `${wsProtocol}://${host}${wsPath}?token=${client.wsToken}`;
        }

        // Get all agents in domain for selection
        const agents = await AgentModel.getMulti(this.domain._id, {}).toArray();

        // Get agent info if configured
        let agentInfo = null;
        if (client.settings?.agent?.agentId) {
            const selectedAgents = agents.filter(a => a.aid === client.settings.agent.agentId);
            if (selectedAgents.length > 0) {
                agentInfo = selectedAgents[0];
            }
        }

        this.response.template = 'client_detail.html';
        this.response.body = { client: clientWithActualStatus, domainId: this.domain._id, wsEndpoint, agentInfo, agents };
    }
}

export class ClientDeleteHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { clientId } = this.request.body;
        const clientIdNum = parseInt(clientId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        await ClientModel.del(this.domain._id, clientIdNum);
        this.response.redirect = this.url('client_domain', { domainId: this.domain._id });
    }
}

export class ClientChatListHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { clientId } = this.request.params;
        const clientIdNum = parseInt(clientId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const chats = await ClientChatModel.getByClientId(this.domain._id, clientIdNum);
        
        this.response.template = 'client_chat_list.html';
        this.response.body = {
            client,
            chats: chats.map(chat => ({
                conversationId: chat.conversationId,
                messageCount: chat.messageCount,
                createdAt: chat.createdAt,
                updatedAt: chat.updatedAt,
            })),
            domainId: this.domain._id,
            all_chats: chats.map(chat => ({
                conversationId: chat.conversationId,
                messageCount: chat.messageCount,
                createdAt: chat.createdAt,
                updatedAt: chat.updatedAt,
            })),
        };
    }
}

export class ClientChatDetailHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { clientId, conversationId } = this.request.params;
        const clientIdNum = parseInt(clientId, 10);
        const conversationIdNum = parseInt(conversationId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }
        if (isNaN(conversationIdNum) || conversationIdNum < 1) {
            throw new ValidationError('conversationId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const chat = await ClientChatModel.getByConversationId(this.domain._id, clientIdNum, conversationIdNum);
        if (!chat) {
            throw new NotFoundError('Chat');
        }

        // Get all chats for sidebar
        const allChats = await ClientChatModel.getByClientId(this.domain._id, clientIdNum);

        this.response.template = 'client_chat_detail.html';
        this.response.body = {
            client,
            chat,
            domainId: this.domain._id,
            all_chats: allChats.map(c => ({
                conversationId: c.conversationId,
                messageCount: c.messageCount,
                createdAt: c.createdAt,
                updatedAt: c.updatedAt,
            })),
        };
    }
}

export class ClientChatDeleteHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { clientId, conversationId } = this.request.body;
        const clientIdNum = parseInt(clientId, 10);
        const conversationIdNum = parseInt(conversationId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }
        if (isNaN(conversationIdNum) || conversationIdNum < 1) {
            throw new ValidationError('conversationId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        // Get chat to delete audio files
        const chat = await ClientChatModel.getByConversationId(this.domain._id, clientIdNum, conversationIdNum);
        if (chat) {
            // Delete audio files
            for (const msg of chat.messages) {
                if (msg.asrAudioPath) {
                    try {
                        await this.ctx.storage.del(msg.asrAudioPath);
                    } catch (error: any) {
                        logger.warn('Failed to delete ASR audio: %s', error.message);
                    }
                }
                if (msg.ttsAudioPath) {
                    try {
                        await this.ctx.storage.del(msg.ttsAudioPath);
                    } catch (error: any) {
                        logger.warn('Failed to delete TTS audio: %s', error.message);
                    }
                }
            }
        }

        await ClientChatModel.delete(this.domain._id, clientIdNum, conversationIdNum);
        this.response.body = { success: true };
    }
}

export class ClientChatAudioDownloadHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { clientId, conversationId, messageIndex, audioType } = this.request.params;
        const clientIdNum = parseInt(clientId, 10);
        const conversationIdNum = parseInt(conversationId, 10);
        const msgIndex = parseInt(messageIndex, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }
        if (isNaN(conversationIdNum) || conversationIdNum < 1) {
            throw new ValidationError('conversationId');
        }
        if (isNaN(msgIndex) || msgIndex < 0) {
            throw new ValidationError('messageIndex');
        }
        if (audioType !== 'asr' && audioType !== 'tts') {
            throw new ValidationError('audioType');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const chat = await ClientChatModel.getByConversationId(this.domain._id, clientIdNum, conversationIdNum);
        if (!chat) {
            throw new NotFoundError('Chat');
        }

        if (msgIndex >= chat.messages.length) {
            throw new NotFoundError('Message');
        }

        const message = chat.messages[msgIndex];
        const audioPath = audioType === 'asr' ? message.asrAudioPath : message.ttsAudioPath;
        
        if (!audioPath) {
            throw new NotFoundError('Audio file not found');
        }

        try {
            const audioStream = await this.ctx.storage.get(audioPath);
            if (!audioStream) {
                throw new NotFoundError('Audio file');
            }

            // Set response headers
            this.response.type = 'audio/pcm'; // PCM16 format
            this.response.disposition = `attachment; filename="${audioType}_${conversationIdNum}_${msgIndex}.pcm"`;
            
            // Pipe audio stream to response
            this.response.body = audioStream;
        } catch (error: any) {
            logger.error('Failed to download audio: %s', error.message);
            throw new NotFoundError('Audio file');
        }
    }
}

export class ClientUpdateSettingsHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = null;
        
        const { clientId } = this.request.params;
        const clientIdNum = parseInt(clientId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const { asr, tts, agent } = this.request.body;
        const settingsUpdate: any = {};

        if (asr !== undefined) {
            settingsUpdate.asr = asr;
        }
        if (tts !== undefined) {
            settingsUpdate.tts = tts;
        }
        if (agent !== undefined) {
            // If agentId provided, validate and get agentDocId
            if (agent.agentId) {
                const agents = await AgentModel.getMulti(this.domain._id, { aid: agent.agentId }).toArray();
                if (agents.length === 0) {
                    throw new NotFoundError('Agent');
                }
                settingsUpdate.agent = {
                    agentId: agent.agentId,
                    agentDocId: agents[0].docId,
                };
            } else {
                settingsUpdate.agent = undefined;
            }
        }

        await ClientModel.updateSettings(this.domain._id, clientIdNum, settingsUpdate);

        this.response.body = { success: true };
    }
}

// Client WebSocket endpoint (for external clients to connect, using token authentication)
type ClientSubscription = {
    event: string;
    dispose: () => void;
};

export class ClientConnectionHandler extends ConnectionHandler<Context> {
    static active = new Map<number, ClientConnectionHandler>();
    private clientId: number | null = null;
    private clientDocId: ObjectId | null = null;
    private token: string | null = null; // 保存 token，用于 cleanup 时从 EdgeServerConnectionHandler 删除
    private subscriptions: Array<{ dispose: () => void }> = [];
    private eventSubscriptions: ClientSubscription[] = [];
    private accepted = false;
    private asrWs: WebSocket | null = null;
    private asrTaskId: string | null = null;
    private asrInitResolved: boolean = false;
    private asrInitPromise: { resolve: () => void; reject: (error: Error) => void } | null = null;
    private ttsWs: WebSocket | null = null;
    private ttsInitResolved: boolean = false;
    private ttsInitPromise: { resolve: () => void; reject: (error: Error) => void } | null = null;
    private ttsTextBuffer: string = '';
    private ttsPendingText: string = '';
    private pendingCommits: number = 0;
    private client: any = null;
    private currentAsrAudioBuffers: Buffer[] = [];
    private currentTtsAudioBuffers: Buffer[] = [];
    private currentConversationId: number | null = null;
    // Promise resolver for waiting TTS playback completion before tool calls
    private ttsPlaybackWaitPromise: { resolve: () => void; reject: (error: Error) => void } | null = null;
    
    static getConnection(clientId: number): ClientConnectionHandler | null {
        return ClientConnectionHandler.active.get(clientId) || null;
    }

    async prepare() {
        const { token } = this.request.query;
        
        if (!token || typeof token !== 'string') {
            this.close(4000, 'Token is required');
            return;
        }

        // 使用统一的 token 验证
        const tokenDoc = await EdgeTokenModel.getByToken(token);
        if (!tokenDoc || tokenDoc.type !== 'client' || tokenDoc.domainId !== this.domain._id) {
            logger.warn('Client WebSocket connection rejected: Invalid token');
            this.close(4000, 'Invalid token');
            return;
        }

        // 更新 token 最后使用时间
        await EdgeTokenModel.updateLastUsed(token);

        // 查找或创建 Edge
        let edge = await EdgeModel.getByToken(this.domain._id, token);
        if (!edge) {
            // Edge 不存在，创建 Edge（使用 tokenDoc 中的 token）
            // 如果没有用户认证，使用默认 owner（1）或从 domain 获取
            const owner = this.user?._id || 1;
            edge = await EdgeModel.add({
                domainId: this.domain._id,
                type: tokenDoc.type as 'provider' | 'client' | 'node',
                owner: owner,
                token: tokenDoc.token,
            });
            logger.info('Created edge on client connection: eid=%d, token=%s, type=%s, owner=%d', edge.eid, token, tokenDoc.type, owner);
        }
        
        // 更新 edge 状态
        const wasFirstConnection = !edge.tokenUsedAt;
        try {
            await EdgeModel.update(this.domain._id, edge.eid, {
                status: 'online',
                tokenUsedAt: edge.tokenUsedAt || new Date(),
            });
            
            // 如果是首次连接，发送 edge/connected 事件
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

        // 查找或创建关联的 client
        let client: any = null;
        if (edge.clientId) {
            // Edge 已有关联的 client，使用它
            client = await ClientModel.getByClientId(this.domain._id, edge.clientId);
            if (client) {
                logger.info('Client already exists, using existing client: clientId=%d, edgeId=%d', client.clientId, edge.eid);
            }
        }
        
        if (!client) {
            // 自动创建 client 并建立双向关联
            client = await ClientModel.add({
                domainId: this.domain._id,
                name: `Client-${edge.eid}`,
                owner: edge.owner,
                edgeId: edge.eid,
            });
            await EdgeModel.update(this.domain._id, edge.eid, { clientId: client.clientId });
            logger.info('Auto-created client for edge on connection: clientId=%d, edgeId=%d', client.clientId, edge.eid);
            
            // 发送 client/connected 事件，让前端显示这个 client
            (this.ctx.emit as any)('client/connected', client);
        }
        
        if (!client) {
            logger.warn('Client WebSocket connection rejected: Failed to create client');
            this.close(4000, 'Failed to create client');
            return;
        }

        // Singleton pattern: reject new connection if one already exists
        if (ClientConnectionHandler.active.has(client.clientId)) {
            try { 
                this.close(1000, 'Client singleton: connection already active'); 
            } catch { 
                /* ignore */ 
            }
            return;
        }

        this.clientId = client.clientId;
        this.clientDocId = client.docId;
        this.token = token; // 保存 token
        this.client = client;
        this.accepted = true;

        // Add to active connections (singleton pattern, one connection per clientId)
        ClientConnectionHandler.active.set(this.clientId, this);
        
        // 同时注册到 EdgeServerConnectionHandler，以便状态检查统一（和 node/provider 一样）
        // 注意：这里使用 token 作为 key，和 EdgeServerConnectionHandler 保持一致
        EdgeServerConnectionHandler.active.set(token, this as any);

        logger.info('Client WebSocket connected: %s (clientId: %d, token: %s) from %s', 
            this.clientDocId, this.clientId, token, this.request.ip);

        addClientLog(this.clientId, 'info', `Client connected: ${this.request.ip}`);

        await ClientModel.updateStatus(this.domain._id, this.clientId, 'connected');
        
        // Send initial config to client via status/update event
        this.send({ 
            event: 'status/update', 
            payload: [{ client: this.client }] 
        });
        
        const dispose1 = this.ctx.on('client/status/update' as any, async (...args: any[]) => {
            const [updateClientId] = args;
            if (updateClientId === this.clientId) {
                const updatedClient = await ClientModel.getByClientId(this.domain._id, this.clientId!);
                if (updatedClient) {
                    this.send({ 
                        event: 'status/update', 
                        payload: [{ client: updatedClient }] 
                    });
                }
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        (this.ctx.emit as any)('client/status/update', this.clientId);
    }

    async message(msg: any) {
        if (!this.accepted || !this.clientId || !this.clientDocId) return;

        if (typeof msg === 'string') {
            try {
                msg = JSON.parse(msg);
            } catch {
                logger.warn('Failed to parse string message from client: clientId=%d', this.clientId);
                return;
            }
        }

        if (!msg || typeof msg !== 'object') {
            return;
        }

        // Support Cordis event system: publish and subscribe
        const key = msg.key;
        if (key === 'publish') {
            // Client publishes event to server
            const { event, payload } = msg;
            if (typeof event === 'string') {
                try {
                    const payloadArray = Array.isArray(payload) ? payload : (payload !== undefined ? [payload] : []);
                    
                    // Handle TTS playback completion event from client
                    if (event === 'tts/playback_completed') {
                        logger.info('TTS playback completed: clientId=%d', this.clientId);
                        if (this.ttsPlaybackWaitPromise) {
                            this.ttsPlaybackWaitPromise.resolve();
                            this.ttsPlaybackWaitPromise = null;
                        }
                        return;
                    }
                    
                    if (event === 'client/asr/audio') {
                        logger.debug('Received ASR audio event: clientId=%d, payload length=%d', this.clientId, payloadArray.length);
                        if (payloadArray.length > 0 && payloadArray[0]?.audio) {
                            const audioLength = typeof payloadArray[0].audio === 'string' ? payloadArray[0].audio.length : 0;
                            logger.debug('ASR audio data length: %d chars', audioLength);
                        }
                    }
                    
                    const args = [event, this.clientId, payloadArray];
                    (this.ctx.parallel as any).apply(this.ctx, args);
                } catch (e) {
                    logger.warn('publish failed: %s', (e as Error).message);
                    addClientLog(this.clientId, 'error', `Event publish failed: ${(e as Error).message}`);
                }
            }
            return;
        }

        if (key === 'subscribe') {
            // Client subscribes to server events
            const { event } = msg;
            if (typeof event === 'string') {
                const handler = (...args: any[]) => {
                    try {
                        this.send({ event, payload: args });
                    } catch (e) {
                        // ignore
                    }
                };
                const dispose = this.ctx.on(event as any, handler as any);
                this.eventSubscriptions.push({ event, dispose });
                this.send({ ok: 1, event });
                addClientLog(this.clientId, 'debug', `Subscribed to event: ${event}`);
            }
            return;
        }

        if (key === 'unsubscribe') {
            // Client unsubscribes
            const { event } = msg;
            if (typeof event === 'string') {
                const rest: ClientSubscription[] = [];
                for (const sub of this.eventSubscriptions) {
                    if (sub.event === event) {
                        try {
                            sub.dispose?.();
                        } catch {
                            // ignore
                        }
                    } else {
                        rest.push(sub);
                    }
                }
                this.eventSubscriptions = rest;
                this.send({ ok: 1, event });
                addClientLog(this.clientId, 'debug', `Unsubscribed from event: ${event}`);
            }
            return;
        }

        // Compatible with legacy message format (type field)
        const type = msg.type || msg.key;

        if (!type) {
            return;
        }

        switch (type) {
        case 'ping':
            this.send({ type: 'pong' });
            addClientLog(this.clientId, 'debug', 'Received ping message');
            break;
        case 'status':
            try {
                const { status, errorMessage } = msg;
                if (status === 'connected' || status === 'disconnected' || status === 'error') {
                    await ClientModel.updateStatus(this.domain._id, this.clientId, status, errorMessage);
                    (this.ctx.emit as any)('client/status/update', this.clientId);
                }
            } catch (error: any) {
                logger.error('Failed to update status: %s', error.message);
            }
            break;
        default:
            // Other message types handled via event system (backward compatible)
            if (type && type !== 'ping' && type !== 'status') {
                try {
                    if (type === 'asr/audio' && msg.audio) {
                        const args = [`client/${type}`, this.clientId, [{ audio: msg.audio }]];
                        (this.ctx.parallel as any).apply(this.ctx, args);
                    } else {
                        const args = [`client/${type}`, this.clientId, msg];
                        (this.ctx.parallel as any).apply(this.ctx, args);
                    }
                } catch (e) {
                    logger.warn('Failed to publish legacy message as event: %s', (e as Error).message);
                }
            }
            break;
        }
    }

    // Initialize ASR WebSocket connection (lazy initialization, auto-init on first audio)
    private async ensureAsrConnection(): Promise<void> {
        if (this.asrWs && this.asrWs.readyState === 1) {
            return;
        }

        if (this.asrWs && this.asrWs.readyState === 0) {
            logger.debug('ASR WebSocket connecting, waiting...: clientId=%d', this.clientId);
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('ASR WebSocket connection timeout'));
                }, 5000);
                
                const checkInterval = setInterval(() => {
                    if (this.asrWs && this.asrWs.readyState === 1) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        resolve();
                    } else if (this.asrWs && this.asrWs.readyState === 3) { // 3 = CLOSED
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        reject(new Error('ASR WebSocket connection closed'));
                    }
                }, 100);
            });
        }

        if (!this.client || !this.client.settings?.asr) {
            logger.error('ASR config not found: clientId=%d', this.clientId);
            this.sendEvent('asr/error', [{ message: 'ASR config not set' }]);
            return;
        }

        const asrConfig = this.client.settings.asr;
        logger.info('ASR config loaded: clientId=%d, provider=%s, model=%s, baseUrl=%s, apiKey length=%d', 
            this.clientId, asrConfig.provider, asrConfig.model, asrConfig.baseUrl, asrConfig.apiKey?.length || 0);
            addClientLog(this.clientId, 'info', `ASR config: provider=${asrConfig.provider}, model=${asrConfig.model}`);

        if (asrConfig.provider !== 'qwen-realtime') {
            logger.error('Unsupported ASR provider: clientId=%d, provider=%s', this.clientId, asrConfig.provider);
            this.sendEvent('asr/error', [{ message: `Unsupported ASR provider: ${asrConfig.provider}` }]);
            return;
        }

        if (!asrConfig.apiKey) {
            logger.error('ASR API Key not found: clientId=%d', this.clientId);
            this.sendEvent('asr/error', [{ message: 'ASR API Key not set' }]);
            return;
        }

        try {
            const baseUrl = asrConfig.baseUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
            const model = asrConfig.model || 'qwen3-asr-flash-realtime';
            const apiKey = asrConfig.apiKey;
            
            const apiKeyMasked = apiKey.length > 8 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '***';
            const wsUrl = `${baseUrl}?model=${encodeURIComponent(model)}&api_key=${encodeURIComponent(apiKey)}`;
            const wsUrlForLog = `${baseUrl}?model=${encodeURIComponent(model)}&api_key=${apiKeyMasked}`;
            
            logger.info('Connecting to ASR service: clientId=%d, url=%s', this.clientId, wsUrlForLog);
            addClientLog(this.clientId, 'info', `Connecting to ASR service: ${baseUrl}, model=${model}, apiKey=${apiKeyMasked}`);
            
            this.asrWs = new WebSocket(wsUrl);
            return new Promise<void>((resolve, reject) => {
                const connectionTimeout = setTimeout(() => {
                    logger.error('ASR WebSocket connection timeout: clientId=%d', this.clientId);
                    addClientLog(this.clientId, 'error', 'ASR WebSocket connection timeout');
                    reject(new Error('ASR WebSocket connection timeout'));
                }, 10000);

                this.asrWs!.on('open', () => {
                    if (!this.asrWs) {
                        logger.error('ASR WebSocket is null in open handler: clientId=%d', this.clientId);
                        return;
                    }
                    logger.info('ASR WebSocket connected successfully: clientId=%d, readyState=%d', 
                        this.clientId, this.asrWs.readyState);
                    addClientLog(this.clientId, 'info', `ASR WebSocket connected, readyState=${this.asrWs.readyState}`);
                    
                    this.asrTaskId = `task-${this.clientId}-${Date.now()}`;
                    const initMessage = {
                        type: 'session.update',
                        session: {
                            input_audio_format: 'pcm',
                            input_audio_transcription: {
                                model: asrConfig.model || 'qwen3-asr-flash-realtime',
                            },
                            turn_detection: {
                                type: asrConfig.enableServerVad ? 'server_vad' : 'none',
                                threshold: 0.2,
                                silence_duration_ms: 800,
                            },
                        },
                    };
                    logger.info('Sending ASR init message: clientId=%d, task_id=%s, message=%o', 
                        this.clientId, this.asrTaskId, initMessage);
                    addClientLog(this.clientId, 'info', `Sending ASR init message: task_id=${this.asrTaskId}`);
                    
                    try {
                        if (!this.asrWs) {
                            logger.error('ASR WebSocket is null when sending init message: clientId=%d', this.clientId);
                            clearTimeout(connectionTimeout);
                            reject(new Error('ASR WebSocket is null'));
                            return;
                        }
                        
                        this.asrWs.send(JSON.stringify(initMessage));
                        logger.info('ASR init message sent successfully: clientId=%d', this.clientId);
                        
                        this.asrInitPromise = { resolve, reject };
                        setTimeout(() => {
                            if (!this.asrInitResolved && this.asrInitPromise) {
                                logger.warn('ASR init response timeout, continuing anyway: clientId=%d', this.clientId);
                                addClientLog(this.clientId, 'warn', 'ASR init response timeout, continuing');
                                this.asrInitResolved = true;
                                this.asrInitPromise = null;
                                clearTimeout(connectionTimeout);
                                resolve();
                            }
                        }, 5000);
                    } catch (error: any) {
                        logger.error('Failed to send ASR init message: %s', error.message);
                        addClientLog(this.clientId, 'error', `Failed to send ASR init message: ${error.message}`);
                        clearTimeout(connectionTimeout);
                        reject(error);
                        return;
                    }
                });

                this.asrWs!.on('error', (error: Error) => {
                    clearTimeout(connectionTimeout);
                    logger.error('ASR WebSocket connection error: %s', error.message);
                    addClientLog(this.clientId, 'error', `ASR WebSocket connection error: ${error.message}`);
                    reject(error);
                });

                this.asrWs!.on('close', (code: number, reason: Buffer) => {
                    logger.warn('ASR WebSocket closed: clientId=%d, code=%d, reason=%s', 
                        this.clientId, code, reason.toString());
                    addClientLog(this.clientId, 'warn', `ASR WebSocket closed: code=${code}, reason=${reason.toString()}`);
                    this.asrWs = null;
                    this.asrTaskId = null;
                    this.asrInitResolved = false;
                    if (this.asrInitPromise) {
                        this.asrInitPromise.reject(new Error(`ASR WebSocket closed: ${reason.toString()}`));
                        this.asrInitPromise = null;
                    }
                });

                        this.asrWs!.on('message', (data: Buffer) => {
                        try {
                            const rawData = data.toString();
                            logger.info('ASR raw message received: clientId=%d, length=%d bytes', 
                                this.clientId, rawData.length);
                            logger.debug('ASR raw message preview: clientId=%d, preview=%s', 
                                this.clientId, rawData.substring(0, 500));
                            
                            const message = JSON.parse(rawData);
                            
                            logger.info('ASR message parsed: clientId=%d, type=%s, event_id=%s', 
                                this.clientId, 
                                message.type || 'unknown',
                                message.event_id || 'none');
                            addClientLog(this.clientId, 'info', 
                                `Received ASR message: type=${message.type || 'unknown'}, event_id=${message.event_id || 'none'}`);
                    if (!this.asrInitResolved && this.asrInitPromise) {
                        if (message.type === 'session.created') {
                            logger.info('ASR init confirmed by server: clientId=%d, session_id=%s', 
                                this.clientId, message.session?.id || 'unknown');
                                addClientLog(this.clientId, 'info', `ASR init confirmed: session_id=${message.session?.id || 'unknown'}`);
                            this.asrInitResolved = true;
                            if (this.asrInitPromise) {
                                this.asrInitPromise.resolve();
                                this.asrInitPromise = null;
                            }
                        } else if (message.type === 'error') {
                                const errorMsg = message.error?.message || 'ASR init failed';
                                logger.error('ASR init failed: clientId=%d, error=%s', this.clientId, errorMsg);
                                addClientLog(this.clientId, 'error', `ASR init failed: ${errorMsg}`);
                            this.asrInitResolved = true;
                            if (this.asrInitPromise) {
                                this.asrInitPromise.reject(new Error(errorMsg));
                                this.asrInitPromise = null;
                            }
                            return;
                        }
                    }
                    
                            if (message.type === 'conversation.item.input_audio_transcription.text') {
                        const text = message.stash || message.text || '';
                        if (text) {
                                    addClientLog(this.clientId, 'info', `ASR intermediate result: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
                            this.sendEvent('asr/result', [{ text, isFinal: false }]);
                        }
                            } else if (message.type === 'conversation.item.input_audio_transcription.completed') {
                        const text = message.transcript || '';
                        if (text) {
                                    addClientLog(this.clientId, 'info', `ASR final result: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
                                    this.sendEvent('asr/result', [{ text, isFinal: true }]);
                                    
                                    (async () => {
                                        try {
                                            const latestClient = await ClientModel.getByClientId(this.domain._id, this.clientId!);
                                            if (latestClient) {
                                                this.client = latestClient;
                                            }
                                        } catch (error: any) {
                                            logger.warn('Failed to refresh client config: %s', error.message);
                                        }
                                        
                                        const agentId = this.client?.settings?.agent?.agentId;
                                        logger.info('ASR completion check: clientId=%d, agentId=%s, text=%s', 
                                            this.clientId, agentId || 'not configured', text ? 'has text' : 'no text');
                                        addClientLog(this.clientId, 'info', `Checking Agent config: agentId=${agentId || 'not configured'}, text=${text ? 'has text' : 'no text'}`);
                                        
                                        if (text && agentId) {
                                            logger.info('ASR completion: triggering Agent chat: clientId=%d, agentId=%s, text=%s', 
                                                this.clientId, agentId, text.substring(0, 50));
                                            addClientLog(this.clientId, 'info', `ASR final result, auto-triggering Agent chat: ${text.substring(0, 50)}...`);
                                            
                                            try {
                                                logger.info('ASR completion: calling handleAgentChat directly: clientId=%d', this.clientId);
                                                await this.handleAgentChat({ message: text, history: [] });
                                                logger.info('ASR completion: handleAgentChat completed: clientId=%d', this.clientId);
                                            } catch (error: any) {
                                                logger.error('Auto trigger agent chat failed: %s, stack=%s', error.message, error.stack);
                                                addClientLog(this.clientId, 'error', `Auto-trigger Agent chat failed: ${error.message}`);
                                            }
                                        } else {
                                            if (!text) {
                                                logger.warn('ASR completion: text is empty, skipping Agent trigger: clientId=%d', this.clientId);
                                                addClientLog(this.clientId, 'warn', 'ASR final result but text is empty, skipping Agent trigger');
                                            } else if (!agentId) {
                                                logger.warn('ASR completion: Agent not configured, skipping Agent trigger: clientId=%d', this.clientId);
                                                addClientLog(this.clientId, 'warn', 'ASR final result but Agent not configured, skipping Agent trigger');
                                            }
                                        }
                                    })().catch((error: any) => {
                                        logger.error('Failed to process ASR completion: %s', error.message);
                                        addClientLog(this.clientId, 'error', `Failed to process ASR completion: ${error.message}`);
                                    });
                        }
                            } else if (message.type === 'conversation.item.input_audio_transcription.failed') {
                                const errorMsg = message.error?.message || 'ASR transcription failed';
                                addClientLog(this.clientId, 'error', `ASR transcription failed: ${errorMsg}`);
                        this.sendEvent('asr/error', [{ message: errorMsg }]);
                            } else if (message.type === 'error') {
                                const errorMsg = message.error?.message || 'ASR task failed';
                                addClientLog(this.clientId, 'error', `ASR error: ${errorMsg}`);
                        this.sendEvent('asr/error', [{ message: errorMsg }]);
                            } else if (message.type === 'conversation.item.input_audio_transcription.started') {
                                addClientLog(this.clientId, 'debug', 'ASR sentence started');
                                this.sendEvent('asr/sentence_begin', []);
                            } else if (message.type === 'conversation.item.input_audio_transcription.completed') {
                                addClientLog(this.clientId, 'debug', 'ASR sentence ended');
                                this.sendEvent('asr/sentence_end', []);
                            } else {
                                logger.info('ASR unknown message type: clientId=%d, type=%s', 
                                    this.clientId, message.type);
                            }
                } catch (error: any) {
                    logger.error('Failed to parse ASR message: %s, raw data: %s', error.message, data.toString().substring(0, 200));
                        addClientLog(this.clientId, 'error', `ASR message parse error: ${error.message}`);
                }
                });
            });
        } catch (error: any) {
            logger.error('Failed to start ASR: %s', error.message);
            this.sendEvent('asr/error', [{ message: error.message }]);
        }
    }

    // Send event (unified format)
    private sendEvent(event: string, payload: any[]) {
        try {
            const message = { event, payload };
            logger.debug('sendEvent: clientId=%d, event=%s, payload length=%d', 
                this.clientId, event, payload.length);
            this.send(message);
        } catch (error: any) {
            logger.error('sendEvent failed: clientId=%d, event=%s, error=%s', 
                this.clientId, event, error.message);
            addClientLog(this.clientId, 'error', `Failed to send event: ${event}, ${error.message}`);
        }
    }

    async handleAsrAudio(payload: any[]) {
        if (!payload || payload.length === 0) {
            logger.warn('No payload in ASR audio event: clientId=%d, payload=%o', this.clientId, payload);
            addClientLog(this.clientId, 'warn', 'ASR audio event: payload is empty');
            return;
        }

        const audioDataObj = payload[0];
        if (!audioDataObj) {
            logger.warn('No audio data object in payload: clientId=%d, payload=%o', this.clientId, payload);
            addClientLog(this.clientId, 'warn', 'ASR audio event: payload[0] is empty');
            return;
        }

        if (!audioDataObj.audio) {
            logger.warn('No audio field in payload object: clientId=%d, audioDataObj=%o', this.clientId, audioDataObj);
            addClientLog(this.clientId, 'warn', 'ASR audio event: audio field missing');
            return;
        }

        // Ensure ASR connection is established
        try {
            await this.ensureAsrConnection();
        } catch (error: any) {
            logger.error('Failed to ensure ASR connection: %s', error.message);
            this.sendEvent('asr/error', [{ message: `ASR connection failed: ${error.message}` }]);
            return;
        }

        if (!this.asrWs || this.asrWs.readyState !== 1) { // 1 = OPEN
            logger.warn('ASR WebSocket not connected after ensure: clientId=%d, readyState=%d', 
                this.clientId, this.asrWs?.readyState || -1);
            this.sendEvent('asr/error', [{ message: 'ASR WebSocket not connected' }]);
            return;
        }

        if (!this.asrTaskId) {
            logger.warn('ASR task not initialized: clientId=%d', this.clientId);
            this.sendEvent('asr/error', [{ message: 'ASR task not initialized, please retry later' }]);
            return;
        }

            try {
                const audioBase64 = audioDataObj.audio;
                if (typeof audioBase64 !== 'string') {
                    logger.warn('Audio data must be base64 string: clientId=%d', this.clientId);
                    return;
                }

                const audioData = Buffer.from(audioBase64, 'base64');
                
                // Collect ASR audio for saving to chat history
                this.currentAsrAudioBuffers.push(audioData);
                
                logger.debug('Processing ASR audio: clientId=%d, audioData length=%d bytes', this.clientId, audioData.length);
                addClientLog(this.clientId, 'debug', `Processing ASR audio data: ${audioData.length} bytes`);

                if (!this.asrTaskId) {
                    logger.warn('ASR task not initialized: clientId=%d', this.clientId);
                    this.sendEvent('asr/error', [{ message: 'ASR task not initialized' }]);
                    return;
                }
                
                const audioMessage = {
                    type: 'input_audio_buffer.append',
                    audio: audioBase64,
                };
                
                logger.debug('Sending audio to ASR: clientId=%d, audio length=%d bytes (base64: %d chars)', 
                    this.clientId, audioData.length, audioBase64.length);
                this.asrWs.send(JSON.stringify(audioMessage));
            } catch (error: any) {
                logger.error('Failed to send audio to ASR: %s', error.message);
                addClientLog(this.clientId, 'error', `Failed to send audio to ASR: ${error.message}`);
            this.sendEvent('asr/error', [{ message: error.message }]);
        }
    }

    async handleAsrCommit(payload: any[]) {
        if (!this.asrWs || this.asrWs.readyState !== 1) {
            logger.warn('ASR WebSocket not connected for commit: clientId=%d', this.clientId);
            return;
        }

        try {
            const commitMessage = {
                type: 'input_audio_buffer.commit',
            };
            this.asrWs.send(JSON.stringify(commitMessage));
            addClientLog(this.clientId, 'debug', 'ASR audio buffer committed');
        } catch (error: any) {
            logger.error('Failed to commit audio buffer: %s', error.message);
                addClientLog(this.clientId, 'error', `ASR commit error: ${error.message}`);
        }
    }

    async handleAsrRecordingStarted(payload: any[]) {
        addClientLog(this.clientId, 'info', 'Recording started');
        await this.ensureAsrConnection();
    }

    async handleAsrRecordingCompleted(payload: any[]) {
        addClientLog(this.clientId, 'info', 'Recording completed, forcing audio buffer commit');
        await this.handleAsrCommit([]);
    }


    async handleTtsStart(msg: any) {
        if (!this.client || !this.client.settings?.tts) {
            this.sendEvent('tts/error', [{ message: 'TTS config not set' }]);
            return;
        }

        const ttsConfig = this.client.settings.tts;
        if (ttsConfig.provider !== 'qwen') {
            this.sendEvent('tts/error', [{ message: `Unsupported TTS provider: ${ttsConfig.provider}` }]);
            return;
        }

        try {
            this.sendEvent('tts/started', []);
        } catch (error: any) {
            logger.error('Failed to start TTS: %s', error.message);
            this.sendEvent('tts/error', [{ message: error.message }]);
        }
    }

    // Initialize TTS WebSocket connection for realtime models
    private async ensureTtsConnection(): Promise<void> {
        if (this.ttsWs && this.ttsWs.readyState === 1) {
            return;
        }

        if (this.ttsWs && this.ttsWs.readyState === 0) {
            logger.debug('TTS WebSocket connecting, waiting...: clientId=%d', this.clientId);
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    logger.error('TTS WebSocket connection timeout: clientId=%d', this.clientId);
                    addClientLog(this.clientId, 'error', 'TTS WebSocket connection timeout');
                    reject(new Error('TTS WebSocket connection timeout'));
                }, 5000);
                
                const checkInterval = setInterval(() => {
                    if (this.ttsWs && this.ttsWs.readyState === 1) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        resolve();
                    } else if (this.ttsWs && this.ttsWs.readyState === 3) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        reject(new Error('TTS WebSocket connection closed'));
                    }
                }, 100);
            });
        }

        if (!this.client || !this.client.settings?.tts) {
            logger.error('TTS config not found: clientId=%d', this.clientId);
            this.sendEvent('tts/error', [{ message: 'TTS config not set' }]);
            return;
        }

        const ttsConfig = this.client.settings.tts;
        if (ttsConfig.provider !== 'qwen') {
            logger.error('Unsupported TTS provider: clientId=%d, provider=%s', this.clientId, ttsConfig.provider);
            this.sendEvent('tts/error', [{ message: `Unsupported TTS provider: ${ttsConfig.provider}` }]);
            return;
        }

        if (!ttsConfig.apiKey) {
            logger.error('TTS API Key not found: clientId=%d', this.clientId);
            this.sendEvent('tts/error', [{ message: 'TTS API Key not set' }]);
            return;
        }

        try {
            const model = ttsConfig.model || 'qwen3-tts-flash-realtime';
            const apiKey = ttsConfig.apiKey;
            const baseUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
            const apiKeyMasked = apiKey.length > 8 ? `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}` : '***';
            const wsUrl = `${baseUrl}?model=${encodeURIComponent(model)}&api_key=${encodeURIComponent(apiKey)}`;
            const wsUrlForLog = `${baseUrl}?model=${encodeURIComponent(model)}&api_key=${apiKeyMasked}`;
            
            logger.info('Connecting to TTS service: clientId=%d, url=%s', this.clientId, wsUrlForLog);
            addClientLog(this.clientId, 'info', `Connecting to TTS service: ${baseUrl}, model=${model}, apiKey=${apiKeyMasked}`);
            
            this.ttsWs = new WebSocket(wsUrl);

            return new Promise<void>((resolve, reject) => {
                const connectionTimeout = setTimeout(() => {
                    logger.error('TTS WebSocket connection timeout: clientId=%d', this.clientId);
                    addClientLog(this.clientId, 'error', 'TTS WebSocket connection timeout');
                    reject(new Error('TTS WebSocket connection timeout'));
                }, 10000);

                this.ttsWs!.on('open', () => {
                    if (!this.ttsWs) {
                        logger.error('TTS WebSocket is null in open handler: clientId=%d', this.clientId);
                        return;
                    }
                    logger.info('TTS WebSocket connected successfully: clientId=%d, readyState=%d', 
                        this.clientId, this.ttsWs.readyState);
                    addClientLog(this.clientId, 'info', `TTS WebSocket connected, readyState=${this.ttsWs.readyState}`);
                    
                    const initMessage = {
                        type: 'session.update',
                        session: {
                            modalities: ['audio'],
                            output_audio_format: 'pcm16',
                            sample_rate: 24000,
                            voice: ttsConfig.voice || 'Cherry',
                        },
                    };
                    logger.info('Sending TTS init message: clientId=%d, message=%o', this.clientId, initMessage);
                    addClientLog(this.clientId, 'info', 'Sending TTS init message');
                    
                    try {
                        if (!this.ttsWs) {
                            logger.error('TTS WebSocket is null when sending init message: clientId=%d', this.clientId);
                            clearTimeout(connectionTimeout);
                            reject(new Error('TTS WebSocket is null'));
                            return;
                        }
                        
                        this.ttsWs.send(JSON.stringify(initMessage));
                        logger.info('TTS init message sent successfully: clientId=%d', this.clientId);
                        
                        this.ttsInitPromise = { resolve, reject };
                        setTimeout(() => {
                            if (!this.ttsInitResolved && this.ttsInitPromise) {
                                logger.warn('TTS init response timeout, continuing anyway: clientId=%d', this.clientId);
                                addClientLog(this.clientId, 'warn', 'TTS init response timeout, continuing');
                                this.ttsInitResolved = true;
                                this.ttsInitPromise = null;
                                clearTimeout(connectionTimeout);
                                resolve();
                            }
                        }, 5000);
                    } catch (error: any) {
                        logger.error('Failed to send TTS init message: %s', error.message);
                        addClientLog(this.clientId, 'error', `Failed to send TTS init message: ${error.message}`);
                        clearTimeout(connectionTimeout);
                        reject(error);
                        return;
                    }
                });

                this.ttsWs!.on('error', (error: Error) => {
                    clearTimeout(connectionTimeout);
                    logger.error('TTS WebSocket connection error: %s', error.message);
                    addClientLog(this.clientId, 'error', `TTS WebSocket connection error: ${error.message}`);
                    reject(error);
                });

                this.ttsWs!.on('close', (code: number, reason: Buffer) => {
                    logger.warn('TTS WebSocket closed: clientId=%d, code=%d, reason=%s', 
                        this.clientId, code, reason.toString());
                    addClientLog(this.clientId, 'warn', `TTS WebSocket closed: code=${code}, reason=${reason.toString()}`);
                    this.ttsWs = null;
                    this.ttsInitResolved = false;
                    if (this.ttsInitPromise) {
                        this.ttsInitPromise.reject(new Error(`TTS WebSocket closed: ${reason.toString()}`));
                        this.ttsInitPromise = null;
                    }
                });

                this.ttsWs!.on('message', (data: Buffer) => {
                    try {
                        const rawData = data.toString();
                        logger.debug('TTS raw message received: clientId=%d, length=%d bytes', 
                            this.clientId, rawData.length);
                        
                        const message = JSON.parse(rawData);
                        
                        logger.debug('TTS message parsed: clientId=%d, type=%s', 
                            this.clientId, message.type || 'unknown');
                        
                        if (!this.ttsInitResolved && this.ttsInitPromise) {
                            if (message.type === 'session.created') {
                                logger.info('TTS init confirmed by server: clientId=%d, session_id=%s', 
                                    this.clientId, message.session?.id || 'unknown');
                                addClientLog(this.clientId, 'info', `TTS init confirmed: session_id=${message.session?.id || 'unknown'}`);
                                this.ttsInitResolved = true;
                                if (this.ttsInitPromise) {
                                    this.ttsInitPromise.resolve();
                                    this.ttsInitPromise = null;
                                }
                            } else if (message.type === 'error') {
                                const errorMsg = message.error?.message || 'TTS init failed';
                                logger.error('TTS init failed: clientId=%d, error=%s', this.clientId, errorMsg);
                                addClientLog(this.clientId, 'error', `TTS init failed: ${errorMsg}`);
                                this.ttsInitResolved = true;
                                if (this.ttsInitPromise) {
                                    this.ttsInitPromise.reject(new Error(errorMsg));
                                    this.ttsInitPromise = null;
                                }
                                return;
                            }
                        }
                        
                        if (message.type === 'response.audio.delta') {
                            if (message.delta) {
                                // Collect TTS audio for saving to chat history
                                // TTS audio is base64 encoded PCM16 data
                                try {
                                    const audioBuffer = Buffer.from(message.delta, 'base64');
                                    this.currentTtsAudioBuffers.push(audioBuffer);
                                } catch (e) {
                                    logger.warn('Failed to decode TTS audio delta: %s', (e as Error).message);
                                }
                                
                                addClientLog(this.clientId, 'debug', `Received TTS audio chunk: ${message.delta.length} chars`);
                                this.sendEvent('tts/audio', [{ audio: message.delta }]);
                            }
                        } else if (message.type === 'response.audio.done') {
                            this.pendingCommits = Math.max(0, this.pendingCommits - 1);
                            addClientLog(this.clientId, 'info', `TTS audio generation completed, remaining: ${this.pendingCommits}`);
                            if (this.pendingCommits === 0) {
                                this.sendEvent('tts/done', []);
                                addClientLog(this.clientId, 'info', 'All TTS audio generation completed');
                            }
                        } else if (message.type === 'error') {
                            const errorMsg = message.error?.message || 'TTS task failed';
                            addClientLog(this.clientId, 'error', `TTS error: ${errorMsg}`);
                            this.sendEvent('tts/error', [{ message: errorMsg }]);
                        } else {
                            logger.debug('TTS unknown message type: clientId=%d, type=%s', 
                                this.clientId, message.type);
                        }
                    } catch (error: any) {
                        logger.error('Failed to parse TTS message: %s, raw data: %s', error.message, data.toString().substring(0, 200));
                        addClientLog(this.clientId, 'error', `TTS message parse error: ${error.message}`);
                    }
                });
            });
        } catch (error: any) {
            logger.error('Failed to start TTS: %s', error.message);
            this.sendEvent('tts/error', [{ message: error.message }]);
        }
    }

    // Add text to TTS buffer, split by sentences
    private async addTtsText(content: string) {
        if (!this.client || !this.client.settings?.tts) {
            return;
        }

        this.ttsTextBuffer += content;
        
        const sentenceEndRegex = /[。！？\n\n]/;
        let sentenceEndIndex = this.ttsTextBuffer.search(sentenceEndRegex);
        
        if (sentenceEndIndex < 0 && this.ttsTextBuffer.length > 80) {
            const commaIndex = this.ttsTextBuffer.lastIndexOf('，');
            if (commaIndex > 0) {
                sentenceEndIndex = commaIndex;
            }
        }
        
        while (sentenceEndIndex >= 0) {
            const sentence = this.ttsTextBuffer.substring(0, sentenceEndIndex + 1);
            this.ttsTextBuffer = this.ttsTextBuffer.substring(sentenceEndIndex + 1);
            
            await this.flushTtsSentence(sentence);
            
            sentenceEndIndex = this.ttsTextBuffer.search(sentenceEndRegex);
        }
    }

    // Process complete sentence and push to TTS
    private async flushTtsSentence(sentence: string) {
        if (!sentence || !sentence.trim()) {
            return;
        }

        try {
            await this.ensureTtsConnection();
        } catch (error: any) {
            logger.warn('TTS connection not ready, caching text: clientId=%d, error=%s', this.clientId, error.message);
            this.ttsPendingText += sentence;
            return;
        }

        if (!this.ttsWs || this.ttsWs.readyState !== 1) {
            logger.warn('TTS WebSocket not ready, caching text: clientId=%d', this.clientId);
            this.ttsPendingText += sentence;
            return;
        }

        if (this.ttsPendingText) {
            const pending = this.ttsPendingText;
            this.ttsPendingText = '';
            await this.flushTtsSentence(pending);
        }

        const appendEvent = {
            type: 'input_text_buffer.append',
            text: sentence,
        };
        this.ttsWs.send(JSON.stringify(appendEvent));
        logger.debug('TTS append text: clientId=%d, sentence=%s', this.clientId, sentence.substring(0, 30));
        addClientLog(this.clientId, 'debug', `TTS append: ${sentence.substring(0, 30)}...`);

        const commitEvent = {
            type: 'input_text_buffer.commit',
        };
        this.ttsWs.send(JSON.stringify(commitEvent));
        this.pendingCommits++;
        logger.debug('TTS commit: clientId=%d, pendingCommits=%d', this.clientId, this.pendingCommits);
        addClientLog(this.clientId, 'debug', `TTS commit, pending: ${this.pendingCommits}`);
    }

    async handleTtsText(msg: any) {
        if (!msg.text || typeof msg.text !== 'string') {
            this.sendEvent('tts/error', [{ message: 'Invalid text content' }]);
            return;
        }

        await this.addTtsText(msg.text);
        
        if (this.ttsTextBuffer) {
            await this.flushTtsSentence(this.ttsTextBuffer);
            this.ttsTextBuffer = '';
        }
    }

    async handleTtsStop(msg: any) {
        this.sendEvent('tts/stopped', []);
    }

    async handleAgentChat(msg: any) {
        logger.info('handleAgentChat called: clientId=%d, msg=%o', this.clientId, msg);
        addClientLog(this.clientId, 'info', `Starting Agent chat: message=${msg?.message?.substring(0, 50) || 'no message'}...`);
        
        if (!this.client || !this.client.settings?.agent) {
            logger.warn('handleAgentChat: Agent config not set: clientId=%d', this.clientId);
            this.sendEvent('agent/error', [{ message: 'Agent config not set' }]);
            addClientLog(this.clientId, 'error', 'Agent config not set');
            return;
        }

        const agentConfig = this.client.settings.agent;
        if (!agentConfig.agentId) {
            logger.warn('handleAgentChat: Agent ID not configured: clientId=%d', this.clientId);
            this.sendEvent('agent/error', [{ message: 'Agent ID not configured' }]);
            addClientLog(this.clientId, 'error', 'Agent ID not configured');
            return;
        }

        const message = msg.message;
        const history = msg.history || [];

        if (!message || typeof message !== 'string') {
            logger.warn('handleAgentChat: Invalid message: clientId=%d, message=%o', this.clientId, message);
            this.sendEvent('agent/error', [{ message: 'Invalid message content' }]);
            addClientLog(this.clientId, 'error', 'Invalid message content');
            return;
        }

        this.currentTtsAudioBuffers = [];
        const chatMessages: Array<{
            role: 'user' | 'assistant' | 'tool';
            content: string;
            timestamp: Date;
            toolName?: string;
            toolCallId?: string;
            responseTime?: number;
            asrAudioPath?: string;
            ttsAudioPath?: string;
        }> = [];

        // Save ASR audio (user recording) collected before this message
        let userAsrAudioPath: string | undefined;
        if (this.currentAsrAudioBuffers.length > 0) {
            try {
                const audioBuffer = Buffer.concat(this.currentAsrAudioBuffers);
                const audioPath = `client/${this.domain._id}/${this.clientId}/asr/${Date.now()}.pcm`;
                await this.ctx.storage.put(audioPath, audioBuffer, {});
                userAsrAudioPath = audioPath;
                logger.info('ASR audio saved: clientId=%d, path=%s, size=%d bytes', this.clientId, audioPath, audioBuffer.length);
                // Clear ASR buffer after saving
                this.currentAsrAudioBuffers = [];
            } catch (error: any) {
                logger.error('Failed to save ASR audio: %s', error.message);
            }
        }

        // Add user message
        chatMessages.push({
            role: 'user',
            content: message,
            timestamp: new Date(),
            asrAudioPath: userAsrAudioPath,
        });

        let assistantContent = '';
        let currentToolCall: { toolName: string; toolCallId?: string; startTime: number } | null = null;

        try {
            logger.info('handleAgentChat: Fetching agent: clientId=%d, agentId=%s', this.clientId, agentConfig.agentId);
            addClientLog(this.clientId, 'info', `Fetching Agent info: agentId=${agentConfig.agentId}`);
            
            const agents = await AgentModel.getMulti(this.domain._id, { aid: agentConfig.agentId }).toArray();
            if (agents.length === 0) {
                logger.error('handleAgentChat: Agent not found: clientId=%d, agentId=%s', this.clientId, agentConfig.agentId);
                this.sendEvent('agent/error', [{ message: 'Agent not found' }]);
                addClientLog(this.clientId, 'error', `Agent not found: ${agentConfig.agentId}`);
                return;
            }

            const agent = agents[0];
            logger.info('handleAgentChat: Agent found: clientId=%d, agentId=%s, agentDocId=%s', 
                this.clientId, agentConfig.agentId, agent.docId);
            addClientLog(this.clientId, 'info', `Agent info retrieved: agentId=${agentConfig.agentId}, docId=${agent.docId}`);
            
            // Use internal Agent API function to process chat
            logger.info('handleAgentChat: Calling internal Agent API: clientId=%d', this.clientId);
            addClientLog(this.clientId, 'info', 'Calling internal Agent API');
            
            await processAgentChatInternal(agent, message, history, {
                onContent: (content: string) => {
                    assistantContent += content;
                    this.sendEvent('agent/content', [content]);
                    this.addTtsText(content).catch((error: any) => {
                        logger.warn('addTtsText failed: %s', error.message);
                    });
                },
                onToolCall: async (tools: any[]) => {
                    if (assistantContent.trim()) {
                        chatMessages.push({
                            role: 'assistant',
                            content: assistantContent,
                            timestamp: new Date(),
                        });
                        assistantContent = '';
                    }

                    // Wait for TTS playback to complete before tool call to create natural pause
                    if (this.client?.settings?.tts && this.pendingCommits > 0) {
                        logger.info('Waiting for TTS playback before tool call: clientId=%d, pendingCommits=%d', this.clientId, this.pendingCommits);
                        
                        // Step 1: Wait for TTS audio generation to complete
                        await new Promise<void>((resolve) => {
                            const checkInterval = setInterval(() => {
                                if (this.pendingCommits === 0) {
                                    clearInterval(checkInterval);
                                    resolve();
                                }
                            }, 100);
                            
                            setTimeout(() => {
                                clearInterval(checkInterval);
                                logger.warn('TTS generation timeout, continuing: clientId=%d', this.clientId);
                                resolve();
                            }, 10000);
                        });
                        
                        // Step 2: Wait for client-side audio playback to complete
                        logger.info('Waiting for client-side TTS playback: clientId=%d', this.clientId);
                        this.sendEvent('agent/wait_tts_playback', []);
                        
                        await new Promise<void>((resolve) => {
                            this.ttsPlaybackWaitPromise = { resolve, reject: () => {} };
                            
                            setTimeout(() => {
                                if (this.ttsPlaybackWaitPromise) {
                                    logger.warn('TTS playback wait timeout, continuing: clientId=%d', this.clientId);
                                    this.ttsPlaybackWaitPromise = null;
                                    resolve();
                                }
                            }, 30000);
                        });
                        
                        logger.info('TTS playback completed, proceeding with tool call: clientId=%d', this.clientId);
                    }

                    const toolName = tools[0] || 'unknown';
                    currentToolCall = {
                        toolName,
                        toolCallId: `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        startTime: Date.now(),
                    };
                    this.sendEvent('agent/tool_call', [{ tools }]);
                },
                onToolResult: (tool: string, result: any) => {
                    const responseTime = currentToolCall ? Date.now() - currentToolCall.startTime : undefined;
                    const toolCallId = currentToolCall?.toolCallId;

                    chatMessages.push({
                        role: 'tool',
                        content: JSON.stringify(result),
                        timestamp: new Date(),
                        toolName: tool,
                        toolCallId,
                        responseTime,
                    });

                    currentToolCall = null;
                    this.sendEvent('agent/tool_result', [{ tool, result }]);
                },
                onDone: async (finalMessage: string, finalHistory: string) => {
                    // Save TTS audio (AI response audio) to storage
                    let assistantTtsAudioPath: string | undefined;
                    if (this.currentTtsAudioBuffers.length > 0) {
                        try {
                            const audioBuffer = Buffer.concat(this.currentTtsAudioBuffers);
                            const audioPath = `client/${this.domain._id}/${this.clientId}/tts/${Date.now()}.pcm`;
                            await this.ctx.storage.put(audioPath, audioBuffer, {});
                            assistantTtsAudioPath = audioPath;
                            logger.info('TTS audio saved: clientId=%d, path=%s, size=%d bytes', this.clientId, audioPath, audioBuffer.length);
                        } catch (error: any) {
                            logger.error('Failed to save TTS audio: %s', error.message);
                        }
                    }

                    if (assistantContent.trim()) {
                        chatMessages.push({
                            role: 'assistant',
                            content: assistantContent,
                            timestamp: new Date(),
                            ttsAudioPath: assistantTtsAudioPath,
                        });
                    } else if (assistantTtsAudioPath) {
                        chatMessages.push({
                            role: 'assistant',
                            content: '',
                            timestamp: new Date(),
                            ttsAudioPath: assistantTtsAudioPath,
                        });
                    }

                                            this.sendEvent('agent/done', [{
                        message: finalMessage,
                        history: finalHistory,
                    }]);
                    addClientLog(this.clientId, 'info', `Agent chat completed: ${finalMessage.substring(0, 50)}...`);
                    
                    try {
                        if (chatMessages.length > 0) {
                            await ClientChatModel.add(
                                this.domain._id,
                                this.clientId!,
                                this.client!.owner,
                                chatMessages,
                            );
                            logger.info('Chat history saved: clientId=%d, messageCount=%d', this.clientId, chatMessages.length);
                            this.currentAsrAudioBuffers = [];
                            this.currentTtsAudioBuffers = [];
                        }
                    } catch (error: any) {
                        logger.error('Failed to save chat history: %s', error.message);
                    }
                    
                    // Handle TTS
                                            (async () => {
                                                try {
                                                    const latestClient = await ClientModel.getByClientId(this.domain._id, this.clientId!);
                                                    if (latestClient) {
                                                        this.client = latestClient;
                                                    }
                                                } catch (error: any) {
                                                    logger.warn('Failed to refresh client config for TTS: %s', error.message);
                                                }
                                                
                                                const ttsConfig = this.client?.settings?.tts;
                                                if (this.ttsTextBuffer && this.ttsTextBuffer.trim()) {
                                                    addClientLog(this.clientId, 'info', `Agent reply completed, processing remaining TTS text: ${this.ttsTextBuffer.substring(0, 50)}...`);
                                                    await this.flushTtsSentence(this.ttsTextBuffer);
                                                    this.ttsTextBuffer = '';
                                                }
                                                
                        if (finalMessage && ttsConfig) {
                                                    addClientLog(this.clientId, 'info', 'Agent reply completed, TTS processing completed');
                                                }
                                            })().catch((error: any) => {
                                                logger.error('Failed to process Agent completion for TTS: %s', error.message);
                    });
                },
                onError: (error: string) => {
                    logger.error('handleAgentChat: Internal API error: clientId=%d, error=%s', this.clientId, error);
                    addClientLog(this.clientId, 'error', `Agent chat error: ${error}`);
                    this.sendEvent('agent/error', [{ message: error }]);
                },
            });
        } catch (error: any) {
            logger.error('Failed to process agent chat: %s', error.message);
            addClientLog(this.clientId, 'error', `Agent chat error: ${error.message}`);
            this.sendEvent('agent/error', [{ message: error.message }]);
        }
    }

    async cleanup() {
        // Unsubscribe from all events
        for (const sub of this.eventSubscriptions) {
            try {
                sub.dispose?.();
            } catch {
                // ignore
            }
        }
        this.eventSubscriptions = [];

        // Close ASR WebSocket connection
        if (this.asrWs) {
            try {
                this.asrWs.close();
            } catch {
                // ignore
            }
            this.asrWs = null;
            this.asrTaskId = null;
        }

                // Close TTS WebSocket connection if exists
                if (this.ttsWs) {
                    try {
                        this.ttsWs.close();
                    } catch {
                        // ignore
                    }
                    this.ttsWs = null;
                    this.ttsInitResolved = false;
                    if (this.ttsInitPromise) {
                        this.ttsInitPromise.reject(new Error('TTS WebSocket closed before init complete'));
                        this.ttsInitPromise = null;
                    }
                }

        for (const sub of this.subscriptions) {
            try {
                sub.dispose?.();
            } catch {
                // ignore
            }
        }
        this.subscriptions = [];
        
        if (this.clientId && this.accepted) {
            ClientConnectionHandler.active.delete(this.clientId);
            
            // 从 EdgeServerConnectionHandler 中删除（和 node/provider 一样）
            if (this.token) {
                EdgeServerConnectionHandler.active.delete(this.token);
            }
            
            try {
                await ClientModel.updateStatus(this.domain._id, this.clientId, 'disconnected');
                (this.ctx.emit as any)('client/status/update', this.clientId);
                
                // 更新 edge 状态为离线（和 EdgeServerConnectionHandler.cleanup 一样）
                if (this.token) {
                    const edge = await EdgeModel.getByToken(this.domain._id, this.token);
                    if (edge) {
                        await EdgeModel.update(this.domain._id, edge.eid, { status: 'offline' });
                        (this.ctx.emit as any)('edge/status/update', this.token, 'offline');
                    }
                }
            } catch (error: any) {
                logger.error('Failed to update client status on disconnect: %s', error.message);
            }
        }

        if (this.accepted && this.clientId) {
            logger.info('Client WebSocket disconnected: clientId=%d from %s', this.clientId, this.request.ip);
            addClientLog(this.clientId, 'info', `Client disconnected: ${this.request.ip}`);
        }
    }
}

export class ClientStatusConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    private clientId: number | null = null;
    private subscriptions: Array<{ dispose: () => void }> = [];

    async prepare() {
        const { clientId } = this.request.query;
        const clientIdNum = parseInt(clientId as string, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            logger.debug('Client Status WebSocket rejected: Invalid clientId=%s', clientId);
            this.close(1000, 'Invalid clientId');
            return;
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            logger.debug('Client Status WebSocket rejected: Client not found, clientId=%d', clientIdNum);
            this.close(1000, 'Client not found');
            return;
        }

        if (!this.user || !this.user._id) {
            logger.debug('Client Status WebSocket rejected: User not authenticated, clientId=%d', clientIdNum);
            this.close(1000, 'Authentication required');
            return;
        }
        
        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            logger.debug('Client Status WebSocket rejected: Permission denied, clientId=%d, userId=%d, clientOwner=%d', 
                clientIdNum, this.user._id, client.owner);
            this.close(1000, 'Permission denied');
            return;
        }

        this.clientId = clientIdNum;

        // Status WebSocket connection at debug level to reduce log noise
        logger.debug('Client Status WebSocket connected: clientId=%d', this.clientId);

        // Check actual connection status
        const actualStatus = ClientConnectionHandler.active.has(clientIdNum) ? 'connected' : 'disconnected';
        const clientWithActualStatus = { ...client, status: actualStatus };
        
        this.send({ type: 'init', client: clientWithActualStatus });

        // Periodically check actual connection status
        let lastKnownStatus = actualStatus;
        const checkInterval = setInterval(() => {
            if (!this.clientId) {
                clearInterval(checkInterval);
                return;
            }
            const isActuallyConnected = ClientConnectionHandler.active.has(this.clientId);
            const currentStatus = isActuallyConnected ? 'connected' : 'disconnected';
            
            // Only send update when status changes
            if (lastKnownStatus !== currentStatus) {
                lastKnownStatus = currentStatus;
                const updatedClient = { ...client, status: currentStatus };
                this.send({ type: 'client/status', client: updatedClient });
            }
        }, 2000);

        this.subscriptions.push({ 
            dispose: () => clearInterval(checkInterval) 
        });

        const dispose1 = this.ctx.on('client/status/update' as any, async (...args: any[]) => {
            const [updateClientId] = args;
            if (updateClientId === this.clientId) {
                // Check actual connection status
                const isActuallyConnected = ClientConnectionHandler.active.has(this.clientId!);
                const actualStatus = isActuallyConnected ? 'connected' : 'disconnected';
                
                const updatedClient = await ClientModel.getByClientId(this.domain._id, this.clientId!);
                if (updatedClient) {
                    const clientWithActualStatus = { ...updatedClient, status: actualStatus };
                    this.send({ type: 'client/status', client: clientWithActualStatus });
                }
            }
        });
        this.subscriptions.push({ dispose: dispose1 });
    }

    async message(msg: any) {
        if (!this.clientId) return;

        if (msg && typeof msg === 'object') {
            const { type } = msg;
            switch (type) {
            case 'ping':
                this.send({ type: 'pong' });
                break;
            case 'refresh':
                {
                    const client = await ClientModel.getByClientId(this.domain._id, this.clientId);
                    if (client) {
                        this.send({ type: 'refresh', client });
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
        if (this.clientId) {
            // Status WebSocket disconnect at debug level to reduce log noise
            logger.debug('Client Status WebSocket disconnected: clientId=%d', this.clientId);
        }
    }
}

export class ClientLogsHandler extends Handler<Context> {
    async get() {
        const { clientId } = this.request.params;
        const clientIdNum = parseInt(clientId, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            throw new ValidationError('clientId');
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            throw new NotFoundError('Client');
        }

        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const logs = logBuffer.get(clientIdNum) || [];
        
        this.response.template = 'client_logs.html';
        this.response.body = { client, domainId: this.domain._id, logs: logs.slice(-100) };
    }
}

export class ClientLogsConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    private clientId: number | null = null;

    async prepare() {
        const { clientId } = this.request.query;
        const clientIdNum = parseInt(clientId as string, 10);
        
        if (isNaN(clientIdNum) || clientIdNum < 1) {
            this.close(1000, 'Invalid clientId');
            return;
        }

        const client = await ClientModel.getByClientId(this.domain._id, clientIdNum);
        if (!client) {
            this.close(1000, 'Client not found');
            return;
        }

        if (!this.user || !this.user._id) {
            this.close(1000, 'Authentication required');
            return;
        }
        
        if (client.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            this.close(1000, 'Permission denied');
            return;
        }

        this.clientId = clientIdNum;

        // Add to connection set
        if (!logConnections.has(clientIdNum)) {
            logConnections.set(clientIdNum, new Set());
        }
        logConnections.get(clientIdNum)!.add(this);

        // Send historical logs
        const logs = logBuffer.get(clientIdNum) || [];
        const recentLogs = logs.slice(-50);
        this.send({ type: 'history', logs: recentLogs });
    }

    async message(msg: any) {
        // Log connection doesn't need to handle messages
    }

    async cleanup() {
        if (this.clientId) {
            const connections = logConnections.get(this.clientId);
            if (connections) {
                connections.delete(this);
                if (connections.size === 0) {
                    logConnections.delete(this.clientId);
                }
            }
        }
    }
}

export async function apply(ctx: Context) {
    // Apply client_chat model
    await applyClientChat(ctx);

    ctx.Route('client_domain', '/client', ClientDomainHandler);
    ctx.Route('client_create', '/client/create', ClientEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_edit', '/client/:clientId/edit', ClientEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_delete', '/client/delete', ClientDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_detail', '/client/:clientId', ClientDetailHandler);
    // Token 生成路由已迁移到 edge 模块
    ctx.Route('client_chat_list', '/client/:clientId/chats', ClientChatListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_chat_detail', '/client/:clientId/chat/:conversationId', ClientChatDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_chat_delete', '/client/chat/delete', ClientChatDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_chat_audio_download', '/client/:clientId/chat/:conversationId/audio/:messageIndex/:audioType', ClientChatAudioDownloadHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_delete_token', '/client/:clientId/delete-token', ClientDeleteTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_update_settings', '/client/:clientId/update-settings', ClientUpdateSettingsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_logs', '/client/:clientId/logs', ClientLogsHandler);
    ctx.Connection('client_conn', '/client/ws', ClientConnectionHandler);
    ctx.Connection('client_status_conn', '/client/status/ws', ClientStatusConnectionHandler);
    ctx.Connection('client_logs_conn', '/client/logs/ws', ClientLogsConnectionHandler);

    // Register Cordis event handlers for stream proxying
    // ASR events (new protocol)
    (ctx as any).on('client/asr/audio', async (clientId: number, payload: any[]) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            await handler.handleAsrAudio(payload);
        }
    });

    (ctx as any).on('client/asr/commit', async (clientId: number, payload: any[]) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            await handler.handleAsrCommit(payload);
        }
    });

    (ctx as any).on('client/asr/recording_started', async (clientId: number, payload: any[]) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            await handler.handleAsrRecordingStarted(payload);
        }
    });

    (ctx as any).on('client/asr/recording_completed', async (clientId: number, payload: any[]) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            await handler.handleAsrRecordingCompleted(payload);
        }
    });

    // TTS events
    (ctx as any).on('client/tts/start', async (clientId: number, msg: any) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            addClientLog(clientId, 'info', 'TTS start request');
            await handler.handleTtsStart(msg);
        }
    });

    (ctx as any).on('client/tts/text', async (clientId: number, msg: any) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            addClientLog(clientId, 'info', `TTS text request: ${msg.text ? msg.text.substring(0, 50) + (msg.text.length > 50 ? '...' : '') : 'no text'}`);
            await handler.handleTtsText(msg);
        }
    });

    (ctx as any).on('client/tts/stop', async (clientId: number, msg: any) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            addClientLog(clientId, 'info', 'TTS stop request');
            await handler.handleTtsStop(msg);
        }
    });

    // Agent events
    (ctx as any).on('client/agent/chat', async (clientId: number, msg: any) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            addClientLog(clientId, 'info', `Agent chat request: ${msg.message ? msg.message.substring(0, 50) + (msg.message.length > 50 ? '...' : '') : 'no message'}`);
            await handler.handleAgentChat(msg);
        }
    });
}


