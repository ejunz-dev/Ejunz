/**
 * Shared base outline loading + outline-explorer filtering (same rules as BaseDataHandler / base data API).
 */
import * as document from '../model/document';
import {
    BaseModel,
    getBranchData,
    TYPE_CARD,
    hasActiveOutlineExplorerFilters,
    applyOutlineExplorerUrlFilters,
    trimOutlineExplorerFiltersForClient,
    type OutlineExplorerFilters,
} from '../model/base';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc } from '../interface';

export function outlineExplorerFiltersFromToolArgs(args: Record<string, unknown> | undefined | null): OutlineExplorerFilters {
    const g = (k: string) => {
        const v = args?.[k];
        return typeof v === 'string' ? v : '';
    };
    return {
        filterNode: g('filterNode') || g('filter_node'),
        filterCard: g('filterCard') || g('filter_card'),
        filterProblem: g('filterProblem') || g('filter_problem'),
    };
}

export type FetchBaseOutlineOptions = {
    baseDocId?: number;
    branch?: string;
    filters: OutlineExplorerFilters;
};

/**
 * Load nodes, edges, and per-node cards for a base doc + branch, then apply outline URL-style filters.
 * Card query uses baseDocId + branch (aligned with base outline page).
 */
export async function fetchFilteredBaseOutline(
    domainId: string,
    options: FetchBaseOutlineOptions,
): Promise<{
    base: BaseDoc;
    nodes: BaseNode[];
    edges: BaseEdge[];
    nodeCardsMap: Record<string, CardDoc[]>;
    currentBranch: string;
    outlineExplorerFilters: OutlineExplorerFilters;
} | null> {
    let base: BaseDoc | null = null;
    if (options.baseDocId != null && Number.isFinite(options.baseDocId) && options.baseDocId > 0) {
        base = await BaseModel.get(domainId, options.baseDocId, document.TYPE_BASE);
    } else {
        base = await BaseModel.getByDomain(domainId);
    }
    if (!base) return null;

    const currentBranch =
        (options.branch && String(options.branch).trim())
        || (base as any).currentBranch
        || 'main';

    const { nodes: rawNodes, edges: rawEdges } = getBranchData(base, currentBranch);
    let nodes = rawNodes || [];
    let edges = rawEdges || [];

    const baseNumericId = Number((base as any).docId);
    const dataCardFilter: Record<string, unknown> = { baseDocId: baseNumericId };
    if (currentBranch === 'main') {
        (dataCardFilter as any).$or = [{ branch: 'main' }, { branch: { $exists: false } }];
    } else {
        (dataCardFilter as any).branch = currentBranch;
    }

    const allCards = await document.getMulti(domainId, TYPE_CARD, dataCardFilter as any)
        .sort({ order: 1, cid: 1 })
        .toArray() as CardDoc[];

    let nodeCardsMap: Record<string, CardDoc[]> = {};
    for (const card of allCards) {
        if (card.nodeId) {
            if (!nodeCardsMap[card.nodeId]) nodeCardsMap[card.nodeId] = [];
            nodeCardsMap[card.nodeId].push(card);
        }
    }
    for (const nodeId of Object.keys(nodeCardsMap)) {
        nodeCardsMap[nodeId].sort(
            (a, b) => (a.order ?? 999999) - (b.order ?? 999999) || (a.cid - b.cid),
        );
    }

    const outlineExplorerFilters = options.filters;
    if (hasActiveOutlineExplorerFilters(outlineExplorerFilters)) {
        const applied = applyOutlineExplorerUrlFilters(nodes, edges, nodeCardsMap, outlineExplorerFilters);
        nodes = applied.nodes;
        edges = applied.edges;
        nodeCardsMap = applied.nodeCardsMap;
    }

    return {
        base,
        nodes,
        edges,
        nodeCardsMap,
        currentBranch,
        outlineExplorerFilters: trimOutlineExplorerFiltersForClient(outlineExplorerFilters),
    };
}
