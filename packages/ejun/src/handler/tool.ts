import { ObjectId } from 'mongodb';
import { ConnectionHandler, Handler, param, Types } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import EdgeModel from '../model/edge';
import ToolModel from '../model/tool';
import DomainMarketToolModel from '../model/domain_market_tool';
import { EdgeServerConnectionHandler } from './edge';
import { ValidationError, NotFoundError } from '../error';
import type { ToolDoc } from '../interface';
import { registerSystemToolCatalog, registerSystemToolExecutor, executeSystemTool } from '../lib/systemTools';
import { SYSTEM_TOOLS_CATALOG, executeSystemTool as pluginExecuteSystemTool } from '@ejunz/ejunztools';

// 插件注册：将 ejunztools 的 catalog 与 executor 注册到 core，core 不写死 package
registerSystemToolCatalog(SYSTEM_TOOLS_CATALOG as any);
registerSystemToolExecutor(pluginExecuteSystemTool);

const logger = new Logger('handler/tool');

/** Tool market: system MCP tools (non-Edge); from @ejunz/ejunztools */
export const MARKET_TOOLS_CATALOG = SYSTEM_TOOLS_CATALOG as Array<{
    id: string;
    name: string;
    description: string;
    inputSchema: ToolDoc['inputSchema'];
}>;

/** Build enabled system tools for domain (list/WebSocket); no Edge. */
async function buildSystemToolsForDomain(domainId: string): Promise<any[]> {
    const enabled = await DomainMarketToolModel.getByDomain(domainId);
    return enabled.map((doc) => {
        const entry = SYSTEM_TOOLS_CATALOG.find((c) => c.id === doc.toolKey);
        if (!entry) return null;
        return {
            edgeToken: 'system',
            edgeName: 'system',
            edgeStatus: 'working',
            name: entry.name,
            description: entry.description,
            inputSchema: entry.inputSchema,
            toolKey: entry.id,
            tid: null,
            eid: null,
            edgeId: null,
        };
    }).filter(Boolean);
}

/** Returns domain market tools for agent; when type is system, callTool uses executeSystemTool (not Edge). */
export async function getDomainMarketToolsForAgent(domainId: string): Promise<Array<{ name: string; description: string; inputSchema: any; type?: 'system'; system?: boolean }>> {
    const list = await buildSystemToolsForDomain(domainId);
    return list.map((t: any) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema, type: 'system' as const, system: t.system !== false }));
}

