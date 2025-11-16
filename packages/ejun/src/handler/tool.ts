import { ObjectId } from 'mongodb';
import { ConnectionHandler, Handler, param, Types } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import EdgeModel from '../model/edge';
import ToolModel from '../model/tool';
import { EdgeServerConnectionHandler } from './edge';
import { ValidationError } from '../error';
import type { ToolDoc } from '../interface';

const logger = new Logger('handler/tool');

// Tool页面相关handler
export class ToolDomainHandler extends Handler<Context> {
    async get() {
        const edges = await EdgeModel.getByDomain(this.domain._id);
        const allTools: any[] = [];
        
        for (const edge of edges) {
            const tools = await ToolModel.getByToken(this.domain._id, edge.token);
            const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
            
            for (const tool of tools) {
                allTools.push({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    edgeName: edge.name || `Edge-${edge.edgeId}`,
                    edgeStatus: isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline',
                });
            }
        }
        
        allTools.sort((a, b) => {
            if (a.edgeName !== b.edgeName) {
                return a.edgeName.localeCompare(b.edgeName);
            }
            return (a.toolId || 0) - (b.toolId || 0);
        });
        
        const wsPath = `/d/${this.domain._id}/tool/status/ws`;
        const protocol = this.request.headers['x-forwarded-proto'] || (this.request.headers['x-forwarded-ssl'] === 'on' ? 'https' : 'http');
        const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
        const host = this.request.host || this.request.headers.host || 'localhost';
        const wsEndpointBase = `${wsProtocol}://${host}${wsPath}`;
        
        this.response.template = 'tool_main.html';
        this.response.body = { 
            tools: allTools, 
            domainId: this.domain._id,
            wsEndpointBase,
        };
    }
}

export class ToolDetailHandler extends Handler<Context> {
    tool: ToolDoc;

    @param('toolId', Types.ObjectId)
    async prepare(domainId: string, toolId: ObjectId) {
        const tool = await ToolModel.get(toolId);
        if (!tool || tool.domainId !== domainId) {
            throw new ValidationError('Tool not found');
        }
        this.tool = tool;
    }

    @param('toolId', Types.ObjectId)
    async get(domainId: string, toolId: ObjectId) {
        const edge = await EdgeModel.get(this.tool.edgeDocId);
        if (!edge) {
            throw new ValidationError('Edge not found');
        }
        
        const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
        let edgeStatus: 'online' | 'offline' | 'working' = edge.status;
        if (isConnected) {
            const tools = await ToolModel.getByToken(domainId, edge.token);
            edgeStatus = tools.length > 0 ? 'working' : 'online';
        } else {
            edgeStatus = 'offline';
        }

        this.response.template = 'tool_detail.html';
        this.response.body = {
            tool: this.tool,
            edge: {
                ...edge,
                status: edgeStatus,
            },
            domainId: this.domain._id,
        };
    }
}

export class ToolStatusConnectionHandler extends ConnectionHandler<Context> {
    noCheckPermView = true;
    private subscriptions: Array<{ dispose: () => void }> = [];

    async prepare() {
        const edges = await EdgeModel.getByDomain(this.domain._id);
        const allTools: any[] = [];
        
        for (const edge of edges) {
            const tools = await ToolModel.getByToken(this.domain._id, edge.token);
            const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
            
            for (const tool of tools) {
                allTools.push({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    edgeName: edge.name || `Edge-${edge.edgeId}`,
                    edgeStatus: isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline',
                });
            }
        }
        
        allTools.sort((a, b) => {
            if (a.edgeName !== b.edgeName) {
                return a.edgeName.localeCompare(b.edgeName);
            }
            return (a.toolId || 0) - (b.toolId || 0);
        });
        
        this.send({ type: 'init', tools: allTools });

        // 监听工具更新事件
        const dispose1 = this.ctx.on('mcp/tools/update' as any, async (...args: any[]) => {
            const [token] = args;
            const edge = await EdgeModel.getByToken(this.domain._id, token);
            if (edge) {
                const tools = await ToolModel.getByToken(this.domain._id, token);
                const isConnected = EdgeServerConnectionHandler.active.has(token);
                
                const toolsWithStatus = tools.map(tool => ({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    edgeName: edge.name || `Edge-${edge.edgeId}`,
                    edgeStatus: isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline',
                }));
                
                this.send({ 
                    type: 'tools/update', 
                    token,
                    tools: toolsWithStatus,
                });
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        // 监听服务器连接状态更新
        const dispose2 = this.ctx.on('mcp/server/connection/update' as any, async (...args: any[]) => {
            const [token, status] = args;
            const edge = await EdgeModel.getByToken(this.domain._id, token);
            if (edge) {
                const tools = await ToolModel.getByToken(this.domain._id, token);
                const isConnected = EdgeServerConnectionHandler.active.has(token);
                const finalStatus = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
                
                const toolsWithStatus = tools.map(tool => ({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    edgeName: edge.name || `Edge-${edge.edgeId}`,
                    edgeStatus: finalStatus,
                }));
                
                this.send({ 
                    type: 'server/status', 
                    token,
                    tools: toolsWithStatus,
                });
            }
        });
        this.subscriptions.push({ dispose: dispose2 });
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
                    const edges = await EdgeModel.getByDomain(this.domain._id);
                    const allTools: any[] = [];
                    
                    for (const edge of edges) {
                        const tools = await ToolModel.getByToken(this.domain._id, edge.token);
                        const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
                        
                        for (const tool of tools) {
                            allTools.push({
                                ...tool,
                                edgeToken: edge.token,
                                edgeId: edge._id,
                                edgeName: edge.name || `Edge-${edge.edgeId}`,
                                edgeStatus: isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline',
                            });
                        }
                    }
                    
                    allTools.sort((a, b) => {
                        if (a.edgeName !== b.edgeName) {
                            return a.edgeName.localeCompare(b.edgeName);
                        }
                        return (a.toolId || 0) - (b.toolId || 0);
                    });
                    
                    this.send({ type: 'refresh', tools: allTools });
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
        logger.debug('Tool Status WebSocket disconnected: domainId=%s', this.domain._id);
    }
}

export async function apply(ctx: Context) {
    ctx.Route('tool_domain', '/tool/list', ToolDomainHandler);
    ctx.Route('tool_detail', '/tool/:toolId', ToolDetailHandler);
    ctx.Connection('tool_status_conn', '/tool/status/ws', ToolStatusConnectionHandler);
}

