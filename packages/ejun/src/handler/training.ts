import { Handler } from '@ejunz/framework';
import type { Context } from '../context';
import { Types, ConnectionHandler, param } from '../service/server';
import { ObjectId } from 'mongodb';
import { Logger } from '../utils';
import { NotFoundError, PermissionError, ValidationError } from '../error';
import * as document from '../model/document';
import { PRIV } from '../model/builtin';
import { PERM } from '../model/builtin';
import { BaseModel, CardModel } from '../model/base';
import TrainingModel, { listBranchesForBase } from '../model/training';
import {
    loadTrainingMergedGraph,
    makeTrainingNodeId,
    makeTrainingRootId,
    parseTrainingNodeId,
    pickBranchData,
} from '../lib/trainingMergedGraph';
import UserModel from '../model/user';
import moment from 'moment-timezone';
import { getTodayUserDomainContribution } from '../lib/homepageRanking';
import type {
    BaseDoc, TrainingDagNode, TrainingPlanSource, TrainingSection, TrainingDoc, CardDoc, BaseNode, BaseEdge,
} from '../interface';
const logger = new Logger('training');

async function computeTrainingTodayContribution(
    domainId: string,
    uid: number,
    training: TrainingDoc,
    mergedNodes: BaseNode[],
): Promise<{ nodes: number; cards: number; problems: number; nodeChars: number; cardChars: number; problemChars: number }> {
    const todayKey = moment.utc().format('YYYY-MM-DD');
    const t = await getTodayUserDomainContribution(domainId, uid, todayKey);
    return { ...t, nodeChars: 0, cardChars: 0, problemChars: 0 };
}

function normalizeDomainId(domainId: any, args: any): string {
    if (typeof domainId === 'string' && domainId) return domainId;
    const did = args?.domainId ?? (domainId as any)?._id ?? (domainId as any)?.domainId ?? 'system';
    return String(did || 'system');
}

function stripTrainingPrefix(baseDocId: number, s: string): string {
    const prefix = `t_${baseDocId}_`;
    const v = String(s || '');
    return v.startsWith(prefix) ? v.slice(prefix.length) : v;
}

function getRootNodeIdLocal(nodes: BaseNode[] = [], edges: BaseEdge[] = []): string | null {
    if (!nodes.length) return null;
    const levelRoot = nodes.find((n: any) => Number((n as any).level || 0) === 0);
    if (levelRoot) return String((levelRoot as any).id);
    const incoming = new Set((edges || []).map((e: any) => String((e as any).target)));
    const noIncoming = nodes.find((n: any) => !incoming.has(String((n as any).id)));
    return noIncoming ? String((noIncoming as any).id) : String((nodes[0] as any).id);
}

export class TrainingConnectionHandler extends ConnectionHandler {
    private trainingDocId?: string;
    private subscriptions: Array<{ dispose: () => void }> = [];

    @param('docId', Types.String, true)
    async prepare(domainId: string, docId?: string) {
        const finalDomainId = domainId || (this.request.query?.domainId as string) || (this.args as any).domainId;
        const qDocId = this.request.query?.docId as string;
        const finalDocId = (docId && String(docId).trim()) || (qDocId && String(qDocId).trim()) || '';
        if (!finalDomainId || !finalDocId || !ObjectId.isValid(finalDocId)) {
            this.close(1000, 'domainId and docId are required');
            return;
        }
        this.trainingDocId = finalDocId;
        const tid = new ObjectId(finalDocId);
        const training = await TrainingModel.get(finalDomainId, tid);
        if (!training) {
            this.close(1000, 'Training not found');
            return;
        }
        if (training.owner !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        }
        const sources = TrainingModel.resolvePlanSources(training);
        const targetPairs = new Set(sources.map((s) => `${s.baseDocId}::${s.targetBranch || 'main'}`));

        logger.info('Training WebSocket connected: docId=%s', finalDocId);

        try {
            const { nodes } = await loadTrainingMergedGraph(finalDomainId, training);
            const todayContribution = await computeTrainingTodayContribution(finalDomainId, this.user._id, training as any, nodes);
            this.send({ type: 'init', todayContribution, todayContributionAllDomains: todayContribution, contributions: [], contributionDetails: {} });
        } catch {
            this.send({ type: 'init' });
        }

        const dispose = (this.ctx.on as any)('base/update', async (...args: any[]) => {
            const [baseDocId, _userId, branch] = args;
            const key = `${Number(baseDocId)}::${String(branch || 'main')}`;
            if (!targetPairs.has(key)) return;
            try {
                const fresh = await TrainingModel.get(finalDomainId, tid);
                if (!fresh) {
                    this.send({ type: 'update' });
                    return;
                }
                const { nodes } = await loadTrainingMergedGraph(finalDomainId, fresh);
                const todayContribution = await computeTrainingTodayContribution(finalDomainId, this.user._id, fresh as any, nodes);
                this.send({ type: 'update', todayContribution, todayContributionAllDomains: todayContribution, contributions: [], contributionDetails: {} });
            } catch {
                this.send({ type: 'update' });
            }
        });
        this.subscriptions.push({ dispose });
    }

