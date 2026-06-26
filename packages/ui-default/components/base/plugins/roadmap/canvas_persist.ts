import type { BaseNode, BaseEdge, Card, FileItem } from 'vj/components/base/types';
import { i18n } from 'vj/utils';

export function findCardOwnerNodeId(
  nodeCardsMap: Record<string, Card[]>,
  cardId: string,
): string | null {
  const cardIdStr = String(cardId);
  for (const [nodeId, cards] of Object.entries(nodeCardsMap)) {
    if ((cards || []).some((card) => String(card.docId) === cardIdStr)) {
      return nodeId;
    }
  }
  return null;
}

export function findRoadmapParentForChildNode(
  base: { nodes: BaseNode[]; edges: BaseEdge[] },
  childNodeId: string,
): string | null {
  const edge = base.edges.find((item) => item.target === childNodeId);
  if (!edge) return null;
  const parent = base.nodes.find((node) => node.id === edge.source);
  return parent?.type === 'roadmap' ? parent.id : null;
}

export function resolveRoadmapCardLocation(
  base: { nodes: BaseNode[]; edges: BaseEdge[] },
  nodeCardsMap: Record<string, Card[]>,
  cardId: string,
): { roadmapNodeId: string; childNodeId: string; card: Card } | null {
  const childNodeId = findCardOwnerNodeId(nodeCardsMap, cardId);
  if (!childNodeId) return null;
  const roadmapNodeId = findRoadmapParentForChildNode(base, childNodeId);
  if (!roadmapNodeId) return null;
  const card = (nodeCardsMap[childNodeId] || []).find(
    (item) => String(item.docId) === String(cardId),
  );
  if (!card) return null;
  return { roadmapNodeId, childNodeId, card };
}

export function buildRoadmapCardFileItem(
  childNodeId: string,
  card: Card,
  base: { nodes: BaseNode[] },
): FileItem {
  const node = base.nodes.find((item) => item.id === childNodeId);
  const name = String(node?.text || card.title || '').trim() || i18n('Unnamed');
  return {
    type: 'card',
    id: `card-${card.docId}`,
    name,
    nodeId: childNodeId,
    cardId: card.docId,
    parentId: childNodeId,
    level: 0,
  };
}

export function roadmapChildIdSet(
  base: { nodes: BaseNode[]; edges: BaseEdge[] },
  roadmapId: string,
): Set<string> {
  const ids = new Set(
    base.edges.filter((e) => e.source === roadmapId).map((e) => e.target),
  );
  return ids;
}

export function isRoadmapCanvasInternalEdge(edge: BaseEdge, childIds: Set<string>): boolean {
  return childIds.has(edge.source) && childIds.has(edge.target);
}

export function mergeRoadmapCanvasIntoBase(
  prev: { nodes: BaseNode[]; edges: BaseEdge[] },
  roadmapId: string,
  updatedNodes: BaseNode[],
  updatedEdges: BaseEdge[],
): { nodes: BaseNode[]; edges: BaseEdge[] } | null {
  const childIds = roadmapChildIdSet(prev, roadmapId);
  if (updatedNodes.length === 0 && childIds.size > 0) return null;
  for (const n of updatedNodes) childIds.add(n.id);

  const updatedNodeIds = new Set(updatedNodes.map((n) => n.id));

  const nextNodes = prev.nodes
    .map((n) => {
      if (!childIds.has(n.id) && !updatedNodeIds.has(n.id)) return n;
      const match = updatedNodes.find((u) => u.id === n.id);
      return match ? { ...n, ...match } : n;
    })
    .filter((n) => {
      if (!childIds.has(n.id)) return true;
      return updatedNodeIds.has(n.id);
    });

  const added = updatedNodes.filter((n) => !childIds.has(n.id));
  const deadIds = [...childIds].filter((id) => !updatedNodeIds.has(id));

  if (!added.length && !deadIds.length) {
    let nodesSame = true;
    for (const id of childIds) {
      const before = prev.nodes.find((n) => n.id === id);
      const after = nextNodes.find((n) => n.id === id);
      if (!before || !after) {
        nodesSame = false;
        break;
      }
      const beforeData = before.data as { posX?: number; posY?: number; lane?: number; roadmapNodeType?: string } | undefined;
      const afterData = after.data as { posX?: number; posY?: number; lane?: number; roadmapNodeType?: string } | undefined;
      if (
        before.text !== after.text
        || beforeData?.posX !== afterData?.posX
        || beforeData?.posY !== afterData?.posY
        || beforeData?.lane !== afterData?.lane
        || beforeData?.roadmapNodeType !== afterData?.roadmapNodeType
      ) {
        nodesSame = false;
        break;
      }
    }

    const prevInternal = prev.edges.filter((e) => isRoadmapCanvasInternalEdge(e, childIds));
    const edgesSame = prevInternal.length === updatedEdges.length
      && prevInternal.every((e) =>
        updatedEdges.some((u) => u.source === e.source && u.target === e.target
          && String((e as BaseEdge & { lineStyle?: string }).lineStyle || '') === String((u as BaseEdge & { lineStyle?: string }).lineStyle || '')
          && String((e as BaseEdge & { label?: string }).label || '') === String((u as BaseEdge & { label?: string }).label || '')),
      );

    if (nodesSame && edgesSame) return null;
  }

  const keptEdges = prev.edges.filter((e) => !isRoadmapCanvasInternalEdge(e, childIds));
  for (const n of updatedNodes) {
    if (!keptEdges.some((e) => e.source === roadmapId && e.target === n.id)) {
      keptEdges.push({
        id: `temp-edge-tree-${roadmapId}-${n.id}`,
        source: roadmapId,
        target: n.id,
      });
    }
  }

  return {
    nodes: nextNodes,
    edges: [...keptEdges, ...updatedEdges],
  };
}

