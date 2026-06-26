import type { Edge, Node } from 'reactflow';
import { domainApiPath, i18n } from 'vj/utils';
import { LANE_NODE_WIDTH, nearestLaneFromX, type RoadmapLane } from './lanes';

export type RoadmapStatus = 'planned' | 'in_progress' | 'done' | 'blocked';
export type RoadmapNodeType = 'main' | 'sub' | 'hook' | 'text' | 'root' | 'milestone' | 'task' | 'decision' | 'release';
export type RoadmapPriority = 'low' | 'medium' | 'high';

export interface RoadmapNodeData {
  roadmapNodeType?: RoadmapNodeType;
  status?: RoadmapStatus;
  owner?: string;
  dueDate?: string;
  description?: string;
  nodeText?: string;
  hookRoadmapDocId?: string | number;
  hookRoadmapBranch?: string;
  hookRoadmapTitle?: string;
  hookRoadmapUrl?: string;
  priority?: RoadmapPriority;
  lane?: 1 | 2 | 3;
}

export interface BaseRoadmapNode {
  id: string;
  text: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  color?: string;
  backgroundColor?: string;
  fontSize?: number;
  shape?: 'rectangle' | 'circle' | 'ellipse' | 'diamond';
  parentId?: string;
  children?: string[];
  expanded?: boolean;
  level?: number;
  order?: number;
  style?: Record<string, any>;
  data?: RoadmapNodeData & Record<string, any>;
}

export interface BaseRoadmapEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
  lineStyle?: 'solid' | 'dashed';
  style?: Record<string, any>;
  type?: 'straight' | 'curved' | 'bezier';
  color?: string;
  width?: number;
}

export interface RoadmapDoc {
  domainId?: string;
  docId?: number | string;
  rid?: string | number;
  title?: string;
  content?: string;
  currentBranch?: string;
  branches?: string[];
  githubRepo?: string;
  nodes?: BaseRoadmapNode[];
  edges?: BaseRoadmapEdge[];
  layout?: Record<string, any>;
  viewport?: { x: number; y: number; zoom: number };
  editorUi?: { showProblemCount?: boolean };
}

export interface RoadmapQueryContext {
  domainId: string;
  docId: string;
}

export function statusLabel(status?: RoadmapStatus): string {
  switch (status) {
    case 'in_progress': return i18n('Roadmap status in progress');
    case 'done': return i18n('Roadmap status done');
    case 'blocked': return i18n('Roadmap status blocked');
    case 'planned':
    default: return i18n('Roadmap status planned');
  }
}

export function nodeTypeLabel(type?: RoadmapNodeType): string {
  switch (type) {
    case 'main': return i18n('Roadmap node type main');
    case 'sub': return i18n('Roadmap node type sub');
    case 'hook': return i18n('Roadmap node type hook');
    case 'text': return i18n('Roadmap node type text');
    case 'root': return i18n('Roadmap node type root');
    case 'milestone': return i18n('Roadmap node type milestone');
    case 'decision': return i18n('Roadmap node type decision');
    case 'release': return i18n('Roadmap node type release');
    case 'task':
    default: return i18n('Roadmap node type task');
  }
}

export function priorityLabel(priority?: RoadmapPriority): string {
  switch (priority) {
    case 'low': return i18n('Roadmap priority low');
    case 'high': return i18n('Roadmap priority high');
    case 'medium':
    default: return i18n('Roadmap priority medium');
  }
}

export function newCardLabel(): string {
  return i18n('Base roadmap new card');
}

export function roadmapUntitledCardLabel(): string {
  return i18n('Unnamed Card');
}

export function statusColor(status?: RoadmapStatus): string {
  switch (status) {
    case 'done': return '#8fd6a3';
    case 'in_progress': return '#f0b65a';
    case 'blocked': return '#ef7b72';
    case 'planned':
    default: return '#78c7d2';
  }
}

export function baseNodeToFlowNode(node: BaseRoadmapNode, index = 0): Node {
  const data = node.data || {};
  const width = typeof node.width === 'number' && node.width > 0 ? node.width : undefined;
  return {
    id: node.id,
    type: 'roadmap',
    position: {
      x: typeof node.x === 'number' && Number.isFinite(node.x) ? node.x : 120 + (index % 4) * 280,
      y: typeof node.y === 'number' && Number.isFinite(node.y) ? node.y : 100 + Math.floor(index / 4) * 170,
    },
    ...(width ? { width, style: { width } } : {}),
    ...(typeof node.height === 'number' && node.height > 0 ? { height: node.height } : {}),
    data: {
      ...data,
      label: node.text || roadmapUntitledCardLabel(),
      originalNode: node,
    },
  };
}

export type RoadmapEdgeLineStyle = 'solid' | 'dashed';

export const ROADMAP_EDGE_DASH = '8 6';

export function roadmapEdgeDashStyle(lineStyle?: RoadmapEdgeLineStyle): Record<string, string> {
  return lineStyle === 'dashed' ? { strokeDasharray: ROADMAP_EDGE_DASH } : {};
}

export function roadmapEdgeLineStyleFromStyle(style?: Record<string, any>): RoadmapEdgeLineStyle {
  return style?.strokeDasharray ? 'dashed' : 'solid';
}

export function roadmapFlowEdgeType(lineStyle?: RoadmapEdgeLineStyle): 'straight' | 'default' {
  return lineStyle === 'dashed' ? 'default' : 'straight';
}

type RoadmapEdgeNodeRef = {
  id: string;
  x?: number;
  y?: number;
  data?: Record<string, unknown>;
};

