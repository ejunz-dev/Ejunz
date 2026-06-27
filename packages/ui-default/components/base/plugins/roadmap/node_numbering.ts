import { i18n } from 'vj/utils';
import type { Edge, Node } from 'reactflow';
import { isMainNodeType, isSubNodeType } from './node_kinds';

export const ROADMAP_MAIN_NUMBER_PATTERN = /^\d+$/;
export const ROADMAP_SUB_NUMBER_PATTERN = /^\d+\.\d+$/;

export interface RoadmapNumberingNode {
  id: string;
  data?: Record<string, unknown>;
}

export interface RoadmapNumberingEdge {
  source: string;
  target: string;
}

function nodeLabel(node: RoadmapNumberingNode): string {
  return String(node.data?.label || node.id);
}

export function isValidRoadmapMainNumber(value: string): boolean {
  const trimmed = value.trim();
  if (!ROADMAP_MAIN_NUMBER_PATTERN.test(trimmed)) return false;
  const num = Number(trimmed);
  return Number.isInteger(num) && num >= 1;
}

export function isValidRoadmapSubNumber(value: string): boolean {
  const trimmed = value.trim();
  if (!ROADMAP_SUB_NUMBER_PATTERN.test(trimmed)) return false;
  const [prefix, suffix] = trimmed.split('.');
  return isValidRoadmapMainNumber(prefix) && isValidRoadmapMainNumber(suffix);
}

function parseMainNumber(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  if (!isValidRoadmapMainNumber(raw)) return null;
  return Number(raw);
}

function collectMainNodes(nodes: RoadmapNumberingNode[]): RoadmapNumberingNode[] {
  return nodes.filter((node) => isMainNodeType(node.data?.roadmapNodeType));
}

function collectSubNodes(nodes: RoadmapNumberingNode[]): RoadmapNumberingNode[] {
  return nodes.filter((node) => isSubNodeType(node.data?.roadmapNodeType));
}

function maxMainNumber(nodes: RoadmapNumberingNode[]): number {
  return collectMainNodes(nodes).reduce((max, node) => {
    const num = parseMainNumber(node.data?.nodeNumber);
    return num != null ? Math.max(max, num) : max;
  }, 0);
}

function buildAdjacency(edges: RoadmapNumberingEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  edges.forEach((edge) => link(edge.source, edge.target));
  return adj;
}

export function resolveMainNumberPrefix(
  nodes: RoadmapNumberingNode[],
  edges: RoadmapNumberingEdge[],
  anchorNodeId: string,
): string {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adj = buildAdjacency(edges);
  const visited = new Set<string>();
  const queue = [anchorNodeId];

  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodeById.get(id);
    if (!node) continue;
    if (isMainNodeType(node.data?.roadmapNodeType)) {
      const num = String(node.data?.nodeNumber || '').trim();
      if (isValidRoadmapMainNumber(num)) return num;
    }
    adj.get(id)?.forEach((peerId) => queue.push(peerId));
  }

  const fallback = maxMainNumber(nodes) + 1;
  return String(Math.max(1, fallback));
}

export function allocateDefaultMainNodeNumber(nodes: RoadmapNumberingNode[]): string {
  return String(maxMainNumber(nodes) + 1);
}

export function allocateDefaultSubNodeNumber(
  nodes: RoadmapNumberingNode[],
  edges: RoadmapNumberingEdge[],
  anchorNodeId: string,
): string {
  const mainPrefix = resolveMainNumberPrefix(nodes, edges, anchorNodeId);
  let maxSuffix = 0;
  collectSubNodes(nodes).forEach((node) => {
    const raw = String(node.data?.nodeNumber || '').trim();
    if (!isValidRoadmapSubNumber(raw)) return;
    const [prefix, suffix] = raw.split('.');
    if (prefix !== mainPrefix) return;
    maxSuffix = Math.max(maxSuffix, Number(suffix));
  });
  return `${mainPrefix}.${maxSuffix + 1}`;
}

export function computeRoadmapNodeNumbers(nodes: Node[], _edges: Edge[]): Map<string, string> {
  const result = new Map<string, string>();

  nodes.forEach((node) => {
    const type = node.data?.roadmapNodeType;
    const raw = String(node.data?.nodeNumber || '').trim();
    if (isMainNodeType(type) && isValidRoadmapMainNumber(raw)) {
      result.set(node.id, raw);
      return;
    }
    if (isSubNodeType(type) && isValidRoadmapSubNumber(raw)) {
      result.set(node.id, raw);
    }
  });

  return result;
}

function mainNumberSet(nodes: RoadmapNumberingNode[]): Set<string> {
  const set = new Set<string>();
  collectMainNodes(nodes).forEach((node) => {
    const raw = String(node.data?.nodeNumber || '').trim();
    if (isValidRoadmapMainNumber(raw)) set.add(raw);
  });
  return set;
}

export function validateRoadmapNodeNumbers(
  nodes: RoadmapNumberingNode[],
  _edges: RoadmapNumberingEdge[] = [],
): string[] {
  const errors: string[] = [];
  const mains = mainNumberSet(nodes);

  nodes.forEach((node) => {
    const raw = String(node.data?.nodeNumber || '').trim();
    const label = nodeLabel(node);

    if (isMainNodeType(node.data?.roadmapNodeType)) {
      if (!raw) {
        errors.push(i18n('Roadmap main node number missing').replace('{0}', label));
        return;
      }
      if (!isValidRoadmapMainNumber(raw)) {
        errors.push(i18n('Roadmap main node number invalid').replace('{0}', label));
      }
      return;
    }

    if (!isSubNodeType(node.data?.roadmapNodeType)) return;

    if (!raw) {
      errors.push(i18n('Roadmap sub node number missing').replace('{0}', label));
      return;
    }
    if (!isValidRoadmapSubNumber(raw)) {
      errors.push(i18n('Roadmap sub node number invalid').replace('{0}', label));
      return;
    }
    const prefix = raw.split('.')[0];
    if (!mains.has(prefix)) {
      errors.push(i18n('Roadmap sub node number prefix invalid').replace('{0}', label));
    }
  });

  return errors;
}

export function withDefaultRoadmapNodeNumber(
  nodes: RoadmapNumberingNode[],
  edges: RoadmapNumberingEdge[],
  kind: 'main' | 'sub',
  anchorNodeId?: string,
): string | undefined {
  if (kind === 'main') return allocateDefaultMainNodeNumber(nodes);
  if (kind === 'sub' && anchorNodeId) {
    return allocateDefaultSubNodeNumber(nodes, edges, anchorNodeId);
  }
  return undefined;
}
