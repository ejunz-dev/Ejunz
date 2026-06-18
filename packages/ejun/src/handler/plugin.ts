import { Filter } from 'mongodb';
import type { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError, ValidationError } from '../error';
import type { BaseDoc, BaseNode, CardDoc, DomainDoc, PluginDoc } from '../interface';
import { loadPluginCardDefinitions, sanitizePluginNodeData, summarizePluginDefinitions } from '../lib/pluginRuntime';
import {
    parseDraftPluginMcpDefinitions,
    refreshPluginMcpStatus,
    summarizePluginMcpAvailability,
    syncPluginManagedMcps,
    testPluginMcpDefinitions,
    checkAllEnabledPluginMcpStatus,
    cleanupPluginMcpArtifacts,
} from '../lib/pluginMcp';
import { listDomainMcps } from '../lib/mcpRegistry';
import { BaseModel, CardModel, getBranchData, TYPE_CARD, type MindMapDocType } from '../model/base';
import { PERM, PRIV } from '../model/builtin';
import * as document from '../model/document';
import DomainModel from '../model/domain';
import PluginModel from '../model/plugin';
import { Handler, param, post, query, Types } from '../service/server';
import { BaseBatchSaveHandler, buildBaseEditorPageBody } from './base';

function parsePluginSlug(raw: unknown, fallback: string): string {
    const s = String(raw || '').trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return s || PluginModel.slugify(fallback) || 'plugin';
}

function assertPluginEditable(handler: Handler, plugin: PluginDoc) {
    if (!PluginModel.canEdit(handler.user, plugin)) {
        throw new ForbiddenError('Only plugin owner or system administrator can edit this plugin');
    }
}

async function buildPluginView(domainId: string, plugin: PluginDoc) {
    return {
        ...plugin,
        summary: await summarizePluginDefinitions(domainId, plugin),
        mcpAvailability: await summarizePluginMcpAvailability(domainId, plugin, plugin.currentBranch || 'main'),
    };
}

async function cleanupDeletedPluginArtifacts(domainId: string, pluginDocId: number) {
    await cleanupPluginMcpArtifacts({ domainId, pluginDocId });
    await document.deleteMulti(domainId, document.TYPE_CARD, { baseDocId: pluginDocId } as any);
    await document.coll.updateMany({
        domainId,
        docType: document.TYPE_AGENT,
        'pluginBindings.docId': pluginDocId,
    } as any, {
        $pull: { pluginBindings: { docId: pluginDocId } },
    } as any);
}

async function buildAvailableMcpServicesForPluginEditor(domainId: string, user: any) {
    const rows = await listDomainMcps(domainId, user);
    return rows
        .filter((row) => row.assignable && row.kind !== 'outbound')
        .map((row) => ({
            mid: row.mid,
            kind: row.kind,
            sourceLabel: row.sourceLabel,
            name: row.name,
            description: String(row.description || '').slice(0, 1000),
            status: row.status,
            online: row.online,
            assignable: row.assignable,
            toolCount: row.toolCount,
            tools: (row.tools || []).map((tool) => ({
                uniqueId: tool.uniqueId,
                name: tool.name,
                description: String(tool.description || '').slice(0, 1000),
                kind: tool.kind,
                toolDocId: tool.toolDocId?.toString(),
                toolKey: tool.toolKey,
                edgeDocId: tool.edgeDocId?.toString(),
                edgeId: tool.edgeId,
                type: tool.type,
            })),
        }));
}

export class PluginDomainHandler extends Handler {
    @query('q', Types.String, true)
    async get(domainId: string, q?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const query: Filter<PluginDoc> = {} as any;
        const all = await PluginModel.getAll(domainId, query);
        const keyword = String(q || '').trim().toLowerCase();
        const plugins = await Promise.all(all
            .filter((p) => PluginModel.canRead(this.user, p) || PluginModel.canEdit(this.user, p))
            .filter((p) => {
                if (!keyword) return true;
                return [p.title, p.content, p.pluginSlug, ...(p.tag || [])]
                    .some((x) => String(x || '').toLowerCase().includes(keyword));
            })
            .map((p) => buildPluginView(domainId, p)));
        this.response.template = 'plugin_domain.html';
        this.response.body = {
            plugins,
            qs: q || '',
        };
    }
}

