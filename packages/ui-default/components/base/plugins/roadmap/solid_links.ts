import type { Edge, Node } from 'reactflow';
import {
  roadmapEdgeLineStyleFromStyle,
  RoadmapEdgeLineStyle,
} from './shared';

const HORIZONTAL_HANDLES = new Set(['left', 'right']);

export function getEdgeLineStyle(edge: Edge): RoadmapEdgeLineStyle {
  const fromData = edge.data?.lineStyle;
  if (fromData === 'solid' || fromData === 'dashed') return fromData;
  return roadmapEdgeLineStyleFromStyle(edge.style as Record<string, any>);
}

export function isSolidEdge(edge: Edge): boolean {
  return getEdgeLineStyle(edge) !== 'dashed';
}

export function isHorizontalConnection(
  sourceHandle?: string | null,
  targetHandle?: string | null,
): boolean {
  if (!sourceHandle || !targetHandle) return false;
  return HORIZONTAL_HANDLES.has(sourceHandle) && HORIZONTAL_HANDLES.has(targetHandle);
}

export function isHorizontalSolidEdge(edge: Edge, nodes?: Node[]): boolean {
  if (!isSolidEdge(edge)) return false;
  if (isHorizontalConnection(edge.sourceHandle, edge.targetHandle)) return true;
  if (edge.sourceHandle || edge.targetHandle) return false;
  if (!nodes?.length) return false;
  const source = nodes.find((node) => node.id === edge.source);
  const target = nodes.find((node) => node.id === edge.target);
  if (!source || !target) return false;
  const dx = Math.abs(target.position.x - source.position.x);
  const dy = Math.abs(target.position.y - source.position.y);
  return dx >= dy;
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

export function getSolidLinkedNodeIds(nodeId: string, edges: Edge[], nodes: Node[]): Set<string> {
  const adj = buildHorizontalSolidAdjacency(edges, nodes);
  const visited = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    adj.get(current)?.forEach((peerId) => stack.push(peerId));
  }
  return visited;
}

export function alignNodesInSolidComponents(nodes: Node[], edges: Edge[]): Node[] {
  const visited = new Set<string>();
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const updates = new Map<string, Node>();

  nodes.forEach((node) => {
    if (visited.has(node.id)) return;
    const component = getSolidLinkedNodeIds(node.id, edges, nodes);
    if (component.size <= 1) {
      visited.add(node.id);
      return;
    }
    component.forEach((id) => visited.add(id));

    const componentNodes = [...component]
      .map((id) => nodeMap.get(id))
      .filter((item): item is Node => !!item);
    const anchorY = Math.min(...componentNodes.map((item) => item.position.y));

    componentNodes.forEach((item) => {
      updates.set(item.id, {
        ...item,
        position: {
          ...item.position,
          y: anchorY,
        },
      });
    });
  });

  return nodes.map((node) => updates.get(node.id) || node);
}

export function applySharedSolidY(
  nodes: Node[],
  anchorNodeId: string,
  y: number,
  edges: Edge[],
): Node[] {
  const linked = getSolidLinkedNodeIds(anchorNodeId, edges, nodes);
  if (linked.size <= 1) return nodes;
  return nodes.map((node) => (
    linked.has(node.id)
      ? { ...node, position: { ...node.position, y } }
      : node
  ));
}

export function shouldAlignSolidConnection(connection: {
  sourceHandle?: string | null;
  targetHandle?: string | null;
}): boolean {
  return isHorizontalConnection(connection.sourceHandle, connection.targetHandle);
}
