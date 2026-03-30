import { Handler } from '@ejunz/framework';
import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { param, Types } from '../service/server';
import { NotFoundError, PermissionError, ValidationError } from '../error';
import * as document from '../model/document';
import { PRIV } from '../model/builtin';
import { BaseModel, CardModel } from '../model/base';
import TrainingModel, { listBranchesForBase } from '../model/training';
import UserModel from '../model/user';
import {
    BaseBatchSaveHandler,
    BaseCardHandler,
    BaseConnectionHandler,
    BaseDataHandler,
    BaseEdgeHandler,
    BaseEditorDocHandler,
    BaseEditorUiPrefsHandler,
    BaseExpandStateHandler,
    BaseNodeHandler,
    BaseSaveHandler,
} from './base';
import type {
    BaseDoc, TrainingDagNode, TrainingPlanSource, TrainingSection, TrainingDoc,
} from '../interface';

function trainingDocIdFromParam(raw: string | undefined): ObjectId | null {
    if (!raw || !ObjectId.isValid(raw)) return null;
    return new ObjectId(raw);
}

async function loadBases(domainId: string): Promise<BaseDoc[]> {
    const rows = await document.getMulti(domainId, document.TYPE_BASE, {}).toArray() as BaseDoc[];
    // Training mode may clone/edit both knowledge bases and skill bases.
    // So we should not filter out `type === 'skill'` here.
    return rows;
}

function parsePlanSourcesPayload(raw: unknown): TrainingPlanSource[] {
    let data = raw;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            throw new ValidationError('planSources');
        }
    }
    if (!Array.isArray(data) || !data.length) throw new ValidationError('planSources');
    return data.map((row: any) => {
        const baseDocId = Number(row.baseDocId);
        if (!Number.isSafeInteger(baseDocId) || baseDocId < 1) throw new ValidationError('planSources');
        const sourceBranch = typeof row.sourceBranch === 'string' ? row.sourceBranch.trim() : '';
        const targetBranch = typeof row.targetBranch === 'string' ? row.targetBranch.trim() : '';
        if (!sourceBranch || !targetBranch) throw new ValidationError('planSources');
        return { baseDocId, sourceBranch, targetBranch };
    });
}

function parseDagPayload(raw: unknown): TrainingDagNode[] | undefined {
    if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
    let data = raw;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            throw new ValidationError('dag');
        }
    }
    if (!Array.isArray(data)) throw new ValidationError('dag');
    const ids = new Set<number>();
    const out: TrainingDagNode[] = [];
    const arr = data as any[];
    for (const n of arr) {
        const _id = Number(n._id);
        if (!Number.isFinite(_id)) throw new ValidationError('dag');
        if (ids.has(_id)) throw new ValidationError('dag');
        ids.add(_id);
        if (!n.title || typeof n.title !== 'string' || !String(n.title).trim()) throw new ValidationError('dag');
        if (!Array.isArray(n.requireNids)) throw new ValidationError('dag');
        const requireNids = [...new Set(
            (n.requireNids as any[]).map((x) => Number(x)).filter((x) => Number.isFinite(x)),
        )];
        out.push({ _id, title: String(n.title).trim(), requireNids });
    }
    for (const n of out) {
        for (const nid of n.requireNids) {
            if (!ids.has(nid)) throw new ValidationError('dag');
        }
    }
    return out;
}

function sanitizeBranchName(raw: string): string {
    // Branch name is used as URL path segment. We keep it identical to training.name,
    // but we must forbid '/' because it would break path segmentation.
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.includes('/')) throw new ValidationError('name');
    return s;
}

function pickBranchData(base: BaseDoc, branch: string): { nodes: any[]; edges: any[] } {
    const b = String(branch || 'main');
    const bd: any = (base as any).branchData || {};
    if (b === 'main') {
        return { nodes: (base as any).nodes || [], edges: (base as any).edges || [] };
    }
    return { nodes: bd[b]?.nodes || [], edges: bd[b]?.edges || [] };
}

export class TrainingDomainHandler extends Handler<Context> {
    async get() {
        const trainings = await TrainingModel.getByDomain(this.domain._id);
        trainings.sort((a, b) => {
            const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : 0;
            const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : 0;
            return tb - ta;
        });
        this.response.template = 'training_domain.html';
        this.response.body = { trainings, domainId: this.domain._id };
    }
}