export class PluginCreateHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = 'plugin_edit.html';
        this.response.body = { plugin: null, operation: 'create' };
    }

    @param('title', Types.Title)
    @post('content', Types.Content, true)
    @post('pluginSlug', Types.String, true)
    async post(domainId: string, title: string, content = '', pluginSlug?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const slug = parsePluginSlug(pluginSlug, title);
        const existing = await PluginModel.getAll(domainId, { pluginSlug: slug } as any);
        if (existing.length) throw new ValidationError('pluginSlug');
        const { docId } = await PluginModel.create(domainId, this.user._id, title, content, this.request.ip, {
            pluginSlug: slug,
            visibility: 'private',
            enabled: true,
        });
        this.response.redirect = this.url('plugin_editor', { docId });
    }
}

export class PluginMetaEditHandler extends Handler {
    plugin?: PluginDoc;

    @param('docId', Types.PositiveInt)
    async prepare(domainId: string, docId: number) {
        this.plugin = await PluginModel.get(domainId, docId);
        if (!this.plugin) throw new NotFoundError('Plugin not found');
    }

    @param('docId', Types.PositiveInt)
    async get(_domainId: string, _docId: number) {
        assertPluginEditable(this, this.plugin!);
        this.response.template = 'plugin_edit.html';
        this.response.body = { plugin: this.plugin, operation: 'update' };
    }

    @param('docId', Types.PositiveInt)
    @param('title', Types.Title)
    @post('content', Types.Content, true)
    @post('pluginSlug', Types.String, true)
    @post('visibility', Types.String, true)
    @post('enabled', Types.String, true)
    async post(domainId: string, docId: number, title: string, content = '', pluginSlug?: string, visibility?: string, enabled?: string) {
        assertPluginEditable(this, this.plugin!);
        const vis = visibility === 'domain' || visibility === 'system' ? visibility : 'private';
        if (vis === 'system' && !this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM)) throw new ForbiddenError('Only administrator can create system plugins');
        const nextEnabled = enabled !== 'off' && enabled !== 'false';
        const wasEnabled = this.plugin!.enabled !== false;
        await PluginModel.update(domainId, docId, {
            title,
            content,
            pluginSlug: parsePluginSlug(pluginSlug, title),
            visibility: vis,
            enabled: nextEnabled,
        } as Partial<PluginDoc>);
        if (wasEnabled && !nextEnabled) await cleanupPluginMcpArtifacts({ domainId, pluginDocId: docId });
        this.response.redirect = this.url('plugin_editor', { docId });
    }
}

export class PluginDeleteHandler extends Handler {
    @param('docId', Types.PositiveInt)
    async post(domainId: string, docId: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const plugin = await PluginModel.get(domainId, docId);
        if (!plugin) throw new NotFoundError('Plugin not found');
        assertPluginEditable(this, plugin);
        await cleanupDeletedPluginArtifacts(domainId, docId);
        await PluginModel.delete(domainId, docId);
        this.response.body = { success: true };
        this.response.redirect = this.url('plugin_domain');
    }
}

export class PluginEditorHandler extends Handler {
    plugin?: PluginDoc;

