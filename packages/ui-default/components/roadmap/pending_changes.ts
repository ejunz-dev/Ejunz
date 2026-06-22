import type { Edge, Node } from 'reactflow';
import {
  baseEdgeToFlowEdge,
  baseNodeToFlowNode,
  flowEdgeToBaseEdge,
  flowNodeToBaseNode,
  type BaseRoadmapEdge,
  type BaseRoadmapNode,
} from './shared';

export type RoadmapPendingStatus = 'create' | 'update' | 'delete';

export const ROADMAP_PENDING_COLORS: Record<RoadmapPendingStatus, string> = {
  create: '#4caf50',
  update: '#ff9800',
  delete: '#f44336',
};

export type RoadmapPendingStatusMaps = {
  nodeStatus: Map<string, RoadmapPendingStatus>;
  edgeStatus: Map<string, RoadmapPendingStatus>;
};

export type RoadmapViewport = { x: number; y: number; zoom: number };

export type RoadmapSnapshot = {
  nodes: BaseRoadmapNode[];
  edges: BaseRoadmapEdge[];
  viewport: RoadmapViewport;
};

export type RoadmapPendingItem = {
  id: string;
  label: string;
};

export type RoadmapPendingChanges = {
  createdNodes: RoadmapPendingItem[];
  deletedNodes: RoadmapPendingItem[];
  updatedNodes: RoadmapPendingItem[];
  createdEdges: RoadmapPendingItem[];
  deletedEdges: RoadmapPendingItem[];
  updatedEdges: RoadmapPendingItem[];
  viewportChanged: boolean;
};

function normalizeViewport(viewport?: RoadmapViewport | null): RoadmapViewport {
  const vp = viewport || { x: 0, y: 0, zoom: 1 };
  return {
    x: Math.round(vp.x * 100) / 100,
    y: Math.round(vp.y * 100) / 100,
    zoom: Math.round(vp.zoom * 1000) / 1000,
  };
}

function nodeLabel(node: BaseRoadmapNode): string {
  return String(node.text || '').trim() || node.id;
}

function edgeLabel(edge: BaseRoadmapEdge, nodeLabels: Map<string, string>): string {
  const label = String(edge.label || '').trim();
  if (label) return label;
  const source = nodeLabels.get(edge.source) || edge.source;
  const target = nodeLabels.get(edge.target) || edge.target;
  return `${source} → ${target}`;
}

function normalizeNode(node: BaseRoadmapNode): BaseRoadmapNode {
  return {
    ...node,
    x: Math.round(node.x ?? 0),
    y: Math.round(node.y ?? 0),
    text: String(node.text || ''),
    data: node.data ? { ...node.data } : undefined,
  };
}

function normalizeEdge(edge: BaseRoadmapEdge): BaseRoadmapEdge {
  return {
    ...edge,
    label: typeof edge.label === 'string' ? edge.label : undefined,
    lineStyle: edge.lineStyle,
    color: edge.color,
    width: edge.width,
    type: edge.type,
    style: edge.style ? { ...edge.style } : undefined,
  };
}

function stableNode(node: BaseRoadmapNode): string {
  return JSON.stringify(normalizeNode(node));
}

function stableEdge(edge: BaseRoadmapEdge): string {
  return JSON.stringify(normalizeEdge(edge));
}

export function buildRoadmapSnapshot(
  nodes: Node[],
  edges: Edge[],
  viewport?: RoadmapViewport | null,
): RoadmapSnapshot {
  return {
    nodes: nodes.map(flowNodeToBaseNode).map(normalizeNode).sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.map(flowEdgeToBaseEdge).map(normalizeEdge).sort((a, b) => a.id.localeCompare(b.id)),
    viewport: normalizeViewport(viewport),
  };
}

