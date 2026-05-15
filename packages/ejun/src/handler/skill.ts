import type { Context } from '../context';
import { Handler, param, Types } from '../service/server';
import { NotFoundError, BadRequestError, ValidationError } from '../error';
import { PERM, PRIV } from '../model/builtin';
import { BaseModel, attachBaseListStats, loadCardStatsByBaseDocId } from '../model/base';
import { SkillModel, resolveSkillDocByIdOrBid } from '../model/skill';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc } from '../interface';
import * as document from '../model/document';
import {
    getBranchData,
    readOptionalRequestBaseDocId,
    BaseCardHandler,
    BaseNodeHandler,
    BaseEdgeHandler,
    BaseDataHandler,
    BaseSaveHandler,
    BaseBatchSaveHandler,
    BatchSaveOptions,
    BaseOutlineDocHandler,
    BaseEditorDocHandler,
    BaseConnectionHandler,
} from './base';

type RequestLike = { body?: any; query?: any };

async function resolveSkillBaseForApi(domainId: string, req: RequestLike): Promise<BaseDoc> {
    const specified = readOptionalRequestBaseDocId(req);
    if (specified) {
        const base = await SkillModel.get(domainId, specified);
        if (!base) throw new NotFoundError('Base not found');
        return base as BaseDoc;
    }
    const all = await SkillModel.getAll(domainId);
    if (all.length === 0) throw new NotFoundError('Skills Base not found');
    if (all.length === 1) return all[0] as BaseDoc;
    throw new BadRequestError('docId is required when multiple skill libraries exist');
}

export class SkillOutlineDocHandler extends BaseOutlineDocHandler {
    protected override outlineDocPageTemplate(): string {
        return 'skill_outline.html';
    }

    protected override async resolveOutlineDocForGet(domainId: string, docId: string): Promise<BaseDoc | null> {
        const doc = await resolveSkillDocByIdOrBid(domainId, docId);
        return doc ? (doc as unknown as BaseDoc) : null;
    }

    protected override outlineDocBranchRouteName(): 'base_outline_doc_branch' | 'skill_outline_doc_branch' {
        return 'skill_outline_doc_branch';
    }

    protected override assertOutlineDocBase(_base: BaseDoc): void {}

    protected override getOutlineDocRootLabel(base: BaseDoc): string {
        return (base.title && String(base.title).trim()) || 'Skills';
    }

    protected override getOutlineDocEditorMode(): 'base' | 'skill' {
        return 'skill';
    }
}

export class SkillEditorDocHandler extends BaseEditorDocHandler {
    protected override editorDocDevelopPageTemplate(): string {
        return 'skill_editor.html';
    }

    protected override editorDocDevelopPageName(): string {
        return 'skill_editor_doc_branch';
    }

    @param('docId', Types.String)
    override async _prepare(domainId: string, docId: string) {
        this.base = (await resolveSkillDocByIdOrBid(domainId, docId)) as BaseDoc | undefined;
        if (!this.base) throw new NotFoundError('Base not found');
    }

    protected override getEditorOutlineBranchUrl(domainId: string, docId: string, branch: string): string {
        return this.url('skill_outline_doc_branch', { domainId, docId, branch });
    }
}

class SkillDomainListHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('pjax', Types.Boolean)
    @param('format', Types.String, true)
    async get(domainId: string, page = 1, q = '', pjax = false, format?: string) {
        const did = typeof domainId === 'string' ? domainId : (this.args?.domainId ?? (domainId as any)?._id ?? 'system');
        const limit = this.ctx.setting.get('pagination.problem') || 20;
        let bases = await SkillModel.getAll(did);
        const qs = (q || '').trim();
        if (qs) {
            const lower = qs.toLowerCase();
            bases = bases.filter((b) => (b.title || '').toLowerCase().includes(lower) || (b.content || '').toLowerCase().includes(lower));
        }
        const total = bases.length;
        const ppcount = Math.max(1, Math.ceil(total / limit));
        const page1 = Math.max(1, Math.min(page, ppcount));
        const basesSlice = bases.slice((page1 - 1) * limit, page1 * limit);
        const pageNumericIds = basesSlice.map((b) => Number(b.docId)).filter((n) => Number.isFinite(n) && n > 0);
        const cardStatsPage = await loadCardStatsByBaseDocId(did, pageNumericIds);
        const basesPage = attachBaseListStats(
            basesSlice.map((b) => ({
                ...b,
                docId: b.docId.toString(),
                nodes: (b as any).nodes || [],
            })) as any,
            cardStatsPage,
        );
        if (format === 'json') {
            this.response.body = {
                bases: basesPage,
                domainId: String(did),
                page: page1,
                ppcount,
                totalPages: ppcount,
                qs,
            };
            return;
        }
        this.response.template = 'skill_domain.html';
        if (pjax) {
            const html = await this.renderHTML('partials/skill_list.html', {
                bases: basesPage,
                domainId: String(did),
                page: page1,
                ppcount,
                totalPages: ppcount,
                qs,
            });
            this.response.body = {
                title: this.renderTitle(this.translate('skill_domain')),
                fragments: [{ html: html || '' }],
            };
        } else {
            this.response.body = {
                bases: basesPage,
                domainId: String(did),
                page: page1,
                ppcount,
                totalPages: ppcount,
                qs,
            };
        }
    }

    async postDeleteSelected(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const { docIds } = this.request.body;
        const did = typeof domainId === 'string' ? domainId : (this.args?.domainId ?? 'system');
        const ids: string[] = Array.isArray(docIds) ? docIds : [];
        for (const raw of ids) {
            const id = Number(raw);
            if (!Number.isFinite(id)) continue;
            const base = await SkillModel.get(did, id);
            if (!base) continue;
            if (!this.user.own(base)) {
                this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
            }
            await SkillModel.delete(did, id);
        }
        this.response.body = { success: true };
    }
}

class SkillOutlineLegacyRedirectHandler extends Handler {
    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        const skills = await SkillModel.getAll(domainId);
        const b = branch && String(branch).trim() ? branch.trim() : 'main';
        if (skills.length === 1) {
            const docSeg = (skills[0].bid && String(skills[0].bid).trim()) || String(skills[0].docId);
            this.response.redirect = this.url('skill_outline_doc_branch', { domainId, docId: docSeg, branch: b });
            return;
        }
        this.response.redirect = this.url('skill_domain', { domainId });
    }
}

class SkillListLegacyRedirectHandler extends Handler {
    async get(domainId: string) {
        const path = this.url('skill_domain', { domainId });
        const query = this.request.query || {};
        const q = typeof (query as any).q === 'string' ? (query as any).q : '';
        const pageRaw = (query as any).page;
        const page = pageRaw != null ? String(pageRaw) : '';
        const pairs: string[] = [];
        if (q) pairs.push(`q=${encodeURIComponent(q)}`);
        if (page) pairs.push(`page=${encodeURIComponent(page)}`);
        this.response.redirect = pairs.length ? `${path}?${pairs.join('&')}` : path;
    }
}

class SkillCreateNewHandler extends Handler {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = 'skill_create.html';
        this.response.body = {};
    }

    @param('title', Types.String)
    @param('bid', Types.String, true)
    async post(domainId: string, title: string, bid?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const actualDomainId = this.args.domainId || domainId || 'system';
        const trimmedTitle = (title || '').trim();
        if (!trimmedTitle) {
            throw new ValidationError(this.translate('Skill library title is required.'));
        }
        const finalBid = (bid || '').trim();
        if (finalBid) {
            const existed = await SkillModel.getBybid(actualDomainId, finalBid);
            if (existed) {
                throw new ValidationError(this.translate('Skill library SID already exists: {0}').replace('{0}', finalBid));
            }
        }
        const { docId } = await SkillModel.create(
            actualDomainId,
            this.user._id,
            trimmedTitle,
            '',
            'main',
            this.request.ip,
            this.domain.name,
            finalBid || undefined,
        );
        const docSeg = finalBid || String(docId);
        this.response.redirect = this.url('skill_outline_doc_branch', {
            domainId: actualDomainId,
            docId: docSeg,
            branch: 'main',
        });
    }
}

class SkillCardHandler extends BaseCardHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc> {
        const specified = readOptionalRequestBaseDocId(this.request);
        if (specified) {
            const base = await SkillModel.get(domainId, specified);
            if (!base) throw new NotFoundError('Base not found');
            return base as BaseDoc;
        }
        return resolveSkillBaseForApi(domainId, this.request);
    }
}

