import { supportsRoadmapPracticeProblems } from './node_kinds';

export type RoadmapDetailDisplaySettings = {
  showProblemCount: boolean;
  showNodeNumber: boolean;
  showNodeCardTimestamps: boolean;
  /** Show the floating AI tutor bar in detail view. */
  showAiTutor: boolean;
  /** Show the floating expand-state save indicator in detail view. */
  showExpandSaveIndicator: boolean;
};

export const defaultRoadmapDetailDisplaySettings = (): RoadmapDetailDisplaySettings => ({
  showProblemCount: false,
  showNodeNumber: false,
  showNodeCardTimestamps: false,
  showAiTutor: true,
  showExpandSaveIndicator: true,
});

export function readRoadmapDetailDisplaySettings(): RoadmapDetailDisplaySettings {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.roadmapDetailUiPrefs) || null;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return {
    showProblemCount: Boolean((raw as Record<string, unknown>).showProblemCount),
    showNodeNumber: Boolean((raw as Record<string, unknown>).showNodeNumber),
    showNodeCardTimestamps: Boolean((raw as Record<string, unknown>).showNodeCardTimestamps),
    showAiTutor: (raw as Record<string, unknown>).showAiTutor !== false,
    showExpandSaveIndicator: (raw as Record<string, unknown>).showExpandSaveIndicator !== false,
  };
}

/** Editor canvas display prefs persisted on the roadmap document (per branch). */
export function readRoadmapEditorDisplaySettings(): RoadmapDetailDisplaySettings {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.roadmapEditorUiPrefs) || null;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return {
    showProblemCount: Boolean((raw as Record<string, unknown>).showProblemCount),
    showNodeNumber: Boolean((raw as Record<string, unknown>).showNodeNumber),
    showNodeCardTimestamps: Boolean((raw as Record<string, unknown>).showNodeCardTimestamps),
    showAiTutor: (raw as Record<string, unknown>).showAiTutor !== false,
    showExpandSaveIndicator: (raw as Record<string, unknown>).showExpandSaveIndicator !== false,
  };
}

export function editorDisplaySettingsFromDoc(
  doc?: { editorUi?: Record<string, unknown> } | null,
): RoadmapDetailDisplaySettings {
  const raw = doc?.editorUi;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return {
    showProblemCount: Boolean(raw.showProblemCount),
    showNodeNumber: Boolean(raw.showNodeNumber),
    showNodeCardTimestamps: Boolean(raw.showNodeCardTimestamps),
    showAiTutor: raw.showAiTutor !== false,
    showExpandSaveIndicator: raw.showExpandSaveIndicator !== false,
  };
}

export function roadmapDetailDisplaySettingsEqual(
  a: RoadmapDetailDisplaySettings,
  b: RoadmapDetailDisplaySettings,
): boolean {
  return a.showProblemCount === b.showProblemCount
    && a.showNodeNumber === b.showNodeNumber
    && a.showNodeCardTimestamps === b.showNodeCardTimestamps
    && a.showAiTutor === b.showAiTutor
    && a.showExpandSaveIndicator === b.showExpandSaveIndicator;
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