    async message(_msg: any) {
        // Editor uses WS only as a trigger to refetch data.
    }

    async cleanup() {
        for (const sub of this.subscriptions) {
            try { sub.dispose(); } catch { }
        }
        this.subscriptions = [];
    }
}

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

/** Create training-named branch + clone main cards when absent (used on training create and when adding a base to an existing plan). */
async function materializeTrainingBranches(
    domainId: string,
    userId: number,
    ip: string,
    baseBranchName: string,
    planSources: TrainingPlanSource[],
    basesToMaterialize: Set<number>,
) {
    const baseByDocId = new Map<number, BaseDoc>();
    for (const s of planSources) {
        if (!basesToMaterialize.has(s.baseDocId)) continue;
        const b = await BaseModel.get(domainId, s.baseDocId);
        if (!b) throw new ValidationError('planSources');
        baseByDocId.set(s.baseDocId, b);
    }
    for (const ps of planSources) {
        if (!basesToMaterialize.has(ps.baseDocId)) continue;
        const base = baseByDocId.get(ps.baseDocId);
        if (!base) throw new ValidationError('planSources');

        const main = pickBranchData(base, 'main');
        const bd: any = (base as any).branchData || {};
        if (!bd[baseBranchName]) {
            bd[baseBranchName] = {
                nodes: JSON.parse(JSON.stringify(main.nodes || [])),
                edges: JSON.parse(JSON.stringify(main.edges || [])),
            };
            await document.set(domainId, document.TYPE_BASE, ps.baseDocId, {
                branchData: bd,
                updateAt: new Date(),
            } as any);
        }

        const existing = await document.getMulti(domainId, document.TYPE_CARD, {
            baseDocId: ps.baseDocId,
            branch: baseBranchName,
        } as any).limit(1).toArray();
        if (existing.length) continue;

        const mainCards = await document.getMulti(domainId, document.TYPE_CARD, {
            baseDocId: ps.baseDocId,
            $or: [{ branch: 'main' }, { branch: { $exists: false } }],
        } as any).toArray() as any[];
        for (const c of mainCards) {
            const newCardDocId = await CardModel.create(
                domainId,
                ps.baseDocId,
                String(c.nodeId),
                userId,
                String(c.title || ''),
                String(c.content || ''),
                ip,
                (c as any).problems,
                (c as any).order,
                baseBranchName,
            );
            await CardModel.update(domainId, newCardDocId, {
                cardFace: (c as any).cardFace,
                files: (c as any).files,
            } as any);
        }
    }
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

        const trainingName = String(name).trim();
        if (!trainingName) throw new ValidationError('name');

        const baseBranchName = sanitizeBranchName(trainingName);
        if (!baseBranchName) throw new ValidationError('name');

        const allBaseIds = new Set(planSources.map((s) => s.baseDocId));
        await materializeTrainingBranches(
            this.domain._id,
            this.user._id,
            this.request.ip,
            baseBranchName,
            planSources,
            allBaseIds,
        );

        planSources = planSources.map((s) => ({
            baseDocId: s.baseDocId,
            sourceBranch: 'main',
            targetBranch: baseBranchName,
        }));

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
        });
        this.response.redirect = this.url('training_editor', {
            domainId: this.domain._id,
            trainingDocId: String(training.docId),
        });
    }
}

