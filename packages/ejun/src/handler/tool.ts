import { Handler } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import DomainMarketToolModel from '../model/domain_market_tool';
import { ValidationError } from '../error';
import type { ToolDoc } from '../interface';
import {
    executeLocalMcpTool,
    getLocalMcpToolCatalog,
    getMarketMcpTools,
    isLocalMcpToolAvailableInDomain,
} from '../service/mcp';
import { isMcpBuiltinMutatingTool } from '../service/mcp';
import {
    EJUNZ_TOOLS_MCP_LOCAL_KEY,
    ensureBuiltinEjunzToolsMcp,
    removeBuiltinEjunzToolsMcp,
} from '../service/mcp';
import {
    getBuiltinEjunzToolsRuntime,
    getBuiltinEjunzToolsVersion,
    getEjunzToolsCatalog,
} from '../service/mcp';
import {
    cleanupPluginMcpArtifacts,
    getBuiltinPluginMcpRuntime,
    listBuiltinPluginMcpRuntimes,
} from '../service/mcp';

const logger = new Logger('handler/tool');

export async function domainMarketHasInstalledToolName(domainId: string, name: string): Promise<boolean> {
    return isLocalMcpToolAvailableInDomain(domainId, name);
}

/** Optional market MCP tools from @ejunz/ejunztools. */
export const MARKET_TOOLS_CATALOG = getMarketMcpTools() as Array<{
    id: string;
    name: string;
    description: string;
    inputSchema: ToolDoc['inputSchema'];
}>;

function ejunzToolsMarketEntry() {
    const runtime = getBuiltinEjunzToolsRuntime();
    const version = getBuiltinEjunzToolsVersion();
    const toolCount = getEjunzToolsCatalog().length;
    return {
        id: EJUNZ_TOOLS_MCP_LOCAL_KEY,
        name: 'Ejunz Tools',
        description: `Ejunz Tools builtin MCP provider (${runtime ? 'online' : 'offline'}, version ${version}, ${toolCount} tools).`,
        inputSchema: { type: 'object', properties: {} } as ToolDoc['inputSchema'],
        kind: 'mcp_provider',
        runtimeMode: 'builtin',
        runtimeVersion: version,
        status: runtime ? 'online' : 'offline',
        toolCount,
    };
}

function builtinPluginMarketEntries() {
    return listBuiltinPluginMcpRuntimes()
        .filter((runtime) => runtime.domainInstallable)
        .map((runtime) => ({
            id: runtime.localKey,
            name: runtime.name || runtime.localKey,
            description: runtime.description || `${runtime.packageName || runtime.localKey} builtin plugin MCP provider (${runtime.tools.length} tools).`,
            inputSchema: { type: 'object', properties: {} } as ToolDoc['inputSchema'],
            kind: 'mcp_provider',
            runtimeMode: 'builtin',
            runtimeVersion: runtime.version,
            status: 'online',
            toolCount: runtime.tools.length,
        }));
}

function marketEntries() {
    return [ejunzToolsMarketEntry(), ...builtinPluginMarketEntries()];
}

/** MCP market page: list local/site MCP tools and enable them for the current domain. */
export class McpMarketHandler extends Handler<Context> {
    async get() {
        const enabled = await DomainMarketToolModel.getByDomain(this.domain._id);
        const addedNames = enabled.map((doc) => {
            const entry = marketEntries().find((c) => c.id === doc.toolKey);
            return entry?.name;
        }).filter(Boolean) as string[];
        this.response.template = 'mcp_market.html';
        this.response.body = {
            marketTools: marketEntries(),
            addedNames,
            domainId: this.domain._id,
        };
    }
}

