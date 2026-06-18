import os from 'os';
import WebSocket from 'ws';
import { SYSTEM_TOOLS_CATALOG, executeSystemTool } from '../tools';
import { toolsVersion } from '../config';

type PendingRequest = {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
};

function log(level: 'info' | 'warn' | 'error' | 'debug', host: string, message: string, ...args: any[]) {
    const fn = console[level] || console.log;
    fn(`[ejunztools:${host}] ${message}`, ...args);
}

function rpcError(id: any, code: number, message: string) {
    return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(result: unknown) {
    return {
        content: [{
            type: 'text',
            text: result === undefined ? '' : typeof result === 'string' ? result : JSON.stringify(result),
        }],
        structuredContent: result,
    };
}

export default class EjunzToolsWsHost {
    private ws?: WebSocket;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private heartbeatTimer?: ReturnType<typeof setInterval>;
    private reconnectAttempts = 0;
    private disposed = false;
    private pending = new Map<string, PendingRequest>();
    private reqSeq = 0;
    private startedAt = new Date();

    constructor(public config: any) {
        this.config.host ||= this.config.toolsId || os.hostname();
        this.config.token ||= '';
        this.config.toolsLabel ||= 'Ejunz Tools';
        if (!this.config.server_url?.startsWith('http')) this.config.server_url = `http://${this.config.server_url}`;
        if (!this.config.server_url.endsWith('/')) this.config.server_url = `${this.config.server_url}/`;
    }

    connect() {
        this.disposed = false;
        this.openWebSocket();
    }

    async dispose() {
        this.disposed = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error('connection closed'));
        }
        this.pending.clear();
        try { this.ws?.close(1000, 'disposed'); } catch { /* ignore */ }
    }

    private version() {
        return toolsVersion(this.config);
    }

    private wsUrl() {
        const url = new URL('mcp/ws', this.config.server_url);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        if (this.config.token) url.searchParams.set('token', this.config.token);
        return url.toString();
    }

    private send(data: any) {
        if (this.ws?.readyState !== WebSocket.OPEN) return false;
        this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
        return true;
    }

    private request(method: string, params?: any, timeoutMs = 10000) {
        const id = `${Date.now()}-${++this.reqSeq}`;
        const payload = { jsonrpc: '2.0', id, method, params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`rpc timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            if (!this.send(payload)) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('websocket not connected'));
            }
        });
    }

    private initializeParams() {
        return {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            clientInfo: {
                name: '@ejunz/ejunztools',
                version: this.version(),
            },
            ejunz: {
                provider: 'ejunztools',
                mode: 'ws',
                label: this.config.toolsLabel,
                toolsId: this.config.toolsId || this.config.host,
                host: os.hostname(),
                pid: process.pid,
                startedAt: this.startedAt,
            },
        };
    }

    private toolsListResult() {
        return {
            tools: SYSTEM_TOOLS_CATALOG.map((tool) => ({
                name: tool.name || tool.id,
                description: tool.description || '',
                inputSchema: tool.inputSchema || { type: 'object', properties: {} },
            })),
        };
    }

    private openWebSocket() {
        if (this.disposed) return;
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) return;

        const url = this.wsUrl();
        log('info', this.config.host, 'Connecting MCP websocket: %s', url.replace(/token=[^&]+/, 'token=***'));
        const ws = new WebSocket(url);
        this.ws = ws;

        ws.on('open', () => {
            this.reconnectAttempts = 0;
            log('info', this.config.host, 'MCP websocket connected');
            this.request('initialize', this.initializeParams()).catch((e) => log('warn', this.config.host, 'initialize failed: %s', e.message));
            this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
            this.send({ jsonrpc: '2.0', method: 'notifications/tools-update', params: this.toolsListResult() });
            this.heartbeatTimer = setInterval(() => {
                this.send({ type: 'ping', status: 'connected' });
            }, 10000);
        });

        ws.on('message', (data) => {
            const text = data.toString();
            if (text === 'ping') {
                this.send('pong');
                return;
            }
            if (text === 'pong') return;
            let msg: any;
            try {
                msg = JSON.parse(text);
            } catch (e: any) {
                log('warn', this.config.host, 'Invalid websocket message: %s', e?.message || e);
                return;
            }
            this.handleMessage(msg).catch((e) => log('error', this.config.host, 'Failed to handle message: %s', e?.stack || e?.message || e));
        });

        ws.on('close', (code, reason) => {
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
            log('warn', this.config.host, 'MCP websocket closed (%s) %s', code, reason?.toString?.() || '');
            this.scheduleReconnect();
        });

        ws.on('error', (err: any) => {
            log('warn', this.config.host, 'MCP websocket error: %s', err?.message || err);
        });
    }

    private scheduleReconnect() {
        if (this.disposed || this.config.reconnect === false) return;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts++);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            this.openWebSocket();
        }, delay);
    }

    private async handleMessage(msg: any) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.id !== undefined && !msg.method) {
            const pending = this.pending.get(String(msg.id));
            if (pending) {
                this.pending.delete(String(msg.id));
                clearTimeout(pending.timer);
                if (msg.error) pending.reject(new Error(msg.error.message || 'rpc error'));
                else pending.resolve(msg.result);
                return;
            }
        }

        if (!msg.method) return;
        const id = msg.id;
        const reply = (result: any) => {
            if (id === undefined || id === null) return;
            this.send({ jsonrpc: '2.0', id, result });
        };

        switch (msg.method) {
        case 'initialize':
            reply({
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: '@ejunz/ejunztools', version: this.version() },
            });
            break;
        case 'tools/list':
            reply(this.toolsListResult());
            break;
        case 'tools/call': {
            const params = msg.params || {};
            const name = params.name;
            const args = params.arguments || params.args || {};
            if (!name || typeof name !== 'string') {
                this.send(rpcError(id, -32602, 'tools/call requires params.name'));
                return;
            }
            try {
                const result = await executeSystemTool(name, args || {});
                reply(toolResult(result));
            } catch (e: any) {
                this.send(rpcError(id, -32000, e?.message || String(e)));
            }
            break;
        }
        default:
            if (id !== undefined && id !== null) this.send(rpcError(id, -32601, 'Method not found'));
        }
    }
}
