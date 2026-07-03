import { ObjectId } from 'mongodb';
import type { User } from '../../interface';
import { Logger } from '../../logger';
import type { McpDoc } from '../../model/mcp';
import type { EdgeDoc } from '../../model/edge';
import type { ToolDoc } from '../../model/tool';
import EdgeModel from '../../model/edge';
import McpModel from '../../model/mcp';
import ToolModel from '../../model/tool';
import DomainMarketToolModel from '../../model/domain_market_tool';
import { getLocalMcpToolCatalog } from './localSystemTools';
import { resolveMcpTools } from './builtinTools';
import {
    getBuiltinEjunzToolsLabel,
    getBuiltinEjunzToolsRuntime,
    getBuiltinEjunzToolsVersion,
    getEjunzToolsCatalog,
} from './ejunzTools';

export type McpKind = 'outbound' | 'system' | 'inbound' | 'plugin' | 'ejunztools';
export type McpRuntimeMode = 'builtin' | 'ws';

const SYSTEM_TOOLS_MCP_NAME = 'System Tools';
const SYSTEM_TOOLS_MCP_DESCRIPTION = '本站内置的 System Tools 工具集合，按 domain 启用。';
const SYSTEM_TOOLS_MCP_SOURCE_LABEL = 'system_tools';
const SYSTEM_TOOLS_MCP_KIND = 'system';
const SYSTEM_TOOLS_MCP_SOURCE_TYPE = 'system_tools';
const SYSTEM_TOOLS_MCP_LOCAL_KEY = 'system_tools';

const logger = new Logger('mcpRegistry');

let edgeTokenConnectedChecker: ((token: string) => boolean) | undefined;

export function setEdgeTokenConnectedChecker(checker: (token: string) => boolean) {
    edgeTokenConnectedChecker = checker;
}

function isEdgeTokenConnected(token?: string): boolean {
    return !!token && !!edgeTokenConnectedChecker?.(token);
}

const EJUNZ_TOOLS_MCP_NAME = 'Ejunz Tools';
const EJUNZ_TOOLS_MCP_DESCRIPTION = 'Ejunz Tools MCP provider，支持 builtin / ws 启动方式。';
const EJUNZ_TOOLS_MCP_KIND = 'ejunztools';
const EJUNZ_TOOLS_MCP_SOURCE_TYPE = 'ejunztools';
export const EJUNZ_TOOLS_MCP_LOCAL_KEY = 'ejunztools';
export const EJUNZ_TOOLS_PACKAGE_NAME = '@ejunz/ejunztools';

export interface NormalizedMcpTool {
    uniqueId: string;
    name: string;
    description: string;
    inputSchema?: any;
    kind: McpKind;
    toolKey?: string;
    token?: string;
    toolDocId?: ObjectId;
    edgeDocId?: ObjectId;
    edgeId?: number;
    type?: 'system' | 'market_mcp' | 'edge' | 'plugin_mcp' | 'ejunztools';
    system?: boolean;
}

export interface NormalizedMcpRow {
    mcp: McpDoc;
    mid: number;
    kind: McpKind;
    kindLabel: string;
    sourceLabel: string;
    assignableLabel: string;
    name: string;
    description: string;
    status: 'online' | 'offline' | 'pending';
    online: boolean;
    assignable: boolean;
    toolCount: number;
    tools?: NormalizedMcpTool[];
    edge?: EdgeDoc | null;
    runtimeMode?: McpRuntimeMode;
    runtimeVersion?: string;
    runtimeLabel?: string;
}

export function mcpKind(mcp: Partial<McpDoc>): McpKind {
    return (mcp.kind || 'outbound') as McpKind;
}

export function uniqueOutboundToolId(mcp: McpDoc, toolName: string): string {
    return `outbound:${mcp._id.toString()}:${toolName}`;
}

export function uniqueSystemToolId(toolKey: string): string {
    return `system:${toolKey}`;
}

export function uniqueEjunzToolsToolId(toolKey: string): string {
    return `ejunztools:${toolKey}`;
}

export function uniqueInboundToolId(edgeDocId: ObjectId, toolDocId: ObjectId): string {
    return `inbound:${edgeDocId.toString()}:${toolDocId.toString()}`;
}

