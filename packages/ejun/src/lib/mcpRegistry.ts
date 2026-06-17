import { ObjectId } from 'mongodb';
import type { User } from '../interface';
import type { McpDoc } from '../model/mcp';
import type { EdgeDoc } from '../model/edge';
import type { ToolDoc } from '../model/tool';
import EdgeModel from '../model/edge';
import McpModel from '../model/mcp';
import ToolModel from '../model/tool';
import DomainMarketToolModel from '../model/domain_market_tool';
import { EdgeServerConnectionHandler } from '../handler/edge';
import { getLocalMcpToolCatalog } from './localSystemTools';
import { resolveMcpTools } from './mcpBuiltinTools';

export type McpKind = 'outbound' | 'system' | 'inbound' | 'plugin';

const SYSTEM_TOOLS_MCP_NAME = 'System Tools';
const SYSTEM_TOOLS_MCP_DESCRIPTION = '本站内置的 System Tools 工具集合，按 domain 启用。';
const SYSTEM_TOOLS_MCP_SOURCE_LABEL = 'system_tools';
const SYSTEM_TOOLS_MCP_KIND = 'system';
const SYSTEM_TOOLS_MCP_SOURCE_TYPE = 'system_tools';
const SYSTEM_TOOLS_MCP_LOCAL_KEY = 'system_tools';

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
    type?: 'system' | 'market_mcp' | 'edge' | 'plugin_mcp';
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

export function uniqueInboundToolId(edgeDocId: ObjectId, toolDocId: ObjectId): string {
    return `inbound:${edgeDocId.toString()}:${toolDocId.toString()}`;
}

export function uniquePluginToolId(mcp: McpDoc, toolDocId: ObjectId): string {
    return `plugin:${mcp._id.toString()}:${toolDocId.toString()}`;
}

function edgeDisplayName(edge: EdgeDoc): string {
    return edge.name || `Edge-${edge.eid}`;
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
            kind: SYSTEM_TOOLS_MCP_KIND,
            toolKey: entry.id,
            type: entry.source === 'system' ? 'system' as const : 'market_mcp' as const,
            system: entry.source === 'system' ? true : undefined,
        }));
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return tools;
}

async function inboundTools(domainId: string, edge: EdgeDoc): Promise<NormalizedMcpTool[]> {
    const docs = await ToolModel.getByEdgeDocId(domainId, edge._id);
    return docs
        .map((tool) => ({
            uniqueId: uniqueInboundToolId(edge._id, tool._id),
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            kind: 'inbound' as const,
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
    if (mcp) return mcp;
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

export async function ensureInboundMcpForEdge(domainId: string, edge: EdgeDoc): Promise<McpDoc> {
    let mcp = await McpModel.getBySourceEdgeDocId(domainId, edge._id);
    if (mcp) return mcp;
    mcp = await McpModel.add({
        domainId,
        owner: edge.owner,
        kind: 'inbound',
        source: { type: 'edge', edgeDocId: edge._id, edgeId: edge.eid, externalUrl: edge.wsEndpoint },
        assignable: false,
        status: edge.status === 'online' || edge.status === 'working' ? 'online' : 'offline',
        edgeId: edge.eid,
        name: edgeDisplayName(edge),
        description: edge.description || '外部接入的 MCP / Edge provider。',
    });
    return mcp;
}

export async function getMcpTools(domainId: string, mcp: McpDoc): Promise<NormalizedMcpTool[]> {
    const kind = mcpKind(mcp);
    if (kind === 'outbound') return outboundTools(mcp);
    if (kind === SYSTEM_TOOLS_MCP_KIND) return systemTools(domainId);
    if (kind === 'plugin' || mcp.source?.type === 'plugin') return pluginTools(domainId, mcp);

    const edgeDocId = mcp.source?.edgeDocId;
    let edge: EdgeDoc | null = null;
    if (edgeDocId) edge = await EdgeModel.get(edgeDocId);
    if (!edge && mcp.edgeId) edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    if (!edge) return [];
    return inboundTools(domainId, edge);
}

export async function getNormalizedMcp(domainId: string, mid: number): Promise<NormalizedMcpRow | null> {
    const mcp = await McpModel.getByMcpId(domainId, mid);
    if (!mcp) return null;
    const kind = mcpKind(mcp);
    const tools = await getMcpTools(domainId, mcp);
    let edge: EdgeDoc | null = null;
    if (kind === 'inbound') {
        if (mcp.source?.edgeDocId) edge = await EdgeModel.get(mcp.source.edgeDocId);
        if (!edge && mcp.edgeId) edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    } else if (kind === 'outbound' && mcp.edgeId) {
        edge = await EdgeModel.getByEdgeId(domainId, mcp.edgeId);
    }
    const online = kind === 'outbound' || kind === 'plugin'
        ? mcp.status === 'online'
        : kind === SYSTEM_TOOLS_MCP_KIND
            ? true
            : !!edge && EdgeServerConnectionHandler.active.has(edge.token);
    const assignable = kind !== 'outbound' && tools.length > 0 && mcp.assignable !== false;
    return {
        mcp,
        mid: mcp.mid,
        kind,
        sourceLabel: kind === SYSTEM_TOOLS_MCP_KIND ? SYSTEM_TOOLS_MCP_SOURCE_LABEL : kind === 'inbound' ? (edge ? edgeDisplayName(edge) : 'external') : kind === 'plugin' ? 'plugin MCP' : 'outbound endpoint',
        kindLabel: kind,
        assignableLabel: assignable ? '可分配' : '不可分配',
        name: mcp.name || (kind === SYSTEM_TOOLS_MCP_KIND ? SYSTEM_TOOLS_MCP_NAME : kind === 'inbound' ? 'Inbound MCP' : kind === 'plugin' ? 'Plugin MCP' : `MCP-${mcp.mid}`),
        description: mcp.description || '',
        status: online ? 'online' : (kind === 'outbound' && !mcp.edgeId ? 'pending' : 'offline'),
        online,
        assignable,
        toolCount: tools.length,
        tools,
        edge,
    };
}

export async function listDomainMcps(domainId: string, user?: User): Promise<NormalizedMcpRow[]> {
    const owner = user?._id || 1;
    await ensureSystemToolsMcp(domainId, owner);

    const edges = await EdgeModel.getByDomain(domainId);
    for (const edge of edges) {
        if (edge.category === 'outbound' || edge.type === 'mcp') continue;
        const tools = await ToolModel.getByEdgeDocId(domainId, edge._id);
        if (edge.tokenUsedAt || tools.length > 0) {
            const mcp = await ensureInboundMcpForEdge(domainId, edge);
            const assignable = tools.length > 0;
            const status = EdgeServerConnectionHandler.active.has(edge.token) ? 'online' : 'offline';
            await McpModel.update(domainId, mcp.mid, {
                name: mcp.name || edgeDisplayName(edge),
                edgeId: edge.eid,
                assignable,
                status,
                source: { ...(mcp.source || { type: 'edge' }), edgeDocId: edge._id, edgeId: edge.eid, externalUrl: edge.wsEndpoint },
            });
        }
    }

    const docs = await McpModel.getByDomain(domainId);
    const rows = (await Promise.all(docs.map((mcp) => getNormalizedMcp(domainId, mcp.mid))))
        .filter((row): row is NormalizedMcpRow => !!row);
    rows.sort((a, b) => {
        const order = { outbound: 0, system: 1, inbound: 2, plugin: 3 } as Record<McpKind, number>;
        if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
        return (a.mid || 0) - (b.mid || 0);
    });
    return rows;
}
