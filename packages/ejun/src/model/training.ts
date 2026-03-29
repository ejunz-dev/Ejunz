import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import type {
    BaseDoc, BaseEdge, BaseNode, TrainingDagNode, TrainingDoc,
    TrainingPlanSource, TrainingProblemRow, TrainingSection,
} from '../interface';
import { BaseModel } from './base';
import * as document from './document';

function getBranchDataLocal(
    base: BaseDoc,
    branch: string,
): { nodes: BaseNode[]; edges: BaseEdge[] } {
    const branchName = branch || 'main';
    if (base.branchData && base.branchData[branchName]) {
        return {
            nodes: base.branchData[branchName].nodes || [],
            edges: base.branchData[branchName].edges || [],
        };
    }
    if (branchName === 'main') {
        return {
            nodes: base.nodes || [],
            edges: base.edges || [],
        };
    }
    return { nodes: [], edges: [] };
}

/** Public branch names for UI (main + branchData keys + base.branches). */
export function listBranchesForBase(base: BaseDoc): string[] {
    const s = new Set<string>();
    if (Array.isArray(base.branches)) {
        for (const b of base.branches) {
            if (b) s.add(String(b));
        }
    }
    if (base.branchData) {
        for (const b of Object.keys(base.branchData)) {
            if (b) s.add(b);
        }
    }
    s.add('main');
    return Array.from(s).sort();
}

class TrainingModel {
    static async get(domainId: string, docId: ObjectId | string): Promise<TrainingDoc | null> {
        const id = typeof docId === 'string' ? new ObjectId(docId) : docId;
        return await document.get(domainId, document.TYPE_TRAINING, id);
    }

    static getStatus(domainId: string, docId: ObjectId | string, uid: number) {
        const id = typeof docId === 'string' ? new ObjectId(docId) : docId;
        return document.getStatus(domainId, document.TYPE_TRAINING, id, uid);
    }

    /** Legacy or partial doc → ordered plan sources. */
    static resolvePlanSources(training: Pick<TrainingDoc, 'planSources' | 'baseDocId' | 'sourceBranch' | 'targetBranch'>): TrainingPlanSource[] {
        if (training.planSources?.length) return training.planSources;
        return [{
            baseDocId: training.baseDocId,
            sourceBranch: training.sourceBranch || 'main',
            targetBranch: training.targetBranch || 'main',
        }];
    }

    /** Merge branch-diff sections from multiple bases (one subsection per diff chunk per source). */
    static async buildSectionsFromPlanSources(
        domainId: string,
        sources: TrainingPlanSource[],
    ): Promise<TrainingSection[]> {
        if (!sources.length) return [];
        const out: TrainingSection[] = [];
        let sNum = 0;
        for (const src of sources) {
            const base = await BaseModel.get(domainId, src.baseDocId);
            if (!base) throw new Error(`Base docId ${src.baseDocId} not found`);
            const chunks = TrainingModel.buildSectionsFromBranchDiff(base, src.sourceBranch, src.targetBranch);
            const baseTitle = (base.title || `docId ${src.baseDocId}`).trim();
            for (const chunk of chunks) {
                sNum++;
                const inner = chunk.title.replace(/^Section 1\.\s*/, '');
                out.push({
                    ...chunk,
                    title: `Section ${sNum}. [${baseTitle}] ${inner}`,
                });
            }
        }
        return out;
    }

    /**
     * Apply Hydro-style DAG: dag[i] matches sections[i]; requireNids reference node _id → section index.
     */
    static applyDagToSections(sections: TrainingSection[], dag: TrainingDagNode[]): TrainingSection[] {
        if (!dag.length || dag.length !== sections.length) return sections.map((s) => ({ ...s }));
        const idToIdx = new Map<number, number>();
        dag.forEach((n, i) => idToIdx.set(Number(n._id), i));
        return sections.map((sec, i) => {
            const node = dag[i];
            const reqs = (node.requireNids || [])
                .map((nid) => idToIdx.get(Number(nid)))
                .filter((x): x is number => x !== undefined);
            const title = (node.title && String(node.title).trim()) ? String(node.title).trim() : sec.title;
            const status: TrainingSection['status'] = reqs.length ? 'locked' : (sec.status || 'open');
            return {
                ...sec,
                title,
                requireSectionIndexes: reqs.length ? [...new Set(reqs)] : undefined,
                status,
            };
        });
    }

