import {
  defaultRoadmapDetailDisplaySettings,
  roadmapDetailDisplaySettingsEqual,
  type RoadmapDetailDisplaySettings,
} from 'vj/components/roadmap/detail_display_settings';

export type BaseDetailDisplaySettings = RoadmapDetailDisplaySettings;

export const defaultBaseDetailDisplaySettings = defaultRoadmapDetailDisplaySettings;
export const baseDetailDisplaySettingsEqual = roadmapDetailDisplaySettingsEqual;

export function readBaseDetailDisplaySettings(): BaseDetailDisplaySettings {
  const raw =
    (typeof window !== 'undefined' && (window as any).UiContext?.baseDetailUiPrefs) || null;
  if (!raw || typeof raw !== 'object') {
    return defaultBaseDetailDisplaySettings();
  }
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
    indicatorY: typeof r.indicatorY === 'number' ? r.indicatorY : 72,
    toolbarOpen: r.toolbarOpen === true,
    toolbarX: typeof r.toolbarX === 'number' ? r.toolbarX : 320,
    toolbarY: typeof r.toolbarY === 'number' ? r.toolbarY : 108,
  };
}

export function getCardProblemCount(card: { problems?: unknown[] }): number {
  return (card.problems || []).length;
}