class SkillNodeHandler extends BaseNodeHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc> {
        return resolveSkillBaseForApi(domainId, this.request);
    }
}

class SkillEdgeHandler extends BaseEdgeHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc> {
        return resolveSkillBaseForApi(domainId, this.request);
    }
}

class SkillDataHandler extends BaseDataHandler {
    protected override async getBase(domainId: string): Promise<BaseDoc | null> {
        const specified = readOptionalRequestBaseDocId(this.request);
        if (specified) {
            return (await SkillModel.get(domainId, specified)) as BaseDoc | null;
        }
        const all = await SkillModel.getAll(domainId);
        return all.length === 1 ? (all[0] as BaseDoc) : null;
    }

    protected override async createBase(domainId: string, branch: string): Promise<BaseDoc> {
        const title = (this.domain.name && `${this.domain.name} Skills`) || 'Agent Skills';
        const { docId } = await SkillModel.create(
            domainId,
            this.user._id,
            title,
            'Agent Skills 管理',
            branch,
            this.request.ip,
            this.domain.name,
            undefined,
            this.getDefaultRootText(),
        );
        const base = await SkillModel.get(domainId, docId);
        if (!base) throw new Error('Failed to create Skills base');
        return base as BaseDoc;
    }

    protected override getDefaultRootText(): string {
        return 'Skills';
    }

    protected override getCardFilter(base: BaseDoc): Record<string, unknown> {
        return { baseDocId: base.docId };
    }

    @param('branch', Types.String, true)
    override async get(domainId: string, branch?: string) {
        const all = await SkillModel.getAll(domainId);
        const specified = readOptionalRequestBaseDocId(this.request);
        if (!specified && all.length > 1) {
            throw new BadRequestError('docId is required when multiple skill libraries exist');
        }
        let base = await this.getBase(domainId);
        if (!base) base = await this.createBase(domainId, branch || 'main');
        const skillsBase = base;
        const currentBranch = branch || (skillsBase as any)?.currentBranch || 'main';
        const branchData = getBranchData(skillsBase, currentBranch);
        let nodes: BaseNode[] = branchData.nodes || [];
        let edges: BaseEdge[] = branchData.edges || [];
        if (nodes.length === 0) {
            const rootNode: Omit<BaseNode, 'id'> = { text: this.getDefaultRootText(), level: 0 };
            await SkillModel.addNode(domainId, skillsBase.docId, rootNode, undefined, currentBranch);
            const updatedBase = await SkillModel.get(domainId, skillsBase.docId);
            if (updatedBase) {
                const updatedBranchData = getBranchData(updatedBase as BaseDoc, currentBranch);
                nodes = updatedBranchData.nodes || [];
                edges = updatedBranchData.edges || [];
            }
        }
        const allCards = await document.getMulti(domainId, document.TYPE_CARD, this.getCardFilter(skillsBase))
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        const nodeCardsMap: Record<string, CardDoc[]> = {};
        for (const card of allCards) {
            if (card.nodeId) {
                if (!nodeCardsMap[card.nodeId]) nodeCardsMap[card.nodeId] = [];
                nodeCardsMap[card.nodeId].push(card);
            }
        }
        for (const nodeId of Object.keys(nodeCardsMap)) {
            nodeCardsMap[nodeId].sort((a, b) =>
                (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid));
        }
        this.response.body = {
            ...skillsBase,
            nodes,
            edges,
            currentBranch,
            nodeCardsMap,
            files: skillsBase.files || [],
        };
    }
}

class SkillSaveHandler extends BaseSaveHandler {
    protected override saveMindMapDocType(): typeof document.TYPE_BASE | typeof document.TYPE_SKILL {
        return document.TYPE_SKILL;
    }

    protected override async getBase(domainId: string): Promise<BaseDoc | null> {
        const specified = readOptionalRequestBaseDocId(this.request);
        if (specified) {
            const b = await SkillModel.get(domainId, specified);
            return (b as BaseDoc) || null;
        }
        const all = await SkillModel.getAll(domainId);
        return all.length === 1 ? (all[0] as BaseDoc) : null;
    }

    protected override getDefaultTitle(): string {
        return 'Agent Skills 管理';
    }

    protected override getDefaultRootText(): string {
        return 'Skills';
    }

