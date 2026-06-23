import type { Connection } from 'reactflow';
import Notification from 'vj/components/notification';
import { i18n } from 'vj/utils';
import type { BaseRoadmapNode, RoadmapEdgeLineStyle, RoadmapNodeType } from './shared';

export type RoadmapNodeKind = 'main' | 'sub' | 'hook' | 'text';

export const ROADMAP_NODE_KINDS: RoadmapNodeKind[] = ['main', 'sub', 'hook', 'text'];

const LEGACY_KIND_MAP: Record<string, RoadmapNodeKind> = {
  root: 'main',
  milestone: 'main',
  task: 'sub',
  decision: 'sub',
  release: 'sub',
};

export function getRoadmapNodeKind(type?: RoadmapNodeType | string): RoadmapNodeKind {
  const raw = String(type || '').trim();
  if (ROADMAP_NODE_KINDS.includes(raw as RoadmapNodeKind)) return raw as RoadmapNodeKind;
  return LEGACY_KIND_MAP[raw] || 'sub';
}

export function roadmapNodeKindLabel(kind: RoadmapNodeKind): string {
  switch (kind) {
    case 'main': return i18n('Roadmap node type main');
    case 'sub': return i18n('Roadmap node type sub');
    case 'hook': return i18n('Roadmap node type hook');
    case 'text': return i18n('Roadmap node type text');
    default: return i18n('Roadmap node type sub');
  }
}

export function canConnectEdgeToTarget(
  targetType: RoadmapNodeType | string | undefined,
  lineStyle: RoadmapEdgeLineStyle,
  sourceType?: RoadmapNodeType | string | undefined,
): boolean {
  const targetKind = getRoadmapNodeKind(targetType);
  const sourceKind = sourceType ? getRoadmapNodeKind(sourceType) : null;
  if (targetKind === 'main' && lineStyle === 'dashed') return false;
  if (targetKind === 'sub' && lineStyle === 'solid') {
    // Main → sub hierarchy uses solid edges; other links to sub use dashed.
    return sourceKind === 'main';
  }
  return true;
}

/** Default line style for a new connection between two node kinds. */
export function inferConnectionLineStyle(
  sourceType?: RoadmapNodeType | string,
  targetType?: RoadmapNodeType | string,
): RoadmapEdgeLineStyle {
  const sourceKind = getRoadmapNodeKind(sourceType);
  const targetKind = getRoadmapNodeKind(targetType);
  if (targetKind === 'sub' && sourceKind !== 'main') return 'dashed';
  return 'solid';
}

export function connectionLineStyle(
  connection: Connection,
  edges: { id: string; style?: Record<string, unknown>; data?: { lineStyle?: RoadmapEdgeLineStyle } }[],
): RoadmapEdgeLineStyle {
  if (!connection.source || !connection.target) return 'solid';
  const edgeId = `edge_${connection.source}_${connection.target}`;
  const existing = edges.find((edge) => edge.id === edgeId);
  if (existing?.data?.lineStyle) return existing.data.lineStyle;
  return 'solid';
}

export function validateRoadmapConnection(
  targetType: RoadmapNodeType | string | undefined,
  lineStyle: RoadmapEdgeLineStyle,
  notify = true,
  sourceType?: RoadmapNodeType | string | undefined,
): boolean {
  if (canConnectEdgeToTarget(targetType, lineStyle, sourceType)) return true;
  if (notify) {
    const kind = getRoadmapNodeKind(targetType);
    if (kind === 'main' && lineStyle === 'dashed') {
      Notification.error(i18n('Roadmap main node dashed target forbidden'));
    } else if (kind === 'sub' && lineStyle === 'solid') {
      Notification.error(i18n('Roadmap sub node solid target forbidden'));
    } else {
      Notification.error(i18n('Roadmap connection not allowed'));
    }
  }
  return false;
}

export function defaultNodeDataForKind(kind: RoadmapNodeKind): Record<string, unknown> {
  return {
    roadmapNodeType: kind,
    status: 'planned',
    priority: 'medium',
    description: '',
    nodeText: kind === 'text' ? '' : undefined,
    hookRoadmapDocId: kind === 'hook' ? '' : undefined,
    hookRoadmapBranch: kind === 'hook' ? 'main' : undefined,
    hookRoadmapTitle: kind === 'hook' ? '' : undefined,
  };
}

export function isHookNodeType(type?: RoadmapNodeType | string): boolean {
  return getRoadmapNodeKind(type) === 'hook';
}

export function isTextNodeType(type?: RoadmapNodeType | string): boolean {
  return getRoadmapNodeKind(type) === 'text';
}

export function isSubNodeType(type?: RoadmapNodeType | string): boolean {
  return getRoadmapNodeKind(type) === 'sub';
}

export function nodeKindBackground(kind: RoadmapNodeKind): string {
  switch (kind) {
    case 'main': return '#ffeb3b';
    case 'sub': return '#fff9c4';
    case 'hook': return '#6eb3ff';
    case 'text': return '#ffffff';
    default: return '#fff9c4';
  }
}

export function nodeKindBorder(kind: RoadmapNodeKind): string {
  switch (kind) {
    case 'main': return '#e6c200';
    case 'sub': return '#e8d44a';
    case 'hook': return '#2b78e4';
    case 'text': return '#d8d8d8';
    default: return '#e8d44a';
  }
}

export function readNodeWidth(node: BaseRoadmapNode): number | undefined {
  if (typeof node.width === 'number' && node.width > 0) return node.width;
  return undefined;
}
