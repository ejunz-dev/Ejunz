import type { BaseEdge, BaseNode } from '../interface';
import * as document from '../model/document';

/**
 * Longest root-to-leaf path length (each node counts as one layer). Forest-safe.
 */
export function computeMaxNodeLayers(nodes: BaseNode[], edges: BaseEdge[]): number {
    if (!nodes?.length) return 0;
    const nodeIds = new Set(nodes.map((n) => n.id));
    const children = new Map<string, string[]>();
    for (const e of edges || []) {
        if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
        if (!children.has(e.source)) children.set(e.source, []);
        children.get(e.source)!.push(e.target);
    }
    const hasParent = new Set<string>();
    for (const e of edges || []) {
        if (nodeIds.has(e.target)) hasParent.add(e.target);
    }
    const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
    const startIds = roots.length > 0 ? roots : nodes.map((n) => n.id);

    let maxDepth = 0;
    const memo = new Map<string, number>();

    function depth(nodeId: string, visiting: Set<string>): number {
        if (memo.has(nodeId)) return memo.get(nodeId)!;
        if (visiting.has(nodeId)) return 1;
        visiting.add(nodeId);
        const cs = children.get(nodeId) || [];
        let d = 1;
        if (cs.length) {
            for (const c of cs) {
                d = Math.max(d, 1 + depth(c, visiting));
            }
        }
        visiting.delete(nodeId);
        memo.set(nodeId, d);
        return d;
    }

    for (const r of startIds) {
        maxDepth = Math.max(maxDepth, depth(r, new Set()));
    }
    return maxDepth;
}

/**
 * Count of distinct nodes one hop below root(s): targets of edges whose source is a root (no incoming edge).
 */
export function countMainLevelChildNodes(nodes: BaseNode[], edges: BaseEdge[]): number {
    if (!nodes?.length) return 0;
    const nodeIds = new Set(nodes.map((n) => n.id));
    const hasParent = new Set<string>();
    for (const e of edges || []) {
        if (nodeIds.has(e.target)) hasParent.add(e.target);
    }
    const roots = nodes.filter((n) => !hasParent.has(n.id));
    if (roots.length === 0) return 0;
    const rootSet = new Set(roots.map((r) => r.id));
    const firstLevel = new Set<string>();
    for (const e of edges || []) {
        if (rootSet.has(e.source) && nodeIds.has(e.target)) {
            firstLevel.add(e.target);
        }
    }
    return firstLevel.size;
}

export type BaseListCardStats = { cardCount: number; problemCount: number };

/** Card + problem counts per baseDocId for main-branch cards (and legacy docs without branch). */
export async function loadCardStatsByBaseDocId(
    domainId: string,
    baseDocIds: number[],
): Promise<Map<number, BaseListCardStats>> {
    const map = new Map<number, BaseListCardStats>();
    const ids = [...new Set(baseDocIds.filter((n) => Number.isFinite(n) && n > 0))];
    if (ids.length === 0) return map;

    const pipeline: Record<string, unknown>[] = [
        {
            $match: {
                domainId,
                docType: document.TYPE_CARD,
                baseDocId: { $in: ids },
                $or: [{ branch: 'main' }, { branch: { $exists: false } }],
            },
        },
        {
            $group: {
                _id: '$baseDocId',
                cardCount: { $sum: 1 },
                problemCount: { $sum: { $size: { $ifNull: ['$problems', []] } } },
            },
        },
    ];

    const rows = (await document.coll.aggregate(pipeline).toArray()) as Array<{
        _id: number;
        cardCount: number;
        problemCount: number;
    }>;

    for (const row of rows) {
        const id = Number(row._id);
        if (!Number.isFinite(id)) continue;
        map.set(id, {
            cardCount: Number(row.cardCount) || 0,
            problemCount: Number(row.problemCount) || 0,
        });
    }
    return map;
}
