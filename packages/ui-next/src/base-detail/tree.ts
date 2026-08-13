import type {
  BaseDetailCard, BaseDetailEdge, BaseDetailNode,
} from './types';

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
  const hasParent = new Set(edges.map((edge) => edge.target));
  return nodes.filter((node) => !hasParent.has(node.id)).map((node) => node.id);
}

export function getSortedNodeChildren(
  nodeId: string,
  nodes: BaseDetailNode[],
  edges: BaseDetailEdge[],
): BaseDetailNode[] {
  const childIds = edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target);
  return childIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is BaseDetailNode => !!node)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export type BaseDetailTreeChild =
  | { kind: 'node'; node: BaseDetailNode; order: number }
  | { kind: 'card'; card: BaseDetailCard; order: number };

export function getSortedNodeCards(
  nodeId: string,
  nodeCardsMap: Record<string, BaseDetailCard[]>,
): BaseDetailCard[] {
  return [...(nodeCardsMap[nodeId] || [])]
    .filter((card) => !card.nodeId || card.nodeId === nodeId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || ((a.cid ?? 0) - (b.cid ?? 0)));
}

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
  const ids: string[] = [];
  const visit = (nodeId: string) => {
    getSortedNodeChildren(nodeId, nodes, edges).forEach((child) => {
      ids.push(child.id);
      visit(child.id);
    });
  };
  visit(rootNodeId);
  return ids;
}

export function buildParentMap(edges: BaseDetailEdge[]): Map<string, string> {
  const parentByNode = new Map<string, string>();
  edges.forEach((edge) => parentByNode.set(edge.target, edge.source));
  return parentByNode;
}

export function collectNodePathFromRoot(
  targetNodeId: string,
  rootNodeId: string,
  edges: BaseDetailEdge[],
): string[] {
  if (targetNodeId === rootNodeId) return [rootNodeId];
  const parentByNode = buildParentMap(edges);
  const path: string[] = [];
  let current: string | undefined = targetNodeId;
  while (current) {
    path.unshift(current);
    if (current === rootNodeId) return path;
    current = parentByNode.get(current);
  }
  return [];
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

export function nodeDisplayLabel(node: BaseDetailNode | null | undefined, unnamed = 'Unnamed Node'): string {
  return node?.text?.trim() || unnamed;
}

export function cardDisplayLabel(card: BaseDetailCard | null | undefined, unnamed = 'Unnamed Card'): string {
  return card?.title?.trim() || unnamed;
}

export function defaultExpandedNodeIds(
  nodes: BaseDetailNode[],
  edges: BaseDetailEdge[],
): Set<string> {
  const expanded = new Set(nodes.filter((node) => node.expanded !== false).map((node) => node.id));
  if (expanded.size === 0) getRootNodeIds(nodes, edges).forEach((id) => expanded.add(id));
  return expanded;
}

export function isNodeVisible(
  nodeId: string,
  rootNodeId: string,
  edges: BaseDetailEdge[],
  expanded: Set<string>,
): boolean {
  if (nodeId === rootNodeId) return true;
  const parentByNode = buildParentMap(edges);
  let current: string | undefined = nodeId;
  while (current) {
    const parent = parentByNode.get(current);
    if (!parent) return false;
    if (parent === rootNodeId) return expanded.has(rootNodeId);
    if (!expanded.has(parent)) return false;
    current = parent;
  }
  return false;
}
