import type { Node } from 'reactflow';
import { i18n } from 'vj/utils';
import type { EditorCard } from '../editor_workspace/card_problems_panel';
import { getRoadmapNodeKind } from './node_kinds';

export type RoadmapDetailFilter = {
  filterNode: string;
  filterCard: string;
  filterProblem: string;
};

export type RoadmapDetailSearchHit = {
  type: 'node' | 'problem';
  nodeId: string;
  label: string;
  sublabel: string;
  problemPid?: string;
};

const FILTER_KEYS = ['filterNode', 'filterCard', 'filterProblem'] as const;

export function emptyRoadmapDetailFilter(): RoadmapDetailFilter {
  return { filterNode: '', filterCard: '', filterProblem: '' };
}

export function readRoadmapDetailFilterFromLocation(): RoadmapDetailFilter {
  try {
    const sp = new URLSearchParams(window.location.search);
    return {
      filterNode: sp.get('filterNode') || '',
      filterCard: sp.get('filterCard') || '',
      filterProblem: sp.get('filterProblem') || '',
    };
  } catch {
    return emptyRoadmapDetailFilter();
  }
}

export function writeRoadmapDetailFilterToLocation(filters: RoadmapDetailFilter): void {
  const params = new URLSearchParams(window.location.search);
  FILTER_KEYS.forEach((key) => {
    const val = filters[key].trim();
    if (val) params.set(key, val);
    else params.delete(key);
  });
  const qs = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
}

export function isRoadmapDetailFilterActive(filters: RoadmapDetailFilter): boolean {
  return !!(filters.filterNode.trim() || filters.filterCard.trim() || filters.filterProblem.trim());
}

function nodeLabel(node: Node): string {
  return String(node.data?.label || i18n('Unnamed Node')).trim() || i18n('Unnamed Node');
}

function nodeContent(node: Node): string {
  return [
    node.data?.description,
    node.data?.nodeText,
  ].map((part) => String(part || '').trim()).filter(Boolean).join('\n');
}

function problemSearchText(problem: Record<string, unknown>): string {
  const parts = [
    problem.title,
    problem.stem,
    problem.faceA,
    problem.faceB,
    problem.hint,
    problem.analysis,
  ];
  if (Array.isArray(problem.options)) {
    parts.push(...problem.options.map((opt) => String(opt ?? '')));
  }
  if (Array.isArray(problem.answers)) {
    parts.push(...problem.answers.map((ans) => String(ans ?? '')));
  }
  return parts.map((part) => String(part || '').trim()).filter(Boolean).join(' ');
}

function cardProblems(nodeId: string, nodeCardsMap: Record<string, EditorCard[]>): EditorCard['problems'] {
  const card = (nodeCardsMap[nodeId] || [])[0];
  return card?.problems || [];
}

export function computeRoadmapDetailSearchHits(
  nodes: Node[],
  query: string,
  nodeCardsMap: Record<string, EditorCard[]>,
  limit = 50,
): RoadmapDetailSearchHit[] {
  const raw = query.trim().toLowerCase();
  if (!raw) return [];

  const hits: RoadmapDetailSearchHit[] = [];

  nodes.forEach((node) => {
    const label = nodeLabel(node);
    const kind = getRoadmapNodeKind(node.data?.roadmapNodeType);
    const content = nodeContent(node);
    if (label.toLowerCase().includes(raw) || content.toLowerCase().includes(raw)) {
      hits.push({
        type: 'node',
        nodeId: node.id,
        label,
        sublabel: `${roadmapNodeKindLabelShort(kind)} · ${label}`,
      });
    }

    cardProblems(node.id, nodeCardsMap).forEach((problem) => {
      const text = problemSearchText(problem as Record<string, unknown>);
      const title = String((problem as { title?: string }).title || '').trim();
      if (text.toLowerCase().includes(raw)) {
        hits.push({
          type: 'problem',
          nodeId: node.id,
          problemPid: problem.pid,
          label: title || text.slice(0, 48) || i18n('Roadmap detail search problem untitled'),
          sublabel: `${label} · ${i18n('Roadmap detail search kind problem')}`,
        });
      }
    });
  });

  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = hit.type === 'node'
      ? `node:${hit.nodeId}`
      : `problem:${hit.nodeId}:${hit.problemPid || hit.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function roadmapNodeKindLabelShort(kind: ReturnType<typeof getRoadmapNodeKind>): string {
  switch (kind) {
    case 'main': return i18n('Roadmap node type main');
    case 'sub': return i18n('Roadmap node type sub');
    case 'hook': return i18n('Roadmap node type hook');
    case 'text': return i18n('Roadmap node type text');
    default: return i18n('Roadmap node type sub');
  }
}

export function computeRoadmapDetailMatchedNodeIds(
  nodes: Node[],
  filters: RoadmapDetailFilter,
  nodeCardsMap: Record<string, EditorCard[]>,
): Set<string> | null {
  if (!isRoadmapDetailFilterActive(filters)) return null;

  const nodeQ = filters.filterNode.trim().toLowerCase();
  const cardQ = filters.filterCard.trim().toLowerCase();
  const problemQ = filters.filterProblem.trim().toLowerCase();
  const matched = new Set<string>();

  nodes.forEach((node) => {
    const label = nodeLabel(node).toLowerCase();
    const content = nodeContent(node).toLowerCase();
    if (nodeQ && !label.includes(nodeQ)) return;
    if (cardQ && !content.includes(cardQ)) return;
    if (problemQ) {
      const hasProblem = cardProblems(node.id, nodeCardsMap).some((problem) => (
        problemSearchText(problem as Record<string, unknown>).toLowerCase().includes(problemQ)
      ));
      if (!hasProblem) return;
    }
    matched.add(node.id);
  });

  return matched;
}
