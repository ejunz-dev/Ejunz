/** Shared base outline loading + outline-explorer filtering. */
import * as document from '../model/document';
import {
    BaseModel,
    TYPE_CARD,
    hasActiveDetailExplorerFilters,
    applyDetailExplorerUrlFilters,
    trimDetailExplorerFiltersForClient,
    type DetailExplorerFilters,
} from '../model/base';
import type { BaseDoc, BaseNode, BaseEdge, CardDoc } from '../interface';

export function detailExplorerFiltersFromToolArgs(args: Record<string, unknown> | undefined | null): DetailExplorerFilters {
    const g = (k: string) => typeof args?.[k] === 'string' ? args[k] as string : '';
    return {
        filterNode: g('filterNode') || g('filter_node'),
        filterCard: g('filterCard') || g('filter_card'),
        filterProblem: g('filterProblem') || g('filter_problem'),
    };
}

export type FetchBaseOutlineOptions = {
    baseDocId?: number;
    filters: DetailExplorerFilters;
};

export async function fetchFilteredBaseDetail(
    domainId: string,
    options: FetchBaseOutlineOptions,
): Promise<{
    base: BaseDoc;
    nodes: BaseNode[];
    edges: BaseEdge[];
    nodeCardsMap: Record<string, CardDoc[]>;
    outlineExplorerFilters: DetailExplorerFilters;
} | null> {
    const base = options.baseDocId != null && Number.isFinite(options.baseDocId) && options.baseDocId > 0
        ? await BaseModel.get(domainId, options.baseDocId, document.TYPE_BASE)
        : await BaseModel.getByDomain(domainId);
    if (!base) return null;

    let nodes = base.nodes || [];
    let edges = base.edges || [];
    const allCards = await document.getMulti(
        domainId,
        TYPE_CARD,
        { baseDocId: Number(base.docId) },
    )
        .sort({ order: 1, cid: 1 })
        .toArray() as CardDoc[];
    let nodeCardsMap: Record<string, CardDoc[]> = {};
    for (const card of allCards) {
        if (!card.nodeId) continue;
        (nodeCardsMap[card.nodeId] ||= []).push(card);
    }
    for (const nodeId of Object.keys(nodeCardsMap)) {
        nodeCardsMap[nodeId].sort((a, b) => (a.order ?? 999999) - (b.order ?? 999999) || a.cid - b.cid);
    }

    const outlineExplorerFilters = options.filters;
    if (hasActiveDetailExplorerFilters(outlineExplorerFilters)) {
        const applied = applyDetailExplorerUrlFilters(nodes, edges, nodeCardsMap, outlineExplorerFilters);
        nodes = applied.nodes;
        edges = applied.edges;
        nodeCardsMap = applied.nodeCardsMap;
    }
    return { base, nodes, edges, nodeCardsMap, outlineExplorerFilters: trimDetailExplorerFiltersForClient(outlineExplorerFilters) };
}
