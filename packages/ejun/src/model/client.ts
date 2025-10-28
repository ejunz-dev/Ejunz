import { Collection } from 'mongodb';
import db from '../service/db';
import { Logger } from '../logger';

const ClientLogger = new Logger('client');

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
}
export interface ClientDoc {
    _id: string;
    domainId: string;
    apiKey?: string;
    model?: string;
    apiUrl?: string;
}

export interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, any>;
    };
}

export const coll: Collection<ClientDoc> = db.collection('client');

export class McpClient {
    async getTools(): Promise<McpTool[]> {
        try {
            const ctx = (global as any).app || (global as any).Ejunz;
            if (ctx) {
                const tools = await ctx.serial('mcp/tools/list');
                ClientLogger.info('Got tool list:', { toolCount: tools?.length || 0 });
                return tools || [];
            }
            return [];
        } catch (e) {
            ClientLogger.error('Failed to get tool list', e);
            return [];
        }
    }

    async callTool(name: string, args: any): Promise<any> {
        ClientLogger.info(`Calling tool: ${name}`, args);
        
        try {
            const ctx = (global as any).app || (global as any).Ejunz;
            if (ctx) {
                const result = await ctx.serial('mcp/tool/call', { name, args });
                ClientLogger.info('Got result from event:', result);
                return result;
            }
            throw new Error('Context not available');
        } catch (e) {
            ClientLogger.error(`Failed to call tool: ${name}`, e);
            throw e;
        }
    }
}

const ClientModel = {
    coll,
};

export default ClientModel;

global.Ejunz.model.client = ClientModel;