/** Add a local/site MCP tool to this domain. */
export class McpMarketAddHandler extends Handler<Context> {
    async post() {
        const toolKey = this.request.body?.toolKey;
        if (!toolKey || typeof toolKey !== 'string') throw new ValidationError('toolKey');
        const entry = marketEntries().find(e => e.id === toolKey);
        if (!entry) throw new ValidationError('Unknown tool in catalog');

        const has = await DomainMarketToolModel.has(this.domain._id, toolKey);
        if (has) {
            this.response.body = { ok: true, message: 'already_added' };
            return;
        }
        await DomainMarketToolModel.add(this.domain._id, toolKey, this.user._id);
        if (toolKey === EJUNZ_TOOLS_MCP_LOCAL_KEY) {
            const mcp = await ensureBuiltinEjunzToolsMcp(this.domain._id, this.user._id);
            (this.ctx.emit as any)('mcp/tools/update', 'ejunztools');
            this.response.body = { ok: true, mid: mcp?.mid };
            return;
        }
        const runtime = getBuiltinPluginMcpRuntime(toolKey);
        if (runtime) {
            if (!runtime.ensureDomainMcp) throw new ValidationError('Builtin plugin MCP cannot be installed for a domain');
            const mcp = await runtime.ensureDomainMcp({ domainId: this.domain._id, owner: this.user._id });
            (this.ctx.emit as any)('mcp/tools/update', toolKey);
            this.response.body = { ok: true, mid: mcp?.mid };
            return;
        }
        (this.ctx.emit as any)('mcp/tools/update', 'system');
        this.response.body = { ok: true };
    }
}

/** Remove a local/site MCP tool from this domain. */
export class McpMarketRemoveHandler extends Handler<Context> {
    async post() {
        const toolKey = this.request.body?.toolKey;
        if (!toolKey || typeof toolKey !== 'string') throw new ValidationError('toolKey');
        const entry = marketEntries().find(e => e.id === toolKey);
        if (!entry) throw new ValidationError('Unknown tool in catalog');

        const has = await DomainMarketToolModel.has(this.domain._id, toolKey);
        if (!has) {
            this.response.body = { ok: true, message: 'not_added' };
            return;
        }
        await DomainMarketToolModel.remove(this.domain._id, toolKey);
        if (toolKey === EJUNZ_TOOLS_MCP_LOCAL_KEY) {
            await removeBuiltinEjunzToolsMcp(this.domain._id);
            (this.ctx.emit as any)('mcp/tools/update', 'ejunztools');
            this.response.body = { ok: true };
            return;
        }
        const runtime = getBuiltinPluginMcpRuntime(toolKey);
        if (runtime?.removeDomainMcp) {
            await runtime.removeDomainMcp({ domainId: this.domain._id });
        } else if (runtime) {
            await cleanupPluginMcpArtifacts({ domainId: this.domain._id, localKey: toolKey });
        }
        (this.ctx.emit as any)('mcp/tools/update', runtime ? toolKey : 'system');
        this.response.body = { ok: true };
    }
}

export async function apply(ctx: Context) {
    (ctx as any).on('mcp/tools/list/local', async (payload?: { domainId?: string }) => {
        const domainId = payload?.domainId;
        if (!domainId) return [];
        const enabled = await DomainMarketToolModel.getByDomain(domainId);
        const enabledKeys = new Set(enabled.map((doc) => doc.toolKey));
        return getLocalMcpToolCatalog()
            .filter((entry) => entry.defaultEnabled || entry.source === 'system' || enabledKeys.has(entry.id))
            .map((entry) => ({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }));
    });
    (ctx as any).on('mcp/tool/call/local', async (payload: {
        name: string;
        args?: Record<string, unknown>;
        domainId?: string;
        baseDocId?: number;
        branch?: string;
        owner?: number;
    }) => {
        const result = await executeLocalMcpTool(payload.name, payload.args || {}, {
            domainId: payload.domainId,
            baseDocId: payload.baseDocId,
            branch: payload.branch || 'main',
            owner: payload.owner,
        });
        if (payload.baseDocId && isMcpBuiltinMutatingTool(payload.name)) {
            (ctx.emit as any)('base/update', payload.baseDocId, null, payload.branch || 'main');
        }
        return result;
    });
}