export class TrainingBasesEditHandler extends Handler<Context> {
    @param('trainingDocId', Types.String)
    async get(domainId: string, trainingDocId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!trainingDocId || !ObjectId.isValid(trainingDocId)) throw new ValidationError('docId');
        const tid = new ObjectId(trainingDocId);
        const training = await TrainingModel.get(did, tid);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }
        const bases = await loadBases(did);
        const basesMeta = bases.map((b) => ({
            docId: b.docId,
            title: b.title || String(b.docId),
            branches: listBranchesForBase(b),
        }));
        const sources = TrainingModel.resolvePlanSources(training);
        const initialPlan = sources.map((s) => ({ baseDocId: s.baseDocId }));
        this.response.template = 'training_bases_edit.html';
        this.response.body = {
            domainId: did,
            trainingDocId: String(training.docId),
            training,
            basesMeta,
            basesMetaJson: JSON.stringify(basesMeta),
            initialPlanSourcesJson: JSON.stringify(initialPlan),
        };
    }

    @param('trainingDocId', Types.String)
    async post(domainId: string, trainingDocId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!trainingDocId || !ObjectId.isValid(trainingDocId)) throw new ValidationError('docId');
        const tid = new ObjectId(trainingDocId);
        const training = await TrainingModel.get(did, tid);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }
        const { planSources: planSourcesRaw } = this.request.body || {};
        const parsed = parsePlanSourcesPayload(planSourcesRaw);
        const oldSources = TrainingModel.resolvePlanSources(training);
        const baseBranchNameRaw = oldSources.length
            ? String(oldSources[0].targetBranch || '').trim()
            : sanitizeBranchName(String(training.name || '').trim());
        if (!baseBranchNameRaw) throw new ValidationError('planSources');

        const ids = parsed.map((r) => r.baseDocId);
        if (new Set(ids).size !== ids.length) {
            throw new ValidationError('planSources');
        }

        const normalized: TrainingPlanSource[] = parsed.map((s) => ({
            baseDocId: s.baseDocId,
            sourceBranch: 'main',
            targetBranch: baseBranchNameRaw,
        }));

        for (const s of normalized) {
            const b = await BaseModel.get(did, s.baseDocId);
            if (!b) throw new ValidationError('planSources');
        }

        const oldIds = new Set(oldSources.map((s) => s.baseDocId));
        const toMaterialize = new Set(
            normalized.filter((s) => !oldIds.has(s.baseDocId)).map((s) => s.baseDocId),
        );
        if (toMaterialize.size) {
            await materializeTrainingBranches(
                did,
                this.user._id,
                this.request.ip,
                baseBranchNameRaw,
                normalized,
                toMaterialize,
            );
        }

        await TrainingModel.update(did, tid, { planSources: normalized });
        this.response.redirect = this.url('training_editor', {
            domainId: did,
            trainingDocId: String(tid),
        });
    }
}

export class TrainingEditorHandler extends Handler<Context> {
    @param('trainingDocId', Types.String)
    async get(domainId: string, trainingDocId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!trainingDocId || !ObjectId.isValid(trainingDocId)) throw new ValidationError('docId');
        const tid = new ObjectId(trainingDocId);
        const training = await TrainingModel.get(did, tid);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }

        const { nodes, edges, nodeCardsMap } = await loadTrainingMergedGraph(did, training);
        const todayContribution = await computeTrainingTodayContribution(did, this.user._id, training as any, nodes);
        const _sources = TrainingModel.resolvePlanSources(training);
        const trainingTargetBranch = _sources.length
            ? String(_sources[0].targetBranch || '').trim() || 'main'
            : 'main';
        this.response.template = 'training_editor.html';
        this.response.body = {
            base: {
                docId: String(training.docId),
                title: training.name,
                type: 'training',
                nodes,
                edges,
            },
            currentBranch: 'main',
            branches: ['main'],
            nodeCardsMap,
            files: [],
            domainId: did,
            editorMode: 'training',
            trainingTargetBranch,
            trainingDocId: String(training.docId),
            todayContribution,
            todayContributionAllDomains: todayContribution,
            contributions: [],
            contributionDetails: {},
            githubRepo: '',
            userGithubTokenConfigured: false,
        };
    }
}

export class TrainingDataHandler extends Handler<Context> {
    @param('docId', Types.String)
    async get(domainId: string, docId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!docId || !ObjectId.isValid(docId)) throw new ValidationError('docId');
        const tid = new ObjectId(docId);
        const training = await TrainingModel.get(did, tid);
        if (!training) throw new NotFoundError('training');
        const { nodes, edges, nodeCardsMap } = await loadTrainingMergedGraph(did, training);
        const todayContribution = await computeTrainingTodayContribution(did, this.user._id, training as any, nodes);
        this.response.body = {
            docId: String(training.docId),
            title: training.name,
            nodes,
            edges,
            currentBranch: 'main',
            nodeCardsMap,
            todayContribution,
            todayContributionAllDomains: todayContribution,
        };
    }
}

