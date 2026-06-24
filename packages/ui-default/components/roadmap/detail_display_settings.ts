import { supportsRoadmapPracticeProblems } from './node_kinds';

export type RoadmapDetailDisplaySettings = {
  showProblemCount: boolean;
};

export const defaultRoadmapDetailDisplaySettings = (): RoadmapDetailDisplaySettings => ({
  showProblemCount: false,
});

export function readRoadmapDetailDisplaySettings(): RoadmapDetailDisplaySettings {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.roadmapDetailUiPrefs) || null;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return {
    showProblemCount: Boolean((raw as Record<string, unknown>).showProblemCount),
  };
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
