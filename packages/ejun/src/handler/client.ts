
import { ObjectId } from 'mongodb';
import { Handler, ConnectionHandler } from '@ejunz/framework';
import { Context } from '../context';
import { ValidationError, PermissionError, NotFoundError } from '../error';
import { Logger } from '../logger';
import ClientModel from '../model/client';
import AgentModel, { McpClient } from '../model/agent';
import domain from '../model/domain';
import * as document from '../model/document';
import { PRIV } from '../model/builtin';
import WebSocket from 'ws';
import request from 'superagent';
import Agent from '../model/agent';

const logger = new Logger('handler/client');

// Get assigned tools (consistent with getAssignedTools in agent.ts)
async function getAssignedTools(domainId: string, mcpToolIds?: ObjectId[]): Promise<any[]> {
    if (!mcpToolIds || mcpToolIds.length === 0) {
        return [];
    }
    
    const assignedTools: any[] = [];
    for (const toolId of mcpToolIds) {
        try {
            const tool = await document.get(domainId, document.TYPE_MCP_TOOL, toolId);
            if (tool) {
                assignedTools.push({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                });
            }
        } catch (error) {
            logger.warn('Invalid tool ID: %s', toolId.toString());
        }
    }
    return assignedTools;
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

export class ClientGenerateTokenHandler extends Handler<Context> {
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

        const wsToken = await ClientModel.generateWsToken();
        await ClientModel.update(this.domain._id, clientIdNum, { wsToken });

        this.response.body = { wsToken };
    }
}

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
    
    static getConnection(clientId: number): ClientConnectionHandler | null {
        return ClientConnectionHandler.active.get(clientId) || null;
    }

    async prepare() {
        const { token } = this.request.query;
        
        if (!token || typeof token !== 'string') {
            this.close(4000, 'Token is required');
            return;
        }

        const clients = await ClientModel.getByDomain(this.domain._id);
        const client = clients.find(c => c.wsToken === token);
        
        if (!client) {
            logger.warn('Client WebSocket connection rejected: Invalid token');
            this.close(4000, 'Invalid token');
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
        this.client = client;
        this.accepted = true;

        // Add to active connections (singleton pattern, one connection per clientId)
        ClientConnectionHandler.active.set(this.clientId, this);

        logger.info('Client WebSocket connected: %s (clientId: %d) from %s', 
            this.clientDocId, this.clientId, this.request.ip);

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
            
            logger.info('handleAgentChat: Fetching domain config: clientId=%d, domainId=%s', this.clientId, this.domain._id);
            const domainInfo = await domain.get(this.domain._id);
            if (!domainInfo) {
                logger.error('handleAgentChat: Domain not found: clientId=%d, domainId=%s', this.clientId, this.domain._id);
                this.sendEvent('agent/error', [{ message: 'Domain not found' }]);
                addClientLog(this.clientId, 'error', 'Domain not found');
                return;
            }

            const apiKey = (domainInfo as any)['apiKey'] || '';
            const model = (domainInfo as any)['model'] || 'deepseek-chat';
            const apiUrl = (domainInfo as any)['apiUrl'] || 'https://api.deepseek.com/v1/chat/completions';

            logger.info('handleAgentChat: Domain config loaded: clientId=%d, model=%s, apiUrl=%s, apiKey length=%d', 
                this.clientId, model, apiUrl, apiKey?.length || 0);
            addClientLog(this.clientId, 'info', `Domain config loaded: model=${model}, apiUrl=${apiUrl}`);

            if (!apiKey) {
                logger.error('handleAgentChat: API Key not configured: clientId=%d', this.clientId);
                this.sendEvent('agent/error', [{ message: 'API Key not configured' }]);
                addClientLog(this.clientId, 'error', 'API Key not configured');
                return;
            }

            // Get assigned tools (filtered by mcpToolIds) - consistent with Agent API
            const tools = await getAssignedTools(this.domain._id, agent.mcpToolIds);

            const agentPrompt = agent.content || '';
            let systemMessage = agentPrompt;
            
            // Add work rules memory (as supplement, not overriding role prompt) - consistent with Agent API
            if (agent.memory) {
                systemMessage += `\n\n---\n【Work Rules Memory - Supplementary Guidelines】\n${agent.memory}\n---\n\n**CRITICAL**: The above work rules contain user guidance for specific questions. When you encounter the same or similar questions mentioned in the memory, you MUST strictly follow the user's guidance without deviation. For example, if the memory says "When user asks xxx, should xxx", you must follow that exactly when the user asks that question.\n\nNote: The above work rules are supplements and refinements to the role definition above, and should not conflict with the role prompt. If there is a conflict between rules and role definition, the role definition (content) takes precedence.`;
            }
            
            // Prohibit using emojis - consistent with Agent API
            if (systemMessage && !systemMessage.includes('do not use emoji') && !systemMessage.includes('不使用表情')) {
                systemMessage += '\n\nNote: Do not use any emoji in your responses.';
            } else if (!systemMessage) {
                systemMessage = 'Note: Do not use any emoji in your responses.';
            }
            
            // Tool usage rules - consistent with Agent API
            if (tools.length > 0) {
                const toolsInfo = '\n\nYou can use the following tools. Use them when appropriate.\n\n' +
                  tools.map(tool => `- ${tool.name}: ${tool.description || ''}`).join('\n') +
                  '\n\n【IMPORTANT RULES - BOTTOM-LEVEL FUNDAMENTAL RULES】You must strictly adhere to the following rules for tool calls:\n1. **ALWAYS speak first before calling tools**: When you need to call a tool, you MUST first stream a message to the user explaining what you are about to do (e.g., "我来搜索一下知识库" / "Let me search the knowledge base", "让我查看一下相关信息" / "Let me check the relevant information"). This gives the user immediate feedback and makes the conversation feel natural and responsive. Only after you have explained what you are doing should you call the tool.\n2. You can only request ONE tool call at a time. It is strictly forbidden to request multiple tools in a single request.\n3. After each tool call completes, you must immediately reply to the user, describing ONLY the result of this tool. Do NOT summarize results from previous tools.\n4. Each tool call response should be independent and focused solely on the current tool\'s result.\n5. After the last tool call completes, you should only reply with the last tool\'s result. Do NOT provide a comprehensive summary of all tools\' results (unless there are clear dependencies between tools that require integration).\n6. It is absolutely forbidden to call multiple tools consecutively without replying to the user.\n7. Tool calls proceed one by one sequentially: first explain what you will do → call one tool → immediately reply with that tool\'s result → decide if another tool is needed.\n8. If multiple tools are needed, proceed one by one: explain what you will do → call the first tool → reply with the first tool\'s result → explain what you will do next → call the second tool → reply with the second tool\'s result, and so on. Each reply should be independent and focused on the current tool.';
                systemMessage = systemMessage + toolsInfo;
            }

            const requestBody: any = {
                model,
                max_tokens: 1024,
                messages: [
                    { role: 'system', content: systemMessage },
                    ...(Array.isArray(history) ? history : []),
                    { role: 'user', content: message },
                ],
                stream: true,
            };

            if (tools.length > 0) {
                requestBody.tools = tools.map((tool: any) => ({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    },
                }));
            }

            let accumulatedContent = '';
            let finishReason = '';
            let toolCalls: any[] = [];
            let iterations = 0;
            const maxIterations = 5;
            let streamFinished = false;
            let waitingForToolCall = false;

            logger.info('handleAgentChat: Starting stream processing: clientId=%d, message length=%d', 
                this.clientId, message.length);
            addClientLog(this.clientId, 'info', `Starting stream processing for Agent chat: message=${message.substring(0, 50)}...`);

            const processStream = async () => {
                try {
                    streamFinished = false;
                    waitingForToolCall = false;
                    
                    logger.info('handleAgentChat: Creating MCP client: clientId=%d', this.clientId);
                    const mcpClient = new McpClient();
                    
                    logger.info('handleAgentChat: Sending request to AI API: clientId=%d, apiUrl=%s', this.clientId, apiUrl);
                    addClientLog(this.clientId, 'info', `Sending request to AI API: ${apiUrl}`);
                    
                    await new Promise<void>((resolve, reject) => {
                        logger.info('handleAgentChat: Creating request: clientId=%d', this.clientId);
                        addClientLog(this.clientId, 'info', `Creating AI API request: ${apiUrl}`);
                        
                        const req = request.post(apiUrl)
                            .send(requestBody)
                            .set('Authorization', `Bearer ${apiKey}`)
                            .set('content-type', 'application/json')
                            .buffer(false)
                            .timeout(60000)
                            .parse((res, callback) => {
                                logger.info('handleAgentChat: Response received: clientId=%d, status=%d', this.clientId, res.statusCode);
                                addClientLog(this.clientId, 'info', `Received AI API response: status=${res.statusCode}`);
                                
                                if (res.statusCode !== 200) {
                                    logger.error('handleAgentChat: API error: clientId=%d, status=%d', this.clientId, res.statusCode);
                                    addClientLog(this.clientId, 'error', `AI API error: status=${res.statusCode}`);
                                    reject(new Error(`API error: ${res.statusCode}`));
                                    return;
                                }
                                
                                res.setEncoding('utf8');
                                let buffer = '';
                                
                                res.on('data', (chunk: string) => {
                                    logger.debug('handleAgentChat: Received data chunk: clientId=%d, length=%d', this.clientId, chunk.length);
                                    if (streamFinished) return;
                                    
                                    buffer += chunk;
                                    const lines = buffer.split('\n');
                                    buffer = lines.pop() || '';
                                    
                                    for (const line of lines) {
                                        if (!line.trim() || !line.startsWith('data: ')) continue;
                                        const data = line.slice(6).trim();
                                        if (data === '[DONE]') {
                                            if (waitingForToolCall) {
                                                callback(null, undefined);
                                                return;
                                            }
                                            streamFinished = true;
                                            this.sendEvent('agent/done', [{
                                                message: accumulatedContent,
                                                history: JSON.stringify([
                                                    ...history,
                                                    { role: 'user', content: message },
                                                    { role: 'assistant', content: accumulatedContent },
                                                ])
                                            }]);
                                            addClientLog(this.clientId, 'info', `Agent chat completed: ${accumulatedContent.substring(0, 50)}...`);
                                            
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
                                                addClientLog(this.clientId, 'debug', `Checking TTS config: ttsConfig=${ttsConfig ? 'configured' : 'not configured'}, content=${accumulatedContent ? 'has content' : 'no content'}`);
                                                
                                                if (this.ttsTextBuffer && this.ttsTextBuffer.trim()) {
                                                    addClientLog(this.clientId, 'info', `Agent reply completed, processing remaining TTS text: ${this.ttsTextBuffer.substring(0, 50)}...`);
                                                    await this.flushTtsSentence(this.ttsTextBuffer);
                                                    this.ttsTextBuffer = '';
                                                }
                                                
                                                if (accumulatedContent && ttsConfig) {
                                                    addClientLog(this.clientId, 'info', 'Agent reply completed, TTS processing completed');
                                                } else {
                                                    if (!accumulatedContent) {
                                                        addClientLog(this.clientId, 'warn', 'Agent reply completed but content is empty, skipping TTS trigger');
                                                    } else if (!ttsConfig) {
                                                        addClientLog(this.clientId, 'warn', 'Agent reply completed but TTS not configured, skipping TTS trigger');
                                                    }
                                                }
                                            })().catch((error: any) => {
                                                logger.error('Failed to process Agent completion for TTS: %s', error.message);
                                                addClientLog(this.clientId, 'error', `Failed to process Agent completion: ${error.message}`);
                                            });
                                            
                                            resolve();
                                            return;
                                        }
                                        
                                        try {
                                            const parsed = JSON.parse(data);
                                            logger.debug('handleAgentChat: Parsed message: clientId=%d, parsed=%o', 
                                                this.clientId, parsed);
                                            const delta = parsed.choices?.[0]?.delta;
                                            
                                            if (delta?.content) {
                                                accumulatedContent += delta.content;
                                                logger.info('handleAgentChat: Sending content chunk: clientId=%d, length=%d, content=%s', 
                                                    this.clientId, delta.content.length, delta.content.substring(0, 50));
                                                addClientLog(this.clientId, 'info', `Sending Agent content chunk: ${delta.content.substring(0, 30)}...`);
                                                this.sendEvent('agent/content', [delta.content]);
                                                
                                                this.addTtsText(delta.content).catch((error: any) => {
                                                    logger.warn('addTtsText failed: %s', error.message);
                                                    addClientLog(this.clientId, 'warn', `TTS text processing failed: ${error.message}`);
                                                });
                                            } else {
                                                logger.debug('handleAgentChat: No content in delta: clientId=%d, delta=%o', 
                                                    this.clientId, delta);
                                            }
                                            
                                            if (delta?.tool_calls) {
                                                waitingForToolCall = true;
                                                for (const toolCall of delta.tool_calls) {
                                                    const index = toolCall.index || 0;
                                                    if (!toolCalls[index]) {
                                                        toolCalls[index] = {
                                                            id: toolCall.id,
                                                            type: 'function',
                                                            function: { name: '', arguments: '' },
                                                        };
                                                    }
                                                    if (toolCall.function?.name) {
                                                        toolCalls[index].function.name += toolCall.function.name;
                                                    }
                                                    if (toolCall.function?.arguments) {
                                                        toolCalls[index].function.arguments += toolCall.function.arguments;
                                                    }
                                                }
                                            }
                                            
                                            if (parsed.choices?.[0]?.finish_reason) {
                                                finishReason = parsed.choices[0].finish_reason;
                                                
                                                if (finishReason === 'tool_calls' && toolCalls.length > 0) {
                                                    this.sendEvent('agent/tool_call', [{ tools: toolCalls }]);
                                                    
                                                    // Execute tool calls
                                                    const executeToolCalls = async () => {
                                                        for (const toolCall of toolCalls) {
                                                            try {
                                                                const toolName = toolCall.function.name;
                                                                const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                                                                
                                                                const tool = tools.find((t: any) => t.name === toolName);
                                                                if (!tool) {
                                                                    this.sendEvent('agent/tool_result', [{
                                                                        tool: toolName,
                                                                        result: { error: `Tool ${toolName} not found` }
                                                                    }]);
                                                                    continue;
                                                                }
                                                                
                                                                addClientLog(this.clientId, 'info', `Calling tool: ${toolName}`);
                                                                const result = await mcpClient.callTool(toolName, toolArgs, this.domain._id);
                                                                this.sendEvent('agent/tool_result', [{
                                                                    tool: toolName,
                                                                    result 
                                                                }]);
                                                                
                                                                // Continue streaming
                                                                iterations++;
                                                                if (iterations < maxIterations) {
                                                                    // Add tool call result to message history
                                                                    const toolMessages = [
                                                                        ...history,
                                                                        { role: 'user', content: message },
                                                                        { role: 'assistant', content: accumulatedContent, tool_calls: toolCalls },
                                                                        { role: 'tool', content: JSON.stringify(result), tool_call_id: toolCall.id },
                                                                    ];
                                                                    
                                                                    requestBody.messages = [
                                                                        { role: 'system', content: systemMessage },
                                                                        ...toolMessages,
                                                                    ];
                                                                    
                                                                    accumulatedContent = '';
                                                                    toolCalls = [];
                                                                    waitingForToolCall = false;
                                                                    
                                                                    await processStream();
                                                                    return;
                                                                }
                                                            } catch (error: any) {
                                                                addClientLog(this.clientId, 'error', `Tool call error: ${error.message}`);
                                                                this.sendEvent('agent/tool_result', [{
                                                                    tool: toolCall.function.name,
                                                                    result: { error: error.message }
                                                                }]);
                                                            }
                                                        }
                                                    };
                                                    
                                                    executeToolCalls().catch((err: any) => {
                                                        logger.error('Tool execution error: %s', err.message);
                                                        addClientLog(this.clientId, 'error', `Tool execution error: ${err.message}`);
                                                    });
                                                } else {
                                                    resolve();
                                                }
                                            }
                                        } catch (e) {
                                            // ignore parse errors
                                        }
                                    }
                                });
                                
                                res.on('end', async () => {
                                    logger.info('handleAgentChat: Response ended: clientId=%d, streamFinished=%s', this.clientId, streamFinished);
                                    if (!streamFinished) {
                                        if (waitingForToolCall && finishReason === 'tool_calls' && toolCalls.length > 0) {
                                            logger.info('handleAgentChat: Waiting for tool call: clientId=%d', this.clientId);
                                            return;
                                        }
                                        logger.info('handleAgentChat: Resolving (end): clientId=%d', this.clientId);
                                        resolve();
                                    }
                                });
                                
                                res.on('error', (err: Error) => {
                                    logger.error('handleAgentChat: Response error: clientId=%d, error=%s', this.clientId, err.message);
                                    addClientLog(this.clientId, 'error', `AI API response error: ${err.message}`);
                                    reject(err);
                                });
                            });
                            
                            req.on('error', (error: Error) => {
                                logger.error('handleAgentChat: Request error: clientId=%d, error=%s', this.clientId, error.message);
                                addClientLog(this.clientId, 'error', `AI API request error: ${error.message}`);
                                reject(error);
                            });
                            
                            req.end((err: any, res: any) => {
                                if (err) {
                                    logger.error('handleAgentChat: Request end error: clientId=%d, error=%s', this.clientId, err.message);
                                    addClientLog(this.clientId, 'error', `AI API request end error: ${err.message}`);
                                    reject(err);
                                } else {
                                    logger.info('handleAgentChat: Request end callback: clientId=%d, status=%d', this.clientId, res?.statusCode);
                                }
                            });
                        });
                } catch (error: any) {
                    logger.error('Agent stream error: %s', error.message);
                    addClientLog(this.clientId, 'error', `Agent stream processing error: ${error.message}`);
                    this.sendEvent('agent/error', [{ message: error.message }]);
                }
            };

            await processStream();
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
            
            try {
                await ClientModel.updateStatus(this.domain._id, this.clientId, 'disconnected');
                (this.ctx.emit as any)('client/status/update', this.clientId);
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
    ctx.Route('client_domain', '/client', ClientDomainHandler);
    ctx.Route('client_create', '/client/create', ClientEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_edit', '/client/:clientId/edit', ClientEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_delete', '/client/delete', ClientDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('client_detail', '/client/:clientId', ClientDetailHandler);
    ctx.Route('client_generate_token', '/client/:clientId/generate-token', ClientGenerateTokenHandler, PRIV.PRIV_USER_PROFILE);
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