export class TrainingCreateHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const bases = await loadBases(this.domain._id);
        const basesMeta = bases.map((b) => ({
            docId: b.docId,
            title: b.title || String(b.docId),
            branches: listBranchesForBase(b),
        }));
        this.response.template = 'training_create.html';
        this.response.body = {
            domainId: this.domain._id,
            bases,
            basesMeta,
            basesMetaJson: JSON.stringify(basesMeta),
        };
    }

    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const {
            name,
            description,
            introQuote,
            planSources: planSourcesRaw,
            baseDocId: baseRaw,
            sourceBranch,
            targetBranch,
        } = this.request.body || {};
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new ValidationError('name');
        }

        let planSources: TrainingPlanSource[];
        if (planSourcesRaw !== undefined && planSourcesRaw !== null && String(planSourcesRaw).trim() !== '') {
            planSources = parsePlanSourcesPayload(planSourcesRaw);
        } else {
            const baseDocId = Number(baseRaw);
            if (!Number.isSafeInteger(baseDocId) || baseDocId < 1) {
                throw new ValidationError('baseDocId');
            }
            if (!sourceBranch || typeof sourceBranch !== 'string') {
                throw new ValidationError('sourceBranch');
            }
            if (!targetBranch || typeof targetBranch !== 'string') {
                throw new ValidationError('targetBranch');
            }
            planSources = [{
                baseDocId,
                sourceBranch: sourceBranch.trim(),
                targetBranch: targetBranch.trim(),
            }];
        }

        const baseByDocId = new Map<number, BaseDoc>();
        for (const s of planSources) {
            const b = await BaseModel.get(this.domain._id, s.baseDocId);
            if (!b) throw new ValidationError('planSources');
            baseByDocId.set(s.baseDocId, b);
        }

        let mergedBaseDocId: number | null = null;
        let mergedBranch = 'main';
        const mergedBase = await BaseModel.create(
            this.domain._id,
            this.user._id,
            String(name).trim(),
            '',
            undefined,
            'main',
            this.request.ip,
            undefined,
            this.domain.name,
            'base',
            true,
        );
        mergedBaseDocId = Number(mergedBase.docId);

            const mergedNodes: any[] = [];
            const mergedEdges: any[] = [];
            const rootId = `training_root_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            mergedNodes.push({
                id: rootId,
                text: String(name).trim(),
                level: 0,
                expanded: true,
            });

            for (let i = 0; i < planSources.length; i++) {
                const ps = planSources[i];
                const base = baseByDocId.get(ps.baseDocId);
                if (!base) throw new ValidationError('planSources');
                const srcBranch = ps.targetBranch || ps.sourceBranch || 'main';
                const src = pickBranchData(base, srcBranch);
                const srcNodes = (src.nodes || []).map((n: any) => ({ ...n }));
                const srcEdges = (src.edges || []).map((e: any) => ({ ...e }));

                const idMap = new Map<string, string>();
                for (const n of srcNodes) {
                    const newId = `training_${i}_${String(n.id)}`;
                    idMap.set(String(n.id), newId);
                }

                for (const n of srcNodes) {
                    const oldId = String(n.id);
                    const newId = idMap.get(oldId)!;
                    const mergedParent = n.parentId && idMap.has(String(n.parentId))
                        ? idMap.get(String(n.parentId))
                        : rootId;
                    mergedNodes.push({
                        ...n,
                        id: newId,
                        parentId: mergedParent,
                        level: Number(n.level ?? 0) + 1,
                    });
                }

                for (const e of srcEdges) {
                    const source = idMap.get(String(e.source));
                    const target = idMap.get(String(e.target));
                    if (!source || !target) continue;
                    mergedEdges.push({
                        ...e,
                        id: `training_${i}_${String(e.id || `${e.source}_${e.target}`)}`,
                        source,
                        target,
                    });
                }

                const incoming = new Set<string>(srcEdges.map((e: any) => String(e.target)));
                const roots = srcNodes.filter((n: any) => !incoming.has(String(n.id)));
                for (let r = 0; r < roots.length; r++) {
                    const mapped = idMap.get(String(roots[r].id));
                    if (!mapped) continue;
                    mergedEdges.push({
                        id: `training_edge_root_src_${i}_${r}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                        source: rootId,
                        target: mapped,
                    });
                }

                for (const n of srcNodes) {
                    const oldNodeId = String(n.id);
                    const newNodeId = idMap.get(oldNodeId);
                    if (!newNodeId) continue;
                    const cards = await CardModel.getByNodeId(
                        this.domain._id,
                        ps.baseDocId,
                        oldNodeId,
                        srcBranch,
                    );
                    for (const c of cards) {
                        const newCardDocId = await CardModel.create(
                            this.domain._id,
                            mergedBaseDocId,
                            newNodeId,
                            this.user._id,
                            c.title,
                            c.content,
                            this.request.ip,
                            c.problems,
                            c.order,
                            mergedBranch,
                        );
                        await CardModel.update(this.domain._id, newCardDocId, {
                            cardFace: (c as any).cardFace,
                            files: (c as any).files,
                        } as any);
                    }
                }
            }

        await BaseModel.updateFull(this.domain._id, mergedBaseDocId, {
            title: String(name).trim(),
            nodes: mergedNodes,
            edges: mergedEdges,
            branchData: {
                main: { nodes: mergedNodes, edges: mergedEdges },
            },
        });

        const sections: TrainingSection[] = [];
        const dag: TrainingDagNode[] | undefined = undefined;

        const training = await TrainingModel.add({
            domainId: this.domain._id,
            name: name.trim(),
            description: typeof description === 'string' ? description : undefined,
            introQuote: typeof introQuote === 'string' ? introQuote.trim() : undefined,
            planSources,
            sections,
            dag,
            owner: this.user._id,
            baseDocId: mergedBaseDocId || undefined,
            sourceBranch: mergedBranch,
            targetBranch: mergedBranch,
        });
        this.response.redirect = this.url('training_editor_branch', {
            domainId: this.domain._id,
            docId: String(mergedBaseDocId),
            branch: encodeURIComponent(String(mergedBranch)),
        });
    }
}