export class TrainingSaveHandler extends Handler<Context> {
    async post(domainId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const body: any = this.request.body || {};
        const rawDocId = String(body.docId || body.trainingDocId || '');
        if (!rawDocId || !ObjectId.isValid(rawDocId)) throw new ValidationError('docId');
        const tid = new ObjectId(rawDocId);
        const training = await TrainingModel.get(did, tid);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const nodes: BaseNode[] = Array.isArray(body.nodes) ? body.nodes : [];
        const edges: BaseEdge[] = Array.isArray(body.edges) ? body.edges : [];
        const sources = TrainingModel.resolvePlanSources(training);
        const byBase = new Map<number, { branch: string; nodes: BaseNode[]; edges: BaseEdge[] }>();
        for (const s of sources) byBase.set(s.baseDocId, { branch: s.targetBranch || 'main', nodes: [], edges: [] });

        const rootId = makeTrainingRootId(String(training.docId));
        for (const n of nodes) {
            const nid = String((n as any).id ?? (n as any)._id ?? '');
            if (!nid || nid === rootId) continue;
            const parsed = parseTrainingNodeId(nid);
            if (!parsed) continue;
            const bucket = byBase.get(parsed.baseDocId);
            if (!bucket) continue;

            const rawParentId = (n as any).parentId ? String((n as any).parentId) : '';
            const parsedParent = rawParentId ? parseTrainingNodeId(rawParentId) : null;
            const parentId = (parsedParent && parsedParent.baseDocId === parsed.baseDocId) ? parsedParent.nodeId : undefined;

            bucket.nodes.push({
                ...(n as any),
                id: parsed.nodeId,
                parentId,
                level: Math.max(0, Number((n as any).level || 0) - 1),
            } as any);
        }

        for (const e of edges) {
            const parsedS = parseTrainingNodeId(String((e as any).source ?? (e as any).from ?? ''));
            const parsedT = parseTrainingNodeId(String((e as any).target ?? (e as any).to ?? ''));
            if (!parsedS || !parsedT) continue;
            if (parsedS.baseDocId !== parsedT.baseDocId) continue;
            const bucket = byBase.get(parsedS.baseDocId);
            if (!bucket) continue;
            bucket.edges.push({
                ...(e as any),
                id: stripTrainingPrefix(
                    parsedS.baseDocId,
                    (e as any).id ? String((e as any).id) : `${parsedS.nodeId}=>${parsedT.nodeId}`,
                ),
                source: parsedS.nodeId,
                target: parsedT.nodeId,
            } as any);
        }

        for (const [baseDocId, bucket] of byBase) {
            // Safety: if we couldn't parse any node/edge for this base from payload,
            // do NOT overwrite the branch to empty (prevents accidental wipeout).
            if (!bucket.nodes.length && !bucket.edges.length) continue;
            const base = await BaseModel.get(did, baseDocId);
            if (!base) continue;
            // Protect base root node: never allow deleting it from training editor payload.
            const currentBranchData: any = (base as any).branchData?.[bucket.branch];
            const curNodes: BaseNode[] = (currentBranchData?.nodes || (bucket.branch === 'main' ? (base as any).nodes : [])) || [];
            const curEdges: BaseEdge[] = (currentBranchData?.edges || (bucket.branch === 'main' ? (base as any).edges : [])) || [];
            const rootNodeId = getRootNodeIdLocal(curNodes, curEdges);
            if (rootNodeId && !bucket.nodes.find((n: any) => String((n as any).id) === rootNodeId)) {
                const rootNode = curNodes.find((n: any) => String((n as any).id) === rootNodeId);
                if (rootNode) bucket.nodes.unshift(rootNode as any);
            }
            (base as any).branchData = (base as any).branchData || {};
            (base as any).branchData[bucket.branch] = { nodes: bucket.nodes, edges: bucket.edges };
            await BaseModel.updateFull(did, baseDocId, { branchData: (base as any).branchData } as any);
            (this.ctx.emit as any)('base/update', baseDocId, null, bucket.branch);
        }

        // Bump training updatedAt so editor can reflect today's contribution.
        await TrainingModel.update(did, tid, {});

        this.response.body = { success: true };
    }
}

export class TrainingCardHandler extends Handler<Context> {
    async post(domainId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const body: any = this.request.body || {};
        const rawDocId = String(body.docId || '');
        const nodeId = String(body.nodeId || '');
        if (!rawDocId || !ObjectId.isValid(rawDocId)) throw new ValidationError('docId');
        if (!nodeId) throw new ValidationError('nodeId');
        const tid = new ObjectId(rawDocId);
        const training = await TrainingModel.get(did, tid);
        if (!training) throw new NotFoundError('training');

        const parsed = parseTrainingNodeId(nodeId);
        if (!parsed) throw new ValidationError('nodeId');
        const source = TrainingModel.resolvePlanSources(training).find((s) => s.baseDocId === parsed.baseDocId);
        if (!source) throw new ValidationError('nodeId');
        const branch = source.targetBranch || 'main';

        const title = typeof body.title === 'string' ? body.title : '';
        const content = typeof body.content === 'string' ? body.content : '';
        const problems = Array.isArray(body.problems) ? body.problems : undefined;
        const order = typeof body.order === 'number' ? body.order : undefined;
        const cardId = await CardModel.create(
            did,
            parsed.baseDocId,
            parsed.nodeId,
            this.user._id,
            title,
            content,
            this.request.ip,
            problems,
            order,
            branch,
        );
        // Bump training updatedAt so editor can reflect today's contribution.
        await TrainingModel.update(did, tid, {});
        // Trigger editor refresh + contribution update for this base/branch.
        (this.ctx.emit as any)('base/update', parsed.baseDocId, this.user._id, branch);
        this.response.body = { cardId };
    }
}

