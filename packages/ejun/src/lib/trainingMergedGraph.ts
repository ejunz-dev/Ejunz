import type { BaseDoc, BaseEdge, BaseNode, CardDoc, TrainingDoc } from '../interface';
import { BaseModel } from '../model/base';
import TrainingModel from '../model/training';
import * as document from '../model/document';

export function pickBranchData(base: BaseDoc, branch: string): { nodes: any[]; edges: any[] } {
    const b = String(branch || 'main');
    const bd: any = (base as any).branchData || {};
    if (b === 'main') {
        return { nodes: (base as any).nodes || [], edges: (base as any).edges || [] };
    }
    return { nodes: bd[b]?.nodes || [], edges: bd[b]?.edges || [] };
}

export function makeTrainingRootId(trainingDocId: string): string {
    return `training_root_${trainingDocId}`;
}

/** Virtual root in the merged graph (anchors each source's top-level nodes; omit from learn path section lists). */
export function isTrainingRootNodeId(nodeId: string): boolean {
    return String(nodeId || '').startsWith('training_root_');
}

export function makeTrainingNodeId(baseDocId: number, nodeId: string): string {
    return `t_${baseDocId}_${nodeId}`;
}

export function parseTrainingNodeId(nodeId: string): { baseDocId: number; nodeId: string } | null {
    const m = /^t_(\d+)_(.+)$/.exec(String(nodeId || ''));
    if (!m) return null;
    const baseDocId = Number(m[1]);
    if (!Number.isSafeInteger(baseDocId) || baseDocId < 1) return null;
    return { baseDocId, nodeId: String(m[2]) };
}

export async function loadTrainingMergedGraph(
    domainId: string,
    training: TrainingDoc,
): Promise<{ nodes: BaseNode[]; edges: BaseEdge[]; nodeCardsMap: Record<string, CardDoc[]> }> {
    const sources = TrainingModel.resolvePlanSources(training);
    const trainingDocId = String(training.docId);
    const rootId = makeTrainingRootId(trainingDocId);

    const allNodes: BaseNode[] = [{
        id: rootId,
        text: training.name || 'Training',
        level: 0,
        expanded: true,
        order: 0,
    } as any];
    const allEdges: BaseEdge[] = [];
    const nodeCardsMap: Record<string, CardDoc[]> = {};

    for (const src of sources) {
        const base = await BaseModel.get(domainId, src.baseDocId);
        if (!base) continue;
        const branch = src.targetBranch || 'main';
        const { nodes, edges } = pickBranchData(base, branch);
        const existingNodeIds = new Set((nodes || []).map((n: any) => String((n as any).id ?? '')));

        for (const n of (nodes || [])) {
            const rawId = String((n as any).id ?? '');
            if (!rawId) continue;
            const nid = makeTrainingNodeId(src.baseDocId, rawId);
            const rawParentId = (n as any).parentId ? String((n as any).parentId) : '';
            const parentId = rawParentId && existingNodeIds.has(rawParentId)
                ? makeTrainingNodeId(src.baseDocId, rawParentId)
                : rootId;
            allNodes.push({
                ...(n as any),
                id: nid,
                parentId,
                level: Number((n as any).level || 0) + 1,
            } as any);
        }

        for (const e of (edges || [])) {
            const rawEid = String((e as any).id ?? '');
            const rawS = String((e as any).source ?? '');
            const rawT = String((e as any).target ?? '');
            if (!rawS || !rawT) continue;
            allEdges.push({
                ...(e as any),
                id: makeTrainingNodeId(src.baseDocId, rawEid || `${rawS}=>${rawT}`),
                source: makeTrainingNodeId(src.baseDocId, rawS),
                target: makeTrainingNodeId(src.baseDocId, rawT),
            } as any);
        }

        const cards = await document.getMulti(domainId, document.TYPE_CARD, { baseDocId: src.baseDocId, branch } as any)
            .sort({ order: 1, cid: 1 })
            .toArray() as CardDoc[];
        for (const c of cards) {
            if (!c.nodeId) continue;
            const tnid = makeTrainingNodeId(src.baseDocId, String(c.nodeId));
            const cloned = { ...(c as any), nodeId: tnid };
            if (!nodeCardsMap[tnid]) nodeCardsMap[tnid] = [];
            nodeCardsMap[tnid].push(cloned);
        }
    }

    return { nodes: allNodes, edges: allEdges, nodeCardsMap };
}