class TrainingEditorDocHandler extends BaseEditorDocHandler {
    /** 与 BaseEditorDocHandler.get 一致：框架传入整包 args，需 @param 拆出 domainId + branch */
    @param('branch', Types.String, true)
    async get(domainId: string, branch?: string) {
        await super.get(domainId, branch);
        this.response.template = 'training_editor.html';
        if (this.response.body) {
            (this.response.body as any).editorMode = 'training';
        }
    }
}

export class TrainingPreviewHandler extends Handler<Context> {
    async get() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const q = this.request.query || {};
        if (typeof q.sources === 'string' && q.sources.trim()) {
            const planSources = parsePlanSourcesPayload(q.sources);
            for (const s of planSources) {
                const b = await BaseModel.get(this.domain._id, s.baseDocId);
                if (!b) throw new ValidationError('planSources');
            }
            let sections = await TrainingModel.buildSectionsFromPlanSources(this.domain._id, planSources);
            let dag = typeof q.dag === 'string' ? parseDagPayload(q.dag) : undefined;
            if (dag && dag.length === sections.length) {
                sections = TrainingModel.applyDagToSections(sections, dag);
            } else {
                dag = undefined;
            }
            this.response.type = 'application/json';
            this.response.template = null;
            this.response.body = { sections, planSources, dag };
            return;
        }

        const { baseDocId: baseRaw, sourceBranch, targetBranch } = q;
        const baseDocId = Number(baseRaw);
        if (!Number.isSafeInteger(baseDocId) || baseDocId < 1) {
            throw new ValidationError('baseDocId');
        }
        if (!sourceBranch || typeof sourceBranch !== 'string') {
            throw new ValidationError('sourceBranch');
        }
        if (!targetBranch || typeof targetBranch !== 'string') {
            throw new ValidationError('targetBranch');
        }
        const base = await BaseModel.get(this.domain._id, baseDocId);
        if (!base) throw new ValidationError('baseDocId');
        const sections = TrainingModel.buildSectionsFromBranchDiff(base, sourceBranch, targetBranch);
        this.response.type = 'application/json';
        this.response.template = null;
        this.response.body = {
            sections,
            planSources: [{ baseDocId, sourceBranch, targetBranch }],
        };
    }
}

