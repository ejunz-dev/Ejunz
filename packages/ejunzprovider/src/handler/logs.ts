import { Context, Handler, PRIV } from 'ejun';

const logBuffer: Array<{ time: string; level: string; message: string }> = [];
const MAX_LOG_BUFFER = 1000;

export class McpLogsHandler extends Handler {
    async get() {
        await this.checkPriv(PRIV.PRIV_VIEW_SYSTEM_NOTIFICATION);
        
        this.response.template = 'mcp_logs.html';
        this.response.body = {
            logs: logBuffer.slice(-100),
        };
    }
}

export class McpLogsApiHandler extends Handler {
    async get() {
        const count = parseInt(this.args?.count as string || '100', 10);
        
        this.response.body = {
            logs: logBuffer.slice(-count),
            total: logBuffer.length,
        };
    }
}

export function addLog(level: string, message: string) {
    const time = new Date().toISOString();
    const logEntry = { time, level, message };
    logBuffer.push(logEntry);
    
    if (logBuffer.length > MAX_LOG_BUFFER) {
        logBuffer.shift();
    }
    
    broadcastLog(logEntry);
}

const connections = new Set<any>();

export function handleWebSocket(ws: any) {
    connections.add(ws);
    
    const recentLogs = logBuffer.slice(-50);
    try {
        const historyMsg = JSON.stringify({
            type: 'history',
            logs: recentLogs,
        });
        ws.send(historyMsg);
    } catch (e) {
    }
    
    ws.on('close', (code: number, reason: string) => {
        connections.delete(ws);
    });
    
    ws.on('error', (err: any) => {
        connections.delete(ws);
    });
}

function broadcastLog(logData: any) {
    const message = JSON.stringify({ type: 'log', data: logData });
    connections.forEach(ws => {
        try {
            if (ws.readyState === 1) {
                ws.send(message);
            }
        } catch (e) {
        }
    });
}

export async function apply(ctx: Context) {
    ctx.Route('mcp_logs', '/mcp/logs', McpLogsHandler);
    ctx.Route('mcp_logs_api', '/mcp/logs/api', McpLogsApiHandler);
}
