import { Handler } from '@ejunz/framework';
import { ObjectId } from 'mongodb';
import { Context } from '../context';
import { NotFoundError, PermissionError, ValidationError } from '../error';
import * as document from '../model/document';
import { PRIV } from '../model/builtin';
import { BaseModel } from '../model/base';
import TrainingModel, { listBranchesForBase } from '../model/training';
import UserModel from '../model/user';
import type {
    BaseDoc, TrainingDagNode, TrainingProblemRow, TrainingPlanSource, TrainingSection, TrainingDoc,
} from '../interface';

function trainingDocIdFromParam(raw: string | undefined): ObjectId | null {
    if (!raw || !ObjectId.isValid(raw)) return null;
    return new ObjectId(raw);
}

function parseSectionsPayload(raw: unknown): TrainingSection[] {
    let data = raw;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch {
            throw new ValidationError('sections');
        }
    }
    if (!Array.isArray(data)) throw new ValidationError('sections');
    return data.map((s: any, i: number) => {
        const problems: TrainingProblemRow[] = Array.isArray(s.problems)
            ? s.problems.map((p: any) => ({
                title: typeof p.title === 'string' ? p.title : '',
                source: typeof p.source === 'string' ? p.source : undefined,
                pid: typeof p.pid === 'string' ? p.pid : undefined,
                tried: typeof p.tried === 'number' ? p.tried : 0,
                ac: typeof p.ac === 'number' ? p.ac : 0,
                difficulty: typeof p.difficulty === 'number' ? p.difficulty : undefined,
                nodeId: typeof p.nodeId === 'string' ? p.nodeId : undefined,
            }))
            : [];
        const st = s.status;
        const status = st === 'locked' || st === 'invalid' || st === 'open' ? st : 'open';
        return {
            title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : `Section ${i + 1}`,
            description: typeof s.description === 'string' ? s.description : undefined,
            status,
            requireSectionIndexes: Array.isArray(s.requireSectionIndexes)
                ? s.requireSectionIndexes.map((n: any) => Number(n)).filter((n: number) => !Number.isNaN(n))
                : undefined,
            problems,
        };
    });
}

async function loadBases(domainId: string): Promise<BaseDoc[]> {
    const rows = await document.getMulti(domainId, document.TYPE_BASE, {}).toArray() as BaseDoc[];
    return rows.filter((b) => (b as any).type !== 'skill');
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
            sections: sectionsRaw,
            dag: dagRaw,
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

        for (const s of planSources) {
            const b = await BaseModel.get(this.domain._id, s.baseDocId);
            if (!b) throw new ValidationError('planSources');
        }

        let sections: TrainingSection[];
        if (
            sectionsRaw !== undefined
            && sectionsRaw !== null
            && String(sectionsRaw).trim() !== ''
            && String(sectionsRaw).trim() !== '[]'
        ) {
            sections = parseSectionsPayload(sectionsRaw);
        } else {
            sections = await TrainingModel.buildSectionsFromPlanSources(this.domain._id, planSources);
        }
        if (!sections.length) {
            sections = await TrainingModel.buildSectionsFromPlanSources(this.domain._id, planSources);
        }

        let dag = parseDagPayload(dagRaw);
        if (dag && dag.length) {
            if (dag.length !== sections.length) {
                throw new ValidationError('dag');
            }
            sections = TrainingModel.applyDagToSections(sections, dag);
        } else {
            dag = undefined;
        }

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

        this.response.redirect = `/training/${training.docId}`;
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
        const planSources = TrainingModel.resolvePlanSources(training);
        const bases = await loadBases(this.domain._id);
        const basesMeta = bases.map((b) => ({
            docId: b.docId,
            title: b.title || String(b.docId),
            branches: listBranchesForBase(b),
        }));
        this.response.template = 'training_edit.html';
        this.response.body = {
            training,
            domainId: this.domain._id,
            basesMetaJson: JSON.stringify(basesMeta),
            initialSectionsJson: JSON.stringify(training.sections || []),
            initialPlanSourcesJson: JSON.stringify(planSources),
            sectionsJson: JSON.stringify(training.sections || [], null, 2),
            planSourcesJson: JSON.stringify(planSources, null, 2),
            dagJson: training.dag?.length ? JSON.stringify(training.dag, null, 2) : '',
        };
    }

    async post() {
        const training = await this.prepareTraining();
        const {
            name,
            description,
            introQuote,
            enrollCount: enrollRaw,
            sections: sectionsRaw,
            planSources: planSourcesRaw,
            dag: dagRaw,
        } = this.request.body || {};
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new ValidationError('name');
        }

        let merged = sectionsRaw !== undefined && sectionsRaw !== ''
            ? parseSectionsPayload(sectionsRaw)
            : [...(training.sections || [])];

        let planSources: TrainingPlanSource[] | undefined;
        if (planSourcesRaw !== undefined && String(planSourcesRaw).trim() !== '') {
            planSources = parsePlanSourcesPayload(planSourcesRaw);
            for (const s of planSources) {
                const b = await BaseModel.get(this.domain._id, s.baseDocId);
                if (!b) throw new ValidationError('planSources');
            }
        }

        let dagStored: TrainingDagNode[] | undefined;
        if (dagRaw !== undefined && String(dagRaw).trim() !== '') {
            const dag = parseDagPayload(dagRaw);
            if (merged.length) {
                if (!dag?.length || dag.length !== merged.length) {
                    throw new ValidationError('dag');
                }
                dagStored = dag;
                merged = TrainingModel.applyDagToSections(merged, dag);
            } else {
                dagStored = undefined;
            }
        } else if (dagRaw !== undefined && String(dagRaw).trim() === '') {
            dagStored = undefined;
        }

        let enrollCount: number | undefined;
        if (enrollRaw !== undefined && enrollRaw !== '') {
            const n = Number(enrollRaw);
            if (Number.isFinite(n) && n >= 0) enrollCount = Math.floor(n);
        }
        const update: Partial<TrainingDoc> = {
            name: name.trim(),
            description: typeof description === 'string' ? description : undefined,
            introQuote: typeof introQuote === 'string' ? introQuote.trim() : undefined,
        };
        if ((sectionsRaw !== undefined && sectionsRaw !== '') || dagRaw !== undefined) {
            update.sections = merged;
        }
        if (planSources?.length) {
            update.planSources = planSources;
            update.baseDocId = planSources[0].baseDocId;
            update.sourceBranch = planSources[0].sourceBranch;
            update.targetBranch = planSources[0].targetBranch;
        }
        if (dagRaw !== undefined) {
            update.dag = dagStored;
        }
        if (enrollCount !== undefined) update.enrollCount = enrollCount;

        await TrainingModel.update(this.domain._id, training.docId, update);
        this.response.redirect = `/training/${training.docId}`;
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
    ctx.Route('training_edit', '/training/:docId/edit', TrainingEditHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('training_domain', '/training', TrainingDomainHandler);
    ctx.Route('training_detail', '/training/:docId', TrainingDetailHandler);
}
