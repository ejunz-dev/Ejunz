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
  nodeIds: string[],
  nodeCardsMap: Record<string, { problems?: unknown[] }[]>,
): Map<string, number> {
  const map = new Map<string, number>();
  nodeIds.forEach((nodeId) => {
    const cards = nodeCardsMap[nodeId] || [];
    const count = cards.reduce(
      (sum, card) => sum + (card.problems || []).length,
      0,
    );
    map.set(nodeId, count);
  });
  return map;
}
