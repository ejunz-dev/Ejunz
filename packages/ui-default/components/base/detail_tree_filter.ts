import type { BaseEdge, BaseNode, Card } from './types';
import { i18n } from 'vj/utils';
import {
  cardDisplayLabel,
  getSortedNodeCards,
  nodeDisplayLabel,
} from './detail_tree';

export type BaseDetailFilter = {
  filterNode: string;
  filterCard: string;
  filterProblem: string;
};

export type BaseDetailTreeVisibility = {
  visibleNodeIds: Set<string>;
  visibleCardIds: Set<string> | null;
  forceExpandedNodeIds: Set<string>;
  matchCount: number;
};

const FILTER_KEYS = ['filterNode', 'filterCard', 'filterProblem'] as const;

export function emptyBaseDetailFilter(): BaseDetailFilter {
  return { filterNode: '', filterCard: '', filterProblem: '' };
}

export function readBaseDetailFilterFromLocation(): BaseDetailFilter {
  try {
    const sp = new URLSearchParams(window.location.search);
    return {
      filterNode: sp.get('filterNode') || '',
      filterCard: sp.get('filterCard') || '',
      filterProblem: sp.get('filterProblem') || '',
    };
  } catch {
    return emptyBaseDetailFilter();
  }
}

export function writeBaseDetailFilterToLocation(filters: BaseDetailFilter): void {
  const params = new URLSearchParams(window.location.search);
  FILTER_KEYS.forEach((key) => {
    const val = filters[key].trim();
    if (val) params.set(key, val);
    else params.delete(key);
  });
  const qs = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
}

export function isBaseDetailFilterActive(filters: BaseDetailFilter): boolean {
  return !!(filters.filterNode.trim() || filters.filterCard.trim() || filters.filterProblem.trim());
}