// Tool page handlers
export class ToolDomainHandler extends Handler<Context> {
    async get() {
        const edges = await EdgeModel.getByDomain(this.domain._id);
        const allTools: any[] = [];

        for (const edge of edges) {
            const tools = await ToolModel.getByToken(this.domain._id, edge.token);
            const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
            const edgeStatus = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
            const displayEdgeName = edge.name || `Edge-${edge.eid}`;
            for (const tool of tools) {
                allTools.push({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    eid: edge.eid,
                    edgeName: displayEdgeName,
                    edgeStatus,
                });
            }
        }

        const systemTools = await buildSystemToolsForDomain(this.domain._id);
        allTools.push(...systemTools);

        allTools.sort((a, b) => {
            if (a.edgeName !== b.edgeName) {
                return a.edgeName.localeCompare(b.edgeName);
            }
            const tidA = a.tid ?? 0;
            const tidB = b.tid ?? 0;
            if (tidA !== tidB) return tidA - tidB;
            return (a.name || '').localeCompare(b.name || '');
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

/** Returns domain tools list as JSON (for skill editor sidebar). */
export class ToolListApiHandler extends Handler<Context> {
    async get() {
        const edges = await EdgeModel.getByDomain(this.domain._id);
        const allTools: any[] = [];

        for (const edge of edges) {
            const tools = await ToolModel.getByToken(this.domain._id, edge.token);
            const isConnected = EdgeServerConnectionHandler.active.has(edge.token);
            const edgeStatus = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
            const displayEdgeName = edge.name || `Edge-${edge.eid}`;
            for (const tool of tools) {
                allTools.push({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    eid: edge.eid,
                    edgeName: displayEdgeName,
                    edgeStatus,
                });
            }
        }

        const systemTools = await buildSystemToolsForDomain(this.domain._id);
        allTools.push(...systemTools);

        allTools.sort((a, b) => {
            if (a.edgeName !== b.edgeName) {
                return a.edgeName.localeCompare(b.edgeName);
            }
            const tidA = a.tid ?? 0;
            const tidB = b.tid ?? 0;
            if (tidA !== tidB) return tidA - tidB;
            return (a.name || '').localeCompare(b.name || '');
        });

        this.response.template = null;
        this.response.body = { tools: allTools };
    }
}

/** Tool market page: list system MCP tools, add to domain (no Edge). */
export class ToolMarketHandler extends Handler<Context> {
    async get() {
        const enabled = await DomainMarketToolModel.getByDomain(this.domain._id);
        const addedNames = enabled.map((doc) => {
            const entry = SYSTEM_TOOLS_CATALOG.find((c) => c.id === doc.toolKey);
            return entry?.name;
        }).filter(Boolean) as string[];
        this.response.template = 'tool_market.html';
        this.response.body = {
            marketTools: SYSTEM_TOOLS_CATALOG,
            addedNames,
            domainId: this.domain._id,
        };
    }
}

/** System tool detail (from domain_market_tool; no Edge). */
export class ToolSystemDetailHandler extends Handler<Context> {
    async get() {
        const { toolKey } = this.request.params;
        if (!toolKey || typeof toolKey !== 'string') {
            throw new ValidationError('toolKey');
        }
        const has = await DomainMarketToolModel.has(this.domain._id, toolKey);
        if (!has) {
            throw new NotFoundError(toolKey);
        }
        const entry = SYSTEM_TOOLS_CATALOG.find(c => c.id === toolKey);
        if (!entry) {
            throw new NotFoundError(toolKey);
        }
        this.response.template = 'tool_system_detail.html';
        this.response.body = {
            tool: { name: entry.name, description: entry.description, inputSchema: entry.inputSchema },
            toolKey: entry.id,
            domainId: this.domain._id,
        };
    }
}

/** 将市场中的工具添加到当前 domain 的 tool/list（仅写入 domain_market_tool，不创建 Edge） */
export class ToolMarketAddHandler extends Handler<Context> {
    async post() {
        const toolKey = this.request.body?.toolKey;
        if (!toolKey || typeof toolKey !== 'string') {
            throw new ValidationError('toolKey');
        }
        const entry = SYSTEM_TOOLS_CATALOG.find(e => e.id === toolKey);
        if (!entry) {
            throw new ValidationError('Unknown tool in catalog');
        }
        const uid = this.user._id;
        const has = await DomainMarketToolModel.has(this.domain._id, toolKey);
        if (has) {
            this.response.body = { ok: true, message: 'already_added' };
            return;
        }
        await DomainMarketToolModel.add(this.domain._id, toolKey, uid);
        (this.ctx.emit as any)('mcp/tools/update', 'system');
        this.response.body = { ok: true };
    }
}

/** 从当前 domain 卸载市场已添加的工具 */
export class ToolMarketRemoveHandler extends Handler<Context> {
    async post() {
        const toolKey = this.request.body?.toolKey;
        if (!toolKey || typeof toolKey !== 'string') {
            throw new ValidationError('toolKey');
        }
        const entry = SYSTEM_TOOLS_CATALOG.find(e => e.id === toolKey);
        if (!entry) {
            throw new ValidationError('Unknown tool in catalog');
        }
        const has = await DomainMarketToolModel.has(this.domain._id, toolKey);
        if (!has) {
            this.response.body = { ok: true, message: 'not_added' };
            return;
        }
        await DomainMarketToolModel.remove(this.domain._id, toolKey);
        (this.ctx.emit as any)('mcp/tools/update', 'system');
        this.response.body = { ok: true };
    }
}

export class ToolDetailHandler extends Handler<Context> {
    tool: ToolDoc;

    async get() {
        const { tid } = this.request.params;
        
        // tid with dot (e.g. .css.map) = static asset; 404
        if (tid && (tid.includes('.') || !/^\d+$/.test(tid))) {
            throw new NotFoundError(tid);
        }
        
        const tidNum = parseInt(tid, 10);
        if (isNaN(tidNum) || tidNum < 1) {
            throw new ValidationError('tid');
        }
        
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
            isSystemTool: false,
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
            const edgeStatus = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
            const displayEdgeName = edge.name || `Edge-${edge.eid}`;
            for (const tool of tools) {
                allTools.push({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    edgeName: displayEdgeName,
                    edgeStatus,
                });
            }
        }
        const systemTools = await buildSystemToolsForDomain(this.domain._id);
        allTools.push(...systemTools);

        allTools.sort((a, b) => {
            if (a.edgeName !== b.edgeName) {
                return a.edgeName.localeCompare(b.edgeName);
            }
            const tidA = a.tid ?? 0;
            const tidB = b.tid ?? 0;
            if (tidA !== tidB) return tidA - tidB;
            return (a.name || '').localeCompare(b.name || '');
        });

        this.send({ type: 'init', tools: allTools });

        // Tool update (incl. system: build system tools, no Edge)
        const dispose1 = this.ctx.on('mcp/tools/update' as any, async (...args: any[]) => {
            const [token] = args;
            if (token === 'system') {
                const tools = await buildSystemToolsForDomain(this.domain._id);
                this.send({ type: 'tools/update', token: 'system', tools });
                return;
            }
            const edge = await EdgeModel.getByToken(this.domain._id, token);
            if (edge) {
                const tools = await ToolModel.getByToken(this.domain._id, token);
                const isConnected = EdgeServerConnectionHandler.active.has(token);
                const edgeStatus = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
                const displayEdgeName = edge.name || `Edge-${edge.eid}`;
                const toolsWithStatus = tools.map(tool => ({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    eid: edge.eid,
                    edgeName: displayEdgeName,
                    edgeStatus,
                }));
                this.send({ type: 'tools/update', token, tools: toolsWithStatus });
            }
        });
        this.subscriptions.push({ dispose: dispose1 });

        // Listen for server connection updates; skip system (no Edge)
        const dispose2 = this.ctx.on('mcp/server/connection/update' as any, async (...args: any[]) => {
            const [token] = args;
            if (token === 'system') return;
            const edge = await EdgeModel.getByToken(this.domain._id, token);
            if (edge) {
                const tools = await ToolModel.getByToken(this.domain._id, token);
                const isConnected = EdgeServerConnectionHandler.active.has(token);
                const finalStatus = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
                const displayEdgeName = edge.name || `Edge-${edge.eid}`;
                const toolsWithStatus = tools.map(tool => ({
                    ...tool,
                    edgeToken: edge.token,
                    edgeId: edge._id,
                    eid: edge.eid,
                    edgeName: displayEdgeName,
                    edgeStatus: finalStatus,
                }));
                this.send({ type: 'server/status', token, tools: toolsWithStatus });
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
                        const edgeStatus = isConnected ? (tools.length > 0 ? 'working' : 'online') : 'offline';
                        const displayEdgeName = edge.name || `Edge-${edge.eid}`;
                        for (const tool of tools) {
                            allTools.push({
                                ...tool,
                                edgeToken: edge.token,
                                edgeId: edge._id,
                                eid: edge.eid,
                                edgeName: displayEdgeName,
                                edgeStatus,
                            });
                        }
                    }
                    const systemTools = await buildSystemToolsForDomain(this.domain._id);
                    allTools.push(...systemTools);
                    allTools.sort((a, b) => {
                        if (a.edgeName !== b.edgeName) {
                            return a.edgeName.localeCompare(b.edgeName);
                        }
                        const tidA = a.tid ?? 0;
                        const tidB = b.tid ?? 0;
                        if (tidA !== tidB) return tidA - tidB;
                        return (a.name || '').localeCompare(b.name || '');
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
    ctx.Route('tool_list_api', '/tool/api/list', ToolListApiHandler);
    ctx.Route('tool_market', '/tool/market', ToolMarketHandler);
    ctx.Route('tool_market_add', '/tool/market/add', ToolMarketAddHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tool_market_remove', '/tool/market/remove', ToolMarketRemoveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('tool_system_detail', '/tool/system/:toolKey', ToolSystemDetailHandler);
    ctx.Route('tool_detail', '/tool/:tid', ToolDetailHandler);
    ctx.Connection('tool_status_conn', '/tool/status/ws', ToolStatusConnectionHandler);

    // System MCP tools (domain_market_tool; no Edge)
    (ctx as any).on('mcp/tools/list/local', async (payload?: { domainId?: string }) => {
        const domainId = payload?.domainId;
        if (!domainId) return [];
        const enabled = await DomainMarketToolModel.getByDomain(domainId);
        return enabled.map(doc => {
            const entry = SYSTEM_TOOLS_CATALOG.find(c => c.id === doc.toolKey);
            return entry ? { name: entry.name, description: entry.description, inputSchema: entry.inputSchema } : null;
        }).filter(Boolean);
    });
    (ctx as any).on('mcp/tool/call/local', async ({ name, args }: { name: string; args?: Record<string, unknown> }) => {
        return executeSystemTool(name, args || {});
    });
}