export function computeRoadmapPendingChanges(
  baseline: RoadmapSnapshot,
  current: RoadmapSnapshot,
): RoadmapPendingChanges {
  const baselineNodes = new Map(baseline.nodes.map((node) => [node.id, node]));
  const currentNodes = new Map(current.nodes.map((node) => [node.id, node]));
  const baselineEdges = new Map(baseline.edges.map((edge) => [edge.id, edge]));
  const currentEdges = new Map(current.edges.map((edge) => [edge.id, edge]));

  const labelMap = new Map<string, string>();
  current.nodes.forEach((node) => labelMap.set(node.id, nodeLabel(node)));
  baseline.nodes.forEach((node) => {
    if (!labelMap.has(node.id)) labelMap.set(node.id, nodeLabel(node));
  });

  const createdNodes: RoadmapPendingItem[] = [];
  const deletedNodes: RoadmapPendingItem[] = [];
  const updatedNodes: RoadmapPendingItem[] = [];

  currentNodes.forEach((node, id) => {
    const prev = baselineNodes.get(id);
    if (!prev) {
      createdNodes.push({ id, label: nodeLabel(node) });
      return;
    }
    if (stableNode(prev) !== stableNode(node)) {
      updatedNodes.push({ id, label: nodeLabel(node) });
    }
  });
  baselineNodes.forEach((node, id) => {
    if (!currentNodes.has(id)) {
      deletedNodes.push({ id, label: nodeLabel(node) });
    }
  });

  const createdEdges: RoadmapPendingItem[] = [];
  const deletedEdges: RoadmapPendingItem[] = [];
  const updatedEdges: RoadmapPendingItem[] = [];

  currentEdges.forEach((edge, id) => {
    const prev = baselineEdges.get(id);
    if (!prev) {
      createdEdges.push({ id, label: edgeLabel(edge, labelMap) });
      return;
    }
    if (stableEdge(prev) !== stableEdge(edge)) {
      updatedEdges.push({ id, label: edgeLabel(edge, labelMap) });
    }
  });
  baselineEdges.forEach((edge, id) => {
    if (!currentEdges.has(id)) {
      deletedEdges.push({ id, label: edgeLabel(edge, labelMap) });
    }
  });

  const viewportChanged = JSON.stringify(baseline.viewport) !== JSON.stringify(current.viewport);

  return {
    createdNodes,
    deletedNodes,
    updatedNodes,
    createdEdges,
    deletedEdges,
    updatedEdges,
    viewportChanged,
  };
}

export function countRoadmapPendingChanges(pending: RoadmapPendingChanges): number {
  return pending.createdNodes.length
    + pending.deletedNodes.length
    + pending.updatedNodes.length
    + pending.createdEdges.length
    + pending.deletedEdges.length
    + pending.updatedEdges.length
    + (pending.viewportChanged ? 1 : 0);
}

export function hasRoadmapPendingChanges(pending: RoadmapPendingChanges): boolean {
  return countRoadmapPendingChanges(pending) > 0;
}

export function buildRoadmapPendingStatusMaps(pending: RoadmapPendingChanges): RoadmapPendingStatusMaps {
  const nodeStatus = new Map<string, RoadmapPendingStatus>();
  const edgeStatus = new Map<string, RoadmapPendingStatus>();
  pending.createdNodes.forEach((item) => nodeStatus.set(item.id, 'create'));
  pending.updatedNodes.forEach((item) => nodeStatus.set(item.id, 'update'));
  pending.deletedNodes.forEach((item) => nodeStatus.set(item.id, 'delete'));
  pending.createdEdges.forEach((item) => edgeStatus.set(item.id, 'create'));
  pending.updatedEdges.forEach((item) => edgeStatus.set(item.id, 'update'));
  pending.deletedEdges.forEach((item) => edgeStatus.set(item.id, 'delete'));
  return { nodeStatus, edgeStatus };
}

export function buildDeletedGhostNodes(
  baseline: RoadmapSnapshot,
  deletedNodeIds: ReadonlySet<string>,
): Node[] {
  return baseline.nodes
    .filter((node) => deletedNodeIds.has(node.id))
    .map((node, index) => {
      const flowNode = baseNodeToFlowNode(node, index);
      return {
        ...flowNode,
        draggable: false,
        selectable: false,
        data: {
          ...flowNode.data,
          pendingStatus: 'delete' as const,
          isPendingGhost: true,
        },
      };
    });
}

export function buildDeletedGhostEdges(
  baseline: RoadmapSnapshot,
  deletedEdgeIds: ReadonlySet<string>,
): Edge[] {
  return baseline.edges
    .filter((edge) => deletedEdgeIds.has(edge.id))
    .map((edge) => {
      const flowEdge = baseEdgeToFlowEdge(edge);
      return {
        ...flowEdge,
        selectable: false,
        data: {
          ...(flowEdge.data || {}),
          pendingStatus: 'delete' as const,
          isPendingGhost: true,
        },
      };
    });
}

export function resolveRoadmapEdgePendingStatus(
  edge: Edge,
  pending: RoadmapPendingStatusMaps,
): RoadmapPendingStatus | undefined {
  const direct = pending.edgeStatus.get(edge.id);
  if (direct) return direct;
  const source = pending.nodeStatus.get(edge.source);
  const target = pending.nodeStatus.get(edge.target);
  if (source === 'delete' || target === 'delete') return 'delete';
  if (source === 'create' || target === 'create') return 'create';
  if (source === 'update' || target === 'update') return 'update';
  return undefined;
}
