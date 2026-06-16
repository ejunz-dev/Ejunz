import { Handler } from '@ejunz/framework';
import { Context } from '../context';
import { Logger } from '../logger';
import { PRIV } from '../model/builtin';
import DomainMarketToolModel from '../model/domain_market_tool';
import { ValidationError } from '../error';
import type { ToolDoc } from '../interface';
import { registerSystemToolCatalog, registerSystemToolExecutor, executeSystemTool } from '../lib/systemTools';
import { SYSTEM_TOOLS_CATALOG, executeSystemTool as pluginExecuteSystemTool } from '@ejunz/ejunztools';

// Plugin registration: ejunztools catalog + executor into core (no hard-coded package in core)
registerSystemToolCatalog(SYSTEM_TOOLS_CATALOG as any);
registerSystemToolExecutor(pluginExecuteSystemTool);

const logger = new Logger('handler/tool');

export async function domainMarketHasInstalledToolName(domainId: string, name: string): Promise<boolean> {
    const entry = SYSTEM_TOOLS_CATALOG.find((tool) => tool.name === name || tool.id === name);
    return !!entry && await DomainMarketToolModel.has(domainId, entry.id);
}

/** System MCP tools from @ejunz/ejunztools. */
export const MARKET_TOOLS_CATALOG = SYSTEM_TOOLS_CATALOG as Array<{
    id: string;
    name: string;
    description: string;
    inputSchema: ToolDoc['inputSchema'];
}>;

/** MCP market page: list local/site MCP tools and enable them for the current domain. */
export class McpMarketHandler extends Handler<Context> {
    async get() {
        const enabled = await DomainMarketToolModel.getByDomain(this.domain._id);
        const addedNames = enabled.map((doc) => {
            const entry = SYSTEM_TOOLS_CATALOG.find((c) => c.id === doc.toolKey);
            return entry?.name;
        }).filter(Boolean) as string[];
        this.response.template = 'mcp_market.html';
        this.response.body = {
            marketTools: SYSTEM_TOOLS_CATALOG,
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
        const entry = SYSTEM_TOOLS_CATALOG.find(e => e.id === toolKey);
        if (!entry) throw new ValidationError('Unknown tool in catalog');

        const has = await DomainMarketToolModel.has(this.domain._id, toolKey);
        if (has) {
            this.response.body = { ok: true, message: 'already_added' };
            return;
        }
        await DomainMarketToolModel.add(this.domain._id, toolKey, this.user._id);
        (this.ctx.emit as any)('mcp/tools/update', 'system');
        this.response.body = { ok: true };
    }
}

/** Remove a local/site MCP tool from this domain. */
export class McpMarketRemoveHandler extends Handler<Context> {
    async post() {
        const toolKey = this.request.body?.toolKey;
        if (!toolKey || typeof toolKey !== 'string') throw new ValidationError('toolKey');
        const entry = SYSTEM_TOOLS_CATALOG.find(e => e.id === toolKey);
        if (!entry) throw new ValidationError('Unknown tool in catalog');

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

export async function apply(ctx: Context) {
    ctx.Route('mcp_market', '/mcp/market', McpMarketHandler);
    ctx.Route('mcp_market_add', '/mcp/market/add', McpMarketAddHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('mcp_market_remove', '/mcp/market/remove', McpMarketRemoveHandler, PRIV.PRIV_USER_PROFILE);

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
