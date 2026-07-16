export type BaseDetailDisplaySettings = {
  showProblemCount: boolean;
  showNodeNumber: boolean;
  showNodeCardTimestamps: boolean;
  showAiTutor: boolean;
  showExpandSaveIndicator: boolean;
  showToolbar: boolean;
  indicatorX: number;
  indicatorY: number;
  toolbarOpen: boolean;
  toolbarX: number;
  toolbarY: number;
  cardDrawerWidth: number;
  treeDrawerWidth: number;
};

export const defaultBaseDetailDisplaySettings = (): BaseDetailDisplaySettings => ({
  showProblemCount: false,
  showNodeNumber: false,
  showNodeCardTimestamps: false,
  showAiTutor: true,
  showExpandSaveIndicator: true,
  showToolbar: true,
  indicatorX: 320,
  indicatorY: 72,
  toolbarOpen: false,
  toolbarX: 320,
  toolbarY: 108,
  cardDrawerWidth: 420,
  treeDrawerWidth: 320,
});

export function baseDetailDisplaySettingsEqual(
  a: BaseDetailDisplaySettings,
  b: BaseDetailDisplaySettings,
): boolean {
  return a.showProblemCount === b.showProblemCount
    && a.showNodeNumber === b.showNodeNumber
    && a.showNodeCardTimestamps === b.showNodeCardTimestamps
    && a.showAiTutor === b.showAiTutor
    && a.showExpandSaveIndicator === b.showExpandSaveIndicator
    && a.showToolbar === b.showToolbar
    && a.indicatorX === b.indicatorX
    && a.indicatorY === b.indicatorY
    && a.toolbarOpen === b.toolbarOpen
    && a.toolbarX === b.toolbarX
    && a.toolbarY === b.toolbarY
    && a.cardDrawerWidth === b.cardDrawerWidth
    && a.treeDrawerWidth === b.treeDrawerWidth;
}

export function readBaseDetailDisplaySettings(): BaseDetailDisplaySettings {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.baseDetailUiPrefs) || null;
  if (!raw || typeof raw !== 'object') return defaultBaseDetailDisplaySettings();
  const r = raw as Record<string, unknown>;
  return {
    showProblemCount: Boolean(r.showProblemCount),
    showNodeNumber: Boolean(r.showNodeNumber),
    showNodeCardTimestamps: Boolean(r.showNodeCardTimestamps),
    showAiTutor: r.showAiTutor !== false,
    showExpandSaveIndicator: r.showExpandSaveIndicator !== false,
    showToolbar: r.showToolbar !== false,
    indicatorX: typeof r.indicatorX === 'number' ? r.indicatorX : 320,
    indicatorY: typeof r.indicatorY === 'number' ? r.indicatorY : 72,
    toolbarOpen: r.toolbarOpen === true,
    toolbarX: typeof r.toolbarX === 'number' ? r.toolbarX : 320,
    toolbarY: typeof r.toolbarY === 'number' ? r.toolbarY : 108,
    cardDrawerWidth: typeof r.cardDrawerWidth === 'number' ? r.cardDrawerWidth : 420,
    treeDrawerWidth: typeof r.treeDrawerWidth === 'number' ? r.treeDrawerWidth : 320,
  };
}

export function getCardProblemCount(card: { problems?: unknown[] }): number {
  return (card.problems || []).length;
}

export function buildRoadmapNodeProblemCountMap(
  nodes: Array<{ id: string; data?: { roadmapNodeType?: string } }>,
  nodeCardsMap: Record<string, { problems?: unknown[] }[]>,
): Map<string, number> {
  const map = new Map<string, number>();
  nodes.forEach((node) => {
    const cards = nodeCardsMap[node.id] || [];
    const count = cards.reduce(
      (sum, card) => sum + (card.problems || []).length,
      0,
    );
    map.set(node.id, count);
  });
  return map;
}
