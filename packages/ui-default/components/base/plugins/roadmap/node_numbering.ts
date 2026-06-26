import { i18n } from 'vj/utils';
import type { Edge, Node } from 'reactflow';
import { isMainNodeType, isSubNodeType } from './node_kinds';
import { isHorizontalSolidEdge } from './solid_links';

export const ROADMAP_SUB_NUMBER_PATTERN = /^\d+\.\d+$/;

function sortNodesByY(nodes: Node[]): Node[] {
  return [...nodes].sort((a, b) => a.position.y - b.position.y);
}

function buildHorizontalSolidAdjacency(edges: Edge[], nodes: Node[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  edges.forEach((edge) => {
    if (!isHorizontalSolidEdge(edge, nodes)) return;
    link(edge.source, edge.target);
  });
  return adj;
}

function findConnectedComponent(startId: string, adj: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    adj.get(current)?.forEach((peerId) => stack.push(peerId));
  }
  return visited;
}

function findMainNodeComponents(mainNodes: Node[], edges: Edge[], nodes: Node[]): Node[][] {
  const adj = buildHorizontalSolidAdjacency(edges, nodes);
  const visited = new Set<string>();
  const components: Node[][] = [];
  mainNodes.forEach((node) => {
    if (visited.has(node.id)) return;
    const componentIds = findConnectedComponent(node.id, adj);
    componentIds.forEach((id) => visited.add(id));
    const componentNodes = mainNodes.filter((n) => componentIds.has(n.id));
    if (componentNodes.length) components.push(sortNodesByY(componentNodes));
  });
  return components;
}

export function isValidRoadmapSubNumber(value: string): boolean {
  return ROADMAP_SUB_NUMBER_PATTERN.test(value.trim());
}

export function computeRoadmapNodeNumbers(nodes: Node[], edges: Edge[]): Map<string, string> {
  const result = new Map<string, string>();
  const roadmapNodes = nodes.filter((node) => {
    const type = node.data?.roadmapNodeType;
    return isMainNodeType(type) || isSubNodeType(type);
  });
  if (!roadmapNodes.length) return result;

  const mainNodes = roadmapNodes.filter((node) => isMainNodeType(node.data?.roadmapNodeType));
  const subNodes = roadmapNodes.filter((node) => isSubNodeType(node.data?.roadmapNodeType));

  const components = findMainNodeComponents(mainNodes, edges, nodes);
  components.sort((a, b) => a[0].position.y - b[0].position.y);

  let mainCounter = 1;
  components.forEach((component) => {
    component.forEach((node) => {
      result.set(node.id, String(mainCounter));
      mainCounter += 1;
    });
  });

  subNodes.forEach((subNode) => {
    const raw = String(subNode.data?.nodeNumber || '').trim();
    if (isValidRoadmapSubNumber(raw)) {
      result.set(subNode.id, raw);
    }
  });

  return result;
}

export function validateRoadmapSubNodeNumbers(nodes: Node[]): string[] {
  const errors: string[] = [];
  nodes.forEach((node) => {
    if (!isSubNodeType(node.data?.roadmapNodeType)) return;
    const raw = String(node.data?.nodeNumber || '').trim();
    const label = String(node.data?.label || node.id);
    if (!raw) {
      errors.push(i18n('Roadmap sub node number missing').replace('{0}', label));
      return;
    }
    if (!isValidRoadmapSubNumber(raw)) {
      errors.push(i18n('Roadmap sub node number invalid'));
    }
  });
  return errors;
}