export function uniquePluginToolId(mcp: McpDoc, toolDocId: ObjectId): string {
    return `plugin:${mcp._id.toString()}:${toolDocId.toString()}`;
}

function edgeDisplayName(edge: EdgeDoc): string {
    return edge.name || `Edge-${edge.eid}`;
}

function edgeIsEjunzTools(edge: EdgeDoc): boolean {
    return edge.provider?.packageName === EJUNZ_TOOLS_PACKAGE_NAME
        || edge.provider?.name === 'ejunztools'
        || edge.provider?.name === EJUNZ_TOOLS_PACKAGE_NAME;
}

function edgeRuntimeMode(edge?: EdgeDoc | null): McpRuntimeMode | undefined {
    return edge?.provider?.runtimeMode === 'ws' || edge?.provider?.runtimeMode === 'builtin'
        ? edge.provider.runtimeMode
        : undefined;
}

function edgeRuntimeVersion(edge?: EdgeDoc | null): string | undefined {
    return edge?.provider?.runtimeVersion;
}

async function systemTools(domainId: string): Promise<NormalizedMcpTool[]> {
    const enabled = await DomainMarketToolModel.getByDomain(domainId);
    const enabledKeys = new Set(enabled.map((doc) => doc.toolKey));
    const tools = getLocalMcpToolCatalog()
        .filter((entry) => entry.source === 'system' || enabledKeys.has(entry.id))
        .map((entry) => ({
            uniqueId: uniqueSystemToolId(entry.id),
            name: entry.name,
            description: entry.description || '',
            inputSchema: entry.inputSchema,
            kind: SYSTEM_TOOLS_MCP_KIND as McpKind,
            toolKey: entry.id,
            type: entry.source === 'system' ? 'system' as const : 'market_mcp' as const,
            system: entry.source === 'system' ? true : undefined,
        }));
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return tools;
}

