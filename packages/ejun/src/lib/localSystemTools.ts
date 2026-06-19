import { SYSTEM_TOOLS_CATALOG, executeSystemTool as executeEjunzMarketMcpTool } from '@ejunz/ejunztools';
import DomainMarketToolModel from '../model/domain_market_tool';
import {
    MCP_BUILTIN_TOOLS_CATALOG,
    executeMcpBuiltinTool,
    isMcpBuiltinMutatingTool,
    type McpToolContext,
} from './mcpBuiltinTools';
import type { SystemToolCatalogEntry, SystemToolExecutionContext } from './systemTools';
import {
    SCHEDULE_SYSTEM_TOOLS_CATALOG,
    executeScheduleSystemTool,
    isScheduleSystemTool,
    isScheduleSystemToolMutating,
} from './scheduleSystemTools';

export type LocalMcpToolSource = 'system' | 'schedule' | 'market_mcp';

export interface LocalMcpToolEntry extends SystemToolCatalogEntry {
    id: string;
    source: LocalMcpToolSource;
    defaultEnabled: boolean;
    requiresBaseContext?: boolean;
    mutating?: boolean;
}

const defaultSystemToolEntries: LocalMcpToolEntry[] = MCP_BUILTIN_TOOLS_CATALOG.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: `${tool.description}\n\nRequires an Ejunz base-bound execution context.`,
    inputSchema: tool.inputSchema,
    source: 'system',
    defaultEnabled: true,
    requiresBaseContext: true,
    mutating: isMcpBuiltinMutatingTool(tool.name),
}));

const scheduleSystemToolEntries: LocalMcpToolEntry[] = SCHEDULE_SYSTEM_TOOLS_CATALOG.map((tool) => ({
    id: tool.name,
    name: tool.name,
    description: `${tool.description}\n\nRequires a domain execution context.`,
    inputSchema: tool.inputSchema,
    source: 'system',
    defaultEnabled: true,
    requiresBaseContext: false,
    mutating: isScheduleSystemToolMutating(tool.name),
}));

const marketMcpToolEntries: LocalMcpToolEntry[] = SYSTEM_TOOLS_CATALOG.map((tool) => ({
    id: tool.id,
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
    source: 'market_mcp',
    defaultEnabled: false,
}));

const localMcpToolCatalog: LocalMcpToolEntry[] = (() => {
    const out: LocalMcpToolEntry[] = [];
    const seen = new Set<string>();
    for (const tool of [...defaultSystemToolEntries, ...scheduleSystemToolEntries, ...marketMcpToolEntries]) {
        const key = tool.id || tool.name;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(tool);
    }
    return out;
})();

export function getLocalSystemToolCatalog(): LocalMcpToolEntry[] {
    return [...defaultSystemToolEntries, ...scheduleSystemToolEntries];
}

export function getLocalMcpToolCatalog(): LocalMcpToolEntry[] {
    return localMcpToolCatalog;
}

export function getMarketMcpTools(): LocalMcpToolEntry[] {
    return marketMcpToolEntries;
}

export function findLocalMcpToolByIdOrName(idOrName: string): LocalMcpToolEntry | undefined {
    return localMcpToolCatalog.find((tool) => tool.id === idOrName || tool.name === idOrName);
}

export function findLocalSystemToolByIdOrName(idOrName: string): LocalMcpToolEntry | undefined {
    return getLocalSystemToolCatalog().find((tool) => tool.id === idOrName || tool.name === idOrName);
}

export function isDefaultLocalSystemTool(toolKey: string): boolean {
    return findLocalSystemToolByIdOrName(toolKey)?.defaultEnabled === true;
}

export async function isLocalMcpToolAvailableInDomain(domainId: string, toolKeyOrName: string): Promise<boolean> {
    const entry = findLocalMcpToolByIdOrName(toolKeyOrName);
    if (!entry) return false;
    if (entry.source === 'system') return true;
    return DomainMarketToolModel.has(domainId, entry.id);
}

export async function isLocalSystemToolAvailableInDomain(_domainId: string, toolKeyOrName: string): Promise<boolean> {
    return !!findLocalSystemToolByIdOrName(toolKeyOrName);
}

function requireMcpToolContext(entry: LocalMcpToolEntry, context?: SystemToolExecutionContext): McpToolContext {
    if (!context?.domainId) {
        throw new Error(`Editor MCP tool requires a domain execution context: ${entry.name}`);
    }
    if (!context?.baseDocId) {
        throw new Error(`Editor MCP tool requires an agent knowledge-base binding: ${entry.name}`);
    }
    if (!context?.owner) {
        throw new Error(`Editor MCP tool requires a positive caller/owner context: ${entry.name}`);
    }
    return {
        domainId: context.domainId,
        baseDocId: context.baseDocId,
        branch: context.branch || 'main',
        owner: context.owner,
        setting: context.setting,
    };
}

export async function executeLocalSystemTool(
    name: string,
    args: Record<string, unknown>,
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    const entry = findLocalSystemToolByIdOrName(name);
    if (!entry) throw new Error(`Unknown system tool: ${name}`);
    if (entry.source === 'schedule' || isScheduleSystemTool(entry.name)) {
        return executeScheduleSystemTool(entry.name, args || {}, context);
    }
    return executeMcpBuiltinTool(requireMcpToolContext(entry, context), entry.name, args || {});
}

export async function executeLocalMcpTool(
    name: string,
    args: Record<string, unknown>,
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    const entry = findLocalMcpToolByIdOrName(name);
    if (!entry) throw new Error(`Unknown System Tools tool: ${name}`);
    if (entry.source === 'system') return executeLocalSystemTool(entry.name, args, context);
    if (!context?.domainId || !(await DomainMarketToolModel.has(context.domainId, entry.id))) {
        const err = new Error(`Tool not added: ${entry.name}. Please add it from the MCP Market for this domain.`);
        (err as any).code = 'TOOL_NOT_ADDED';
        throw err;
    }
    return executeEjunzMarketMcpTool(entry.id, args || {});
}
