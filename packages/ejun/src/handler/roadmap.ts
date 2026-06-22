import parser from '@ejunz/utils/lib/search';
import type { Context } from '../context';
import { BadRequestError, NotFoundError, ValidationError } from '../error';
import type { RoadmapDoc } from '../interface';
import { parseCategory } from '../lib/category';
import { PERM, PRIV } from '../model/builtin';
import RoadmapModel from '../model/roadmap';
import { readOptionalRequestBaseDocId } from '../model/base';
import { Handler, param, post, Types } from '../service/server';
import { applyRoadmapGitRoutes, checkoutRoadmapGitBranch, fetchRoadmapGithubContext } from '../lib/roadmap_git';
import * as document from '../model/document';

const ROADMAP_LIST_SEARCH_OPTIONS = {
    keywords: ['category'],
    offsets: true,
    alwaysArray: true,
    tokenize: true,
};

function readStoredRid(doc: RoadmapDoc | null | undefined): string | undefined {
    if (!doc?.rid) return undefined;
    const rid = String(doc.rid).trim();
    return rid || undefined;
}

function readRoadmapRidInput(source: Record<string, unknown> = {}): string | undefined {
    const rid = String(source.rid || '').trim();
    return rid || undefined;
}

async function assertRoadmapRidAvailable(
    handler: Handler,
    domainId: string,
    rid: string,
    excludeDocId?: number,
): Promise<void> {
    const existed = await RoadmapModel.getByRid(domainId, rid);
    if (!existed) return;
    if (excludeDocId != null && existed.docId === excludeDocId) return;
    throw new ValidationError(handler.translate('Roadmap rid already exists: {0}').replace('{0}', rid));
}

function filterRoadmapsBySearchQuery(roadmaps: RoadmapDoc[], q: string): RoadmapDoc[] {
    const trimmed = (q || '').trim();
    if (!trimmed) return roadmaps;
    const parsed = parser.parse(trimmed, ROADMAP_LIST_SEARCH_OPTIONS) as {
        category?: string[];
        text?: string[];
    };
    const categories = (parsed.category || []).map(String).filter(Boolean);
    const freeText = (parsed.text || []).join(' ').trim().toLowerCase();
    return roadmaps.filter((item) => {
        if (categories.length) {
            const tags = Array.isArray(item.tag) ? item.tag : [];
            if (!categories.some((c) => tags.includes(c))) return false;
        }
        if (freeText) {
            const hay = `${item.title || ''} ${item.content || ''} ${readStoredRid(item) || ''}`.toLowerCase();
            if (!hay.includes(freeText)) return false;
        }
        return true;
    });
}

function attachRoadmapListStats(roadmaps: RoadmapDoc[]) {
    return roadmaps.map((item) => {
        const view = RoadmapModel.withGraph(item);
        return {
            ...item,
            docId: item.docId.toString(),
            rid: readStoredRid(item),
            listStats: {
                nodeCount: view.nodes?.length || 0,
                edgeCount: view.edges?.length || 0,
            },
        };
    });
}

async function resolveRoadmap(domainId: string, docIdOrRid: string): Promise<RoadmapDoc | null> {
    const key = String(docIdOrRid || '').trim();
    if (!key) return null;
    if (/^\d+$/.test(key)) {
        const byId = await RoadmapModel.get(domainId, Number(key));
        if (byId) return byId;
    }
    return RoadmapModel.getByRid(domainId, key);
}

function ensureRoadmapEditable(handler: Handler, roadmap: RoadmapDoc): void {
    if (!handler.user.own(roadmap)) handler.checkPerm(PERM.PERM_EDIT_DISCUSSION);
}

async function applyRoadmapBranchSwitch(
    handler: Handler,
    domainId: string,
    roadmap: RoadmapDoc,
    requestedBranch: string,
): Promise<RoadmapDoc> {
    const currentBaseBranch = (roadmap as any).currentBranch || 'main';
    if (requestedBranch !== currentBaseBranch) {
        await document.set(domainId, document.TYPE_ROADMAP, roadmap.docId, {
            currentBranch: requestedBranch,
        } as any);
        (roadmap as any).currentBranch = requestedBranch;
        try {
            await checkoutRoadmapGitBranch(domainId, roadmap.docId, requestedBranch);
        } catch (err) {
            console.error('Failed to checkout roadmap git branch:', err);
        }
    }
    return RoadmapModel.withGraph(roadmap, requestedBranch);
}

async function renderRoadmapPage(
    handler: Handler,
    domainId: string,
    docId: number,
    editable: boolean,
    branch?: string,
): Promise<void> {
    const roadmap = await RoadmapModel.get(domainId, docId);
    if (!roadmap) throw new NotFoundError('Roadmap not found');
    if (editable) ensureRoadmapEditable(handler, roadmap);

    const requestedBranch = (branch && String(branch).trim()) || (roadmap as any).currentBranch || 'main';
    const viewRoadmap = await applyRoadmapBranchSwitch(handler, domainId, roadmap, requestedBranch);
    const nodeCardsMap = await RoadmapModel.buildNodeCardsMap(domainId, docId, requestedBranch);
    const githubCtx = editable
        ? await fetchRoadmapGithubContext(domainId, handler.user._id)
        : { userGithubTokenConfigured: false };

    handler.response.template = editable ? 'roadmap_edit.html' : 'roadmap_detail.html';
    handler.response.body = {
        roadmap: viewRoadmap,
        domainId,
        currentBranch: requestedBranch,
        githubRepo: ((roadmap as any).githubRepo || '') as string,
        userGithubTokenConfigured: githubCtx.userGithubTokenConfigured,
        nodeCardsMap,
    };
}