export function collectRoadmapCanvasBatchSaveExtras(base: {
  nodes: BaseNode[];
  edges: BaseEdge[];
}): {
  nodeUpdates: Array<{ nodeId: string; text?: string; x?: number; y?: number; data?: Record<string, unknown> }>;
  edgeCreates: Array<{
    source: string;
    target: string;
    label?: string;
    lineStyle?: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
  edgeUpdates: Array<{
    edgeId: string;
    label?: string;
    lineStyle?: string;
    sourceHandle?: string;
    targetHandle?: string;
  }>;
} {
  const roadmapIds = new Set(
    base.nodes.filter((n) => n.type === 'roadmap').map((n) => n.id),
  );
  const childIds = new Set<string>();
  for (const rid of roadmapIds) {
    for (const e of base.edges) {
      if (e.source === rid) childIds.add(e.target);
    }
  }

  const nodeUpdates: Array<{ nodeId: string; text?: string; x?: number; y?: number; data?: Record<string, unknown> }> = [];
  for (const nodeId of childIds) {
    if (nodeId.startsWith('temp-node-')) continue;
    const node = base.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const data = (node.data || {}) as Record<string, unknown>;
    if (!data.roadmapNodeType) continue;
    const x = typeof node.x === 'number' ? node.x : (data.posX as number | undefined);
    const y = typeof node.y === 'number' ? node.y : (data.posY as number | undefined);
    nodeUpdates.push({
      nodeId,
      text: node.text,
      ...(x != null ? { x } : {}),
      ...(y != null ? { y } : {}),
      data: {
        ...data,
        ...(x != null ? { posX: x } : {}),
        ...(y != null ? { posY: y } : {}),
      },
    });
  }

  const edgeCreates: Array<{
    source: string;
    target: string;
    label?: string;
    lineStyle?: string;
    sourceHandle?: string;
    targetHandle?: string;
  }> = [];
  for (const edge of base.edges) {
    if (!isRoadmapCanvasInternalEdge(edge, childIds)) continue;
    if (edge.id && !edge.id.startsWith('temp-edge') && !edge.id.startsWith('edge_')) continue;
    const typedEdge = edge as BaseEdge & {
      label?: string;
      lineStyle?: string;
      sourceHandle?: string;
      targetHandle?: string;
      data?: { lineStyle?: string; sourceHandle?: string; targetHandle?: string };
    };
    const lineStyle = typedEdge.lineStyle ?? typedEdge.data?.lineStyle;
    const sourceHandle = typedEdge.sourceHandle ?? typedEdge.data?.sourceHandle;
    const targetHandle = typedEdge.targetHandle ?? typedEdge.data?.targetHandle;
    edgeCreates.push({
      source: edge.source,
      target: edge.target,
      label: typedEdge.label,
      ...(lineStyle ? { lineStyle } : {}),
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
    });
  }

  return { nodeUpdates, edgeCreates, edgeUpdates: [] };
}

export function collectRoadmapEdgeUpdates(
  base: { edges: BaseEdge[] },
  pendingEdgeIds: Iterable<string>,
): Array<{
  edgeId: string;
  label?: string;
  lineStyle?: string;
  sourceHandle?: string;
  targetHandle?: string;
}> {
  const updates: Array<{
    edgeId: string;
    label?: string;
    lineStyle?: string;
    sourceHandle?: string;
    targetHandle?: string;
  }> = [];

  for (const edgeId of pendingEdgeIds) {
    if (!edgeId || edgeId.startsWith('temp-edge-tree-') || edgeId.startsWith('edge_')) continue;
    const edge = base.edges.find((item) => item.id === edgeId);
    if (!edge) continue;
    const typedEdge = edge as BaseEdge & {
      label?: string;
      lineStyle?: string;
      sourceHandle?: string;
      targetHandle?: string;
      data?: {
        lineStyle?: string;
        sourceHandle?: string;
        targetHandle?: string;
      };
    };
    const lineStyle = typedEdge.lineStyle ?? typedEdge.data?.lineStyle;
    const sourceHandle = typedEdge.sourceHandle ?? typedEdge.data?.sourceHandle;
    const targetHandle = typedEdge.targetHandle ?? typedEdge.data?.targetHandle;
    updates.push({
      edgeId,
      label: typedEdge.label,
      ...(lineStyle ? { lineStyle } : {}),
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
    });
  }

  return updates;
}

export function roadmapNodeCreatePayloadFromBase(node: BaseNode | undefined): {
  x?: number;
  y?: number;
  data?: Record<string, unknown>;
} {
  if (!node) return {};
  const data = (node.data || {}) as Record<string, unknown>;
  const x = typeof node.x === 'number' ? node.x : (data.posX as number | undefined);
  const y = typeof node.y === 'number' ? node.y : (data.posY as number | undefined);
  const payload: { x?: number; y?: number; data?: Record<string, unknown> } = {};
  if (x != null) payload.x = x;
  if (y != null) payload.y = y;
  if (Object.keys(data).length > 0) {
    payload.data = {
      ...data,
      ...(x != null ? { posX: x } : {}),
      ...(y != null ? { posY: y } : {}),
    };
  }
  return payload;
}
