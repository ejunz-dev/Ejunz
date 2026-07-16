/**
 * @deprecated Roadmap module is deprecated. Import from 'vj/components/base/detail_display_settings' instead.
 */
export type { BaseDetailDisplaySettings as RoadmapDetailDisplaySettings } from 'vj/components/base/detail_display_settings';
export {
  defaultBaseDetailDisplaySettings as defaultRoadmapDetailDisplaySettings,
  baseDetailDisplaySettingsEqual as roadmapDetailDisplaySettingsEqual,
  readBaseDetailDisplaySettings as readRoadmapDetailDisplaySettings,
  readBaseDetailDisplaySettings as readRoadmapEditorDisplaySettings,
  buildRoadmapNodeProblemCountMap,
} from 'vj/components/base/detail_display_settings';

export function editorDisplaySettingsFromDoc(
  doc?: { editorUi?: Record<string, unknown> } | null,
): Record<string, unknown> {
  return (doc?.editorUi) || {};
}