export class TrainingBatchSaveHandler extends Handler<Context> {
    async post(domainId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const body: any = this.request.body || {};
        const rawDocId = String(body.docId || body.trainingDocId || '');
        if (!rawDocId || !ObjectId.isValid(rawDocId)) throw new ValidationError('docId');
        const tid = new ObjectId(rawDocId);
        const training = await TrainingModel.get(did, tid);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const sources = TrainingModel.resolvePlanSources(training);
        const baseDocIds = sources.map((s) => s.baseDocId);
        const defaultBaseDocId = baseDocIds.length ? baseDocIds[0] : 0;
        const branchByBase = new Map<number, string>();
        for (const s of sources) branchByBase.set(s.baseDocId, s.targetBranch || 'main');

        // Root delete protection: capture root nodeId per base/branch so UI can't delete it via batch-save.
        const rootByBase = new Map<number, string>();
        for (const s of sources) {
            const baseDocId = Number(s.baseDocId);
            if (!Number.isFinite(baseDocId) || baseDocId <= 0) continue;
            const branch = String(s.targetBranch || 'main') || 'main';
            const base = await BaseModel.get(did, baseDocId);
            if (!base) continue;
            const branchData: any = (base as any).branchData?.[branch];
            const nodes: BaseNode[] = (branchData?.nodes || (branch === 'main' ? (base as any).nodes : [])) || [];
            const edges: BaseEdge[] = (branchData?.edges || (branch === 'main' ? (base as any).edges : [])) || [];
            const rootId = getRootNodeIdLocal(nodes, edges);
            if (rootId) rootByBase.set(baseDocId, rootId);
        }

        const {
            nodeCreates = [],
            nodeUpdates = [],
            nodeDeletes = [],
            edgeCreates = [],
            edgeDeletes = [],
            cardCreates = [],
            cardUpdates = [],
            cardDeletes = [],
        } = body;

        const errors: string[] = [];
        const nodeIdMap = new Map<string, string>();
        const cardIdMap = new Map<string, string>();
        const pendingCardCreatesWithTempNode: any[] = [];

        const grouped = new Map<number, any>();
        const ensureGroup = (baseDocId: number) => {
            const bid = Number(baseDocId);
            if (!Number.isSafeInteger(bid) || bid <= 0) return null;
            if (!grouped.has(bid)) grouped.set(bid, {
                nodeCreates: [],
                nodeUpdates: [],
                nodeDeletes: [],
                edgeCreates: [],
                edgeDeletes: [],
                cardCreates: [],
                cardUpdates: [],
                cardDeletes: [],
            });
            return grouped.get(bid);
        };

        const resolveBaseForCreateParent = (parentId: string | undefined): number => {
            const p = String(parentId || '');
            const parsed = parseTrainingNodeId(p);
            if (parsed) return parsed.baseDocId;
            return defaultBaseDocId;
        };

        for (const c of (nodeCreates || [])) {
            const baseDocId = resolveBaseForCreateParent(c.parentId);
            const g = ensureGroup(baseDocId);
            if (!g) continue;
            g.nodeCreates.push(c);
        }
        for (const u of (nodeUpdates || [])) {
            const parsed = parseTrainingNodeId(String(u.nodeId || ''));
            if (!parsed) continue;
            const g = ensureGroup(parsed.baseDocId);
            if (!g) continue;
            g.nodeUpdates.push({ ...u, nodeId: parsed.nodeId });
        }
        for (const d of (nodeDeletes || [])) {
            const parsed = parseTrainingNodeId(String(d || ''));
            if (!parsed) continue;
            const protectedRoot = rootByBase.get(parsed.baseDocId);
            if (protectedRoot && String(parsed.nodeId) === String(protectedRoot)) continue;
            const g = ensureGroup(parsed.baseDocId);
            if (!g) continue;
            g.nodeDeletes.push(parsed.nodeId);
        }
        for (const e of (edgeDeletes || [])) {
            // edgeId is prefixed in training view; best-effort parse baseId from prefix.
            const m = /^t_(\d+)_(.+)$/.exec(String(e || ''));
            if (!m) continue;
            const baseDocId = Number(m[1]);
            const edgeId = String(m[2] || '');
            const g = ensureGroup(baseDocId);
            if (!g) continue;
            g.edgeDeletes.push(edgeId);
        }
        for (const e of (edgeCreates || [])) {
            const src = String(e.source || '');
            const tgt = String(e.target || '');
            const parsedS = parseTrainingNodeId(src);
            const parsedT = parseTrainingNodeId(tgt);
            // ignore cross-base edges
            if (!parsedS || !parsedT || parsedS.baseDocId !== parsedT.baseDocId) continue;
            const g = ensureGroup(parsedS.baseDocId);
            if (!g) continue;
            g.edgeCreates.push({
                ...e,
                source: parsedS.nodeId,
                target: parsedT.nodeId,
            });
        }

        for (const c of (cardCreates || [])) {
            const nodeId = String(c.nodeId || '');
            if (nodeId.startsWith('temp-node-')) {
                pendingCardCreatesWithTempNode.push(c);
                continue;
            }
            const parsed = parseTrainingNodeId(nodeId);
            if (!parsed) continue;
            const g = ensureGroup(parsed.baseDocId);
            if (!g) continue;
            g.cardCreates.push({ ...c, nodeId: parsed.nodeId });
        }
        for (const u of (cardUpdates || [])) {
            const nodeId = u.nodeId !== undefined ? String(u.nodeId || '') : undefined;
            const parsed = nodeId ? parseTrainingNodeId(nodeId) : null;
            const baseDocId = parsed?.baseDocId;
            // cardUpdate may not include nodeId; we can still update by cardId alone
            const g = baseDocId ? ensureGroup(baseDocId) : null;
            if (g) g.cardUpdates.push({ ...u, nodeId: parsed ? parsed.nodeId : u.nodeId });
            else {
                // fall back: put into first base (update doesn't need baseDocId)
                const gg = ensureGroup(defaultBaseDocId);
                if (gg) gg.cardUpdates.push({ ...u, nodeId: parsed ? parsed.nodeId : u.nodeId });
            }
        }
        for (const d of (cardDeletes || [])) {
            const gg = ensureGroup(defaultBaseDocId);
            if (gg) gg.cardDeletes.push(String(d || ''));
        }

        // Apply per base using the same BaseModel/CardModel operations as BaseBatchSaveHandler.
        for (const [baseDocId, g] of grouped) {
            const branch = branchByBase.get(baseDocId) || 'main';
            const docId = baseDocId;

            const remainingNodeCreates = [...(g.nodeCreates || [])];
            const processedNodeCreates = new Set<string>();

            while (remainingNodeCreates.length > 0) {
                const beforeCount = remainingNodeCreates.length;
                const currentRound: any[] = [];
                for (const nodeCreate of remainingNodeCreates) {
                    if (processedNodeCreates.has(nodeCreate.tempId)) continue;
                    let realParentId = nodeCreate.parentId;
                    if (realParentId && realParentId.startsWith('temp-node-')) {
                        realParentId = nodeIdMap.get(realParentId);
                        if (!realParentId) continue;
                    } else if (realParentId) {
                        // parentId came from training view: might be prefixed
                        const parsedParent = parseTrainingNodeId(String(realParentId));
                        if (parsedParent && parsedParent.baseDocId === baseDocId) realParentId = parsedParent.nodeId;
                        else if (parsedParent) realParentId = undefined;
                    }
                    currentRound.push({ ...nodeCreate, parentId: realParentId });
                    processedNodeCreates.add(nodeCreate.tempId);
                }
                if (currentRound.length === 0) break;

                for (const nodeCreate of currentRound) {
                    try {
                        let realParentId = nodeCreate.parentId;
                        if (realParentId && realParentId.startsWith('temp-node-')) {
                            realParentId = nodeIdMap.get(realParentId);
                        }
                        if (realParentId && !realParentId.startsWith('temp-node-')) {
                            const currentBase = await BaseModel.get(did, docId);
                            if (currentBase) {
                                const branchData = pickBranchData(currentBase as any, branch);
                                const parentExists = branchData.nodes.some((n: BaseNode) => n.id === realParentId);
                                if (!parentExists) realParentId = undefined;
                            } else {
                                realParentId = undefined;
                            }
                        }
                        const nodePayload: Partial<BaseNode> = {
                            text: nodeCreate.text,
                            x: nodeCreate.x,
                            y: nodeCreate.y,
                            parentId: realParentId,
                        };
                        if (nodeCreate.order != null) nodePayload.order = nodeCreate.order;
                        if (nodeCreate.intent !== undefined) nodePayload.intent = nodeCreate.intent;
                        const result = await BaseModel.addNode(
                            did,
                            docId,
                            nodePayload as Omit<BaseNode, 'id'>,
                            realParentId,
                            branch,
                            realParentId,
                        );
                        if (nodeCreate.tempId) {
                            nodeIdMap.set(nodeCreate.tempId, makeTrainingNodeId(baseDocId, result.nodeId));
                        }
                    } catch (e: any) {
                        errors.push(`创建节点失败(base:${docId}): ${e?.message || '未知错误'}`);
                    }
                }

                remainingNodeCreates.splice(0, remainingNodeCreates.length,
                    ...remainingNodeCreates.filter((nc: any) => !processedNodeCreates.has(nc.tempId)),
                );
                if (remainingNodeCreates.length === beforeCount) break;
            }

            // Resolve card creates whose nodeId points to a temp node created in this same batch.
            if (pendingCardCreatesWithTempNode.length > 0) {
                const stillPending: any[] = [];
                for (const cc of pendingCardCreatesWithTempNode) {
                    const tempNodeId = String(cc.nodeId || '');
                    if (!tempNodeId || !tempNodeId.startsWith('temp-node-')) {
                        stillPending.push(cc);
                        continue;
                    }
                    const mapped = nodeIdMap.get(tempNodeId);
                    if (!mapped) {
                        stillPending.push(cc);
                        continue;
                    }
                    const parsed = parseTrainingNodeId(mapped);
                    if (!parsed || parsed.baseDocId !== baseDocId) {
                        stillPending.push(cc);
                        continue;
                    }
                    g.cardCreates.push({ ...cc, nodeId: parsed.nodeId });
                }
                pendingCardCreatesWithTempNode.splice(0, pendingCardCreatesWithTempNode.length, ...stillPending);
            }

            for (const nodeUpdate of (g.nodeUpdates || [])) {
                try {
                    const updates: Partial<BaseNode> = {};
                    if (nodeUpdate.text != null) updates.text = nodeUpdate.text;
                    if (nodeUpdate.order != null) updates.order = nodeUpdate.order;
                    if (nodeUpdate.intent !== undefined) updates.intent = nodeUpdate.intent;
                    if (Object.keys(updates).length === 0) continue;
                    await BaseModel.updateNode(did, docId, nodeUpdate.nodeId, updates, branch);
                } catch (e: any) {
                    errors.push(`更新节点失败(base:${docId}): ${e?.message || '未知错误'}`);
                }
            }

            for (const edgeId of (g.edgeDeletes || [])) {
                try { await BaseModel.deleteEdge(did, docId, String(edgeId), branch); } catch { }
            }
            for (const nodeId of (g.nodeDeletes || [])) {
                try { await BaseModel.deleteNode(did, docId, String(nodeId), branch); } catch (e: any) {
                    errors.push(`删除节点失败(base:${docId}): ${e?.message || '未知错误'}`);
                }
            }
            for (const edgeCreate of (g.edgeCreates || [])) {
                try {
                    const sourceId = String(edgeCreate.source || '');
                    const targetId = String(edgeCreate.target || '');
                    if (sourceId && targetId && !sourceId.startsWith('temp-node-') && !targetId.startsWith('temp-node-')) {
                        await BaseModel.addEdge(did, docId, { source: sourceId, target: targetId, label: edgeCreate.label }, branch);
                    }
                } catch (e: any) {
                    errors.push(`创建边失败(base:${docId}): ${e?.message || '未知错误'}`);
                }
            }

            for (const cardCreate of (g.cardCreates || [])) {
                try {
                    const realNodeId = String(cardCreate.nodeId || '');
                    if (realNodeId && !realNodeId.startsWith('temp-node-')) {
                        const resp = await CardModel.create(
                            did,
                            docId,
                            realNodeId,
                            this.user._id,
                            cardCreate.title || '新卡片',
                            cardCreate.content || '',
                            this.request.ip,
                            cardCreate.problems,
                            cardCreate.order,
                            branch,
                        );
                        if (cardCreate.tempId) cardIdMap.set(String(cardCreate.tempId), String(resp));
                    }
                } catch (e: any) {
                    errors.push(`创建卡片失败(base:${docId}): ${e?.message || '未知错误'}`);
                }
            }
            for (const cardUpdate of (g.cardUpdates || [])) {
                try {
                    const updates: any = {};
                    if (cardUpdate.title !== undefined) updates.title = cardUpdate.title;
                    if (cardUpdate.content !== undefined) updates.content = cardUpdate.content;
                    if (cardUpdate.cardFace !== undefined) updates.cardFace = cardUpdate.cardFace;
                    if (cardUpdate.nodeId !== undefined) updates.nodeId = cardUpdate.nodeId;
                    if (cardUpdate.order !== undefined) updates.order = cardUpdate.order;
                    if (cardUpdate.problems !== undefined) updates.problems = cardUpdate.problems;
                    if (Object.keys(updates).length === 0) continue;
                    await CardModel.update(did, new ObjectId(cardUpdate.cardId), updates);
                } catch (e: any) {
                    errors.push(`更新卡片失败(base:${docId}): ${e?.message || '未知错误'}`);
                }
            }
            for (const cardId of (g.cardDeletes || [])) {
                try { if (ObjectId.isValid(cardId)) await CardModel.delete(did, new ObjectId(cardId)); } catch (e: any) {
                    errors.push(`删除卡片失败(base:${docId}): ${e?.message || '未知错误'}`);
                }
            }

            (this.ctx.emit as any)('base/update', docId, null, branch);
        }

        this.response.body = {
            success: errors.length === 0,
            errors,
            nodeIdMap: Object.fromEntries(nodeIdMap),
            cardIdMap: Object.fromEntries(cardIdMap),
        };
    }
}

