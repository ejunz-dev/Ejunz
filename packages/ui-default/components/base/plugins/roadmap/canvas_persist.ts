import type { BaseNode, BaseEdge, Card, FileItem } from 'vj/components/base/types';
import { i18n } from 'vj/utils';
import { validateRoadmapNodeNumbers } from './node_numbering';

function readRoadmapCoord(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/** DB edge ids from BaseModel.addEdge: edge_<msTimestamp>_<random> */
export function isPersistedBaseEdgeId(edgeId: string): boolean {
  return /^edge_\d{10,}_[a-z0-9]+$/i.test(edgeId);
}

/** Canvas-local edge ids not yet written to DB. */
export function isTemporaryRoadmapCanvasEdgeId(edgeId: string): boolean {
  if (!edgeId) return true;
  if (edgeId.startsWith('temp-edge')) return true;
  if (isPersistedBaseEdgeId(edgeId)) return false;
  return edgeId.startsWith('edge_');
}

/** Resolve canvas layout coords like standalone /roadmap — always top-level x/y + data.posX/posY. */
export function resolveRoadmapCanvasPersistCoords(node: BaseNode): {
  x: number;
  y: number;
  data: Record<string, unknown>;
} | null {
  const data = { ...(node.data || {}) } as Record<string, unknown>;
  if (!data.roadmapNodeType) return null;
  const x = readRoadmapCoord(data.posX) ?? readRoadmapCoord(node.x);
  const y = readRoadmapCoord(data.posY) ?? readRoadmapCoord(node.y);
  if (x == null || y == null) return null;
  return {
    x,
    y,
    data: {
      ...data,
      posX: x,
      posY: y,
    },
  };
}

export function normalizeRoadmapCanvasBaseNode(node: BaseNode): BaseNode {
  const coords = resolveRoadmapCanvasPersistCoords(node);
  if (!coords) return node;
  return {
    ...node,
    x: coords.x,
    y: coords.y,
    data: coords.data,
  };
}

function roadmapCanvasDataSnapshot(data?: Record<string, unknown>): string {
  const keys = [
    'posX', 'posY', 'lane', 'roadmapNodeType', 'nodeNumber', 'nodeText', 'description',
    'hookRoadmapDocId', 'hookRoadmapBranch', 'hookRoadmapTitle', 'hookRoadmapUrl',
  ];
  const source = data || {};
  return keys.map((key) => `${key}:${String(source[key] ?? '')}`).join('|');
}

function roadmapCanvasDataEqual(
  a?: Record<string, unknown>,
  b?: Record<string, unknown>,
): boolean {
  return roadmapCanvasDataSnapshot(a) === roadmapCanvasDataSnapshot(b);
}

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
  for (const edge of base.edges) {
    if (edge.target !== childNodeId) continue;
    const parent = base.nodes.find((node) => node.id === edge.source);
    if (parent?.type === 'roadmap') return parent.id;
  }
  return null;
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
      return match ? normalizeRoadmapCanvasBaseNode({ ...n, ...match }) : n;
    })
    .filter((n) => {
      if (!childIds.has(n.id)) return true;
      return updatedNodeIds.has(n.id);
    });

  const added = updatedNodes.filter((n) => !childIds.has(n.id)).map(normalizeRoadmapCanvasBaseNode);
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
      const beforeData = before.data as Record<string, unknown> | undefined;
      const afterData = after.data as Record<string, unknown> | undefined;
      if (
        before.text !== after.text
        || before.x !== after.x
        || before.y !== after.y
        || beforeData?.posX !== afterData?.posX
        || beforeData?.posY !== afterData?.posY
        || beforeData?.lane !== afterData?.lane
        || beforeData?.roadmapNodeType !== afterData?.roadmapNodeType
        || !roadmapCanvasDataEqual(beforeData, afterData)
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
    const update = buildRoadmapChildNodeUpdate(base, nodeId);
    if (update) nodeUpdates.push(update);
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
    if (!edge.id || isPersistedBaseEdgeId(edge.id)) continue;
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

function buildRoadmapChildNodeUpdate(
  base: { nodes: BaseNode[] },
  nodeId: string,
): { nodeId: string; text?: string; x?: number; y?: number; data?: Record<string, unknown> } | null {
  const node = base.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  const coords = resolveRoadmapCanvasPersistCoords(node);
  if (!coords) return null;
  return {
    nodeId,
    text: node.text,
    x: coords.x,
    y: coords.y,
    data: coords.data,
  };
}

export function collectRoadmapNodeUpdates(
  base: { nodes: BaseNode[]; edges: BaseEdge[] },
  pendingNodeIds: Iterable<string>,
): Array<{ nodeId: string; text?: string; x?: number; y?: number; data?: Record<string, unknown> }> {
  const updates: Array<{ nodeId: string; text?: string; x?: number; y?: number; data?: Record<string, unknown> }> = [];
  for (const nodeId of pendingNodeIds) {
    if (!nodeId || nodeId.startsWith('temp-node-')) continue;
    const update = buildRoadmapChildNodeUpdate(base, nodeId);
    if (update) updates.push(update);
  }
  return updates;
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
    if (!edgeId || edgeId.startsWith('temp-edge-tree-') || !isPersistedBaseEdgeId(edgeId)) continue;
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
  const coords = resolveRoadmapCanvasPersistCoords(node);
  if (!coords) {
    const data = (node.data || {}) as Record<string, unknown>;
    return Object.keys(data).length > 0 ? { data } : {};
  }
  return {
    x: coords.x,
    y: coords.y,
    data: coords.data,
  };
}

function roadmapCanvasNumberingNodes(nodes: BaseNode[]): Array<{ id: string; data?: Record<string, unknown> }> {
  return nodes
    .filter((node) => {
      const type = (node.data as Record<string, unknown> | undefined)?.roadmapNodeType;
      return type === 'main' || type === 'sub';
    })
    .map((node) => ({
      id: node.id,
      data: {
        ...(node.data || {}),
        label: node.text,
      } as Record<string, unknown>,
    }));
}

export function collectRoadmapCanvasValidationErrors(
  base: { nodes: BaseNode[]; edges: BaseEdge[] },
): string[] {
  const errors: string[] = [];
  const roadmapRoots = base.nodes.filter((node) => node.type === 'roadmap');
  for (const root of roadmapRoots) {
    const childIds = roadmapChildIdSet(base, root.id);
    const canvasNodes = base.nodes.filter((node) => childIds.has(node.id));
    const canvasEdges = base.edges.filter(
      (edge) => childIds.has(edge.source) && childIds.has(edge.target),
    );
    errors.push(...validateRoadmapNodeNumbers(roadmapCanvasNumberingNodes(canvasNodes), canvasEdges));
  }
  return errors;
}
