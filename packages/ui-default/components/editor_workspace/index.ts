export { EditorBottomTerminal } from './EditorBottomTerminal';
export { EditorWorkspaceShell } from './EditorWorkspaceShell';
export {
  clampAiPanelHeight,
  clampLeftPanelWidth,
  clampRightPanelWidth,
  EDITOR_WORKSPACE_AI_MIN_H,
  EDITOR_WORKSPACE_LEFT_RAIL_PX,
  EDITOR_WORKSPACE_MAIN_MIN_H,
  EDITOR_WORKSPACE_RIGHT_RAIL_PX,
  readEditorWorkspaceLayoutPrefs,
  writeEditorWorkspaceLayoutPrefs,
} from './layout_prefs';
export type { EditorWorkspaceLayoutPrefs } from './layout_prefs';
export {
  buildAiTerminalStyles,
  buildEditorThemeStyles,
  readEditorTheme,
  useAiTerminalInputPromptParts,
  useAiTerminalStyles,
  useEditorTheme,
  useEditorThemeStyles,
  useRailIconButtonStyle,
} from './theme';
export { CardProblemsPanel, collectPendingRoadmapCardCreates, collectPendingRoadmapCardUpdates, applyRoadmapCardIdMap } from './card_problems_panel';
export { EditableProblem, makeBlankSingleProblem, type LearnProblemNotesDraftBatch } from './editable_problem';
export type { AiTerminalStyles, EditorTheme, EditorThemeStyles } from './theme';