    @param('docId', Types.PositiveInt)
    async prepare(domainId: string, docId: number) {
        this.plugin = await PluginModel.get(domainId, docId);
        if (!this.plugin) throw new NotFoundError('Plugin not found');
        if (!PluginModel.canRead(this.user, this.plugin) && !PluginModel.canEdit(this.user, this.plugin)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    @param('docId', Types.PositiveInt)
    async get(domainId: string, docId: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const branch = typeof this.request.query?.branch === 'string' && this.request.query.branch.trim()
            ? this.request.query.branch.trim()
            : 'main';
        let availableMcpServices: any[] = [];
        try {
            availableMcpServices = await buildAvailableMcpServicesForPluginEditor(domainId, this.user);
        } catch (err: any) {
            console.warn('[plugin-editor] failed to load available MCP services:', err?.message || err);
        }
        const body = await buildBaseEditorPageBody({
            domainId,
            base: this.plugin as BaseDoc,
            requestedBranch: branch,
            uid: this.user._id,
            priv: this.user.priv,
            domainName: this.plugin!.title,
            db: this.ctx.db.db,
            makeEditorUrl: (id, br) => this.url('plugin_editor', { docId: id, query: br === 'main' ? {} : { branch: br } }),
            developPoolUiMode: 'none',
            mapDocType: document.TYPE_PLUGIN,
            editorMode: 'plugins',
            editorApiBasePath: 'plugins',
            socketUrl: '',
            includeContribution: false,
        } as any);
        this.response.template = 'base_editor.html';
        this.response.body = {
            ...body,
            availableMcpServices,
            page_name: 'plugin_editor',
        };
    }
}

export class PluginDataHandler extends Handler {
    @param('branch', Types.String, true)
    @param('docId', Types.PositiveInt, true)
    async get(domainId: string, branch?: string, docId?: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!docId) throw new BadRequestError('docId');
        const plugin = await PluginModel.get(domainId, docId);
        if (!plugin) throw new NotFoundError('Plugin not found');
        if (!PluginModel.canRead(this.user, plugin) && !PluginModel.canEdit(this.user, plugin)) throw new ForbiddenError('Plugin not accessible');
        const currentBranch = branch || plugin.currentBranch || 'main';
        const branchData = getBranchData(plugin as BaseDoc, currentBranch);
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const node of branchData.nodes || []) {
            const cards = await CardModel.getByNodeId(domainId, plugin.docId, node.id, currentBranch);
            if (cards.length) nodeCardsMap[node.id] = cards;
        }
        this.response.body = {
            ...plugin,
            nodes: branchData.nodes || [],
            edges: branchData.edges || [],
            currentBranch,
            nodeCardsMap,
        };
    }
}

export class PluginBatchSaveHandler extends BaseBatchSaveHandler {
    protected getBatchSaveOptions() {
        return {
            type: 'plugin' as const,
            mapDocType: document.TYPE_PLUGIN as MindMapDocType,
            getBase: async (_d: string) => null,
            createBase: async () => { throw new BadRequestError('docId'); },
            getBranch: (base: BaseDoc) => (base as any).currentBranch || 'main',
        };
    }

    protected shouldWriteLearningSidecars(): boolean {
        return false;
    }

    protected async sanitizeNodeCreatePayload(nodeCreate: any, realParentId: string | undefined, ctx: { domainId: string; docId: number; branch: string; base: BaseDoc; mapDocType: MindMapDocType }): Promise<Partial<BaseNode>> {
        const payload = await super.sanitizeNodeCreatePayload(nodeCreate, realParentId, ctx);
        const data = await sanitizePluginNodeData(nodeCreate.data, ctx.domainId);
        if (data) payload.data = data as any;
        return payload;
    }

    protected async sanitizeNodeUpdatePayload(nodeUpdate: any, ctx: { domainId: string; docId: number; branch: string; base: BaseDoc; mapDocType: MindMapDocType }): Promise<Partial<BaseNode>> {
        const payload = await super.sanitizeNodeUpdatePayload(nodeUpdate, ctx);
        if (nodeUpdate.data !== undefined) {
            const data = await sanitizePluginNodeData(nodeUpdate.data, ctx.domainId);
            if (data) payload.data = data as any;
        }
        return payload;
    }

