import { ObjectId } from 'mongodb';
import { ConnectionHandler, Handler, param, Types } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import EdgeModel from '../model/edge';
import ToolModel from '../model/tool';
import { EdgeServerConnectionHandler } from './edge';
import { ValidationError, NotFoundError } from '../error';
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
                    eid: edge.eid,
                    edgeName: edge.name || `Edge-${edge.eid}`,
                    edgeStatus: isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline',
                });
            }
        }
        
        allTools.sort((a, b) => {
            if (a.edgeName !== b.edgeName) {
                return a.edgeName.localeCompare(b.edgeName);
            }
            return (a.tid || 0) - (b.tid || 0);
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

    async get() {
        const { tid } = this.request.params;
        
        // 如果 tid 包含点号（如 .css.map），说明是静态资源，不应该匹配这个路由
        // 框架应该先处理静态资源，但如果到达这里，说明是无效的 tid
        if (tid && (tid.includes('.') || !/^\d+$/.test(tid))) {
            // 返回 404，让静态资源处理器处理
            throw new NotFoundError(tid);
        }
        
        const tidNum = parseInt(tid, 10);
        if (isNaN(tidNum) || tidNum < 1) {
            throw new ValidationError('tid');
        }
        
        // 需要先找到对应的 edge，然后通过 token 和 tid 查找 tool
        const edges = await EdgeModel.getByDomain(this.domain._id);
        let foundTool: ToolDoc | null = null;
        
        for (const edge of edges) {
            const tool = await ToolModel.getByToolId(this.domain._id, edge.token, tidNum);
            if (tool && tool.domainId === this.domain._id) {
                foundTool = tool;
                break;
            }
        }
        
        if (!foundTool) {
            throw new ValidationError('Tool not found');
        }
        this.tool = foundTool;
        const edge = await EdgeModel.get(this.tool.edgeDocId);
        if (!edge) {
            throw new ValidationError('Edge not found');
        }
        
        const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
        let edgeStatus: 'online' | 'offline' | 'working' = edge.status;
        if (isConnected) {
            const tools = await ToolModel.getByToken(this.domain._id, edge.token);
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
                    edgeName: edge.name || `Edge-${edge.eid}`,
                    edgeStatus: isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline',
                });
            }
        }
        
        allTools.sort((a, b) => {
            if (a.edgeName !== b.edgeName) {
                return a.edgeName.localeCompare(b.edgeName);
            }
            return (a.tid || 0) - (b.tid || 0);
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
                    eid: edge.eid,
                    edgeName: edge.name || `Edge-${edge.eid}`,
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
                    eid: edge.eid,
                    edgeName: edge.name || `Edge-${edge.eid}`,
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
                                eid: edge.eid,
                                edgeName: edge.name || `Edge-${edge.eid}`,
                                edgeStatus: isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline',
                            });
                        }
                    }
                    
                    allTools.sort((a, b) => {
                        if (a.edgeName !== b.edgeName) {
                            return a.edgeName.localeCompare(b.edgeName);
                        }
                        return (a.tid || 0) - (b.tid || 0);
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
    ctx.Route('tool_detail', '/tool/:tid', ToolDetailHandler);
    ctx.Connection('tool_status_conn', '/tool/status/ws', ToolStatusConnectionHandler);
}

