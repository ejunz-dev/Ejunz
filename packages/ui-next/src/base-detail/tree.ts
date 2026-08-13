import type { BaseDetailCard, BaseDetailEdge, BaseDetailNode } from './types';

export function stringId(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (object.$oid != null) return String(object.$oid);
    if (object._id != null) return stringId(object._id);
  }
  return String(value);
}

export function getRootNodeIds(nodes: BaseDetailNode[], edges: BaseDetailEdge[]): string[] {
  const children = new Set(edges.map((edge) => stringId(edge.target)));
  return nodes.filter((node) => !children.has(stringId(node.id))).map((node) => stringId(node.id));
}

export function getSortedNodeChildren(
  nodeId: string,
  nodes: BaseDetailNode[],
  edges: BaseDetailEdge[],
): BaseDetailNode[] {
  const childIds = edges
    .filter((edge) => stringId(edge.source) === nodeId)
    .map((edge) => stringId(edge.target));
  return childIds
    .map((id) => nodes.find((node) => stringId(node.id) === id))
    .filter((node): node is BaseDetailNode => !!node)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getSortedNodeCards(
  nodeId: string,
  nodeCardsMap: Record<string, BaseDetailCard[]>,
): BaseDetailCard[] {
  return [...(nodeCardsMap[nodeId] || [])]
    .filter((card) => !card.nodeId || stringId(card.nodeId) === nodeId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.cid ?? 0) - (b.cid ?? 0));
}

export type BaseDetailTreeChild =
  | { kind: 'node'; node: BaseDetailNode; order: number }
  | { kind: 'card'; card: BaseDetailCard; order: number };

export function getMixedNodeChildren(
  nodeId: string,
  nodes: BaseDetailNode[],
  edges: BaseDetailEdge[],
  nodeCardsMap: Record<string, BaseDetailCard[]>,
): BaseDetailTreeChild[] {
  const childNodes = getSortedNodeChildren(nodeId, nodes, edges).map((node) => ({
    kind: 'node' as const,
    node,
    order: node.order ?? 0,
  }));
  const cards = getSortedNodeCards(nodeId, nodeCardsMap).map((card) => ({
    kind: 'card' as const,
    card,
    order: card.order ?? 0,
  }));
  return [...childNodes, ...cards].sort((a, b) => a.order - b.order);
}

export function collectSubtreeNodeIds(
  rootNodeId: string,
  nodes: BaseDetailNode[],
  edges: BaseDetailEdge[],
): string[] {
  const result: string[] = [];
  const visit = (nodeId: string) => {
    for (const child of getSortedNodeChildren(nodeId, nodes, edges)) {
      result.push(stringId(child.id));
      visit(stringId(child.id));
    }
  };
  visit(rootNodeId);
  return result;
}

export function findCardHostNodeId(
  cardId: string,
  nodeCardsMap: Record<string, BaseDetailCard[]>,
): string | null {
  for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
    if (cards.some((card) => stringId(card.docId) === cardId)) return nodeId;
  }
  return null;
}

export function findCardByDocId(
  cardId: string,
  nodeCardsMap: Record<string, BaseDetailCard[]>,
): BaseDetailCard | null {
  for (const cards of Object.values(nodeCardsMap)) {
    const card = cards.find((item) => stringId(item.docId) === cardId);
    if (card) return card;
  }
  return null;
}

export function buildParentMap(edges: BaseDetailEdge[]): Map<string, string> {
  return new Map(edges.map((edge) => [stringId(edge.target), stringId(edge.source)]));
}

export function collectNodePathFromRoot(
  targetNodeId: string,
  rootNodeId: string,
  edges: BaseDetailEdge[],
): string[] {
  const path: string[] = [];
  const parents = buildParentMap(edges);
  let current: string | undefined = targetNodeId;
  while (current) {
    path.unshift(current);
    if (current === rootNodeId) return path;
    current = parents.get(current);
  }
  return [];
}

export function nodeDisplayLabel(node: BaseDetailNode | null | undefined): string {
  return node?.text?.trim() || 'Unnamed Node';
}

export function cardDisplayLabel(card: BaseDetailCard | null | undefined): string {
  return card?.title?.trim() || 'Unnamed Card';
}

export function defaultExpandedNodeIds(nodes: BaseDetailNode[], edges: BaseDetailEdge[]): Set<string> {
  const expanded = new Set(nodes.filter((node) => node.expanded !== false).map((node) => stringId(node.id)));
  if (!expanded.size) getRootNodeIds(nodes, edges).forEach((id) => expanded.add(id));
  return expanded;
}
