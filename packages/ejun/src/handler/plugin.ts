import { Filter } from 'mongodb';
import type { Context } from '../context';
import { BadRequestError, ForbiddenError, NotFoundError, ValidationError } from '../error';
import type { BaseDoc, BaseNode, CardDoc, PluginDoc } from '../interface';
import { sanitizePluginNodeData, summarizePluginDefinitions } from '../lib/pluginRuntime';
import { BaseModel, CardModel, getBranchData, TYPE_CARD, type MindMapDocType } from '../model/base';
import { PERM, PRIV } from '../model/builtin';
import * as document from '../model/document';
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
    };
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
        await PluginModel.update(domainId, docId, {
            title,
            content,
            pluginSlug: parsePluginSlug(pluginSlug, title),
            visibility: vis,
            enabled: enabled !== 'off' && enabled !== 'false',
        } as Partial<PluginDoc>);
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