function problemSearchText(problem: Record<string, unknown>): string {
  const parts = [
    problem.title,
    problem.stem,
    problem.faceA,
    problem.faceB,
    problem.hint,
    problem.analysis,
  ];
  if (Array.isArray(problem.options)) {
    parts.push(...problem.options.map((opt) => String(opt ?? '')));
  }
  if (Array.isArray(problem.answers)) {
    parts.push(...problem.answers.map((ans) => String(ans ?? '')));
  }
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function nodeMatchesNodeFilter(node: BaseNode, filters: BaseDetailFilter): boolean {
  const nodeQ = filters.filterNode.trim().toLowerCase();
  if (!nodeQ) return true;
  return nodeDisplayLabel(node).toLowerCase().includes(nodeQ);
}

function cardMatchesCardFilter(card: Card, filters: BaseDetailFilter): boolean {
  const cardQ = filters.filterCard.trim().toLowerCase();
  const problemQ = filters.filterProblem.trim().toLowerCase();
  if (cardQ) {
    const text = `${cardDisplayLabel(card)} ${String(card.content || '')}`.toLowerCase();
    if (!text.includes(cardQ)) return false;
  }
  if (problemQ) {
    const hasProblem = (card.problems || []).some((problem) => (
      problemSearchText(problem as Record<string, unknown>).toLowerCase().includes(problemQ)
    ));
    if (!hasProblem) return false;
  }
  return true;
}

function nodePassesAllFilters(node: BaseNode, cards: Card[], filters: BaseDetailFilter): boolean {
  if (!nodeMatchesNodeFilter(node, filters)) return false;
  const cardQ = filters.filterCard.trim();
  const problemQ = filters.filterProblem.trim();
  if (cardQ || problemQ) {
    return cards.some((card) => cardMatchesCardFilter(card, filters));
  }
  return true;
}

function buildParentMap(edges: BaseEdge[]): Map<string, string> {
  const parentByNode = new Map<string, string>();
  edges.forEach((edge) => parentByNode.set(edge.target, edge.source));
  return parentByNode;
}

function addNodePath(
  nodeId: string,
  parentByNode: Map<string, string>,
  visibleNodeIds: Set<string>,
  forceExpandedNodeIds: Set<string>,
) {
  let current: string | undefined = nodeId;
  while (current) {
    visibleNodeIds.add(current);
    forceExpandedNodeIds.add(current);
    current = parentByNode.get(current);
  }
}

export function computeBaseDetailTreeVisibility(
  nodes: BaseNode[],
  edges: BaseEdge[],
  nodeCardsMap: Record<string, Card[]>,
  filters: BaseDetailFilter,
  scopeRootNodeIds?: string[],
): BaseDetailTreeVisibility | null {
  if (!isBaseDetailFilterActive(filters)) return null;

  const parentByNode = buildParentMap(edges);
  const visibleNodeIds = new Set<string>();
  const forceExpandedNodeIds = new Set<string>();
  const matchingCardIds = new Set<string>();
  let matchCount = 0;

  const inScope = (nodeId: string): boolean => {
    if (!scopeRootNodeIds?.length) return true;
    let current: string | undefined = nodeId;
    while (current) {
      if (scopeRootNodeIds.includes(current)) return true;
      current = parentByNode.get(current);
    }
    return false;
  };

  nodes.forEach((node) => {
    if (!inScope(node.id)) return;
    const cards = getSortedNodeCards(node.id, nodeCardsMap);
    let nodeMatched = false;

    if (nodePassesAllFilters(node, cards, filters)) {
      nodeMatched = true;
      matchCount += 1;
      addNodePath(node.id, parentByNode, visibleNodeIds, forceExpandedNodeIds);
    }

    cards.forEach((card) => {
      if (!cardMatchesCardFilter(card, filters)) return;
      if (!nodeMatchesNodeFilter(node, filters)) return;
      matchingCardIds.add(card.docId);
      if (!nodeMatched) {
        matchCount += 1;
      }
      addNodePath(node.id, parentByNode, visibleNodeIds, forceExpandedNodeIds);
    });
  });

  const hasCardFilter = !!(filters.filterCard.trim() || filters.filterProblem.trim());
  const visibleCardIds = hasCardFilter ? matchingCardIds : null;

  return {
    visibleNodeIds,
    visibleCardIds,
    forceExpandedNodeIds,
    matchCount,
  };
}

export function computeBaseDetailTreeSearchVisibility(
  nodes: BaseNode[],
  edges: BaseEdge[],
  nodeCardsMap: Record<string, Card[]>,
  query: string,
  scopeRootNodeIds: string[],
): BaseDetailTreeVisibility | null {
  const raw = query.trim().toLowerCase();
  if (!raw || !scopeRootNodeIds.length) return null;

  const parentByNode = buildParentMap(edges);
  const visibleNodeIds = new Set<string>();
  const forceExpandedNodeIds = new Set<string>();
  const matchingCardIds = new Set<string>();
  let matchCount = 0;

  const inScope = (nodeId: string): boolean => {
    let current: string | undefined = nodeId;
    while (current) {
      if (scopeRootNodeIds.includes(current)) return true;
      current = parentByNode.get(current);
    }
    return false;
  };

  const cardMatchesSearch = (card: Card): boolean => {
    const text = `${cardDisplayLabel(card)} ${String(card.content || '')}`.toLowerCase();
    if (text.includes(raw)) return true;
    return (card.problems || []).some((problem) => (
      problemSearchText(problem as Record<string, unknown>).toLowerCase().includes(raw)
    ));
  };

  nodes.forEach((node) => {
    if (!inScope(node.id)) return;
    const cards = getSortedNodeCards(node.id, nodeCardsMap);
    const nodeLabelMatch = nodeDisplayLabel(node).toLowerCase().includes(raw);
    let matched = nodeLabelMatch;

    cards.forEach((card) => {
      if (!cardMatchesSearch(card)) return;
      matchingCardIds.add(card.docId);
      matched = true;
    });

    if (nodeLabelMatch) {
      cards.forEach((card) => matchingCardIds.add(card.docId));
      matched = true;
    }

    if (matched) {
      matchCount += 1;
      addNodePath(node.id, parentByNode, visibleNodeIds, forceExpandedNodeIds);
    }
  });

  return {
    visibleNodeIds,
    visibleCardIds: matchingCardIds,
    forceExpandedNodeIds,
    matchCount,
  };
}

export function mergeBaseDetailTreeVisibility(
  filterVisibility: BaseDetailTreeVisibility | null,
  searchVisibility: BaseDetailTreeVisibility | null,
): BaseDetailTreeVisibility | null {
  if (!filterVisibility && !searchVisibility) return null;
  if (!filterVisibility) return searchVisibility;
  if (!searchVisibility) return filterVisibility;

  const visibleNodeIds = new Set<string>();
  filterVisibility.visibleNodeIds.forEach((id) => {
    if (searchVisibility.visibleNodeIds.has(id)) visibleNodeIds.add(id);
  });

  const visibleCardIds = new Set<string>();
  const filterCards = filterVisibility.visibleCardIds;
  searchVisibility.visibleCardIds.forEach((id) => {
    if (!filterCards || filterCards.has(id)) visibleCardIds.add(id);
  });

  const forceExpandedNodeIds = new Set([
    ...filterVisibility.forceExpandedNodeIds,
    ...searchVisibility.forceExpandedNodeIds,
  ]);

  return {
    visibleNodeIds,
    visibleCardIds: visibleCardIds.size ? visibleCardIds : null,
    forceExpandedNodeIds,
    matchCount: visibleNodeIds.size,
  };
}

export function findCardByDocId(
  nodeCardsMap: Record<string, Card[]>,
  cardId: string,
): Card | null {
  for (const cards of Object.values(nodeCardsMap)) {
    const card = cards.find((item) => item.docId === cardId);
    if (card) return card;
  }
  return null;
}

export function findNodeIdForCard(
  nodeCardsMap: Record<string, Card[]>,
  card: Card,
): string | null {
  if (card.nodeId) return card.nodeId;
  for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
    if (cards.some((item) => item.docId === card.docId)) return nodeId;
  }
  return null;
}
