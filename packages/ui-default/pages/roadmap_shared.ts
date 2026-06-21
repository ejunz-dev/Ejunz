import type { Edge, Node } from 'reactflow';
import { MarkerType } from 'reactflow';
import { domainApiPath } from 'vj/utils';

export type RoadmapStatus = 'planned' | 'in_progress' | 'done' | 'blocked';
export type RoadmapNodeType = 'root' | 'milestone' | 'task' | 'decision' | 'release';
export type RoadmapPriority = 'low' | 'medium' | 'high';

export interface RoadmapNodeData {
  roadmapNodeType?: RoadmapNodeType;
  status?: RoadmapStatus;
  owner?: string;
  dueDate?: string;
  description?: string;
  priority?: RoadmapPriority;
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
  label?: string;
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
  currentBranch?: string;
  nodes?: BaseRoadmapNode[];
  edges?: BaseRoadmapEdge[];
  layout?: Record<string, any>;
  viewport?: { x: number; y: number; zoom: number };
}

export interface RoadmapQueryContext {
  domainId: string;
  docId: string;
}

export function statusLabel(status?: RoadmapStatus): string {
  switch (status) {
    case 'in_progress': return '进行中';
    case 'done': return '已完成';
    case 'blocked': return '阻塞';
    case 'planned':
    default: return '计划中';
  }
}

export function nodeTypeLabel(type?: RoadmapNodeType): string {
  switch (type) {
    case 'root': return '总览';
    case 'milestone': return '里程碑';
    case 'decision': return '决策';
    case 'release': return '发布';
    case 'task':
    default: return '任务';
  }
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
  return {
    id: node.id,
    type: 'roadmap',
    position: {
      x: typeof node.x === 'number' && Number.isFinite(node.x) ? node.x : 120 + (index % 4) * 280,
      y: typeof node.y === 'number' && Number.isFinite(node.y) ? node.y : 100 + Math.floor(index / 4) * 170,
    },
    data: {
      ...data,
      label: node.text || '未命名节点',
      originalNode: node,
    },
  };
}

export function baseEdgeToFlowEdge(edge: BaseRoadmapEdge): Edge {
  return {
    id: edge.id || `edge_${edge.source}_${edge.target}`,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: 'smoothstep',
    animated: (edge as any).animated ?? false,
    style: {
      stroke: edge.color || '#d8b46a',
      strokeWidth: edge.width || 2,
      ...(edge.style || {}),
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edge.color || '#d8b46a',
    },
  };
}

export function flowNodeToBaseNode(node: Node): BaseRoadmapNode {
  const original = (node.data?.originalNode || {}) as BaseRoadmapNode;
  const label = String(node.data?.label || original.text || '未命名节点').trim() || '未命名节点';
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
    expanded: original.expanded ?? true,
    data: roadmapData,
  };
}

export function flowEdgeToBaseEdge(edge: Edge): BaseRoadmapEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: typeof edge.label === 'string' ? edge.label : undefined,
    type: 'bezier',
    color: (edge.style as any)?.stroke || '#d8b46a',
    width: Number((edge.style as any)?.strokeWidth) || 2,
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
    title: data?.title || 'Roadmap',
  };
}
