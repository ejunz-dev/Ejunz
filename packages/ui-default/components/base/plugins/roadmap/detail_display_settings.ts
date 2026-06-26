import type { BaseNode } from 'vj/components/base/types';
import { supportsRoadmapPracticeProblems } from './node_kinds';

export type RoadmapDetailDisplaySettings = {
  showProblemCount: boolean;
  showNodeNumber: boolean;
};

export const defaultRoadmapDetailDisplaySettings = (): RoadmapDetailDisplaySettings => ({
  showProblemCount: false,
  showNodeNumber: false,
});

export function displaySettingsFromRoadmapNode(
  node?: BaseNode | { data?: Record<string, unknown> } | null,
): RoadmapDetailDisplaySettings {
  const raw = (node?.data as Record<string, unknown> | undefined)?.editorUi;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return {
    showProblemCount: Boolean((raw as Record<string, unknown>).showProblemCount),
    showNodeNumber: Boolean((raw as Record<string, unknown>).showNodeNumber),
  };
}

export function roadmapDetailDisplaySettingsEqual(
  a: RoadmapDetailDisplaySettings,
  b: RoadmapDetailDisplaySettings,
): boolean {
  return a.showProblemCount === b.showProblemCount && a.showNodeNumber === b.showNodeNumber;
}

export function buildRoadmapNodeProblemCountMap(
  nodes: Array<{ id: string; data?: { roadmapNodeType?: string } }>,
  nodeCardsMap: Record<string, { problems?: unknown[] }[]>,
): Map<string, number> {
  const map = new Map<string, number>();
  nodes.forEach((node) => {
    if (!supportsRoadmapPracticeProblems(node.data?.roadmapNodeType)) {
      map.set(node.id, 0);
      return;
    }
    const cards = nodeCardsMap[node.id] || [];
    const count = cards.reduce(
      (sum, card) => sum + (card.problems || []).length,
      0,
    );
    map.set(node.id, count);
  });
  return map;
}