async function builtinEjunzTools(): Promise<NormalizedMcpTool[]> {
    return getEjunzToolsCatalog()
        .map((entry) => ({
            uniqueId: uniqueEjunzToolsToolId(entry.id),
            name: entry.name,
            description: entry.description || '',
            inputSchema: entry.inputSchema || { type: 'object', properties: {} },
            kind: EJUNZ_TOOLS_MCP_KIND as McpKind,
            toolKey: entry.id,
            type: 'ejunztools' as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function inboundTools(domainId: string, edge: EdgeDoc, kind: McpKind = 'inbound'): Promise<NormalizedMcpTool[]> {
    const docs = await ToolModel.getByEdgeDocId(domainId, edge._id);
    return docs
        .map((tool) => ({
            uniqueId: uniqueInboundToolId(edge._id, tool._id),
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            kind,
            token: edge.token,
            toolDocId: tool._id,
            edgeDocId: edge._id,
            edgeId: edge.eid,
            type: 'edge' as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function outboundTools(mcp: McpDoc): Promise<NormalizedMcpTool[]> {
    return resolveMcpTools(mcp.tools).map((tool) => ({
        uniqueId: uniqueOutboundToolId(mcp, tool.name),
        name: tool.name,
        description: tool.description || '',
        inputSchema: (tool as any).inputSchema,
        kind: 'outbound' as const,
    }));
}

async function pluginTools(domainId: string, mcp: McpDoc): Promise<NormalizedMcpTool[]> {
    const docs = await ToolModel.getByMcpId(domainId, mcp.mid);
    return docs.map((tool) => ({
        uniqueId: uniquePluginToolId(mcp, tool._id),
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema,
        kind: 'plugin' as const,
        toolDocId: tool._id,
        type: 'plugin_mcp' as const,
    })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function ensureSystemToolsMcp(domainId: string, owner: number): Promise<McpDoc> {
    let mcp = await McpModel.getBySourceSystemKey(domainId, SYSTEM_TOOLS_MCP_LOCAL_KEY);
    if (mcp) {
        const tools = await systemTools(domainId);
        await McpModel.update(domainId, mcp.mid, {
            kind: SYSTEM_TOOLS_MCP_KIND,
            source: { type: SYSTEM_TOOLS_MCP_SOURCE_TYPE, localKey: SYSTEM_TOOLS_MCP_LOCAL_KEY },
            assignable: true,
            status: 'online',
            name: mcp.name || SYSTEM_TOOLS_MCP_NAME,
            description: mcp.description || SYSTEM_TOOLS_MCP_DESCRIPTION,
            toolCount: tools.length,
        });
        try {
            const { ensureSystemDefaultPlugin } = await import('./systemDefaultPlugin');
            await ensureSystemDefaultPlugin(domainId, owner);
        } catch (e) {
            logger.warn('failed to sync System Default plugin for domain=%s: %s', domainId, (e as Error).message);
        }
        return await McpModel.getByMcpId(domainId, mcp.mid) || mcp;
    }
    mcp = await McpModel.add({
        domainId,
        owner,
        kind: SYSTEM_TOOLS_MCP_KIND,
        source: { type: SYSTEM_TOOLS_MCP_SOURCE_TYPE, localKey: SYSTEM_TOOLS_MCP_LOCAL_KEY },
        assignable: true,
        status: 'online',
        name: SYSTEM_TOOLS_MCP_NAME,
        description: SYSTEM_TOOLS_MCP_DESCRIPTION,
    });
    return mcp;
}

export async function getBuiltinEjunzToolsMcp(domainId: string): Promise<McpDoc | null> {
    const docs = await McpModel.getByDomain(domainId);
    return docs.find((mcp) => mcp.kind === EJUNZ_TOOLS_MCP_KIND
        && mcp.source?.type === EJUNZ_TOOLS_MCP_SOURCE_TYPE
        && mcp.source?.localKey === EJUNZ_TOOLS_MCP_LOCAL_KEY) || null;
}

export async function removeBuiltinEjunzToolsMcp(domainId: string): Promise<boolean> {
    const mcps = (await McpModel.getByDomain(domainId)).filter((mcp) => mcp.kind === EJUNZ_TOOLS_MCP_KIND
        && mcp.source?.type === EJUNZ_TOOLS_MCP_SOURCE_TYPE
        && mcp.source?.localKey === EJUNZ_TOOLS_MCP_LOCAL_KEY);
    for (const mcp of mcps) {
        await ToolModel.deleteByMcpId(domainId, mcp.mid);
        await McpModel.del(domainId, mcp.mid);
    }
    return mcps.length > 0;
}

export async function ensureBuiltinEjunzToolsMcp(domainId: string, owner: number): Promise<McpDoc | null> {
    const runtime = getBuiltinEjunzToolsRuntime();
    const runtimeActive = !!runtime;
    const version = getBuiltinEjunzToolsVersion();
    const name = getBuiltinEjunzToolsLabel();
    const source = {
        type: EJUNZ_TOOLS_MCP_SOURCE_TYPE as 'ejunztools',
        localKey: EJUNZ_TOOLS_MCP_LOCAL_KEY,
        runtimeMode: 'builtin' as const,
        runtimeVersion: version,
        packageName: EJUNZ_TOOLS_PACKAGE_NAME,
    };
    const tools = await builtinEjunzTools();
    let mcp = await getBuiltinEjunzToolsMcp(domainId);
    if (mcp) {
        await McpModel.update(domainId, mcp.mid, {
            name: mcp.name || name,
            description: mcp.description || EJUNZ_TOOLS_MCP_DESCRIPTION,
            source,
            assignable: true,
            status: runtimeActive ? 'online' : 'offline',
            toolCount: tools.length,
        });
        const updated = await McpModel.getByMcpId(domainId, mcp.mid) || mcp;
        logger.info('ensured builtin ejunztools MCP: domain=%s mid=%d version=%s tools=%d', domainId, updated.mid, version, tools.length);
        return updated;
    }
    mcp = await McpModel.add({
        domainId,
        owner,
        kind: EJUNZ_TOOLS_MCP_KIND,
        source,
        assignable: true,
        status: runtimeActive ? 'online' : 'offline',
        name,
        description: EJUNZ_TOOLS_MCP_DESCRIPTION,
        toolCount: tools.length,
    });
    logger.info('created builtin ejunztools MCP: domain=%s mid=%d version=%s tools=%d', domainId, mcp.mid, version, tools.length);
    return mcp;
}

export async function ensureInboundMcpForEdge(domainId: string, edge: EdgeDoc): Promise<McpDoc> {
    let mcp = await McpModel.getBySourceEdgeDocId(domainId, edge._id);
    if (mcp) return mcp;
    const isEjunzTools = edgeIsEjunzTools(edge);
    mcp = await McpModel.add({
        domainId,
        owner: edge.owner,
        kind: isEjunzTools ? EJUNZ_TOOLS_MCP_KIND : 'inbound',
        source: {
            type: isEjunzTools ? EJUNZ_TOOLS_MCP_SOURCE_TYPE : 'edge',
            edgeDocId: edge._id,
            edgeId: edge.eid,
            externalUrl: edge.wsEndpoint,
            ...(isEjunzTools ? {
                runtimeMode: 'ws' as const,
                runtimeVersion: edge.provider?.runtimeVersion,
                packageName: EJUNZ_TOOLS_PACKAGE_NAME,
            } : {}),
        },
        assignable: false,
        status: edge.status === 'online' || edge.status === 'working' ? 'online' : 'offline',
        edgeId: edge.eid,
        name: isEjunzTools ? (edge.name || EJUNZ_TOOLS_MCP_NAME) : edgeDisplayName(edge),
        description: edge.description || (isEjunzTools ? '外部 ejunztools WebSocket MCP provider。' : '外部接入的 MCP / Edge provider。'),
    });
    return mcp;
}

export async function getMcpTools(domainId: string, mcp: McpDoc): Promise<NormalizedMcpTool[]> {
    const kind = mcpKind(mcp);
    if (kind === 'outbound') return outboundTools(mcp);
    if (kind === SYSTEM_TOOLS_MCP_KIND) return systemTools(domainId);
    if (kind === 'plugin' || mcp.source?.type === 'plugin') return pluginTools(domainId, mcp);
    if (kind === EJUNZ_TOOLS_MCP_KIND && mcp.source?.runtimeMode === 'builtin') {
        return getBuiltinEjunzToolsRuntime() ? builtinEjunzTools() : [];
    }

    const edgeDocId = mcp.source?.edgeDocId;
    let edge: EdgeDoc | null = null;
    if (edgeDocId) edge = await EdgeModel.get(edgeDocId);
    if (!edge && mcp.edgeId) edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    if (!edge) return [];
    return inboundTools(domainId, edge, kind === EJUNZ_TOOLS_MCP_KIND ? EJUNZ_TOOLS_MCP_KIND : 'inbound');
}

export async function getNormalizedMcp(domainId: string, mid: number): Promise<NormalizedMcpRow | null> {
    const mcp = await McpModel.getByMcpId(domainId, mid);
    if (!mcp) return null;
    const kind = mcpKind(mcp);
    const tools = await getMcpTools(domainId, mcp);
    let edge: EdgeDoc | null = null;
    if (kind === 'inbound' || (kind === EJUNZ_TOOLS_MCP_KIND && mcp.source?.edgeDocId)) {
        if (mcp.source?.edgeDocId) edge = await EdgeModel.get(mcp.source.edgeDocId);
        if (!edge && mcp.edgeId) edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    } else if (kind === 'outbound' && mcp.edgeId) {
        edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    }
    const runtimeMode = (mcp.source?.runtimeMode || edgeRuntimeMode(edge)) as McpRuntimeMode | undefined;
    const runtimeVersion = mcp.source?.runtimeVersion || edgeRuntimeVersion(edge);
    const online = kind === 'outbound' || kind === 'plugin'
        ? mcp.status === 'online'
        : kind === SYSTEM_TOOLS_MCP_KIND
            ? true
            : kind === EJUNZ_TOOLS_MCP_KIND && runtimeMode === 'builtin'
                ? !!getBuiltinEjunzToolsRuntime()
                : !!edge && isEdgeTokenConnected(edge.token);
    const assignable = kind !== 'outbound' && tools.length > 0 && mcp.assignable !== false;
    const sourceLabel = kind === SYSTEM_TOOLS_MCP_KIND
        ? SYSTEM_TOOLS_MCP_SOURCE_LABEL
        : kind === EJUNZ_TOOLS_MCP_KIND
            ? (runtimeMode === 'ws' && edge ? edgeDisplayName(edge) : EJUNZ_TOOLS_PACKAGE_NAME)
            : kind === 'inbound'
                ? (edge ? edgeDisplayName(edge) : 'external')
                : kind === 'plugin'
                    ? 'plugin MCP'
                    : 'outbound endpoint';
    return {
        mcp,
        mid: mcp.mid,
        kind,
        sourceLabel,
        kindLabel: kind,
        assignableLabel: assignable ? '可分配' : '不可分配',
        name: mcp.name || (kind === SYSTEM_TOOLS_MCP_KIND ? SYSTEM_TOOLS_MCP_NAME : kind === EJUNZ_TOOLS_MCP_KIND ? EJUNZ_TOOLS_MCP_NAME : kind === 'inbound' ? 'Inbound MCP' : kind === 'plugin' ? 'Plugin MCP' : `MCP-${mcp.mid}`),
        description: mcp.description || '',
        status: online ? 'online' : (kind === 'outbound' && !mcp.edgeId ? 'pending' : 'offline'),
        online,
        assignable,
        toolCount: tools.length,
        tools,
        edge,
        runtimeMode,
        runtimeVersion,
        runtimeLabel: runtimeMode ? `${runtimeMode}${runtimeVersion ? ` v${runtimeVersion}` : ''}` : undefined,
    };
}

export async function listDomainMcps(domainId: string, user?: User): Promise<NormalizedMcpRow[]> {
    const owner = user?._id || 1;
    await ensureSystemToolsMcp(domainId, owner);
    const ejunzToolsInstalled = await DomainMarketToolModel.has(domainId, EJUNZ_TOOLS_MCP_LOCAL_KEY);
    if (ejunzToolsInstalled) await ensureBuiltinEjunzToolsMcp(domainId, owner);

    const edges = await EdgeModel.getByDomain(domainId);
    for (const edge of edges) {
        if (edge.category === 'outbound' || edge.type === 'mcp') continue;
        const tools = await ToolModel.getByEdgeDocId(domainId, edge._id);
        if (edge.tokenUsedAt || tools.length > 0) {
            const mcp = await ensureInboundMcpForEdge(domainId, edge);
            const isEjunzTools = edgeIsEjunzTools(edge) || mcp.kind === EJUNZ_TOOLS_MCP_KIND;
            const assignable = tools.length > 0;
            const status = isEdgeTokenConnected(edge.token) ? 'online' : 'offline';
            await McpModel.update(domainId, mcp.mid, {
                kind: isEjunzTools ? EJUNZ_TOOLS_MCP_KIND : mcp.kind,
                name: isEjunzTools ? (edge.name || EJUNZ_TOOLS_MCP_NAME) : (mcp.name || edgeDisplayName(edge)),
                edgeId: edge.eid,
                assignable,
                status,
                toolCount: tools.length,
                source: {
                    ...(mcp.source || { type: isEjunzTools ? EJUNZ_TOOLS_MCP_SOURCE_TYPE : 'edge' }),
                    type: isEjunzTools ? EJUNZ_TOOLS_MCP_SOURCE_TYPE : 'edge',
                    edgeDocId: edge._id,
                    edgeId: edge.eid,
                    externalUrl: edge.wsEndpoint,
                    ...(isEjunzTools ? {
                        runtimeMode: 'ws' as const,
                        runtimeVersion: edge.provider?.runtimeVersion,
                        packageName: EJUNZ_TOOLS_PACKAGE_NAME,
                    } : {}),
                },
            });
        }
    }

    const docs = await McpModel.getByDomain(domainId);
    const visibleDocs = docs.filter((mcp) => !(mcp.kind === EJUNZ_TOOLS_MCP_KIND
        && mcp.source?.type === EJUNZ_TOOLS_MCP_SOURCE_TYPE
        && mcp.source?.localKey === EJUNZ_TOOLS_MCP_LOCAL_KEY
        && !ejunzToolsInstalled));
    const rows = (await Promise.all(visibleDocs.map((mcp) => getNormalizedMcp(domainId, mcp.mid))))
        .filter((row): row is NormalizedMcpRow => !!row);
    rows.sort((a, b) => {
        const order = { outbound: 0, system: 1, ejunztools: 2, inbound: 3, plugin: 4 } as Record<McpKind, number>;
        if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
        return (a.mid || 0) - (b.mid || 0);
    });
    return rows;
}
