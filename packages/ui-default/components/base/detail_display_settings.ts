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
  return {
    showProblemCount: Boolean((raw as Record<string, unknown>).showProblemCount),
    showNodeNumber: Boolean((raw as Record<string, unknown>).showNodeNumber),
    showNodeCardTimestamps: Boolean((raw as Record<string, unknown>).showNodeCardTimestamps),
    showAiTutor: (raw as Record<string, unknown>).showAiTutor !== false,
    showExpandSaveIndicator: (raw as Record<string, unknown>).showExpandSaveIndicator !== false,
  };
}

export function getCardProblemCount(card: { problems?: unknown[] }): number {
  return (card.problems || []).length;
}
