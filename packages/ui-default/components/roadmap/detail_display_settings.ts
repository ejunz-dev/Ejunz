import { supportsRoadmapPracticeProblems } from './node_kinds';

export type RoadmapDetailDisplaySettings = {
  showProblemCount: boolean;
  showNodeNumber: boolean;
  showNodeCardTimestamps: boolean;
  /** Show the floating AI tutor bar in detail view. */
  showAiTutor: boolean;
  /** Show the floating expand-state save indicator in detail view. */
  showExpandSaveIndicator: boolean;
  /** Show the floating toolbar in detail view. */
  showToolbar: boolean;
  /** X position of the status indicator (px from right). */
  indicatorX: number;
  /** Y position of the status indicator (px from top). */
  indicatorY: number;
  /** Whether the floating toolbar is open. */
  toolbarOpen: boolean;
  /** X position of the floating toolbar (px from right). */
  toolbarX: number;
  /** Y position of the floating toolbar (px from top). */
  toolbarY: number;
};

export const defaultRoadmapDetailDisplaySettings = (): RoadmapDetailDisplaySettings => ({
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
});

function readCommonDisplaySettings(raw: Record<string, unknown>): RoadmapDetailDisplaySettings {
  return {
    showProblemCount: Boolean(raw.showProblemCount),
    showNodeNumber: Boolean(raw.showNodeNumber),
    showNodeCardTimestamps: Boolean(raw.showNodeCardTimestamps),
    showAiTutor: raw.showAiTutor !== false,
    showExpandSaveIndicator: raw.showExpandSaveIndicator !== false,
    showToolbar: raw.showToolbar !== false,
    indicatorX: typeof raw.indicatorX === 'number' ? raw.indicatorX : 320,
    indicatorY: typeof raw.indicatorY === 'number' ? raw.indicatorY : 72,
    toolbarOpen: raw.toolbarOpen === true,
    toolbarX: typeof raw.toolbarX === 'number' ? raw.toolbarX : 320,
    toolbarY: typeof raw.toolbarY === 'number' ? raw.toolbarY : 108,
  };
}

export function readRoadmapDetailDisplaySettings(): RoadmapDetailDisplaySettings {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.roadmapDetailUiPrefs) || null;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return readCommonDisplaySettings(raw as Record<string, unknown>);
}

/** Editor canvas display prefs persisted on the roadmap document (per branch). */
export function readRoadmapEditorDisplaySettings(): RoadmapDetailDisplaySettings {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.roadmapEditorUiPrefs) || null;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return readCommonDisplaySettings(raw as Record<string, unknown>);
}

export function editorDisplaySettingsFromDoc(
  doc?: { editorUi?: Record<string, unknown> } | null,
): RoadmapDetailDisplaySettings {
  const raw = doc?.editorUi;
  if (!raw || typeof raw !== 'object') return defaultRoadmapDetailDisplaySettings();
  return readCommonDisplaySettings(raw as Record<string, unknown>);
}

export function roadmapDetailDisplaySettingsEqual(
  a: RoadmapDetailDisplaySettings,
  b: RoadmapDetailDisplaySettings,
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
    && a.toolbarY === b.toolbarY;
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