export class RoadmapMainHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('q', Types.Content, true)
    @param('pjax', Types.Boolean)
    async get(domainId: string, page = 1, q = '', pjax = false) {
        const did = typeof domainId === 'string' ? domainId : (this.args?.domainId ?? 'system');
        const limit = this.ctx.setting.get('pagination.problem') || 20;
        let roadmaps = await RoadmapModel.getAll(did);
        roadmaps = filterRoadmapsBySearchQuery(roadmaps, q);
        const total = roadmaps.length;
        const ppcount = Math.max(1, Math.ceil(total / limit));
        const page1 = Math.max(1, Math.min(page, ppcount));
        const slice = roadmaps.slice((page1 - 1) * limit, page1 * limit);
        const qs = (q || '').trim();
        const roadmapsPage = attachRoadmapListStats(slice);

        this.response.template = 'roadmap_main.html';
        if (pjax) {
            const html = await this.renderHTML('partials/roadmap_list.html', {
                roadmaps: roadmapsPage,
                domainId: String(did),
                page: page1,
                ppcount,
                totalPages: ppcount,
                qs,
            });
            this.response.body = {
                title: this.renderTitle(this.translate('roadmap_main')),
                fragments: [{ html: html || '' }],
            };
        } else {
            this.response.body = {
                roadmaps: roadmapsPage,
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
            const roadmap = await RoadmapModel.get(did, id);
            if (!roadmap) continue;
            if (!this.user.own(roadmap)) {
                this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
            }
            await RoadmapModel.delete(did, id);
        }
        this.response.body = { success: true };
    }
}

export class RoadmapListHandler extends Handler {
    @param('format', Types.String, true)
    async get(domainId: string, format?: string) {
        const roadmaps = attachRoadmapListStats(await RoadmapModel.getAll(domainId));
        if (format === 'json') {
            this.response.body = { roadmaps };
            return;
        }
        this.response.redirect = this.url('roadmap_main', { domainId });
    }
}

export class RoadmapCreateHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.template = 'roadmap_create.html';
        this.response.body = { domainId };
    }

    @param('title', Types.String)
    @param('rid', Types.String, true)
    @param('content', Types.String, true)
    @post('tag', Types.Content, true, null, parseCategory)
    async post(
        domainId: string,
        title: string,
        rid?: string,
        content?: string,
        tag: string[] = [],
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const did = typeof domainId === 'string' ? domainId : (this.args?.domainId ?? 'system');
        const finalTitle = (title || '').trim();
        if (!finalTitle) throw new ValidationError(this.translate('Title is required'));

        const finalRid = readRoadmapRidInput({ rid });
        if (finalRid) await assertRoadmapRidAvailable(this, did, finalRid);

        const { docId } = await RoadmapModel.create(did, this.user._id, finalTitle, content || '', this.request.ip, {
            rid: finalRid,
            tag: tag?.length ? [...new Set(tag)] : undefined,
        });

        this.response.body = { docId, rid: finalRid };
        this.response.redirect = this.url('roadmap_edit', { docId });
    }
}

export class RoadmapManageHandler extends Handler {
    roadmap?: RoadmapDoc;

    @param('docId', Types.String)
    async _prepare(domainId: string, docId: string) {
        this.roadmap = await resolveRoadmap(domainId, docId) || undefined;
        if (!this.roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(this.roadmap)) {
            this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        }
    }

    async get() {
        this.response.template = 'roadmap_manage.html';
        this.response.body = { roadmap: this.roadmap };
    }

    @param('docId', Types.String)
    @param('title', Types.String, true)
    @param('content', Types.String, true)
    @param('rid', Types.String, true)
    @post('tag', Types.Content, true, null, parseCategory)
    async postUpdate(
        domainId: string,
        docId: string,
        title?: string,
        content?: string,
        rid?: string,
        tag?: string[],
    ) {
        const roadmapDoc = this.roadmap!;
        const updates: Partial<RoadmapDoc> = {};
        if (title !== undefined) updates.title = title;
        if (content !== undefined) updates.content = content;
        if (tag !== undefined) updates.tag = [...new Set(tag)];
        if (rid !== undefined) {
            const finalRid = String(rid).trim();
            if (finalRid) {
                const existed = await RoadmapModel.getByRid(domainId, finalRid);
                if (existed && existed.docId !== roadmapDoc.docId) {
                    throw new ValidationError(this.translate('Roadmap rid already exists: {0}').replace('{0}', finalRid));
                }
                updates.rid = finalRid;
            } else {
                updates.rid = undefined;
            }
        }

        await RoadmapModel.update(domainId, roadmapDoc.docId, updates);
        this.response.body = { docId: roadmapDoc.docId, rid: rid ? String(rid).trim() : undefined };
        this.response.redirect = this.url('roadmap_detail', { docId: roadmapDoc.docId });
    }

