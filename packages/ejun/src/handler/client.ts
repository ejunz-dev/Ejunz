
import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import ClientModel, { ClientWidgetModel, ClientGsiFieldModel } from '../model/client';
import ClientChatModel, { apply as applyClientChat } from '../model/client_chat';
import EdgeModel from '../model/edge';
import EdgeTokenModel from '../model/edge_token';
import { EdgeServerConnectionHandler } from './edge';
import AgentModel, { McpClient } from '../model/agent';
import type { EdgeBridgeEnvelope } from '../service/bus';
import SessionModel from '../model/session';
import record from '../model/record';
import domain from '../model/domain';
import * as document from '../model/document';
import { PRIV, STATUS } from '../model/builtin';
import WebSocket from 'ws';
import request from 'superagent';
import Agent from '../model/agent';
import ToolModel from '../model/tool';

const logger = new Logger('handler/client');

// Get assigned tools (consistent with getAssignedTools in agent.ts)
// Uses ToolModel and EdgeModel to get tools with token information
async function getAssignedTools(domainId: string, mcpToolIds?: ObjectId[]): Promise<any[]> {
    const allToolIds = new Set<string>();
    
    if (mcpToolIds) {
        for (const toolId of mcpToolIds) {
            allToolIds.add(toolId.toString());
        }
    }
    
    const finalToolIds: ObjectId[] = Array.from(allToolIds).map(id => new ObjectId(id));
    
    if (finalToolIds.length === 0) {
        logger.info('getAssignedTools: No toolIds specified, returning empty array. domainId=%s, mcpToolIds=%o', 
            domainId, mcpToolIds);
        return [];
    }
    
    logger.info('getAssignedTools: Processing %d toolIds: %o', finalToolIds.length, finalToolIds.map(id => id.toString()));
    
    // First, get tools from database and build a map by tool name
    // Use batch query instead of individual queries for better performance
    const dbToolsMap = new Map<string, any>();
    const assignedToolNames = new Set<string>();
    
    try {
        // Batch query all tools at once
        const tools = await document.getMulti(domainId, document.TYPE_TOOL, { _id: { $in: finalToolIds } }).toArray() as any[];
        
        // Get unique edgeDocIds to batch query edges
        const edgeDocIds = new Set<ObjectId>();
        for (const tool of tools) {
            if (tool && tool.domainId === domainId && tool.edgeDocId) {
                edgeDocIds.add(tool.edgeDocId);
            }
        }
        
        // Batch query all edges at once
        const edgesMap = new Map<ObjectId, any>();
        if (edgeDocIds.size > 0) {
            const edges = await document.getMulti(domainId, document.TYPE_EDGE, { _id: { $in: Array.from(edgeDocIds) } }).toArray() as any[];
            for (const edge of edges) {
                if (edge) {
                    edgesMap.set(edge._id, edge);
                }
            }
        }
        
        // Build tools map
        for (const tool of tools) {
            if (tool && tool.domainId === domainId) {
                const edge = edgesMap.get(tool.edgeDocId);
                if (edge) {
                    dbToolsMap.set(tool.name, {
                        name: tool.name,
                        description: tool.description,
                        inputSchema: tool.inputSchema,
                        token: edge.token,
                        edgeId: edge._id,
                    });
                    assignedToolNames.add(tool.name);
                }
            }
        }
    } catch (error) {
        logger.warn('Failed to batch query tools, falling back to individual queries: %s', (error as Error).message);
        // Fallback to individual queries if batch query fails
        for (const toolId of finalToolIds) {
            try {
                const tool = await ToolModel.get(toolId);
                if (tool && tool.domainId === domainId) {
                    const edge = await EdgeModel.get(tool.edgeDocId);
                    if (edge) {
                        dbToolsMap.set(tool.name, {
                            name: tool.name,
                            description: tool.description,
                            inputSchema: tool.inputSchema,
                            token: edge.token,
                            edgeId: edge._id,
                        });
                        assignedToolNames.add(tool.name);
                    }
                }
            } catch (err) {
                logger.warn('Invalid tool ID: %s', toolId.toString());
            }
        }
    }
    
    // Also fetch from real-time MCP connections to get tools that might not be in DB yet
    // or to get more up-to-date tool definitions
    // Use timeout to prevent blocking if MCP is slow or unavailable
    let realtimeTools: any[] = [];
    try {
        const mcpClient = new McpClient();
        // Add timeout to prevent blocking - if MCP is slow, fallback to DB tools
        const timeoutPromise = new Promise<any[]>((_, reject) => {
            setTimeout(() => reject(new Error('MCP tools fetch timeout')), 1000); // 1 second timeout
        });
        realtimeTools = await Promise.race([mcpClient.getTools(), timeoutPromise]);
    } catch (error: any) {
        // Silently fallback to database tools - MCP is optional
        logger.debug('MCP tools fetch failed or timeout, using DB tools only: %s', error.message);
    }
    
    // Merge realtime tools with database tools
    // Priority: realtime tools (more up-to-date) > database tools
    const finalTools: any[] = [];
    const processedNames = new Set<string>();
    
    // First, add realtime tools that match assigned tool names
    // Note: realtime tools don't have token, so we prefer database tools when available
    for (const realtimeTool of realtimeTools) {
        if (assignedToolNames.has(realtimeTool.name) && !dbToolsMap.has(realtimeTool.name)) {
            // Only add realtime tool if not in database (database tools have token)
            finalTools.push({
                name: realtimeTool.name,
                description: realtimeTool.description || '',
                inputSchema: realtimeTool.inputSchema || null,
            });
            processedNames.add(realtimeTool.name);
        }
    }
    
    // Then, add database tools (they have token, so prefer them)
    for (const [toolName, dbTool] of dbToolsMap) {
        if (!processedNames.has(toolName)) {
            finalTools.push(dbTool);
            processedNames.add(toolName);
        }
    }
    
    logger.info('getAssignedTools: dbTools=%d, realtimeTools=%d, matchedTools=%d, finalTools=%d', 
        dbToolsMap.size, realtimeTools.length, processedNames.size, finalTools.length);
    
    return finalTools;
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

// Token generation logic has been moved to edge module

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

export class ClientSettingsHandler extends Handler<Context> {
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

        this.response.template = 'client_settings.html';
        this.response.body = { client, domainId: this.domain._id, agentInfo, agents };
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

export class ClientGsiFieldsHandler extends Handler<Context> {
    async get() {
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

        const gsiFields = await ClientGsiFieldModel.getByClient(this.domain._id, clientIdNum);
        this.response.body = {
            fields: gsiFields.map(f => ({
                path: f.fieldPath,
                type: f.type,
                description: f.description,
                values: f.values,
                range: f.range,
                nullable: f.nullable,
                currentValue: f.currentValue,
            })),
        };
    }
}

export class ClientWidgetControlHandler extends Handler<Context> {
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

        const { widgetName, visible } = this.request.body;
        
        if (!widgetName || typeof widgetName !== 'string') {
            throw new ValidationError('widgetName');
        }
        
        if (typeof visible !== 'boolean') {
            throw new ValidationError('visible');
        }

        // 生成唯一的traceId
        const traceId = `widget-control-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // 构建Ejunz协议格式的控制消息
        const controlMessage = {
            protocol: 'ejunz',
            action: 'control',
            payload: {
                widgetName: widgetName,
                visible: visible
            },
            traceId: traceId,
            direction: 'inbound'
        };

        // 通过ClientConnectionHandler发送消息给下游client
        const handler = ClientConnectionHandler.getConnection(clientIdNum);
        if (!handler) {
            this.response.status = 503;
            this.response.body = { 
                success: false, 
                error: 'Client not connected',
                message: '下游客户端未连接'
            };
            return;
        }

        try {
            // 乐观更新内存中的状态（control/ack会确认）
            handler.setWidgetState(widgetName, visible);
            
            handler.send(controlMessage);
            logger.info('Sent widget control command via server: clientId=%d, widgetName=%s, visible=%s, traceId=%s', 
                clientIdNum, widgetName, visible, traceId);
            
            this.response.body = { 
                success: true, 
                traceId: traceId,
                message: 'Control command sent successfully'
            };
        } catch (error) {
            logger.error('Failed to send widget control command: %s', (error as Error).message);
            this.response.status = 500;
            this.response.body = { 
                success: false, 
                error: (error as Error).message 
            };
        }
    }
}

export class ClientCreateVoiceHandler extends Handler<Context> {
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

        const audioFile = this.request.files?.audioFile;
        if (!audioFile || Array.isArray(audioFile)) {
            throw new ValidationError('audioFile');
        }

        const region = this.request.body.region || 'beijing';
        let preferredName = this.request.body.preferredName;
        const apiKey = this.request.body.apiKey || client.settings?.tts?.apiKey;
        const targetModel = 'qwen3-tts-vc-realtime-2025-11-27'; // 声音复刻必须使用此模型

        if (!apiKey) {
            throw new ValidationError('API Key is required');
        }

        // preferred_name 验证：如果为空或无效，使用默认值或生成一个
        if (!preferredName || preferredName.trim() === '') {
            preferredName = `voice_${Date.now()}`;
        }
        // 确保 preferred_name 符合要求（只包含字母、数字、下划线、连字符）
        preferredName = preferredName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);

        try {
            // 读取音频文件并转换为base64
            const fs = require('fs');
            const path = require('path');
            const audioBuffer = fs.readFileSync(audioFile.filepath);
            const audioBase64 = audioBuffer.toString('base64');
            
            // 根据文件扩展名确定MIME类型
            const ext = path.extname(audioFile.originalFilename || audioFile.filepath).toLowerCase();
            let mimeType = 'audio/mpeg'; // 默认MP3
            if (ext === '.wav') {
                mimeType = 'audio/wav';
            } else if (ext === '.m4a') {
                mimeType = 'audio/mp4';
            } else if (ext === '.mp3') {
                mimeType = 'audio/mpeg';
            }
            
            // 将base64编码包装成data URI格式
            const audioDataUri = `data:${mimeType};base64,${audioBase64}`;
            
            // 根据region选择endpoint
            const endpoint = region === 'singapore' 
                ? 'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization'
                : 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
            
            // 根据文档，API使用JSON格式，audio需要是对象格式，包含data字段（data URI格式）
            const requestBody: any = {
                model: 'qwen-voice-enrollment',
                input: {
                    action: 'create',
                    target_model: targetModel,
                    audio: {
                        data: audioDataUri,
                    },
                    region: region,
                },
            };
            
            // preferred_name 是可选的，只有在有效时才添加
            if (preferredName && preferredName.trim() !== '') {
                requestBody.input.preferred_name = preferredName;
            }
            
            logger.info('Creating voice: clientId=%d, region=%s, preferredName=%s, targetModel=%s', 
                clientIdNum, region, preferredName, targetModel);
            
            const response = await request.post(endpoint)
                .set('Authorization', `Bearer ${apiKey}`)
                .set('Content-Type', 'application/json')
                .send(requestBody);
            
            if (response.status !== 200 || !response.body || !response.body.output || !response.body.output.voice) {
                logger.error('Voice cloning API error: status=%d, body=%o', response.status, response.body);
                const errorMsg = response.body?.message || response.body?.error?.message || response.body?.error?.code || 'Failed to create voice';
                throw new Error(errorMsg);
            }

            const voiceId = response.body.output.voice;
            
            logger.info('Voice created successfully: clientId=%d, voiceId=%s', clientIdNum, voiceId);

            // 保存音色信息到数据库
            const now = new Date();
            const voiceInfo = {
                voiceId,
                preferredName,
                region,
                createdAt: now,
                updatedAt: now,
            };

            const currentSettings = client.settings || {};
            const currentVoices = currentSettings.voiceCloning?.voices || [];
            
            // 检查是否已存在相同voiceId的音色，如果存在则更新，否则添加
            const existingIndex = currentVoices.findIndex((v: any) => v.voiceId === voiceId);
            if (existingIndex >= 0) {
                currentVoices[existingIndex] = { ...currentVoices[existingIndex], ...voiceInfo };
            } else {
                currentVoices.push(voiceInfo);
            }

            await ClientModel.updateSettings(this.domain._id, clientIdNum, {
                voiceCloning: {
                    voices: currentVoices,
                },
            });

            this.response.body = {
                success: true,
                voice: voiceId,
                voiceInfo,
            };
        } catch (error: any) {
            logger.error('Failed to create voice: clientId=%d, error=%s, response=%o, stack=%s', 
                clientIdNum, error.message, error.response?.body, error.stack);
            
            let errorMessage = 'Failed to create voice';
            if (error.response?.body) {
                errorMessage = error.response.body.message || 
                             error.response.body.error?.message || 
                             error.response.body.error?.code ||
                             JSON.stringify(error.response.body);
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            throw new Error(errorMessage);
        }
    }
}

export class ClientListVoicesHandler extends Handler<Context> {
    async get() {
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

        const voices = client.settings?.voiceCloning?.voices || [];
        
        this.response.body = {
            success: true,
            voices,
        };
    }
}

export class ClientDeleteVoiceHandler extends Handler<Context> {
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

        const { voiceId } = this.request.body;
        if (!voiceId) {
            throw new ValidationError('voiceId');
        }

        const apiKey = client.settings?.tts?.apiKey;
        if (!apiKey) {
            throw new ValidationError('API Key is required');
        }

        const currentSettings = client.settings || {};
        const currentVoices = currentSettings.voiceCloning?.voices || [];
        const voiceIndex = currentVoices.findIndex((v: any) => v.voiceId === voiceId);
        
        if (voiceIndex < 0) {
            throw new NotFoundError('Voice');
        }

        const voice = currentVoices[voiceIndex];
        const region = voice.region || 'beijing';

        try {
            // 调用阿里云API删除音色
            const endpoint = region === 'singapore' 
                ? 'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization'
                : 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
            
            const requestBody = {
                model: 'qwen-voice-enrollment',
                input: {
                    action: 'delete',
                    voice: voiceId,
                },
            };
            
            const response = await request.post(endpoint)
                .set('Authorization', `Bearer ${apiKey}`)
                .set('Content-Type', 'application/json')
                .send(requestBody);
            
            if (response.status !== 200) {
                logger.warn('Voice deletion API returned non-200 status: status=%d, body=%o', response.status, response.body);
                // 即使API删除失败，也从数据库中删除
            }

            // 从数据库中删除
            currentVoices.splice(voiceIndex, 1);
            
            await ClientModel.updateSettings(this.domain._id, clientIdNum, {
                voiceCloning: {
                    voices: currentVoices,
                },
            });

            // 如果当前TTS配置使用的是被删除的音色，清空voice字段
            if (client.settings?.tts?.voice === voiceId) {
                await ClientModel.updateSettings(this.domain._id, clientIdNum, {
                    tts: {
                        ...client.settings.tts,
                        voice: undefined,
                    },
                });
            }

            logger.info('Voice deleted successfully: clientId=%d, voiceId=%s', clientIdNum, voiceId);

            this.response.body = {
                success: true,
            };
        } catch (error: any) {
            logger.error('Failed to delete voice: clientId=%d, voiceId=%s, error=%s', 
                clientIdNum, voiceId, error.message);
            
            // 即使API调用失败，也从数据库中删除
            currentVoices.splice(voiceIndex, 1);
            await ClientModel.updateSettings(this.domain._id, clientIdNum, {
                voiceCloning: {
                    voices: currentVoices,
                },
            });

            throw new Error(error.response?.body?.message || error.message || 'Failed to delete voice');
        }
    }
}

export class ClientUpdateVoiceHandler extends Handler<Context> {
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

        const { voiceId, preferredName } = this.request.body;
        if (!voiceId) {
            throw new ValidationError('voiceId');
        }
        if (!preferredName || preferredName.trim() === '') {
            throw new ValidationError('preferredName');
        }

        const currentSettings = client.settings || {};
        const currentVoices = currentSettings.voiceCloning?.voices || [];
        const voiceIndex = currentVoices.findIndex((v: any) => v.voiceId === voiceId);
        
        if (voiceIndex < 0) {
            throw new NotFoundError('Voice');
        }

        // 更新音色名称
        const cleanedName = preferredName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
        currentVoices[voiceIndex] = {
            ...currentVoices[voiceIndex],
            preferredName: cleanedName,
            updatedAt: new Date(),
        };
        
        await ClientModel.updateSettings(this.domain._id, clientIdNum, {
            voiceCloning: {
                voices: currentVoices,
            },
        });

        logger.info('Voice updated successfully: clientId=%d, voiceId=%s, preferredName=%s', 
            clientIdNum, voiceId, cleanedName);

        this.response.body = {
            success: true,
            voice: currentVoices[voiceIndex],
        };
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
    private token: string | null = null;
    private tokenDomainId: string | null = null; // 存储token中的域ID，确保使用正确的域
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
    private currentSessionId: ObjectId | null = null;
    private subscribedRecordIds: Set<string> = new Set();
    private pendingAgentDoneRecords: Map<string, { taskRecordId: string; message: string }> = new Map();
    private sentContentRecordIds: Set<string> = new Set(); // 跟踪已经发送过内容的记录ID，防止重复发送
    // Promise resolver for waiting TTS playback completion before tool calls
    private ttsPlaybackWaitPromise: { resolve: () => void; reject: (error: Error) => void } | null = null;
    private outboundBridgeDisposer: (() => void) | null = null;
    private pendingToolCalls: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }> = new Map();
    private pendingToolCallNames: Map<string, string> = new Map(); // Map requestId to toolName
    private widgetList: any[] | null = null; // 存储组件列表
    private widgetStates: Map<string, boolean> = new Map(); // 存储组件状态（widgetName -> visible）
    
    static getConnection(clientId: number): ClientConnectionHandler | null {
        return ClientConnectionHandler.active.get(clientId) || null;
    }
    
    getWidgetList(): any[] | null {
        return this.widgetList;
    }
    
    getWidgetState(widgetName: string): boolean | null {
        return this.widgetStates.get(widgetName) ?? null;
    }
    
    setWidgetState(widgetName: string, visible: boolean) {
        this.widgetStates.set(widgetName, visible);
    }

    async prepare() {
        const { token } = this.request.query;
        
        if (!token || typeof token !== 'string') {
            this.close(4000, 'Token is required');
            return;
        }

        const tokenDoc = await EdgeTokenModel.getByToken(token);
        if (!tokenDoc || tokenDoc.type !== 'client') {
            logger.warn('Client WebSocket connection rejected: Invalid token or token type');
            this.close(4000, 'Invalid token');
            return;
        }

        // 使用token中的域ID，而不是请求路径中的域ID
        // 这样可以确保token在正确的域中使用
        this.tokenDomainId = tokenDoc.domainId;
        
        // 如果请求路径中的域ID与token中的域ID不匹配，记录警告但继续使用token的域ID
        if (this.domain._id !== this.tokenDomainId) {
            logger.warn('Domain mismatch: token domainId=%s, request domainId=%s, using token domainId', 
                this.tokenDomainId, this.domain._id);
        }

        await EdgeTokenModel.updateLastUsed(token);

        let edge = await EdgeModel.getByToken(this.tokenDomainId!, token);
        if (!edge) {
            const owner = tokenDoc.owner || this.user?._id || 1;
            edge = await EdgeModel.add({
                domainId: this.tokenDomainId!,
                type: tokenDoc.type as 'provider' | 'client' | 'node',
                owner: owner,
                token: tokenDoc.token,
            });
            logger.info('Created edge on client connection: eid=%d, token=%s, type=%s, owner=%d, domainId=%s (from token.domainId=%s)', 
                edge.eid, token, tokenDoc.type, owner, this.tokenDomainId, tokenDoc.domainId);
        }
        
        const wasFirstConnection = !edge.tokenUsedAt;
        try {
            await EdgeModel.update(this.tokenDomainId!, edge.eid, {
                status: 'online',
                tokenUsedAt: edge.tokenUsedAt || new Date(),
            });
            
            if (wasFirstConnection) {
                const updatedEdge = await EdgeModel.getByToken(this.tokenDomainId!, token);
                if (updatedEdge) {
                    (this.ctx.emit as any)('edge/connected', updatedEdge);
                }
            }
        } catch (error) {
            logger.error('Failed to update edge status: %s', (error as Error).message);
        }

        await EdgeTokenModel.markPermanent(token);

        let client: any = null;
        if (edge.clientId) {
            client = await ClientModel.getByClientId(this.tokenDomainId!, edge.clientId);
            if (client) {
                if (client.edgeId !== edge.eid) {
                    await ClientModel.update(this.tokenDomainId!, client.clientId, { edgeId: edge.eid });
                    logger.info('Updated client edgeId to establish bidirectional link: clientId=%d, edgeId=%d', client.clientId, edge.eid);
                }
                logger.info('Client already exists, using existing client: clientId=%d, edgeId=%d', client.clientId, edge.eid);
            }
        } else {
            client = await ClientModel.getByEdgeId(this.tokenDomainId!, edge.eid);
            if (client) {
                await EdgeModel.update(this.tokenDomainId!, edge.eid, { clientId: client.clientId });
                await ClientModel.updateStatus(this.tokenDomainId!, client.clientId, 'connected');
                logger.info('Client already exists by edgeId, established bidirectional link: clientId=%d, edgeId=%d', client.clientId, edge.eid);
                
                logger.info('Client connected event published: clientId=%d', client.clientId);
                (this.ctx.emit as any)('client/connected', client);
            }
        }
        
        if (!client) {
            client = await ClientModel.add({
                domainId: this.tokenDomainId!,
                name: `Client-${edge.eid}`,
                owner: edge.owner,
                edgeId: edge.eid,
            });
            await EdgeModel.update(this.tokenDomainId!, edge.eid, { clientId: client.clientId });
            logger.info('Auto-created client for edge on connection: clientId=%d, edgeId=%d', client.clientId, edge.eid);
            
            logger.info('Client connected event published: clientId=%d', client.clientId);
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
        this.token = token;
        this.client = client;
        this.accepted = true;

        // Add to active connections (singleton pattern, one connection per clientId)
        ClientConnectionHandler.active.set(this.clientId, this);
        
        // Register with EdgeServerConnectionHandler for unified status checking (same as node/provider)
        // Note: Use token as key to match EdgeServerConnectionHandler
        EdgeServerConnectionHandler.active.set(token, this as any);
        
        // Register outbound bridge listener for MCP protocol support
        this.registerOutboundBridgeListener();

        logger.info('Client WebSocket connected: %s (clientId: %d, token: %s) from %s', 
            this.clientDocId, this.clientId, token, this.request.ip);

        addClientLog(this.clientId, 'info', `Client connected: ${this.request.ip}`);

        await ClientModel.updateStatus(this.tokenDomainId!, this.clientId, 'connected');
        
        (this.ctx.emit as any)('edge/status/update', token, 'online');
        (this.ctx.emit as any)('mcp/server/connection/update', token, 'connected');
        (this.ctx.emit as any)('mcp/server/status/update', token);
        
        // Send initial config to client via status/update event
        this.send({ 
            event: 'status/update', 
            payload: [{ client: this.client }] 
        });
        
        const dispose1 = this.ctx.on('client/status/update' as any, async (...args: any[]) => {
            const [updateClientId] = args;
            if (updateClientId === this.clientId && this.tokenDomainId) {
                const updatedClient = await ClientModel.getByClientId(this.tokenDomainId, this.clientId!);
                if (updatedClient) {
                    this.send({ 
                        event: 'status/update', 
                        payload: [{ client: updatedClient }] 
                    });
                }
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        logger.info('Client status update event published: clientId=%d', this.clientId);
        (this.ctx.emit as any)('client/status/update', this.clientId);
        
        // 创建或获取client的session
        await this.ensureClientSession();
    }
    
    // 确保client有session，如果不存在则创建
    private async ensureClientSession(): Promise<void> {
        if (!this.clientId || !this.client) {
            return;
        }
        
        // 如果已经有session，检查是否有效
        if (this.currentSessionId && this.tokenDomainId) {
            try {
                const sdoc = await SessionModel.get(this.tokenDomainId, this.currentSessionId);
                if (sdoc && sdoc.type === 'client' && sdoc.clientId === this.clientId) {
                    // 更新最后活动时间
                    await SessionModel.update(this.tokenDomainId, this.currentSessionId, {
                        lastActivityAt: new Date(),
                    });
                    logger.info('Client session already exists, updated lastActivityAt: clientId=%d, sessionId=%s', 
                        this.clientId, this.currentSessionId.toString());
                    return;
                }
            } catch (error: any) {
                logger.warn('Failed to get existing session: %s', error.message);
            }
        }
        
        // 查找是否有未超时的session（5分钟内）
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        if (!this.tokenDomainId) {
            logger.warn('Cannot ensure client session: tokenDomainId is not set');
            return;
        }
        try {
            const existingSessions = await SessionModel.getMulti(this.tokenDomainId, {
                type: 'client',
                clientId: this.clientId,
                lastActivityAt: { $gte: fiveMinutesAgo },
            }, {
                sort: { lastActivityAt: -1 },
                limit: 1,
            }).toArray();
            
            if (existingSessions.length > 0) {
                const sdoc = existingSessions[0];
                this.currentSessionId = sdoc._id;
                // 更新最后活动时间
                await SessionModel.update(this.tokenDomainId!, sdoc._id, {
                    lastActivityAt: new Date(),
                });
                logger.info('Reused existing client session: clientId=%d, sessionId=%s', 
                    this.clientId, sdoc._id.toString());
                return;
            }
        } catch (error: any) {
            logger.warn('Failed to find existing session: %s', error.message);
        }
        
        // 创建新session
        const agentId = this.client.settings?.agent?.agentId;
        if (!agentId) {
            logger.warn('Cannot create session: agentId not configured: clientId=%d', this.clientId);
            return;
        }
        
        const recordUid = this.client.owner;
        const sessionId = await SessionModel.add(
            this.tokenDomainId!,
            agentId,
            recordUid,
            'client',
            `Client ${this.clientId} Session`,
            undefined,
            this.clientId,
        );
        this.currentSessionId = sessionId;
        logger.info('Created new client session: clientId=%d, sessionId=%s', 
            this.clientId, sessionId.toString());
    }

    async message(msg: any) {
        if (!this.accepted || !this.clientId || !this.clientDocId || !this.token) return;

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

        // Support Ejunz protocol (widget control)
        if (msg.protocol === 'ejunz') {
            logger.debug('Received ejunz protocol message: clientId=%d, action=%s', 
                this.clientId, msg.action);
            
            // Handle handshake message from projection system
            if (msg.action === 'handshake') {
                logger.info('Received ejunz handshake from client: clientId=%d, payload=%o', 
                    this.clientId, msg.payload);
                
                // Extract widget list from handshake payload if available
                // Support multiple possible locations for widget list
                let widgetList = null;
                if (msg.payload?.widgets && Array.isArray(msg.payload.widgets)) {
                    widgetList = msg.payload.widgets;
                } else if (msg.widgets && Array.isArray(msg.widgets)) {
                    widgetList = msg.widgets;
                } else if (msg.payload?.widgetList && Array.isArray(msg.payload.widgetList)) {
                    widgetList = msg.payload.widgetList;
                }
                
                if (widgetList && widgetList.length > 0) {
                    // 存储组件列表到内存（保持向后兼容）
                    this.widgetList = widgetList;
                    
                    // 注册组件到数据库
                    try {
                        const registeredWidgets = await ClientWidgetModel.syncWidgets(
                            this.tokenDomainId || this.domain._id,
                            this.clientId,
                            widgetList
                        );
                        logger.info('Widgets registered to database: clientId=%d, count=%d, widgets=%o', 
                            this.clientId, registeredWidgets.length, registeredWidgets.map(w => w.widgetName));
                    } catch (error) {
                        logger.error('Failed to register widgets to database: clientId=%d, error=%o', 
                            this.clientId, error);
                    }
                    
                    logger.info('Widget list received in handshake: clientId=%d, count=%d, widgets=%o', 
                        this.clientId, widgetList.length, widgetList);
                    // Emit event to notify status WebSocket connections
                    (this.ctx.emit as any)('client/widget/list', this.clientId, widgetList);
                } else {
                    logger.debug('No widget list found in handshake message: clientId=%d', this.clientId);
                }
                
                // 处理GSI字段定义
                const gsiFields = msg.payload?.gsiFields;
                if (gsiFields && typeof gsiFields === 'object') {
                    try {
                        const registeredFields = await ClientGsiFieldModel.syncGsiFields(
                            this.tokenDomainId || this.domain._id,
                            this.clientId,
                            gsiFields
                        );
                        logger.info('GSI fields registered to database: clientId=%d, count=%d', 
                            this.clientId, registeredFields.length);
                    } catch (error) {
                        logger.error('Failed to register GSI fields to database: clientId=%d, error=%o', 
                            this.clientId, error);
                    }
                } else {
                    logger.debug('No GSI fields found in handshake message: clientId=%d', this.clientId);
                }
                
                // 处理组件配置
                const widgetConfigs = msg.payload?.widgetConfigs;
                if (widgetConfigs && typeof widgetConfigs === 'object') {
                    try {
                        const updatedWidgets = await ClientWidgetModel.syncWidgetConfigs(
                            this.tokenDomainId || this.domain._id,
                            this.clientId,
                            widgetConfigs
                        );
                        logger.info('Widget configs synced to database: clientId=%d, count=%d', 
                            this.clientId, Object.keys(widgetConfigs).length);
                        // 发出配置更新事件，通知前端
                        (this.ctx.emit as any)('client/widget/config/update', this.clientId, widgetConfigs);
                    } catch (error) {
                        logger.error('Failed to sync widget configs to database: clientId=%d, error=%o', 
                            this.clientId, error);
                    }
                } else {
                    logger.debug('No widget configs found in handshake message: clientId=%d', this.clientId);
                }
                
                // Send handshake acknowledgment (optional, if needed by protocol)
                return;
            }
            
            // Handle widget/config/update message from projection system
            if (msg.action === 'widget/config/update') {
                logger.info('Received widget config update from client: clientId=%d, payload=%o', 
                    this.clientId, msg.payload);
                
                const widgetConfigs = msg.payload?.widgetConfigs;
                if (widgetConfigs && typeof widgetConfigs === 'object') {
                    try {
                        const updatedWidgets = await ClientWidgetModel.syncWidgetConfigs(
                            this.tokenDomainId || this.domain._id,
                            this.clientId,
                            widgetConfigs
                        );
                        logger.info('Widget configs updated in database: clientId=%d, count=%d', 
                            this.clientId, Object.keys(widgetConfigs).length);
                        // 发出配置更新事件，通知前端
                        (this.ctx.emit as any)('client/widget/config/update', this.clientId, widgetConfigs);
                    } catch (error) {
                        logger.error('Failed to update widget configs in database: clientId=%d, error=%o', 
                            this.clientId, error);
                    }
                } else {
                    logger.warn('Invalid widget config update message: clientId=%d, payload=%o', 
                        this.clientId, msg.payload);
                }
                return;
            }
            
            // Handle control/ack messages (responses from projection system)
            if (msg.action === 'control/ack' || msg.action === 'error') {
                logger.debug('Received widget control response: clientId=%d, action=%s, traceId=%s', 
                    this.clientId, msg.action, msg.traceId);
                // Forward to status WebSocket for UI updates
                (this.ctx.emit as any)('client/widget/response', this.clientId, msg);
                
                // 如果是control/ack，发出widget状态更新事件，供场景系统监听
                if (msg.action === 'control/ack' && msg.payload) {
                    const widgetName = msg.payload.widgetName;
                    const visible = msg.payload.visible;
                    if (widgetName !== undefined && typeof visible === 'boolean') {
                        const domainId = this.tokenDomainId || this.domain._id;
                        
                        // 更新内存中的组件状态
                        this.setWidgetState(widgetName, visible);
                        
                        // 通过WebSocket同步状态到前端
                        (this.ctx.emit as any)('client/widget/state/update', this.clientId, widgetName, visible);
                        
                        logger.info('Emitting client/widget/update event: clientId=%d, domainId=%s, widgetName=%s, visible=%s', 
                            this.clientId, domainId, widgetName, visible);
                        (this.ctx.emit as any)('client/widget/update', this.clientId, widgetName, visible, domainId);
                    }
                }
                return;
            }
            
            // Handle widget state update messages (when client actively changes widget state)
            if (msg.action === 'state/update' || msg.action === 'widget/update') {
                logger.info('Received widget state update: clientId=%d, action=%s, payload=%o', 
                    this.clientId, msg.action, msg.payload);
                
                if (msg.payload) {
                    const widgetName = msg.payload.widgetName;
                    const visible = msg.payload.visible;
                    if (widgetName !== undefined && typeof visible === 'boolean') {
                        const domainId = this.tokenDomainId || this.domain._id;
                        
                        // 更新内存中的组件状态
                        this.setWidgetState(widgetName, visible);
                        
                        // 通过WebSocket同步状态到前端
                        (this.ctx.emit as any)('client/widget/state/update', this.clientId, widgetName, visible);
                        
                        logger.info('Emitting client/widget/update event from state update: clientId=%d, domainId=%s, widgetName=%s, visible=%s', 
                            this.clientId, domainId, widgetName, visible);
                        (this.ctx.emit as any)('client/widget/update', this.clientId, widgetName, visible, domainId);
                    }
                }
                return;
            }
            
            // Handle GSI data update messages
            if (msg.action === 'gsi/update') {
                logger.debug('Received GSI update: clientId=%d, payload=%o', this.clientId, msg.payload);
                
                if (msg.payload && msg.payload.data) {
                    const domainId = this.tokenDomainId || this.domain._id;
                    const gsiData = msg.payload.data;
                    const timestamp = msg.payload.timestamp || Date.now();
                    
                    // 更新GSI字段的当前值
                    try {
                        await ClientGsiFieldModel.updateFieldValues(domainId, this.clientId, gsiData);
                    } catch (error) {
                        logger.error('Failed to update GSI field values: clientId=%d, error=%o', 
                            this.clientId, error);
                    }
                    
                    logger.info('Emitting client/gsi/update event: clientId=%d, domainId=%s', 
                        this.clientId, domainId);
                    (this.ctx.emit as any)('client/gsi/update', this.clientId, gsiData, timestamp, domainId);
                }
                return;
            }
        }

        // Support MCP Envelope protocol (same as node/provider)
        if (EdgeServerConnectionHandler.isBridgeEnvelope(msg)) {
            const envelope = EdgeServerConnectionHandler.normalizeEnvelope(
                msg,
                this.token,
                'inbound',
                this.domain._id,
            );
            // Auto-fill clientId from edge association if missing
            await this.autoFillClientIdFromEdge(envelope);
            if (envelope.protocol === 'mcp') {
                const rpcPayload = EdgeServerConnectionHandler.extractJsonRpcPayload(envelope);
                if (rpcPayload) {
                    await this.handleMcpJsonRpcMessage(rpcPayload);
                }
            }
            (this.ctx.emit as any)('edge/ws/inbound', this.token, envelope);
            return;
        }

        // Support JSON-RPC messages (MCP protocol)
        if (EdgeServerConnectionHandler.isJsonRpcMessage(msg)) {
            await this.handleMcpJsonRpcMessage(msg);
            const normalized = EdgeServerConnectionHandler.normalizeEnvelope(
                {
                    protocol: 'mcp',
                    action: 'jsonrpc',
                    payload: msg,
                },
                this.token,
                'inbound',
                this.domain._id,
            );
            // Auto-fill clientId from edge association if missing
            await this.autoFillClientIdFromEdge(normalized);
            (this.ctx.emit as any)('edge/ws/inbound', this.token, normalized);
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
                    
                    if (event !== 'client/asr/audio') {
                        logger.info('Client published event: clientId=%d, event=%s, payload=%o', this.clientId, event, payload);
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

        const type = msg.type || msg.key;

        if (type) {
            logger.info('Client message received: clientId=%d, type=%s, keys=%s', 
                this.clientId, type, Object.keys(msg).join(','));
        }

        if (!type) {
            logger.warn('Client message without type: clientId=%d, msg=%o', this.clientId, msg);
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
                    if (!this.tokenDomainId) {
                        logger.warn('Cannot update client status: tokenDomainId is not set');
                        return;
                    }
                    await ClientModel.updateStatus(this.tokenDomainId, this.clientId, status, errorMessage);
                    logger.info('Client status update event published: clientId=%d, status=%s', this.clientId, status);
                    (this.ctx.emit as any)('client/status/update', this.clientId);
                }
            } catch (error: any) {
                logger.error('Failed to update status: %s', error.message);
            }
            break;
        case 'voice_chat':
            await this.handleVoiceChat(msg);
            break;
        case 'tools/call':
            // Handle tool call response in legacy format: { type: 'tools/call', result: ..., name: ..., requestId: ... }
            // This is for backward compatibility with clients that return results in legacy format
            if (msg.result !== undefined || msg.error !== undefined) {
                const requestId = msg.requestId;
                const toolName = msg.name || (requestId ? this.pendingToolCallNames.get(requestId) : null);
                
                if (toolName) {
                    // Trigger the result event that handleMcpJsonRpcMessage is waiting for
                    logger.debug('Received tool call result (legacy format): clientId=%d, tool=%s, requestId=%s', 
                        this.clientId, toolName, requestId);
                    (this.ctx.emit as any)(`client/tools/call/result/${toolName}`, msg.result);
                    if (requestId) {
                        this.pendingToolCallNames.delete(requestId);
                    }
                    return;
                }
            }
            // If not a response, treat as regular event
            logger.info('Client published event: clientId=%d, event=client/%s', this.clientId, type);
            const args = [`client/${type}`, this.clientId, msg];
            (this.ctx.parallel as any).apply(this.ctx, args);
            break;
        default:
            if (type && type !== 'ping' && type !== 'status' && type !== 'voice_chat' && type !== 'tools/call') {
                try {
                    if (type === 'asr/audio' && msg.audio) {
                        const args = [`client/${type}`, this.clientId, [{ audio: msg.audio }]];
                        (this.ctx.parallel as any).apply(this.ctx, args);
                    } else {
                        logger.info('Client published event: clientId=%d, event=client/%s', this.clientId, type);
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
                    logger.error('ASR WebSocket connection timeout (waiting for existing connection): clientId=%d', this.clientId);
                    if (this.asrWs && this.asrWs.readyState !== 1) {
                        try {
                            this.asrWs.removeAllListeners();
                            this.asrWs.close();
                        } catch (e) {
                            // ignore
                        }
                        this.asrWs = null;
                    }
                    this.asrTaskId = null;
                    reject(new Error('ASR WebSocket connection timeout'));
                }, 5000);
                
                const checkInterval = setInterval(() => {
                    if (this.asrWs && this.asrWs.readyState === 1) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        resolve();
                    } else if (this.asrWs && this.asrWs.readyState === 3) {
                        clearInterval(checkInterval);
                        clearTimeout(timeout);
                        try {
                            this.asrWs.removeAllListeners();
                        } catch (e) {
                            // ignore
                        }
                        this.asrWs = null;
                        this.asrTaskId = null;
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
                    if (this.asrWs) {
                        try {
                            this.asrWs.removeAllListeners();
                            this.asrWs.close();
                        } catch (e) {
                            // ignore
                        }
                        this.asrWs = null;
                    }
                    this.asrTaskId = null;
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
                    if (this.asrWs) {
                        try {
                            this.asrWs.removeAllListeners();
                            this.asrWs.close();
                        } catch (e) {
                            // ignore
                        }
                        this.asrWs = null;
                    }
                    this.asrTaskId = null;
                    reject(error);
                });

                this.asrWs!.on('close', (code: number, reason: Buffer) => {
                    logger.warn('ASR WebSocket closed: clientId=%d, code=%d, reason=%s', 
                        this.clientId, code, reason?.toString() || '');
                    addClientLog(this.clientId, 'warn', `ASR WebSocket closed: code=${code}, reason=${reason?.toString() || ''}`);
                    clearTimeout(connectionTimeout);
                    if (this.asrWs) {
                        try {
                            this.asrWs.removeAllListeners();
                        } catch (e) {
                            // ignore
                        }
                        this.asrWs = null;
                    }
                    this.asrTaskId = null;
                    this.asrInitResolved = false;
                    if (this.asrInitPromise) {
                        this.asrInitPromise.reject(new Error(`ASR WebSocket closed: ${reason?.toString() || 'unknown reason'}`));
                        this.asrInitPromise = null;
                    }
                    this.sendEvent('asr/error', [{ message: 'ASR WebSocket connection closed' }]);
                });

                        this.asrWs!.on('message', (data: Buffer) => {
                        try {
                            const rawData = data.toString();
                            const message = JSON.parse(rawData);
                            
                            const importantAsrTypes = ['conversation.item.input_audio_transcription.completed', 'error', 'session.created'];
                            if (importantAsrTypes.includes(message.type)) {
                                logger.info('ASR message: clientId=%d, type=%s, event_id=%s', 
                                    this.clientId, 
                                    message.type || 'unknown',
                                    message.event_id || 'none');
                            }
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
                                logger.debug('ASR unknown message type: clientId=%d, type=%s', 
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
            const importantEvents = ['agent/done', 'client/agent/done', 'agent/error', 'agent/content', 'asr/result', 'tts/done'];
            if (importantEvents.includes(event)) {
                logger.info('Client event sent: clientId=%d, event=%s, payload length=%d', 
                    this.clientId, event, payload.length);
            }
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
            // 清理失败的连接
            if (this.asrWs) {
                try {
                    this.asrWs.removeAllListeners();
                    this.asrWs.close();
                } catch (e) {
                    // ignore
                }
                this.asrWs = null;
            }
            this.asrTaskId = null;
            this.sendEvent('asr/error', [{ message: `ASR connection failed: ${error.message}` }]);
            return;
        }

        if (!this.asrWs || this.asrWs.readyState !== 1) { // 1 = OPEN
            logger.warn('ASR WebSocket not connected after ensure: clientId=%d, readyState=%d', 
                this.clientId, this.asrWs?.readyState || -1);
            // 清理无效的连接
            if (this.asrWs && this.asrWs.readyState !== 1) {
                try {
                    this.asrWs.removeAllListeners();
                    this.asrWs.close();
                } catch (e) {
                    // ignore
                }
                this.asrWs = null;
                this.asrTaskId = null;
            }
            this.sendEvent('asr/error', [{ message: 'ASR WebSocket not connected, please retry' }]);
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
                
                // ASR 音频处理很频繁，不记录日志（减少噪音）

                if (!this.asrTaskId) {
                    logger.warn('ASR task not initialized: clientId=%d', this.clientId);
                    this.sendEvent('asr/error', [{ message: 'ASR task not initialized' }]);
                    return;
                }
                
                const audioMessage = {
                    type: 'input_audio_buffer.append',
                    audio: audioBase64,
                };
                
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
        try {
            await this.ensureAsrConnection();
        } catch (error: any) {
            logger.error('Failed to ensure ASR connection on recording start: %s', error.message);
            // 清理失败的连接
            if (this.asrWs) {
                try {
                    this.asrWs.removeAllListeners();
                    this.asrWs.close();
                } catch (e) {
                    // ignore
                }
                this.asrWs = null;
            }
            this.asrTaskId = null;
            this.sendEvent('asr/error', [{ message: `ASR connection failed: ${error.message}` }]);
        }
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
                        const message = JSON.parse(rawData);
                        
                        // 只记录重要的 TTS 消息类型（减少日志噪音）
                        const importantTtsTypes = ['session.created', 'response.audio.done', 'error', 'response.done'];
                        if (importantTtsTypes.includes(message.type)) {
                            logger.info('TTS message: clientId=%d, type=%s', 
                                this.clientId, message.type || 'unknown');
                        }
                        
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
                                
                                // TTS generation finished, release all pending agent/done events
                                for (const [recordId, recordInfo] of this.pendingAgentDoneRecords.entries()) {
                                    logger.info('Sending agent/done after TTS completion: clientId=%d, rid=%s', 
                                        this.clientId, recordId);
                                    this.sendEvent('agent/done', [{
                                        taskRecordId: recordInfo.taskRecordId,
                                        message: recordInfo.message,
                                    }]);
                                    this.sendEvent('client/agent/done', [{
                                        taskRecordId: recordInfo.taskRecordId,
                                        message: recordInfo.message,
                                    }]);
                                }
                                this.pendingAgentDoneRecords.clear();
                            }
                        } else if (message.type === 'error') {
                            const errorMsg = message.error?.message || 'TTS task failed';
                            addClientLog(this.clientId, 'error', `TTS error: ${errorMsg}`);
                            this.sendEvent('tts/error', [{ message: errorMsg }]);
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
        // TTS append 和 commit 很频繁，不记录日志（减少噪音）
        const commitEvent = {
            type: 'input_text_buffer.commit',
        };
        this.ttsWs.send(JSON.stringify(commitEvent));
        this.pendingCommits++;
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

    async handleVoiceChat(msg: any) {
        const isSystemMessage = msg.isSystemMessage === true;
        const message = msg.message || msg.text;
        
        if (!message || typeof message !== 'string') {
            this.sendEvent('agent/error', [{ message: 'Invalid message content' }]);
            return;
        }
        
        await this.handleAgentChat({
            message,
            history: msg.history || [],
            createTaskRecord: msg.createTaskRecord !== false,
            isSystemMessage,
        });
    }

    // MCP protocol support (same as node/provider)
    private async handleMcpJsonRpcMessage(msg: any) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.method) {
            const requestId = msg.id;
            const reply = (result: any) => {
                if (requestId === undefined || requestId === null) return;
                this.send({
                    jsonrpc: '2.0',
                    id: requestId,
                    result,
                });
            };

            if (msg.method === 'initialize') {
                logger.info('Client sent initialize request: clientId=%d, token=%s', this.clientId, this.token);
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
                logger.info('Client initialized: clientId=%d, token=%s', this.clientId, this.token);
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

            if (msg.method === 'notifications/tools-update') {
                // Handle tools update notification (no id, just notification)
                logger.debug('Received tools update notification: clientId=%d, token=%s', this.clientId, this.token);
                if (msg.params && msg.params.tools && Array.isArray(msg.params.tools)) {
                    await this.handleToolsList(msg.params.tools);
                }
                return;
            }

            if (msg.method === 'tools/call') {
                // Handle tool call request from server (same as node/provider)
                const toolName = msg.params?.name;
                const toolArgs = msg.params?.arguments || msg.params?.args || {};

                if (!toolName) {
                    if (requestId !== undefined && requestId !== null) {
                        this.send({
                            jsonrpc: '2.0',
                            id: requestId,
                            error: { code: -32602, message: 'Invalid params: tool name is required' },
                        });
                    }
                    return;
                }

                logger.debug('Received tool call request: clientId=%d, token=%s, tool=%s, id=%s', 
                    this.clientId, this.token, toolName, requestId);

                try {
                    // Call tool via event system (same as legacy client/tools/call event)
                    const result = await new Promise<any>((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            reject(new Error(`Tool call timeout: ${toolName}`));
                        }, 8000);

                        const handler = async (...args: any[]) => {
                            clearTimeout(timeout);
                            try {
                                const [toolResult] = args;
                                resolve(toolResult);
                            } catch (error) {
                                reject(error);
                            }
                        };

                        // Subscribe to tool result event
                        const dispose = this.ctx.once(`client/tools/call/result/${toolName}` as any, handler as any);
                        
                        // Store toolName for requestId to handle legacy response format
                        if (requestId) {
                            this.pendingToolCallNames.set(String(requestId), toolName);
                        }
                        
                        // Emit tool call event
                        (this.ctx.parallel as any)('client/tools/call', this.clientId, {
                            name: toolName,
                            arguments: toolArgs,
                            requestId: requestId,
                        });

                        // Fallback: if no response in 8 seconds, reject
                        setTimeout(() => {
                            dispose();
                            if (!timeout) return; // Already resolved
                            clearTimeout(timeout);
                            reject(new Error(`Tool call timeout: ${toolName}`));
                        }, 8000);
                    });

                    // Send JSON-RPC response
                    if (requestId !== undefined && requestId !== null) {
                        // MCP protocol expects result in format: { content: [{ type: 'text', text: ... }] }
                        const mcpResult = {
                            content: [
                                {
                                    type: 'text',
                                    text: typeof result === 'string' ? result : JSON.stringify(result),
                                },
                            ],
                        };
                        reply(mcpResult);
                    }
                } catch (error: any) {
                    logger.error('Tool call failed: clientId=%d, tool=%s, error=%s', 
                        this.clientId, toolName, error.message);
                    if (requestId !== undefined && requestId !== null) {
                        this.send({
                            jsonrpc: '2.0',
                            id: requestId,
                            error: { code: -32000, message: error.message || 'Tool call failed' },
                        });
                    }
                }
                return;
            }

            logger.debug('Unknown JSON-RPC method from client: clientId=%d, method=%s', this.clientId, msg.method);
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
            // Handle tool call responses
            if (msg.id !== undefined) {
                const rec = this.pendingToolCalls.get(String(msg.id));
                if (rec) {
                    this.pendingToolCalls.delete(String(msg.id));
                    clearTimeout(rec.timeout);
                    logger.debug('Tool call response received: clientId=%d, token=%s, id=%s, hasError=%s', 
                        this.clientId, this.token, msg.id, !!msg.error);
                    if ('error' in msg && msg.error) {
                        rec.reject(new Error(msg.error.message || 'Tool call failed'));
                    } else {
                        rec.resolve(msg.result);
                    }
                    return;
                }
            }
            
            // Handle tools list responses
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

    private async handleToolsList(tools: any[]) {
        if (!this.accepted || !this.token || !this.clientId) return;
        
        try {
            if (!Array.isArray(tools)) {
                logger.warn('Invalid tools format from client: clientId=%d, token=%s, tools=%j', this.clientId, this.token, tools);
                return;
            }

            const edge = await EdgeModel.getByToken(this.domain._id, this.token);
            if (!edge) {
                logger.error('Edge not found: clientId=%d, token=%s', this.clientId, this.token);
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

            logger.info('Syncing %d tools from client: clientId=%d, token=%s', validTools.length, this.clientId, this.token);
            
            await ToolModel.syncToolsFromEdge(
                this.domain._id,
                this.token,
                edge.docId,
                validTools,
                edge.owner,
            );
            
            this.send({ type: 'tools/synced', count: validTools.length });
            
            (this.ctx.emit as any)('mcp/server/status/update', this.token);
            (this.ctx.emit as any)('mcp/tools/update', this.token);
            
            logger.info('Tools synced successfully: clientId=%d, token=%s, count=%d', this.clientId, this.token, validTools.length);
        } catch (error: any) {
            logger.error('Failed to sync tools from client: clientId=%d, token=%s, error=%s', 
                this.clientId, this.token, error.message);
        }
    }

    private async autoFillClientIdFromEdge(envelope: EdgeBridgeEnvelope) {
        if (!this.token) return;
        
        try {
            const edge = await EdgeModel.getByToken(this.domain._id, this.token);
            if (edge && edge.clientId && !envelope.nodeId) {
                // For client, we don't use nodeId, but we can use clientId if needed
                // The envelope protocol uses nodeId for MQTT, but client uses different mechanism
                logger.debug('Auto-filled clientId from edge association: token=%s, clientId=%d', this.token, edge.clientId);
            }
        } catch (error) {
            logger.debug('Failed to auto-fill clientId from edge: token=%s, error=%s', this.token, (error as Error).message);
        }
    }

    // MCP tool call support (same as EdgeServerConnectionHandler)
    async callTool(name: string, args: any): Promise<any> {
        if (!this.accepted || !this.token) {
            throw new Error('Connection not ready');
        }

        // Use string ID (same as EdgeServerConnectionHandler)
        const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const jsonRpcRequest = {
            jsonrpc: '2.0',
            id: requestId,
            method: 'tools/call',
            params: {
                name,
                arguments: args,
            },
        };

        // Wrap in Edge Envelope format (same as node/provider)
        const envelope: EdgeBridgeEnvelope = {
            protocol: 'mcp',
            action: 'jsonrpc',
            payload: jsonRpcRequest,
            token: this.token,
            domainId: this.domain._id,
            direction: 'outbound',
        };

        logger.debug('Sending tool call request (envelope): clientId=%d, token=%s, tool=%s, id=%s, args=%j', 
            this.clientId, this.token, name, requestId, args);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.pendingToolCalls.has(requestId)) {
                    this.pendingToolCalls.delete(requestId);
                    logger.warn('Tool call timeout: clientId=%d, token=%s, tool=%s, id=%s', 
                        this.clientId, this.token, name, requestId);
                    reject(new Error(`Tool call timeout: ${name}`));
                }
            }, 10000);

            this.pendingToolCalls.set(requestId, { resolve, reject, timeout });
            // Store toolName for requestId to handle legacy response format
            this.pendingToolCallNames.set(requestId, name);
            try {
                // Send as Edge Envelope format (same as node/provider)
                this.send(envelope);
            } catch (e) {
                clearTimeout(timeout);
                this.pendingToolCalls.delete(requestId);
                this.pendingToolCallNames.delete(requestId);
                reject(e);
            }
        });
    }

    async handleAgentChat(msg: any) {
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
        // 强制所有请求都创建task，必须通过worker处理
        const createTaskRecord = true;

        if (!message || typeof message !== 'string') {
            logger.warn('handleAgentChat: Invalid message: clientId=%d, message=%o', this.clientId, message);
            this.sendEvent('agent/error', [{ message: 'Invalid message content' }]);
            addClientLog(this.clientId, 'error', 'Invalid message content');
            return;
        }

        if (createTaskRecord) {
            // 所有请求都必须通过worker处理，创建task让worker处理
            const recordUid = this.client.owner; // Use cached owner, don't query
            
            // Get or create session (use cached if available)
            let sessionId = this.currentSessionId;
            if (!sessionId) {
                // Only create session if we don't have one cached
                sessionId = await SessionModel.add(
                    this.domain._id,
                    agentConfig.agentId,
                    recordUid,
                    'client',
                    `Client ${this.clientId} Session`,
                    undefined,
                    this.clientId,
                );
                this.currentSessionId = sessionId;
            }
            
            // Create task record immediately (minimal blocking operation)
            const taskRecordId = await record.addTask(
                this.domain._id,
                agentConfig.agentId,
                recordUid,
                message,
                sessionId,
            );
            
            // 不再设置状态为PROCESSING，让worker处理
            // 不再直接调用processAgentChatInternal，worker会处理所有逻辑
            
            // Subscribe to record immediately to receive updates from worker
            this.subscribeRecord(taskRecordId.toString(), agentConfig.agentId);
            
            // Send task_created event immediately (stage 1 response)
            this.sendEvent('agent/task_created', [{
                taskRecordId: taskRecordId.toString(),
                sessionId: sessionId.toString(),
                message: 'Task created, processing by worker',
            }]);
            
            logger.info('Task created for client, worker will handle: clientId=%d, taskRecordId=%s', 
                this.clientId, taskRecordId.toString());
            
            // Load agent info and create task asynchronously (don't block response)
            (async () => {
                try {
                    // Load agent info
                    const agents = await AgentModel.getMulti(this.domain._id, { aid: agentConfig.agentId }, AgentModel.PROJECTION_DETAIL).toArray();
                    if (agents.length === 0) {
                        logger.error('handleAgentChat: Agent not found: clientId=%d, agentId=%s', this.clientId, agentConfig.agentId);
                        this.sendEvent('agent/error', [{ message: 'Agent not found' }]);
                        addClientLog(this.clientId, 'error', `Agent not found: ${agentConfig.agentId}`);
                        return;
                    }
                    const agent = agents[0];
                    
                    // Get domain info for API
                    const domainInfo = await domain.get(this.domain._id);
                    if (!domainInfo) {
                        logger.error('Domain not found: %s', this.domain._id);
                        return;
                    }
                    
                    // 收集完整的上下文信息，供 worker 使用
                    const { getAssignedTools } = require('./agent');
                    const tools = await getAssignedTools(this.domain._id, agent.mcpToolIds, agent.repoIds);
                    
                    const agentPrompt = agent.content || '';
                    let systemMessage = agentPrompt;
                    
                    if (agent.memory) {
                        const truncateMemory = (memory: string, maxLength: number = 2000): string => {
                            if (!memory || memory.length <= maxLength) {
                                return memory;
                            }
                            return memory.substring(0, maxLength) + '\n\n[... Memory truncated, keeping most important rules ...]';
                        };
                        const truncatedMemory = truncateMemory(agent.memory);
                        systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${truncatedMemory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
                    }
                    
                    const context = {
                        apiKey: (domainInfo as any)['apiKey'] || '',
                        model: (domainInfo as any)['model'] || 'deepseek-chat',
                        apiUrl: (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions',
                        agentContent: agent.content || '',
                        agentMemory: agent.memory || '',
                        tools: tools.map(tool => ({
                            name: tool.name,
                            description: tool.description,
                            inputSchema: tool.inputSchema,
                            token: tool.token,
                            edgeId: tool.edgeId,
                        })),
                        systemMessage,
                    };
                    
                    // Create task for worker to process
                    const taskModel = require('../model/task').default;
                    await taskModel.add({
                        type: 'task',
                        recordId: taskRecordId,
                        sessionId,
                        domainId: this.domain._id,
                        agentId: agentConfig.agentId,
                        uid: recordUid,
                        message,
                        history: JSON.stringify(history),
                        context,
                        priority: 0,
                    });
                    
                    logger.info('Task created for worker: clientId=%d, taskRecordId=%s', 
                        this.clientId, taskRecordId.toString());
                } catch (error: any) {
                    logger.error('Failed to create task: %s', error.message);
                    this.sendEvent('agent/error', [{ message: error.message }]);
                }
            })();
            
            // Handle remaining operations asynchronously (don't block response)
            (async () => {
                try {
                    if (!this.tokenDomainId) return;
                    // Update session last activity
                    await SessionModel.update(this.tokenDomainId, sessionId, {
                        lastActivityAt: new Date(),
                    });
                    
                    // Add record to session
                    await SessionModel.addRecord(this.tokenDomainId, sessionId, taskRecordId);
                } catch (error: any) {
                    logger.error('Failed to update session: %s', error.message);
                }
            })();
            
            return;
        }

        // 所有请求都必须创建task并通过worker处理，不再支持直接处理模式
        logger.error('handleAgentChat: createTaskRecord must be true, all requests must go through worker: clientId=%d', this.clientId);
        this.sendEvent('agent/error', [{ message: 'All requests must create task and be processed by worker' }]);
        return;
    }

    private subscribeRecord(rid: string, agentId: string) {
        if (this.subscribedRecordIds.has(rid)) {
            logger.debug('Record already subscribed: clientId=%d, rid=%s', this.clientId, rid);
            return;
        }
        
        this.subscribedRecordIds.add(rid);
        
        const dispose = this.ctx.on('record/change' as any, async (rdoc: any) => {
            const r = rdoc as any;
            if (!r || !r._id) return;
            
            const recordId = r._id.toString();
            if (recordId !== rid) return;
            if (r.agentId !== agentId) return;
            if (r.domainId !== this.domain._id) return;
            
            if (r.status === STATUS.STATUS_TASK_DELIVERED || r.status === STATUS.STATUS_TASK_ERROR_SYSTEM) {
                logger.info('Record status changed: clientId=%d, rid=%s, status=%s', 
                    this.clientId, recordId, r.status);
            }
            
            try {
                const fullRecord = await record.get(this.domain._id, new ObjectId(rid));
                if (!fullRecord) {
                    logger.warn('Record not found when processing update: clientId=%d, rid=%s', this.clientId, rid);
                    return;
                }
                
                const recordData = fullRecord as any;
                
                const agentMessages = recordData.agentMessages || [];
                const assistantMessages = agentMessages.filter((msg: any) => msg.role === 'assistant');
                
                if (recordData.status === STATUS.STATUS_TASK_DELIVERED && assistantMessages.length > 0) {
                    // 检查是否已经发送过内容，防止重复发送
                    if (this.sentContentRecordIds.has(rid)) {
                        logger.debug('Content already sent for record, skipping: clientId=%d, rid=%s', this.clientId, rid);
                        return;
                    }
                    
                    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];
                    const content = lastAssistantMessage.content || '';
                    
                    if (content) {
                        // 标记为已发送，防止重复
                        this.sentContentRecordIds.add(rid);
                        
                        logger.info('Sending agent reply to client: clientId=%d, rid=%s, content length=%d', 
                            this.clientId, rid, content.length);
                        
                        this.sendEvent('agent/content', [content]);
                        
                        if (this.client?.settings?.tts) {
                            this.pendingAgentDoneRecords.set(rid, {
                                taskRecordId: rid,
                                message: content,
                            });
                            
                            await this.addTtsText(content).catch((error: any) => {
                                logger.warn('Failed to generate TTS for agent reply: %s', error.message);
                                this.pendingAgentDoneRecords.delete(rid);
                                this.sendEvent('agent/done', [{
                                    taskRecordId: rid,
                                    message: content,
                                }]);
                                this.sendEvent('client/agent/done', [{
                                    taskRecordId: rid,
                                    message: content,
                                }]);
                            });
                        } else {
                            this.sendEvent('agent/done', [{
                                taskRecordId: rid,
                                message: content,
                            }]);
                            this.sendEvent('client/agent/done', [{
                                taskRecordId: rid,
                                message: content,
                            }]);
                        }
                    }
                } else if (recordData.status === STATUS.STATUS_TASK_ERROR_SYSTEM) {
                    const errorMsg = recordData.agentError?.message || 'Task processing failed';
                    logger.error('Task processing failed: clientId=%d, rid=%s, error=%s', 
                        this.clientId, rid, errorMsg);
                    this.sendEvent('agent/error', [{ message: errorMsg }]);
                }
            } catch (error: any) {
                logger.error('Error processing record update for client: clientId=%d, rid=%s, error=%s', 
                    this.clientId, rid, error.message);
            }
        });
        
        this.subscriptions.push({ dispose });
        
        logger.debug('Subscribed to record: clientId=%d, rid=%s, agentId=%s', 
            this.clientId, rid, agentId);
    }

    private registerOutboundBridgeListener() {
        if (!this.token) return;

        if (this.outboundBridgeDisposer) {
            try {
                this.outboundBridgeDisposer();
            } catch {
                // ignore
            }
            this.outboundBridgeDisposer = null;
        }

        const token = this.token;
        this.outboundBridgeDisposer = this.ctx.on('edge/ws/outbound' as any, ((targetToken: string, envelope: EdgeBridgeEnvelope) => {
            if (!this.accepted || !token || targetToken !== token) return;

            try {
                const normalized = EdgeServerConnectionHandler.normalizeEnvelope(
                    envelope,
                    token,
                    'outbound',
                    this.domain._id,
                );
                const outboundPayload = normalized.protocol === 'mcp'
                    ? EdgeServerConnectionHandler.extractJsonRpcPayload(normalized) ?? normalized.payload
                    : normalized;
                this.send(outboundPayload);
            } catch (error) {
                logger.error('Failed to forward outbound edge envelope: token=%s, error=%s', token, (error as Error).message);
            }
        }) as any);
    }

    async cleanup() {
        // Clear pending tool calls
        for (const [id, pending] of this.pendingToolCalls.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Connection closed'));
        }
        this.pendingToolCalls.clear();
        this.pendingToolCallNames.clear();
        
        // Unsubscribe from outbound bridge listener
        if (this.outboundBridgeDisposer) {
            try {
                this.outboundBridgeDisposer();
            } catch {
                // ignore
            }
            this.outboundBridgeDisposer = null;
        }
        
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
        
        // Clear record tracking sets
        this.subscribedRecordIds.clear();
        this.sentContentRecordIds.clear();
        this.pendingAgentDoneRecords.clear();
        
        if (this.clientId && this.accepted) {
            ClientConnectionHandler.active.delete(this.clientId);
            
            if (this.token) {
                EdgeServerConnectionHandler.active.delete(this.token);
            }
            
            try {
                if (this.tokenDomainId) {
                    await ClientModel.updateStatus(this.tokenDomainId, this.clientId, 'disconnected');
                    logger.info('Client status update event published: clientId=%d, status=disconnected', this.clientId);
                    (this.ctx.emit as any)('client/status/update', this.clientId);
                    
                    if (this.token) {
                        const edge = await EdgeModel.getByToken(this.tokenDomainId, this.token);
                        if (edge) {
                            await EdgeModel.update(this.tokenDomainId, edge.eid, { status: 'offline' });
                            (this.ctx.emit as any)('edge/status/update', this.token, 'offline');
                        }
                        (this.ctx.emit as any)('mcp/server/connection/update', this.token, 'disconnected');
                    }
                }
            } catch (error: any) {
                logger.error('Failed to update client status on disconnect: %s', error.message);
            }
        }
        
        // 更新session的最后活动时间（断开连接时）
        if (this.currentSessionId && this.clientId && this.tokenDomainId) {
            try {
                await SessionModel.update(this.tokenDomainId, this.currentSessionId, {
                    lastActivityAt: new Date(),
                });
                logger.info('Updated session lastActivityAt on disconnect: clientId=%d, sessionId=%s', 
                    this.clientId, this.currentSessionId.toString());
            } catch (error: any) {
                logger.warn('Failed to update session lastActivityAt on disconnect: %s', error.message);
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

        // 从数据库读取组件列表（优先），如果数据库没有则从内存读取（向后兼容）
        try {
            const dbWidgets = await ClientWidgetModel.getByClient(this.domain._id, clientIdNum);
            if (dbWidgets && dbWidgets.length > 0) {
                const widgetList = dbWidgets.map(w => ({
                    name: w.widgetName,
                    type: w.type,
                    capabilities: w.capabilities,
                }));
                logger.debug('Sending widget list from database to status WebSocket: clientId=%d, count=%d', 
                    this.clientId, widgetList.length);
                this.send({ type: 'widget-list', widgets: widgetList });
            } else {
                // 如果数据库没有，尝试从内存读取（向后兼容）
                const clientHandler = ClientConnectionHandler.getConnection(clientIdNum);
                if (clientHandler) {
                    const existingWidgetList = clientHandler.getWidgetList();
                    if (existingWidgetList && existingWidgetList.length > 0) {
                        logger.debug('Sending existing widget list from memory to status WebSocket: clientId=%d, count=%d', 
                            this.clientId, existingWidgetList.length);
                        this.send({ type: 'widget-list', widgets: existingWidgetList });
                    }
                }
            }
        } catch (error) {
            logger.error('Failed to load widgets from database: clientId=%d, error=%o', this.clientId, error);
            // 降级到内存读取
            const clientHandler = ClientConnectionHandler.getConnection(clientIdNum);
            if (clientHandler) {
                const existingWidgetList = clientHandler.getWidgetList();
                if (existingWidgetList && existingWidgetList.length > 0) {
                    logger.debug('Sending existing widget list from memory (fallback): clientId=%d, count=%d', 
                        this.clientId, existingWidgetList.length);
                    this.send({ type: 'widget-list', widgets: existingWidgetList });
                }
            }
        }

        // Subscribe to widget list updates
        const dispose2 = (this.ctx as any).on('client/widget/list', async (updateClientId: number, widgets: any[]) => {
            if (updateClientId === this.clientId) {
                logger.debug('Sending widget list to status WebSocket: clientId=%d, count=%d', 
                    this.clientId, widgets.length);
                this.send({ type: 'widget-list', widgets });
            }
        });
        this.subscriptions.push({ dispose: dispose2 });

        // Subscribe to widget control responses
        const dispose3 = (this.ctx as any).on('client/widget/response', async (updateClientId: number, response: any) => {
            if (updateClientId === this.clientId) {
                logger.debug('Forwarding widget response to status WebSocket: clientId=%d', this.clientId);
                this.send({ type: 'widget-response', response });
            }
        });
        this.subscriptions.push({ dispose: dispose3 });
        
        // Subscribe to widget state updates
        const dispose4 = (this.ctx as any).on('client/widget/state/update', async (updateClientId: number, widgetName: string, visible: boolean) => {
            if (updateClientId === this.clientId) {
                logger.debug('Forwarding widget state update to status WebSocket: clientId=%d, widgetName=%s, visible=%s', 
                    this.clientId, widgetName, visible);
                this.send({ type: 'widget-state-update', widgetName, visible });
            }
        });
        this.subscriptions.push({ dispose: dispose4 });
        
        // Subscribe to GSI data updates
        const dispose5 = (this.ctx as any).on('client/gsi/update', async (updateClientId: number, gsiData: any, timestamp: number) => {
            if (updateClientId === this.clientId) {
                logger.debug('Forwarding GSI data update to status WebSocket: clientId=%d', this.clientId);
                this.send({ type: 'gsi-update', data: gsiData, timestamp });
            }
        });
        this.subscriptions.push({ dispose: dispose5 });
        
        // Subscribe to widget config updates
        const dispose6 = (this.ctx as any).on('client/widget/config/update', async (updateClientId: number, widgetConfigs: Record<string, any>) => {
            if (updateClientId === this.clientId) {
                logger.debug('Forwarding widget config update to status WebSocket: clientId=%d, count=%d', 
                    this.clientId, Object.keys(widgetConfigs).length);
                this.send({ type: 'widget-config-update', configs: widgetConfigs });
            }
        });
        this.subscriptions.push({ dispose: dispose6 });
        
        // 发送当前所有组件的状态
        const clientHandler = ClientConnectionHandler.getConnection(clientIdNum);
        if (clientHandler) {
            const widgetStates: Record<string, boolean> = {};
            const widgetList = clientHandler.getWidgetList();
            if (widgetList) {
                for (const widget of widgetList) {
                    const widgetName = typeof widget === 'string' ? widget : widget.name;
                    const state = clientHandler.getWidgetState(widgetName);
                    if (state !== null) {
                        widgetStates[widgetName] = state;
                    }
                }
            }
            if (Object.keys(widgetStates).length > 0) {
                this.send({ type: 'widget-states', states: widgetStates });
            }
        }

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
    ctx.Route('client_settings', '/client/:clientId/settings', ClientSettingsHandler, PRIV.PRIV_USER_PROFILE);
    // Token 生成路由已迁移到 edge 模块
    ctx.Route('client_chat_list', '/client/:clientId/chats', ClientChatListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_chat_detail', '/client/:clientId/chat/:conversationId', ClientChatDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_chat_delete', '/client/chat/delete', ClientChatDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_chat_audio_download', '/client/:clientId/chat/:conversationId/audio/:messageIndex/:audioType', ClientChatAudioDownloadHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_delete_token', '/client/:clientId/delete-token', ClientDeleteTokenHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_update_settings', '/client/:clientId/update-settings', ClientUpdateSettingsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_widget_control', '/client/:clientId/widget/control', ClientWidgetControlHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_gsi_fields', '/client/:clientId/gsi/fields', ClientGsiFieldsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_create_voice', '/client/:clientId/create-voice', ClientCreateVoiceHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_list_voices', '/client/:clientId/voices', ClientListVoicesHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_delete_voice', '/client/:clientId/delete-voice', ClientDeleteVoiceHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_update_voice', '/client/:clientId/update-voice', ClientUpdateVoiceHandler, PRIV.PRIV_USER_PROFILE);
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

    // Agent trigger event (reuse handleAgentChat logic)
    (ctx as any).on('client/agent/trigger', async (clientId: number, ...args: any[]) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            // When published via WebSocket publish: ctx.parallel(event, clientId, payloadArray)
            // payloadArray is [msg], so args will be the elements of payloadArray
            // Extract the actual message object from args
            let msg = args.length > 0 ? args[0] : {};
            
            // Handle nested array case: if msg is an array, extract first element
            if (Array.isArray(msg) && msg.length > 0) {
                msg = msg[0];
            }
            
            // If msg doesn't have a message field, convert the entire payload to a message string
            if (!msg.message && typeof msg === 'object') {
                // Convert the payload object to a JSON string as the message
                msg = {
                    message: JSON.stringify(msg),
                    history: msg.history || [],
                    createTaskRecord: msg.createTaskRecord !== false,
                };
            }
            
            logger.debug('Agent trigger received: clientId=%d, args=%o, msg=%o', clientId, args, msg);
            addClientLog(clientId, 'info', `Agent trigger request: ${msg.message ? msg.message.substring(0, 50) + (msg.message.length > 50 ? '...' : '') : 'no message'}`);
            // Reuse the same logic as handleAgentChat
            await handler.handleAgentChat(msg);
        }
    });

    // Voice chat events (new protocol)
    (ctx as any).on('client/voice_chat', async (clientId: number, msg: any) => {
        const handler = ClientConnectionHandler.getConnection(clientId);
        if (handler) {
            addClientLog(clientId, 'info', `Voice chat request via Cordis: ${msg.message ? msg.message.substring(0, 50) + (msg.message.length > 50 ? '...' : '') : 'no message'}, isSystemMessage=${msg.isSystemMessage || false}`);
            await handler.handleVoiceChat(msg);
        }
    });
}