    protected async beforeBatchApply(ctx: { domainId: string; docId: number; branch: string; base: BaseDoc; mapDocType: MindMapDocType; data: any }) {
        const plugin = ctx.base as PluginDoc;
        const definitions = await parseDraftPluginMcpDefinitions({
            domainId: ctx.domainId,
            plugin,
            branch: ctx.branch,
            batch: ctx.data,
        });
        if (!definitions.some((def) => (def.mcpConfigs?.length || 0) > 0 || (def.mcpConfigErrors?.length || 0) > 0)) return { success: true as const };
        const summary = await testPluginMcpDefinitions({
            domainId: ctx.domainId,
            plugin,
            branch: ctx.branch,
            definitions,
        });
        if (!summary.ok) {
            return {
                success: false as const,
                code: 'PLUGIN_MCP_TEST_FAILED',
                errors: summary.errors.length ? summary.errors : ['Plugin MCP test failed; save blocked.'],
                details: summary.results,
            };
        }
        (ctx.data as any).__pluginMcpPreflight = { definitions, summary };
        return { success: true as const };
    }

    protected async afterSuccessfulBatchApply(ctx: { domainId: string; docId: number; branch: string; base: BaseDoc; mapDocType: MindMapDocType; data: any }) {
        const plugin = await PluginModel.get(ctx.domainId, ctx.docId);
        if (!plugin) return;
        const cached = (ctx.data as any).__pluginMcpPreflight;
        const definitions = await loadPluginCardDefinitions(ctx.domainId, plugin, ctx.branch);
        const summary = cached?.summary || await testPluginMcpDefinitions({
            domainId: ctx.domainId,
            plugin,
            branch: ctx.branch,
            definitions,
        });
        await syncPluginManagedMcps({ domainId: ctx.domainId, plugin, branch: ctx.branch, definitions, testSummary: summary });
        await refreshPluginMcpStatus({ domainId: ctx.domainId, plugin, branch: ctx.branch, reason: 'save', definitions, testSummary: summary });
    }
}

export class PluginCatalogHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    async get(domainId: string, docId?: number) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const plugins = docId ? [await PluginModel.get(domainId, docId)] : await PluginModel.getAll(domainId, {} as any);
        this.response.body = await Promise.all((plugins.filter(Boolean) as PluginDoc[])
            .filter((p) => PluginModel.canRead(this.user, p) || PluginModel.canEdit(this.user, p))
            .map(async (p) => ({ docId: p.docId, title: p.title, pluginSlug: p.pluginSlug, summary: await summarizePluginDefinitions(domainId, p) })));
    }
}

export async function apply(ctx: Context) {
    if (process.env.NODE_APP_INSTANCE === '0' || process.env.NODE_APP_INSTANCE === undefined) {
        const intervalMs = Math.max(60_000, Number(process.env.PLUGIN_MCP_CHECK_INTERVAL_MS) || 5 * 60_000);
        setInterval(async () => {
            try {
                const domains = await DomainModel.getMulti({}).project({ _id: 1 }).toArray() as Pick<DomainDoc, '_id'>[];
                for (const d of domains) await checkAllEnabledPluginMcpStatus(d._id);
            } catch (err: any) {
                console.warn('[plugin-mcp] periodic check failed:', err?.message || err);
            }
        }, intervalMs);
    }

    ctx.Route('plugin_domain', '/plugins', PluginDomainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_create', '/plugins/create', PluginCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_catalog', '/plugins/catalog', PluginCatalogHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_catalog_doc', '/plugins/:docId/catalog', PluginCatalogHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_data', '/plugins/data', PluginDataHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_batch_save', '/plugins/batch-save', PluginBatchSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_edit', '/plugins/:docId/edit', PluginMetaEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_delete', '/plugins/:docId/delete', PluginDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_editor', '/plugins/:docId/editor', PluginEditorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('plugin_detail', '/plugins/:docId', PluginEditorHandler, PRIV.PRIV_USER_PROFILE);
}