export class TrainingExpandStateHandler extends Handler<Context> {
    async post(domainId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        // Reuse the same collection schema as base, but key by trainingDocId (ObjectId) in baseDocId field.
        const body: any = this.request.body || {};
        const rawDocId = String(body.docId || body.baseDocId || body.trainingDocId || '');
        if (!rawDocId || !ObjectId.isValid(rawDocId)) throw new ValidationError('docId');
        const tid = new ObjectId(rawDocId);
        const expandedNodeIds = Array.isArray(body.expandedNodeIds) ? body.expandedNodeIds.map((x: any) => String(x)) : [];
        const uid = this.user._id;
        const coll = this.ctx.db.db.collection('base.userExpand');
        await coll.updateOne(
            { domainId: did, baseDocId: tid, uid },
            { $set: { expandedNodeIds, updateAt: new Date() } },
            { upsert: true },
        );
        this.response.body = { success: true };
    }
}

export class TrainingEditorUiPrefsHandler extends Handler<Context> {
    async post(domainId: string) {
        const did = normalizeDomainId(domainId, (this as any).args);
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const body: any = this.request.body || {};
        const rawDocId = String(body.docId || body.baseDocId || body.trainingDocId || '');
        if (!rawDocId || !ObjectId.isValid(rawDocId)) throw new ValidationError('docId');
        const tid = new ObjectId(rawDocId);
        const prefs = body.prefs && typeof body.prefs === 'object' ? body.prefs : {};
        const uid = this.user._id;
        const coll = this.ctx.db.db.collection('base.userEditorUi');
        await coll.updateOne(
            { domainId: did, baseDocId: tid, uid },
            { $set: { prefs, updateAt: new Date() } },
            { upsert: true },
        );
        this.response.body = { success: true };
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

        this.response.redirect = this.url('training_editor', {
            domainId: this.domain._id,
            trainingDocId: String(training.docId),
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
        this.response.redirect = this.url('training_editor', {
            domainId: this.domain._id,
            trainingDocId: String(training.docId),
        });
        return;
    }

    async post() {
        const training = await this.prepareTraining();
        this.response.redirect = this.url('training_editor', {
            domainId: this.domain._id,
            trainingDocId: String(training.docId),
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

        const sources = TrainingModel.resolvePlanSources(training);
        // Delete training doc first (so branch cleanup can detect "other trainings still using branch").
        await TrainingModel.del(this.domain._id, docId);

        // Cleanup training-owned branches on source bases.
        for (const s of sources) {
            const baseDocId = Number(s.baseDocId);
            const branchName = String(s.targetBranch || '').trim();
            if (!Number.isSafeInteger(baseDocId) || baseDocId <= 0) continue;
            if (!branchName || branchName === 'main') continue;

            const stillUsed = await document.getMulti(this.domain._id, document.TYPE_TRAINING, {
                planSources: { $elemMatch: { baseDocId, targetBranch: branchName } },
            } as any).limit(1).toArray();
            if (stillUsed.length) continue;

            const base = await BaseModel.get(this.domain._id, baseDocId);
            if (!base) continue;

            const branches: string[] = Array.isArray((base as any).branches) ? [...(base as any).branches] : ['main'];
            const nextBranches = branches.filter((b) => String(b) !== branchName);
            const nextBranchData: any = { ...((base as any).branchData || {}) };
            if (nextBranchData[branchName]) delete nextBranchData[branchName];

            await document.deleteMulti(this.domain._id, document.TYPE_CARD, { baseDocId, branch: branchName } as any);
            await document.set(this.domain._id, document.TYPE_BASE, baseDocId, {
                branches: nextBranches,
                branchData: nextBranchData,
                updateAt: new Date(),
            } as any);
            (this.ctx.emit as any)('base/update', baseDocId, null, branchName);
        }

        this.response.redirect = this.url('training_domain', { domainId: this.domain._id });
    }
}

export class TrainingGetHandler extends Handler<Context> {
    @param('docId', Types.String)
    async get(domainId: string, docId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const id = trainingDocIdFromParam(docId);
        if (!id) throw new ValidationError('docId');
        const training = await TrainingModel.get(domainId, id);
        if (!training) throw new NotFoundError('training');
        if (training.owner !== this.user._id && !this.user.hasPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN)) {
            throw new PermissionError(PRIV.PRIV_USER_PROFILE);
        }
        this.response.type = 'application/json';
        this.response.template = null;
        this.response.body = { training };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('training_preview', '/training/preview', TrainingPreviewHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_create', '/training/create', TrainingCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_delete', '/training/:docId/delete', TrainingDeleteHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_domain', '/training', TrainingDomainHandler);
    ctx.Route('training_editor', '/training/:trainingDocId/editor', TrainingEditorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_bases', '/training/:trainingDocId/bases', TrainingBasesEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_get', '/training/get', TrainingGetHandler, PRIV.PRIV_USER_PROFILE);

    // Training endpoints: shared storage in source base branches.
    ctx.Route('training_data', '/training/data', TrainingDataHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('training_connection', '/training/ws', TrainingConnectionHandler);
    ctx.Route('training_save', '/training/save', TrainingSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_batch_save', '/training/batch-save', TrainingBatchSaveHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_expand_state', '/training/expand-state', TrainingExpandStateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_editor_ui_prefs', '/training/editor-ui-prefs', TrainingEditorUiPrefsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_card', '/training/card', TrainingCardHandler, PRIV.PRIV_USER_PROFILE);
}