    @param('docId', Types.String)
    async postDelete(domainId: string, docId: string) {
        if (!this.user.own(this.roadmap)) {
            this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        }
        await RoadmapModel.delete(domainId, this.roadmap!.docId);
        this.response.redirect = this.url('roadmap_main', { domainId });
    }
}

export class RoadmapDetailHandler extends Handler {
    @param('docId', Types.PositiveInt)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        const roadmap = await RoadmapModel.get(domainId, docId);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        if (!branch || !String(branch).trim()) {
            this.response.redirect = this.url('roadmap_detail_branch', {
                docId: docId.toString(),
                branch: 'main',
            });
            return;
        }
        await RoadmapModel.incrementViews(domainId, docId);
        const requestedBranch = String(branch).trim();
        const viewRoadmap = await applyRoadmapBranchSwitch(this, domainId, roadmap, requestedBranch);

        this.response.template = 'roadmap_detail.html';
        this.response.body = {
            roadmap: viewRoadmap,
            domainId,
            currentBranch: requestedBranch,
        };
    }
}

export class RoadmapEditPageHandler extends Handler {
    @param('docId', Types.PositiveInt)
    @param('branch', Types.String, true)
    async get(domainId: string, docId: number, branch?: string) {
        if (!branch || !String(branch).trim()) {
            this.response.redirect = this.url('roadmap_edit_branch', {
                docId: docId.toString(),
                branch: 'main',
            });
            return;
        }
        await renderRoadmapPage(this, domainId, docId, true, branch);
    }
}

export class RoadmapDataHandler extends Handler {
    @param('docId', Types.PositiveInt, true)
    @param('branch', Types.String, true)
    async get(domainId: string, docId?: number, branch?: string) {
        if (!docId) throw new BadRequestError('docId');
        const roadmap = await RoadmapModel.get(domainId, docId);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(roadmap)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        const qBranch = branch || this.request.query?.branch;
        const effectiveBranch = qBranch ? String(qBranch) : ((roadmap as any).currentBranch || 'main');
        const view = RoadmapModel.withGraph(roadmap, effectiveBranch);
        const nodeCardsMap = await RoadmapModel.buildNodeCardsMap(domainId, docId, effectiveBranch);
        this.response.body = { ...view, nodeCardsMap };
    }
}

export class RoadmapSaveHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const did = this.args.domainId || (typeof domainId === 'string' ? domainId : 'system');
        const docId = readOptionalRequestBaseDocId(this.request) ?? Number(this.args.docId);
        if (!docId) throw new BadRequestError('docId');

        const roadmap = await RoadmapModel.get(did, docId);
        if (!roadmap) throw new NotFoundError('Roadmap not found');
        if (!this.user.own(roadmap)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const data = this.request.body || {};
        const branch = data.branch || (roadmap as any).currentBranch || 'main';
        await RoadmapModel.saveGraph(did, docId, {
            nodes: data.nodes,
            edges: data.edges,
            layout: data.layout,
            viewport: data.viewport,
            theme: data.theme,
            branch,
        });

        const cardCreates = Array.isArray(data.cardCreates) ? data.cardCreates : [];
        const cardUpdates = Array.isArray(data.cardUpdates) ? data.cardUpdates : [];
        const cardIdMap = (cardCreates.length || cardUpdates.length)
            ? await RoadmapModel.applyCardMutations(
                did,
                docId,
                branch,
                this.user._id,
                this.request.ip,
                cardCreates,
                cardUpdates,
            )
            : {};

        const nodeCardsMap = await RoadmapModel.buildNodeCardsMap(did, docId, branch);
        this.response.body = { success: true, cardIdMap, nodeCardsMap };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('roadmap_main', '/roadmap', RoadmapMainHandler);
    ctx.Route('roadmap_list', '/roadmap/list', RoadmapListHandler);
    ctx.Route('roadmap_create', '/roadmap/create', RoadmapCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_data', '/roadmap/data', RoadmapDataHandler);
    ctx.Route('roadmap_save', '/roadmap/save', RoadmapSaveHandler, PRIV.PRIV_USER_PROFILE);
    // Static /roadmap/* paths must register before /roadmap/:docId (otherwise "branch" matches as docId).
    await applyRoadmapGitRoutes(ctx);
    ctx.Route('roadmap_manage', '/roadmap/:docId/manage', RoadmapManageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_edit', '/roadmap/:docId/edit', RoadmapEditPageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_edit_branch', '/roadmap/:docId/branch/:branch/edit', RoadmapEditPageHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('roadmap_detail', '/roadmap/:docId', RoadmapDetailHandler);
    ctx.Route('roadmap_detail_branch', '/roadmap/:docId/branch/:branch', RoadmapDetailHandler);
}

