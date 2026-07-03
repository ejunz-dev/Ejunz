import { Context, Service } from '../context';
import { Logger } from '../logger';
import EdgeModel from '../model/edge';
import EdgeTokenModel from '../model/edge_token';
import McpModel from '../model/mcp';
import SessionModel from '../model/session';
import RecordModel from '../model/record';
import { BaseModel } from '../model/base';
import type { EdgeTokenDoc } from '../model/edge_token';
import type { McpDoc } from '../interface';
import { randomstring } from '../utils';
import {
    MCP_BUILTIN_TOOLS_CATALOG,
    buildMcpInstructions,
    defaultMcpToolDescriptions,
    executeMcpBuiltinTool,
    isMcpBuiltinMutatingTool,
    isMcpBuiltinTool,
    resolveMcpTools,
    type McpToolContext,
} from './mcp/builtinTools';
import {
    getNormalizedMcp,
    listDomainMcps,
    mcpKind,
    ensureSystemToolsMcp,
    ensureBuiltinEjunzToolsMcp,
    removeBuiltinEjunzToolsMcp,
    setEdgeTokenConnectedChecker,
} from './mcp/registry';
import {
    executeLocalMcpTool,
    executeLocalSystemTool,
    findLocalMcpToolByIdOrName,
    getLocalMcpToolCatalog,
    getLocalSystemToolCatalog,
    getMarketMcpTools,
    isLocalMcpToolAvailableInDomain,
    isLocalSystemToolAvailableInDomain,
} from './mcp/localSystemTools';
import {
    executeSystemTool,
    getSystemToolCatalog,
    registerSystemToolCatalog,
    registerSystemToolExecutor,
    tryExecuteSystemTool,
} from './mcp/systemTools';
import {
    callPluginMcpTool,
    checkAllEnabledPluginMcpStatus,
    cleanupPluginMcpArtifacts,
    getBuiltinPluginMcpRuntime,
    listBuiltinPluginMcpRuntimes,
    parseDraftPluginMcpDefinitions,
    refreshPluginMcpStatus,
    summarizePluginMcpAvailability,
    syncPluginManagedMcps,
    testPluginMcpDefinitions,
} from './mcp/pluginMcp';
import {
    executeBuiltinEjunzToolsTool,
    getBuiltinEjunzToolsRuntime,
    getBuiltinEjunzToolsVersion,
    getEjunzToolsCatalog,
    registerBuiltinEjunzToolsRuntime,
} from './mcp/ejunzTools';

export * from './mcp/builtinTools';
export * from './mcp/registry';
export * from './mcp/localSystemTools';
export * from './mcp/systemTools';
export * from './mcp/scheduleSystemTools';
export * from './mcp/pluginMcp';
export * from './mcp/ejunzTools';

const logger = new Logger('service/mcp');
const MCP_PROTOCOL_VERSION = '2024-11-05';

export type JsonRpcMessage = {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: any;
};

export type McpServerMeta = {
    domainId: string;
    baseDocId?: number;
    branch?: string;
    instructions?: string;
    toolOverrides?: { name: string; description: string }[];
};

type McpSession = {
    sessionId: string;
    domainId: string;
    token: string;
    write: (event: string, data: string) => void;
};

type OpenSseSessionInput = {
    domainId: string;
    token: string;
    write: (event: string, data: string) => void;
};

declare module '../context' {
    interface Context {
        mcp: McpService;
    }
}

let currentMcpService: McpService | undefined;

function clipForLog(value: unknown): string {
    try {
        if (typeof value === 'string') return value;
        return JSON.stringify(value) || '';
    } catch {
        return String(value ?? '');
    }
}

function tokenRefs(): Map<string, number> {
    return ((globalThis as any).__ejunzMcpTokenRefs ??= new Map<string, number>());
}

function sessions(): Map<string, McpSession> {
    return ((globalThis as any).__ejunzMcpSessions ??= new Map<string, McpSession>());
}

export function getMcpService(): McpService | undefined {
    return currentMcpService || (global as any).app?.mcp || (global as any).Ejunz?.mcp;
}

