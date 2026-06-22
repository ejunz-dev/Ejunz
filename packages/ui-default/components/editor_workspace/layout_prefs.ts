export type EditorWorkspaceLayoutPrefs = {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  aiBottomOpen: boolean;
  leftPanelWidth: number;
  rightPanelWidth: number;
  aiPanelHeight: number;
};

const LEFT_MIN = 180;
const LEFT_MAX = 640;
const RIGHT_MIN = 200;
const RIGHT_MAX = 800;
const AI_MIN = 120;
const AI_MAX = 640;

export const EDITOR_WORKSPACE_RIGHT_RAIL_PX = 44;
export const EDITOR_WORKSPACE_LEFT_RAIL_PX = 44;
export const EDITOR_WORKSPACE_AI_MIN_H = AI_MIN;
export const EDITOR_WORKSPACE_MAIN_MIN_H = 160;

export function clampLeftPanelWidth(width: number): number {
  return Math.round(Math.max(LEFT_MIN, Math.min(LEFT_MAX, width)));
}

export function clampRightPanelWidth(width: number): number {
  return Math.round(Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, width)));
}

export function clampAiPanelHeight(height: number): number {
  return Math.round(Math.max(AI_MIN, Math.min(AI_MAX, height)));
}

export function readEditorWorkspaceLayoutPrefs(
  storageKey: string,
  defaults: Partial<EditorWorkspaceLayoutPrefs> = {},
): EditorWorkspaceLayoutPrefs {
  const fallback: EditorWorkspaceLayoutPrefs = {
    leftPanelOpen: true,
    rightPanelOpen: true,
    aiBottomOpen: defaults.aiBottomOpen ?? true,
    leftPanelWidth: 280,
    rightPanelWidth: 320,
    aiPanelHeight: 280,
    ...defaults,
  };

  if (typeof window === 'undefined') return fallback;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      leftPanelOpen: typeof parsed.leftPanelOpen === 'boolean' ? parsed.leftPanelOpen : fallback.leftPanelOpen,
      rightPanelOpen: typeof parsed.rightPanelOpen === 'boolean' ? parsed.rightPanelOpen : fallback.rightPanelOpen,
      aiBottomOpen: typeof parsed.aiBottomOpen === 'boolean' ? parsed.aiBottomOpen : fallback.aiBottomOpen,
      leftPanelWidth: clampLeftPanelWidth(Number(parsed.leftPanelWidth) || fallback.leftPanelWidth),
      rightPanelWidth: clampRightPanelWidth(Number(parsed.rightPanelWidth) || fallback.rightPanelWidth),
      aiPanelHeight: clampAiPanelHeight(Number(parsed.aiPanelHeight) || fallback.aiPanelHeight),
    };
  } catch {
    return fallback;
  }
}

export function writeEditorWorkspaceLayoutPrefs(
  storageKey: string,
  prefs: EditorWorkspaceLayoutPrefs,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
