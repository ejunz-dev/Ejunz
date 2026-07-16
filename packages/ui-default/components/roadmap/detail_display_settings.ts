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
  /** Width of the card detail drawer (px). */
  cardDrawerWidth: number;
  /** Width of the tree sidebar drawer (px). */
  treeDrawerWidth: number;
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
  cardDrawerWidth: 420,
  treeDrawerWidth: 320,
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
    cardDrawerWidth: typeof raw.cardDrawerWidth === 'number' ? raw.cardDrawerWidth : 420,
    treeDrawerWidth: typeof raw.treeDrawerWidth === 'number' ? raw.treeDrawerWidth : 320,
  };
