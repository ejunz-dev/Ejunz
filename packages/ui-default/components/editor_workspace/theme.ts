import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';

export type EditorTheme = 'light' | 'dark';

export function readEditorTheme(): EditorTheme {
  try {
    if ((window as any).Ejunz?.utils?.getTheme) {
      return (window as any).Ejunz.utils.getTheme();
    }
    if ((window as any).UserContext?.theme) {
      return (window as any).UserContext.theme === 'dark' ? 'dark' : 'light';
    }
  } catch {
    /* ignore */
  }
  return 'light';
}

export function useEditorTheme(): EditorTheme {
  const [theme, setTheme] = useState<EditorTheme>(() => readEditorTheme());

  useEffect(() => {
    const sync = () => setTheme(readEditorTheme());
    window.addEventListener('themechange', sync);
    return () => window.removeEventListener('themechange', sync);
  }, []);

  return theme;
}

export type EditorThemeStyles = {
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgSelected: string;
  bgDragOver: string;
  bgDragged: string;
  bgButton: string;
  bgButtonActive: string;
  bgButtonHover: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textOnPrimary: string;
  borderPrimary: string;
  borderSecondary: string;
  borderFocus: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
};

export function buildEditorThemeStyles(theme: EditorTheme): EditorThemeStyles {
  const isDark = theme === 'dark';
  return {
    bgPrimary: isDark ? '#121212' : '#fff',
    bgSecondary: isDark ? '#323334' : '#f6f8fa',
    bgTertiary: isDark ? '#424242' : '#fafbfc',
    bgHover: isDark ? '#424242' : '#f3f4f6',
    bgSelected: isDark ? '#0366d6' : '#0366d6',
    bgDragOver: isDark ? '#1e3a5f' : '#e3f2fd',
    bgDragged: isDark ? '#2a2a2a' : '#f0f0f0',
    bgButton: isDark ? '#323334' : '#fff',
    bgButtonActive: isDark ? '#0366d6' : '#0366d6',
    bgButtonHover: isDark ? '#424242' : '#f3f4f6',
    textPrimary: isDark ? '#eee' : '#24292e',
    textSecondary: isDark ? '#bdbdbd' : '#586069',
    textTertiary: isDark ? '#999' : '#6a737d',
    textOnPrimary: isDark ? '#fff' : '#fff',
    borderPrimary: isDark ? '#424242' : '#e1e4e8',
    borderSecondary: isDark ? '#555' : '#d1d5da',
    borderFocus: isDark ? '#0366d6' : '#0366d6',
    accent: isDark ? '#55b6e2' : '#0366d6',
    success: isDark ? '#4caf50' : '#28a745',
    warning: isDark ? '#ff9800' : '#ff9800',
    error: isDark ? '#f44336' : '#f44336',
  };
}

export type AiTerminalStyles = {
  mono: string;
  shellBg: string;
  tabBarBg: string;
  tabBorder: string;
  tabActiveBg: string;
  tabActiveTop: string;
  text: string;
  textDim: string;
  promptUser: string;
  promptShellUser: string;
  promptShellHost: string;
  promptShellSep: string;
  promptShellPath: string;
  promptAi: string;
  operationBg: string;
  operationBorder: string;
  operationText: string;
  resizeDefault: string;
  resizeActive: string;
};

export function buildAiTerminalStyles(theme: EditorTheme): AiTerminalStyles {
  const isDark = theme === 'dark';
  const mono = 'ui-monospace, Monaco, Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace';
  if (isDark) {
    return {
      mono,
      shellBg: '#1e1e1e',
      tabBarBg: '#252526',
      tabBorder: '#3c3c3c',
      tabActiveBg: '#1e1e1e',
      tabActiveTop: '#007acc',
      text: '#cccccc',
      textDim: '#858585',
      promptUser: '#6a9955',
      promptShellUser: '#E91E63',
      promptShellHost: '#4CAF50',
      promptShellSep: '#ffffff',
      promptShellPath: '#9CDCFE',
      promptAi: '#4ec9b0',
      operationBg: '#2d2d30',
      operationBorder: '#3c3c3c',
      operationText: '#4fc1ff',
      resizeDefault: '#3c3c3c',
      resizeActive: '#007acc',
    };
  }
  return {
    mono,
    shellBg: '#ffffff',
    tabBarBg: '#f3f3f3',
    tabBorder: '#e8e8e8',
    tabActiveBg: '#ffffff',
    tabActiveTop: '#007acc',
    text: '#333333',
    textDim: '#767676',
    promptUser: '#098658',
    promptShellUser: '#C2185B',
    promptShellHost: '#2E7D32',
    promptShellSep: '#24292e',
    promptShellPath: '#0277bd',
    promptAi: '#0451a5',
    operationBg: '#f0f6fc',
    operationBorder: '#c8c8c8',
    operationText: '#0071bc',
    resizeDefault: '#cecece',
    resizeActive: '#007acc',
  };
}

export function useEditorThemeStyles(theme: EditorTheme): EditorThemeStyles {
  return useMemo(() => buildEditorThemeStyles(theme), [theme]);
}

export function useAiTerminalStyles(theme: EditorTheme): AiTerminalStyles {
  return useMemo(() => buildAiTerminalStyles(theme), [theme]);
}

export function useAiTerminalInputPromptParts() {
  return useMemo(() => {
    const uname = String((window as any).UserContext?.uname || '').trim() || 'user';
    const dom = String((window as any).UiContext?.domainId || '').trim() || 'system';
    return { uname, domain: dom, full: `${uname}@${dom}:` };
  }, []);
}

export function useRailIconButtonStyle(
  themeStyles: EditorThemeStyles,
  active: boolean,
): CSSProperties {
  return useMemo(() => ({
    width: '34px',
    height: '34px',
    border: `1px solid ${themeStyles.borderSecondary}`,
    borderRadius: '3px',
    backgroundColor: active ? themeStyles.bgButtonActive : themeStyles.bgButton,
    color: active ? themeStyles.textOnPrimary : themeStyles.textSecondary,
    cursor: 'pointer',
    flexShrink: 0,
    fontSize: '11px',
    fontWeight: 600,
    padding: 0,
    lineHeight: 1,
  }), [active, themeStyles]);
}