export default class McpService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'mcp');
        currentMcpService = this;
        registerSystemToolCatalog(getLocalSystemToolCatalog());
        registerSystemToolExecutor(executeLocalSystemTool);
        setEdgeTokenConnectedChecker((token) => this.isEdgeTransportTokenConnected(token));
        (ctx as any).on('mcp/deliver', ({ sessionId, data }: { sessionId: string; data: string }) => {
            this.deliverToSession(sessionId, data);
        });
        (ctx as any).on('mcp/notify', ({ token, data }: { token: string; data: string }) => {
            this.deliverToToken(token, data);
        });
    }

    edgeTokenConnectedChecker?: (token: string) => boolean;

    isEdgeTransportTokenConnected(token: string): boolean {
        return !!this.edgeTokenConnectedChecker?.(token);
    }

    setEdgeTokenConnectedChecker(checker: (token: string) => boolean) {
        this.edgeTokenConnectedChecker = checker;
    }

    isTokenConnected(token: string): boolean {
        return (tokenRefs().get(token) || 0) > 0;
    }

    activeSessionCount(token: string): number {
        return tokenRefs().get(token) || 0;
    }

    hasSession(sessionId: string): boolean {
        return sessions().has(sessionId);
    }

    async registerOutboundEdge(tokenDoc: EdgeTokenDoc) {
        const { domainId, token, owner, baseDocId, branch } = tokenDoc;
        try {
            let edge = await EdgeModel.getByToken(domainId, token);
            if (!edge) edge = await EdgeModel.add({ domainId, type: 'mcp', owner, token });
            const mcp = await this.getOrCreateMcp(domainId, owner, token, baseDocId, branch);
            if (edge.mcpId !== mcp.mid) await EdgeModel.update(domainId, edge.eid, { mcpId: mcp.mid });
            const wasFirstConnection = !edge.tokenUsedAt;
            await EdgeModel.update(domainId, edge.eid, { status: 'online', tokenUsedAt: edge.tokenUsedAt || new Date() });
            await McpModel.update(domainId, mcp.mid, { status: 'online', edgeId: edge.eid, lastConnectedAt: new Date() });
            tokenRefs().set(token, (tokenRefs().get(token) || 0) + 1);
            if (wasFirstConnection) {
                const updated = await EdgeModel.getByToken(domainId, token);
                if (updated) (this.ctx.emit as any)('edge/connected', updated);
            }
            (this.ctx.emit as any)('edge/status/update', token, 'online');
            (this.ctx.emit as any)('mcp/status/update', domainId, mcp.mid, 'online');
        } catch (e) {
            logger.warn('Failed to register outbound MCP edge: domainId=%s, error=%s', domainId, (e as Error).message);
        }
    }

    async unregisterOutboundEdge(domainId: string, token: string) {
        const refs = tokenRefs();
        const next = (refs.get(token) || 1) - 1;
        if (next > 0) {
            refs.set(token, next);
            return;
        }
        refs.delete(token);
        try {
            const edge = await EdgeModel.getByToken(domainId, token);
            if (edge) {
                await EdgeModel.update(domainId, edge.eid, { status: 'offline' });
                (this.ctx.emit as any)('edge/status/update', token, 'offline');
            }
            const mcp = await McpModel.getByToken(domainId, token);
            if (mcp) {
                await McpModel.update(domainId, mcp.mid, { status: 'offline', lastDisconnectedAt: new Date() });
                (this.ctx.emit as any)('mcp/status/update', domainId, mcp.mid, 'offline');
            }
        } catch (e) {
            logger.warn('Failed to mark outbound MCP edge offline: domainId=%s, error=%s', domainId, (e as Error).message);
        }
    }

    openSseSession(input: OpenSseSessionInput) {
        const sessionId = randomstring(24);
        sessions().set(sessionId, { sessionId, ...input });
        return {
            sessionId,
            dispose: () => {
                sessions().delete(sessionId);
            },
        };
    }

    deliverToSession(sessionId: string, data: string): boolean {
        const session = sessions().get(sessionId);
        if (!session) return false;
        try {
            session.write('message', data);
            return true;
        } catch (e) {
            logger.warn('Failed to deliver MCP message: sessionId=%s, error=%s', sessionId, (e as Error).message);
            return false;
        }
    }

    deliverOrBroadcast(sessionId: string, data: string) {
        if (this.deliverToSession(sessionId, data)) {
            logger.info('MCP deliver -> SSE session (local): sessionId=%s, bytes=%d', sessionId, data.length);
            return;
        }
        if (process.env.exec_mode === 'cluster_mode') {
            logger.warn('MCP deliver: session not on this worker, broadcasting across cluster: sessionId=%s, bytes=%d', sessionId, data.length);
        } else {
            logger.warn('MCP deliver FAILED: SSE session no longer exists in this process; response dropped. sessionId=%s, bytes=%d', sessionId, data.length);
        }
        (this.ctx as any).broadcast('mcp/deliver', { sessionId, data });
    }

    deliverToToken(token: string, data: string): number {
        let delivered = 0;
        for (const session of sessions().values()) {
            if (session.token !== token) continue;
            try {
                session.write('message', data);
                delivered++;
            } catch (e) {
                logger.warn('Failed to push MCP notification: sessionId=%s, error=%s', session.sessionId, (e as Error).message);
            }
        }
        return delivered;
    }

    notifyToolsListChanged(token: string) {
        const data = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        const delivered = this.deliverToToken(token, data);
        (this.ctx as any).broadcast('mcp/notify', { token, data });
        logger.info('MCP tools/list_changed pushed: localSessions=%d (+broadcast to other processes)', delivered);
    }

    async recordToolCall(input: {
        domainId: string;
        uid: number;
        mcpId?: number;
        baseDocId: number;
        branch: string;
        tool: string;
        args: Record<string, any>;
        result?: string;
        isError?: boolean;
        error?: string;
        durationMs: number;
    }): Promise<void> {
        try {
            if (!input.uid || !input.mcpId) return;
            const baseDocId = input.baseDocId || 0;
            const branch = input.branch || 'main';
            const session = await SessionModel.getOrCreateMcpSession(input.domainId, input.uid, input.mcpId, baseDocId, branch);
            await RecordModel.insertMcpToolRecord(input.domainId, input.uid, session._id, {
                mcpId: input.mcpId,
                baseDocId,
                branch,
                meta: {
                    tool: input.tool,
                    args: input.args || {},
                    result: input.result,
                    isError: input.isError,
                    error: input.error,
                    durationMs: input.durationMs,
                    sessionRef: session._id.toHexString(),
                },
            });
        } catch (e) {
            logger.warn('Failed to record MCP tool call: tool=%s, error=%s', input.tool, (e as Error).message);
        }
    }

    async handleJsonRpc(domainId: string, msg: JsonRpcMessage, meta?: McpServerMeta): Promise<any | null> {
        if (!msg || typeof msg !== 'object' || !msg.method) return null;
        const { id, method } = msg;
        const hasId = id !== undefined && id !== null;
        switch (method) {
        case 'initialize': {
            const baseDocId = meta?.baseDocId;
            const instructions = meta?.instructions || await buildMcpInstructions({ domainId, baseDocId, branch: meta?.branch });
            return {
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: MCP_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: baseDocId ? `ejunz-base-${baseDocId}` : 'ejunz-mcp', version: '1.0.0' },
                    instructions,
                },
            };
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
            return null;
        case 'ping':
            return { jsonrpc: '2.0', id, result: {} };
        case 'tools/list':
            return { jsonrpc: '2.0', id, result: { tools: resolveMcpTools(meta?.toolOverrides) } };
        default:
            if (hasId) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
            return null;
        }
    }

    async processMessage(msg: JsonRpcMessage, toolCtx: McpToolContext, meta: McpServerMeta, mcpDoc: { mid: number } | null, logCtx: string): Promise<any | null> {
        logger.info('MCP recv: %s, method=%s, id=%s', logCtx, msg?.method || '-', `${msg?.id ?? '-'}`);
        if (msg && msg.method === 'tools/call' && msg.id !== undefined && msg.id !== null) {
            const name = msg.params?.name;
            const args = msg.params?.arguments || {};
            if (!name || typeof name !== 'string') {
                logger.warn('MCP tools/call rejected (missing name): %s, id=%s', logCtx, `${msg.id}`);
                return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid params: name is required' } };
            }
            if (!isMcpBuiltinTool(name)) {
                logger.warn('MCP tools/call unknown tool: %s, tool=%s, id=%s', logCtx, name, `${msg.id}`);
                return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } };
            }
            logger.info('MCP tools/call -> %s, tool=%s, id=%s, args=%s', logCtx, name, `${msg.id}`, clipForLog(args));
            const startedAt = Date.now();
            let response: any;
            let resultText: string | undefined;
            let isError = false;
            let errorMsg: string | undefined;
            try {
                const result = await executeMcpBuiltinTool(toolCtx, name, args);
                resultText = typeof result === 'string' ? result : JSON.stringify(result);
                response = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: resultText }] } };
                logger.info('MCP tools/call OK: %s, tool=%s, id=%s, %dms, result=%s', logCtx, name, `${msg.id}`, Date.now() - startedAt, clipForLog(resultText));
                if (isMcpBuiltinMutatingTool(name)) (this.ctx.emit as any)('base/update', toolCtx.baseDocId, null, toolCtx.branch);
            } catch (e) {
                isError = true;
                errorMsg = (e as Error).message;
                response = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: errorMsg }], isError: true } };
                logger.warn('MCP tools/call ERROR: %s, tool=%s, id=%s, %dms, error=%s', logCtx, name, `${msg.id}`, Date.now() - startedAt, errorMsg);
            }
            await this.recordToolCall({
                domainId: toolCtx.domainId,
                uid: toolCtx.owner,
                mcpId: mcpDoc?.mid,
                baseDocId: toolCtx.baseDocId,
                branch: toolCtx.branch,
                tool: name,
                args,
                result: isError ? undefined : resultText,
                isError,
                error: errorMsg,
                durationMs: Date.now() - startedAt,
            });
            return response;
        }
        const response = await this.handleJsonRpc(toolCtx.domainId, msg, meta);
        if (!response) {
            logger.info('MCP handled (no response): %s, method=%s', logCtx, msg?.method || '-');
            return null;
        }
        if (response.error) logger.warn('MCP %s ERROR: %s, code=%s, msg=%s', msg?.method || '-', logCtx, response.error.code, response.error.message);
        else logger.info('MCP %s OK: %s', msg?.method || '-', logCtx);
        return response;
    }

    async getOrCreateMcpToken(domainId: string, owner: number, baseDocId?: number, branch?: string): Promise<string> {
        const query: any = { domainId, type: 'mcp_sse', owner };
        if (baseDocId !== undefined && baseDocId !== null) query.baseDocId = baseDocId;
        const existing = await EdgeTokenModel.coll.findOne(query);
        if (existing) {
            const fresh = await EdgeTokenModel.getByToken(existing.token);
            if (fresh) return fresh.token;
        }
        const token = await EdgeTokenModel.generateToken();
        await EdgeTokenModel.add(domainId, 'mcp_sse', token, owner, { baseDocId, branch });
        return token;
    }

    async getOrCreateMcp(domainId: string, owner: number, token: string, baseDocId?: number, branch?: string): Promise<McpDoc> {
        let mcp = await McpModel.getByToken(domainId, token);
        if (!mcp) {
            const instructions = await buildMcpInstructions({ domainId, baseDocId, branch });
            mcp = await McpModel.add({
                domainId,
                owner,
                token,
                baseDocId,
                branch,
                name: baseDocId ? `MCP · base ${baseDocId}` : 'MCP',
                kind: 'outbound',
                source: { type: 'ejunz_base' },
                assignable: false,
                instructions,
                tools: defaultMcpToolDescriptions(),
            });
        }
        return mcp;
    }

    async resolveBasePathId(domainId: string, baseDocId?: number): Promise<string | undefined> {
        if (!baseDocId) return undefined;
        try {
            const base = await BaseModel.get(domainId, baseDocId);
            const bid = (base as any)?.bid;
            if (bid && String(bid).trim()) return String(bid).trim();
        } catch { /* fall back to docId */ }
        return String(baseDocId);
    }

    buildConnectionInfo(input: { protocol: string; host: string; domainId: string; token: string; pathId?: string }) {
        const { protocol, host, domainId, token, pathId } = input;
        const seg = pathId ? `/${encodeURIComponent(pathId)}` : '';
        const baseUrl = `${protocol}://${host}/d/${domainId}/mcp/sse${seg}`;
        const url = `${baseUrl}?token=${token}`;
        const command = `claude mcp add --transport sse ejunz-${domainId} ${baseUrl} --header "Authorization: Bearer ${token}"`;
        const httpBaseUrl = `${protocol}://${host}/d/${domainId}/mcp/http${seg}`;
        const httpUrl = `${httpBaseUrl}?token=${token}`;
        const httpCommand = `claude mcp add --transport http ejunz-${domainId} ${httpBaseUrl} --header "Authorization: Bearer ${token}"`;
        return {
            token,
            url,
            baseUrl,
            command,
            httpUrl,
            httpBaseUrl,
            httpCommand,
            config: { mcpServers: { ejunz: { type: 'sse', url: baseUrl, headers: { Authorization: `Bearer ${token}` } } } },
            httpConfig: { mcpServers: { ejunz: { type: 'http', url: httpBaseUrl, headers: { Authorization: `Bearer ${token}` } } } },
        };
    }

    buildStatus(domainId: string, mcp: { mid: number; token?: string; edgeId?: number }) {
        const online = this.activeSessionCount(mcp.token || '') > 0;
        const edgeId = mcp.edgeId || null;
        return {
            mid: mcp.mid,
            edgeId,
            used: !!edgeId,
            status: online ? 'online' : (edgeId ? 'offline' : 'pending'),
            edgeUrl: edgeId ? `/d/${domainId}/edge/${edgeId}` : null,
        };
    }

    // Registry/tool/plugin wrappers keep callers on ctx.mcp instead of src/lib modules.
    listDomainMcps = listDomainMcps;
    getNormalizedMcp = getNormalizedMcp;
    mcpKind = mcpKind;
    ensureSystemToolsMcp = ensureSystemToolsMcp;
    ensureBuiltinEjunzToolsMcp = ensureBuiltinEjunzToolsMcp;
    removeBuiltinEjunzToolsMcp = removeBuiltinEjunzToolsMcp;
    getLocalSystemToolCatalog = getLocalSystemToolCatalog;
    getLocalMcpToolCatalog = getLocalMcpToolCatalog;
    getMarketMcpTools = getMarketMcpTools;
    findLocalMcpToolByIdOrName = findLocalMcpToolByIdOrName;
    isLocalMcpToolAvailableInDomain = isLocalMcpToolAvailableInDomain;
    isLocalSystemToolAvailableInDomain = isLocalSystemToolAvailableInDomain;
    executeLocalMcpTool = executeLocalMcpTool;
    executeLocalSystemTool = executeLocalSystemTool;
    registerSystemToolCatalog = registerSystemToolCatalog;
    registerSystemToolExecutor = registerSystemToolExecutor;
    getSystemToolCatalog = getSystemToolCatalog;
    executeSystemTool = executeSystemTool;
    tryExecuteSystemTool = tryExecuteSystemTool;
    parseDraftPluginMcpDefinitions = parseDraftPluginMcpDefinitions;
    testPluginMcpDefinitions = testPluginMcpDefinitions;
    syncPluginManagedMcps = syncPluginManagedMcps;
    refreshPluginMcpStatus = refreshPluginMcpStatus;
    checkAllEnabledPluginMcpStatus = checkAllEnabledPluginMcpStatus;
    cleanupPluginMcpArtifacts = cleanupPluginMcpArtifacts;
    summarizePluginMcpAvailability = summarizePluginMcpAvailability;
    callPluginMcpTool = callPluginMcpTool;
    getBuiltinPluginMcpRuntime = getBuiltinPluginMcpRuntime;
    listBuiltinPluginMcpRuntimes = listBuiltinPluginMcpRuntimes;
    registerBuiltinEjunzToolsRuntime = registerBuiltinEjunzToolsRuntime;
    getBuiltinEjunzToolsRuntime = getBuiltinEjunzToolsRuntime;
    getBuiltinEjunzToolsVersion = getBuiltinEjunzToolsVersion;
    getEjunzToolsCatalog = getEjunzToolsCatalog;
    executeBuiltinEjunzToolsTool = executeBuiltinEjunzToolsTool;
    builtinToolsCatalog = MCP_BUILTIN_TOOLS_CATALOG;
    buildMcpInstructions = buildMcpInstructions;
    resolveMcpTools = resolveMcpTools;
    defaultMcpToolDescriptions = defaultMcpToolDescriptions;
    isMcpBuiltinMutatingTool = isMcpBuiltinMutatingTool;
}

export async function apply(ctx: Context) {
    ctx.plugin(McpService);
}
