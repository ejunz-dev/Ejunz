import type { BaseEdge, BaseNode, Card } from './types';
import { i18n } from 'vj/utils';

export type BaseDetailTreeChild =
  | { kind: 'node'; node: BaseNode; order: number }
  | { kind: 'card'; card: Card; order: number };

export function getRootNodeIds(nodes: BaseNode[], edges: BaseEdge[]): string[] {
  const hasParent = new Set(edges.map((edge) => edge.target));
  return nodes
    .filter((node) => !hasParent.has(node.id))
    .map((node) => node.id);
}

export function getSortedNodeChildren(
  nodeId: string,
  nodes: BaseNode[],
  edges: BaseEdge[],
): BaseNode[] {
  const childIds = edges
    .filter((edge) => edge.source === nodeId)
    .map((edge) => edge.target);
  return childIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is BaseNode => !!node)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function getSortedNodeCards(
  nodeId: string,
  nodeCardsMap: Record<string, Card[]>,
): Card[] {
  return (nodeCardsMap[nodeId] || [])
    .filter((card) => !card.nodeId || card.nodeId === nodeId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.cid - b.cid));
}

export function getMixedNodeChildren(
  nodeId: string,
  nodes: BaseNode[],
  edges: BaseEdge[],
  nodeCardsMap: Record<string, Card[]>,
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

export function nodeDisplayLabel(node: BaseNode): string {
  return node.text?.trim() || String(i18n('Unnamed Node'));
}

export function cardDisplayLabel(card: Card): string {
  return card.title?.trim() || String(i18n('Unnamed Card'));
}

export function collectDefaultExpandedNodeIds(
  nodes: BaseNode[],
  edges: BaseEdge[],
): string[] {
  const expanded: string[] = [];
  nodes.forEach((node) => {
    if (node.expanded !== false) expanded.push(node.id);
  });
  if (expanded.length === 0) {
    getRootNodeIds(nodes, edges).forEach((id) => expanded.push(id));
  }
  return expanded;
}

export function collectSubtreeDefaultExpandedNodeIds(
  rootNodeId: string,
  nodes: BaseNode[],
  edges: BaseEdge[],
): string[] {
  const expanded = new Set<string>([rootNodeId]);
  const visit = (nodeId: string) => {
    getSortedNodeChildren(nodeId, nodes, edges).forEach((child) => {
      if (child.expanded !== false) expanded.add(child.id);
      if (child.type !== 'roadmap') visit(child.id);
    });
  };
  visit(rootNodeId);
  return [...expanded];
}

export function getRoadmapChildGraph(
  roadmapNodeId: string,
  nodes: BaseNode[],
  edges: BaseEdge[],
): { childNodes: BaseNode[]; childEdges: BaseEdge[] } {
  const childNodes = edges
    .filter((edge) => edge.source === roadmapNodeId)
    .map((edge) => nodes.find((node) => node.id === edge.target))
    .filter((node): node is BaseNode => !!node);
  const childIds = new Set(childNodes.map((node) => node.id));
  const childEdges = edges.filter(
    (edge) => childIds.has(edge.source) && childIds.has(edge.target),
  );
  return { childNodes, childEdges };
}