    static async add(
        training: Partial<TrainingDoc> & {
            domainId: string;
            name: string;
            owner: number;
            planSources: TrainingPlanSource[];
            sections: TrainingSection[];
            dag?: TrainingDagNode[];
        },
    ): Promise<TrainingDoc> {
        const now = new Date();
        const first = training.planSources[0];
        const payload: Partial<TrainingDoc> = {
            domainId: training.domainId,
            name: training.name,
            description: training.description,
            introQuote: training.introQuote,
            planSources: training.planSources,
            baseDocId: first.baseDocId,
            sourceBranch: first.sourceBranch,
            targetBranch: first.targetBranch,
            dag: training.dag,
            sections: training.sections,
            enrollCount: training.enrollCount ?? 0,
            createdAt: now,
            updatedAt: now,
            owner: training.owner,
        };

        const docId = await document.add(
            training.domainId,
            training.name,
            training.owner,
            document.TYPE_TRAINING,
            null,
            null,
            null,
            payload,
        );

        const row = await document.get(training.domainId, document.TYPE_TRAINING, docId);
        return row as TrainingDoc;
    }

    static async getByDomain(domainId: string): Promise<TrainingDoc[]> {
        return await document.getMulti(domainId, document.TYPE_TRAINING, {}).toArray() as TrainingDoc[];
    }

    static async update(domainId: string, docId: ObjectId, update: Partial<TrainingDoc>): Promise<TrainingDoc> {
        const training = await this.get(domainId, docId);
        if (!training) throw new Error('Training not found');
        const $set = { ...update, updatedAt: new Date() };
        return await document.set(domainId, document.TYPE_TRAINING, docId, $set) as TrainingDoc;
    }

    static async del(domainId: string, docId: ObjectId): Promise<void> {
        const training = await this.get(domainId, docId);
        if (!training) return;
        await document.deleteOne(domainId, document.TYPE_TRAINING, docId);
    }

    /** Build one section from nodes in target branch missing from source branch (order then id). */
    static buildSectionsFromBranchDiff(
        base: BaseDoc,
        sourceBranch: string,
        targetBranch: string,
    ): TrainingSection[] {
        const src = getBranchDataLocal(base, sourceBranch);
        const tgt = getBranchDataLocal(base, targetBranch);
        const srcIds = new Set((src.nodes || []).map((n) => n.id));
        let newNodes = (tgt.nodes || []).filter((n) => !srcIds.has(n.id));
        newNodes = [...newNodes].sort((a, b) => {
            const oa = a.order ?? 0;
            const ob = b.order ?? 0;
            if (oa !== ob) return oa - ob;
            return String(a.id).localeCompare(String(b.id));
        });

        const problems: TrainingProblemRow[] = newNodes.map((n) => {
            const data = (n.data && typeof n.data === 'object') ? n.data as Record<string, unknown> : {};
            return {
                nodeId: n.id,
                title: (n.text || n.id || '').trim() || n.id,
                source: typeof data.oj === 'string' ? data.oj : typeof data.source === 'string' ? data.source : undefined,
                pid: typeof data.pid === 'string' ? data.pid : undefined,
                tried: typeof data.tried === 'number' ? data.tried : 0,
                ac: typeof data.ac === 'number' ? data.ac : 0,
                difficulty: typeof data.difficulty === 'number' ? data.difficulty : undefined,
            };
        });

        const srcLabel = sourceBranch || 'main';
        const tgtLabel = targetBranch || 'main';
        return [{
            title: `Section 1. ${srcLabel} → ${tgtLabel}`,
            description: problems.length
                ? `共 ${problems.length} 个新增节点`
                : '两分支间无新增节点，可在保存后于编辑页补充。',
            status: 'open' as const,
            problems,
        }];
    }
}

export async function apply(ctx: Context) {
    if (process.env.NODE_APP_INSTANCE !== '0') return;
}

export default TrainingModel;
global.Ejunz.model.training = TrainingModel;