    protected override async createBase(domainId: string): Promise<BaseDoc> {
        const title = (this.domain.name && `${this.domain.name} Skills`) || 'Skills';
        const { docId } = await SkillModel.create(
            domainId,
            this.user._id,
            title,
            'Agent Skills 管理',
            'main',
            this.request.ip,
            this.domain.name,
            undefined,
            this.getDefaultRootText(),
        );
        const base = await SkillModel.get(domainId, docId);
        if (!base) throw new Error('Failed to create Skills base');
        return base as BaseDoc;
    }

    protected override shouldSyncToGit(): boolean {
        return false;
    }

    override async post(domainId: string) {
        const specified = readOptionalRequestBaseDocId(this.request);
        const all = await SkillModel.getAll(domainId);
        if (!specified && all.length > 1) {
            throw new BadRequestError('docId is required when multiple skill libraries exist');
        }
        return super.post(domainId);
    }
}

class SkillImplicitEditorHandler extends Handler {
    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const b = branch && String(branch).trim() ? branch.trim() : 'main';
        const all = await SkillModel.getAll(domainId);
        if (all.length === 1) {
            const docSeg = (all[0].bid && String(all[0].bid).trim()) || String(all[0].docId);
            this.response.redirect = this.url('skill_editor_doc_branch', { domainId, docId: docSeg, branch: b });
            return;
        }
        this.response.redirect = this.url('skill_domain', { domainId });
    }
}

class SkillBatchSaveHandler extends BaseBatchSaveHandler {
    protected override getBatchSaveOptions(): BatchSaveOptions {
        return {
            type: 'skill',
            mapDocType: document.TYPE_SKILL,
            getBase: async (d) => {
                const specified = readOptionalRequestBaseDocId(this.request);
                if (specified) {
                    return (await SkillModel.get(d, specified)) as BaseDoc | null;
                }
                const all = await SkillModel.getAll(d);
                return all.length === 1 ? (all[0] as BaseDoc) : null;
            },
            createBase: async (d) => {
                const title = (this.domain.name && `${this.domain.name} Skills`) || 'Skills';
                const { docId } = await SkillModel.create(
                    d,
                    this.user._id,
                    title,
                    'Agent Skills 管理',
                    'main',
                    this.request.ip,
                    this.domain.name,
                    undefined,
                    'Skills',
                );
                const base = await SkillModel.get(d, docId);
                if (!base) throw new Error('Failed to create Skills base');
                return base as BaseDoc;
            },
            getBranch: () => 'main',
        };
    }

    override async post(domainId: string) {
        const specified = readOptionalRequestBaseDocId(this.request);
        const all = await SkillModel.getAll(this.args.domainId || domainId || 'system');
        if (!specified && all.length > 1) {
            throw new BadRequestError('docId is required when multiple skill libraries exist');
        }
        return super.post(domainId);
    }
}

export async function apply(ctx: Context) {
    ctx.Route('skill_list', '/skill/list', SkillListLegacyRedirectHandler);
    ctx.Route('skill_create', '/skill/create', SkillCreateNewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_domain', '/skill', SkillDomainListHandler);
    ctx.Route('skill_outline_branch', '/skill/branch/:branch', SkillOutlineLegacyRedirectHandler);
    ctx.Route('skill_outline_doc', '/skill/:docId/outline', SkillOutlineDocHandler);
    ctx.Route('skill_outline_doc_branch', '/skill/:docId/outline/branch/:branch', SkillOutlineDocHandler);
    ctx.Route('skill_data', '/skill/data', SkillDataHandler);
    ctx.Route('skill_save', '/skill/save', SkillSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_batch_save', '/skill/batch-save', SkillBatchSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_card', '/skill/card', SkillCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_card_update', '/skill/card/:cardId', SkillCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_node', '/skill/node', SkillNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_node_update', '/skill/node/:nodeId', SkillNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_edge', '/skill/edge', SkillEdgeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_editor', '/skill/editor', SkillImplicitEditorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_editor_branch', '/skill/editor/branch/:branch', SkillImplicitEditorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_editor_doc', '/skill/:docId/editor', SkillEditorDocHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('skill_editor_doc_branch', '/skill/:docId/branch/:branch/editor', SkillEditorDocHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('skill_connection', '/skill/ws', BaseConnectionHandler);
}