export class TrainingDetailHandler extends Handler<Context> {
    async get() {
        const docId = trainingDocIdFromParam(this.request.params.docId);
        if (!docId) throw new ValidationError('docId');
        const training = await TrainingModel.get(this.domain._id, docId);
        if (!training) throw new NotFoundError('training');

        const baseDocId = Number((training as any).baseDocId);
        if (!baseDocId) throw new ValidationError('baseDocId');
        const branch = String((training as any).targetBranch || (training as any).sourceBranch || 'main');
        this.response.redirect = this.url('training_editor_branch', {
            domainId: this.domain._id,
            docId: String(baseDocId),
            branch: encodeURIComponent(String(branch)),
        });
        return;

        const owner = await UserModel.getById(this.domain._id, training.owner);
        const ownerDisplayName = owner?.uname ? owner.uname : `uid:${training.owner}`;
        const introQuote = training.introQuote || '任何一个伟大的目标，都有一个微不足道的开始。';

        this.response.template = 'training_detail.html';
        this.response.body = {
            training,
            domainId: this.domain._id,
            introQuote,
            ownerDisplayName,
            enrollCount: training.enrollCount ?? 0,
        };
    }
}

export class TrainingEditHandler extends Handler<Context> {
    async prepareTraining(): Promise<TrainingDoc> {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const docId = trainingDocIdFromParam(this.request.params.docId);
        if (!docId) throw new ValidationError('docId');
        const training = await TrainingModel.get(this.domain._id, docId);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }
        return training;
    }

    async get() {
        const training = await this.prepareTraining();
        const baseDocId = Number((training as any).baseDocId);
        if (!baseDocId) throw new ValidationError('baseDocId');
        const branch = String((training as any).targetBranch || (training as any).sourceBranch || 'main');
        this.response.redirect = this.url('training_editor_branch', {
            domainId: this.domain._id,
            docId: String(baseDocId),
            branch: encodeURIComponent(String(branch)),
        });
        return;
    }

    async post() {
        const training = await this.prepareTraining();
        const baseDocId = Number((training as any).baseDocId);
        if (!baseDocId) throw new ValidationError('baseDocId');
        const branch = String((training as any).targetBranch || (training as any).sourceBranch || 'main');
        this.response.redirect = this.url('training_editor_branch', {
            domainId: this.domain._id,
            docId: String(baseDocId),
            branch: encodeURIComponent(String(branch)),
        });
    }
}

export class TrainingDeleteHandler extends Handler<Context> {
    async post() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const docId = trainingDocIdFromParam(this.request.params.docId);
        if (!docId) throw new ValidationError('docId');
        const training = await TrainingModel.get(this.domain._id, docId);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }
        await TrainingModel.del(this.domain._id, docId);
        this.response.redirect = `/training`;
    }
}

export async function apply(ctx: Context) {
    ctx.Route('training_preview', '/training/preview', TrainingPreviewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_create', '/training/create', TrainingCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_delete', '/training/:docId/delete', TrainingDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_domain', '/training', TrainingDomainHandler);
    ctx.Route('training_editor_branch', '/training/:docId/branch/:branch/editor', TrainingEditorDocHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_editor', '/training/:docId/editor', TrainingEditorDocHandler, PRIV.PRIV_USER_PROFILE);

    // Training editor backend endpoints (reuse base handlers, only route prefix differs).
    ctx.Route('training_data', '/training/data', BaseDataHandler);
    ctx.Connection('training_connection', '/training/ws', BaseConnectionHandler);

    ctx.Route('training_node_update', '/training/node/:nodeId', BaseNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_node', '/training/node', BaseNodeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_edge', '/training/edge', BaseEdgeHandler, PRIV.PRIV_USER_PROFILE);

    ctx.Route('training_save', '/training/save', BaseSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_batch_save', '/training/batch-save', BaseBatchSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_expand_state', '/training/expand-state', BaseExpandStateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_editor_ui_prefs', '/training/editor-ui-prefs', BaseEditorUiPrefsHandler, PRIV.PRIV_USER_PROFILE);

    ctx.Route('training_card', '/training/card', BaseCardHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_card_update', '/training/card/:cardId', BaseCardHandler, PRIV.PRIV_USER_PROFILE);
}