function nodeLaneFromRef(node: RoadmapEdgeNodeRef): RoadmapLane {
  const lane = Number(node.data?.lane);
  if (lane >= 1 && lane <= 3) return lane as RoadmapLane;
  const x = typeof node.x === 'number' ? node.x : Number(node.data?.posX) || 0;
  return nearestLaneFromX(x + LANE_NODE_WIDTH / 2);
}

/** Restore React Flow handles when persisted edges omit sourceHandle/targetHandle. */
export function inferRoadmapEdgeHandles(
  edge: BaseRoadmapEdge,
  nodes?: RoadmapEdgeNodeRef[],
): { sourceHandle: string; targetHandle: string } {
  if (edge.sourceHandle && edge.targetHandle) {
    return { sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle };
  }

  const edgeData = edge.data as { sourceHandle?: string; targetHandle?: string } | undefined;
  if (edgeData?.sourceHandle && edgeData?.targetHandle) {
    return { sourceHandle: edgeData.sourceHandle, targetHandle: edgeData.targetHandle };
  }

  const lineStyle = edge.lineStyle || roadmapEdgeLineStyleFromStyle(edge.style);

  if (nodes?.length) {
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    if (source && target) {
      const sourceLane = nodeLaneFromRef(source);
      const targetLane = nodeLaneFromRef(target);
      if (sourceLane !== targetLane) {
        return { sourceHandle: 'right', targetHandle: 'left' };
      }
    }
  }

  if (lineStyle === 'dashed') {
    return { sourceHandle: 'right', targetHandle: 'left' };
  }
  return { sourceHandle: 'bottom', targetHandle: 'top' };
}

export function baseEdgeToFlowEdge(edge: BaseRoadmapEdge, nodes?: RoadmapEdgeNodeRef[]): Edge {
  const lineStyle = edge.lineStyle || roadmapEdgeLineStyleFromStyle(edge.style);
  const { sourceHandle, targetHandle } = inferRoadmapEdgeHandles(edge, nodes);
  return {
    id: edge.id || `edge_${edge.source}_${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourceHandle,
    targetHandle,
    label: edge.label,
    type: roadmapFlowEdgeType(lineStyle),
    data: { lineStyle, sourceHandle, targetHandle },
    animated: (edge as any).animated ?? false,
    style: {
      stroke: edge.color || '#2b78e4',
      strokeWidth: edge.width || 3,
      ...roadmapEdgeDashStyle(lineStyle),
      ...(edge.style || {}),
    },
  };
}

export function flowNodeToBaseNode(node: Node): BaseRoadmapNode {
  const original = (node.data?.originalNode || {}) as BaseRoadmapNode;
  const label = String(node.data?.label || original.text || roadmapUntitledCardLabel()).trim() || roadmapUntitledCardLabel();
  const {
    label: _label,
    originalNode: _originalNode,
    onPatch: _onPatch,
    onDelete: _onDelete,
    ...roadmapData
  } = node.data || {};
  return {
    ...original,
    id: node.id,
    text: label,
    x: node.position.x,
    y: node.position.y,
    ...(typeof node.width === 'number' && node.width > 0 ? { width: node.width } : {}),
    ...(typeof node.height === 'number' && node.height > 0 ? { height: node.height } : {}),
    parentId: undefined,
    children: undefined,
    expanded: original.expanded ?? true,
    data: roadmapData,
  };
}

export function flowEdgeToBaseEdge(edge: Edge): BaseRoadmapEdge {
  const style = (edge.style || {}) as Record<string, any>;
  const lineStyle = (edge.data?.lineStyle as RoadmapEdgeLineStyle | undefined)
    || roadmapEdgeLineStyleFromStyle(style);
  const sourceHandle = edge.sourceHandle || undefined;
  const targetHandle = edge.targetHandle || undefined;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle,
    targetHandle,
    label: typeof edge.label === 'string' ? edge.label : undefined,
    type: lineStyle === 'solid' ? 'straight' : 'bezier',
    color: style.stroke || '#2b78e4',
    width: Number(style.strokeWidth) || 3,
    lineStyle,
    data: {
      ...(edge.data || {}),
      lineStyle,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(targetHandle ? { targetHandle } : {}),
    },
    style: lineStyle === 'dashed' ? { strokeDasharray: style.strokeDasharray || ROADMAP_EDGE_DASH } : undefined,
  };
}

export function getRoadmapQueryContext(mount?: HTMLElement | null): RoadmapQueryContext {
  const ui = (window as any).UiContext || {};
  const roadmap = ui.roadmap || {};
  const params = new URLSearchParams(window.location.search);
  const pathMatch = window.location.pathname.match(/\/roadmap\/(\d+)(?:\/|$)/);
  return {
    domainId: String(roadmap.domainId || ui.domainId || 'system'),
    docId: String(mount?.getAttribute('data-doc-id') || params.get('docId') || pathMatch?.[1] || roadmap.docId || ''),
  };
}

export function getRoadmapDocFromContext(): RoadmapDoc | null {
  const ui = (window as any).UiContext || {};
  return (ui.roadmap || null) as RoadmapDoc | null;
}

export function roadmapApiPath(path: string, domainId?: string): string {
  return domainApiPath(`/roadmap${path.startsWith('/') ? path : `/${path}`}`, domainId);
}

export function normalizeRoadmapDoc(data: RoadmapDoc | null | undefined): RoadmapDoc {
  return {
    ...data,
    nodes: data?.nodes || [],
    edges: data?.edges || [],
    title: data?.title || i18n('Roadmap'),
    content: data?.content || '',
  };
}
