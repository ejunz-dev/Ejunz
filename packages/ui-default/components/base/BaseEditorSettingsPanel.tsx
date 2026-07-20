import React, { useCallback, useMemo, useState } from 'react';
import { i18n, request, domainApiPath } from 'vj/utils';

interface ThemeStyles {
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  bgPrimary: string;
  bgSecondary: string;
  bgButton: string;
  bgButtonActive: string;
  borderPrimary: string;
  borderSecondary: string;
  accent: string;
  bgHover: string;
}

export function BaseEditorSettingsPanel({
  themeStyles, docId, base, basePath, getBaseUrl, saveHandlerRef,
  explorerMode, setExplorerMode,
  editorRightPanelTab, setEditorRightPanelTab,
  rightPanelOpen, setRightPanelOpen,
  aiBottomOpen, setAiBottomOpen,
  aiPanelHeight, setAiPanelHeight,
  explorerPanelWidth, setExplorerPanelWidth,
  problemsPanelWidth, setProblemsPanelWidth,
  wsIndicatorOpen, setWsIndicatorOpen,
  effectiveDisplaySettings, editorDisplaySettings, setPendingEditorDisplaySettings,
}: {
  themeStyles: ThemeStyles;
  docId?: string;
  base: any;
  basePath: string;
  getBaseUrl: (path: string) => string;
  saveHandlerRef: React.MutableRefObject<() => void>;
  explorerMode: string;
  setExplorerMode: (v: any) => void;
  editorRightPanelTab: string;
  setEditorRightPanelTab: (v: any) => void;
  rightPanelOpen: boolean;
  setRightPanelOpen: (v: boolean) => void;
  aiBottomOpen: boolean;
  setAiBottomOpen: (v: boolean) => void;
  aiPanelHeight: number;
  setAiPanelHeight: (v: number) => void;
  explorerPanelWidth: number;
  setExplorerPanelWidth: (v: number) => void;
  problemsPanelWidth: number;
  setProblemsPanelWidth: (v: number) => void;
  wsIndicatorOpen: boolean;
  setWsIndicatorOpen: (v: boolean) => void;
  effectiveDisplaySettings: Record<string, boolean>;
  editorDisplaySettings: Record<string, boolean>;
  setPendingEditorDisplaySettings: (v: any) => void;
}) {
  // Build current prefs as JSON
  const currentPrefs = useMemo(() => ({
    explorerMode,
    editorRightPanelTab,
    rightPanelOpen,
    aiBottomOpen,
    explorerPanelWidth,
    problemsPanelWidth,
    aiPanelHeight,
    wsIndicatorOpen,
    displaySettings: {
      showProblemCount: effectiveDisplaySettings.showProblemCount ?? false,
      showNodeNumber: effectiveDisplaySettings.showNodeNumber ?? false,
      showNodeCardTimestamps: effectiveDisplaySettings.showNodeCardTimestamps ?? false,
    },
  }), [explorerMode, editorRightPanelTab, rightPanelOpen, aiBottomOpen,
      explorerPanelWidth, problemsPanelWidth, aiPanelHeight, wsIndicatorOpen,
      effectiveDisplaySettings]);

  const [jsonText, setJsonText] = useState(() => JSON.stringify(currentPrefs, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'ok' | 'error'>('idle');

  // Sync JSON text when prefs change externally
  React.useEffect(() => {
    setJsonText(JSON.stringify(currentPrefs, null, 2));
    setParseError(null);
  }, [currentPrefs]);

  const handleApply = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      setParseError(null);

      // Apply to React states — changes take effect immediately
      if (typeof parsed.explorerMode === 'string') setExplorerMode(parsed.explorerMode);
      if (typeof parsed.editorRightPanelTab === 'string') setEditorRightPanelTab(parsed.editorRightPanelTab);
      if (typeof parsed.rightPanelOpen === 'boolean') setRightPanelOpen(parsed.rightPanelOpen);
      if (typeof parsed.aiBottomOpen === 'boolean') setAiBottomOpen(parsed.aiBottomOpen);
      if (typeof parsed.explorerPanelWidth === 'number') setExplorerPanelWidth(parsed.explorerPanelWidth);
      if (typeof parsed.problemsPanelWidth === 'number') setProblemsPanelWidth(parsed.problemsPanelWidth);
      if (typeof parsed.aiPanelHeight === 'number') setAiPanelHeight(parsed.aiPanelHeight);
      if (typeof parsed.wsIndicatorOpen === 'boolean') setWsIndicatorOpen(parsed.wsIndicatorOpen);

      // Apply display settings via pending
      const ds = parsed.displaySettings;
      if (ds && typeof ds === 'object') {
        const pending: Record<string, boolean> = {};
        if (typeof ds.showProblemCount === 'boolean' && ds.showProblemCount !== editorDisplaySettings.showProblemCount) {
          pending.showProblemCount = ds.showProblemCount;
        }
        if (typeof ds.showNodeNumber === 'boolean' && ds.showNodeNumber !== editorDisplaySettings.showNodeNumber) {
          pending.showNodeNumber = ds.showNodeNumber;
        }
        if (typeof ds.showNodeCardTimestamps === 'boolean' && ds.showNodeCardTimestamps !== editorDisplaySettings.showNodeCardTimestamps) {
          pending.showNodeCardTimestamps = ds.showNodeCardTimestamps;
        }
        setPendingEditorDisplaySettings(Object.keys(pending).length > 0 ? pending : null);
      }

    } catch (e: any) {
      setParseError(e.message);
    }
  }, [jsonText, setExplorerMode, setEditorRightPanelTab, setRightPanelOpen, setAiBottomOpen,
      setExplorerPanelWidth, setProblemsPanelWidth, setAiPanelHeight, setWsIndicatorOpen,
      setPendingEditorDisplaySettings, editorDisplaySettings]);

  const handleSave = useCallback(async () => {
    // First apply to state
    handleApply();
    if (parseError) return;

    setSaveStatus('saving');
    try {
      // Trigger the full save cycle which includes editorUiPrefs
      saveHandlerRef.current();
      setSaveStatus('ok');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }, [handleApply, parseError, saveHandlerRef]);

  const textareaStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '300px',
    boxSizing: 'border-box',
    padding: '10px',
    fontSize: '11px',
    fontFamily: 'ui-monospace, Monaco, Menlo, "Ubuntu Mono", Consolas, "Courier New", monospace',
    lineHeight: '1.5',
    tabSize: 2,
    border: `1px solid ${themeStyles.borderSecondary}`,
    borderRadius: '4px',
    background: themeStyles.bgSecondary,
    color: themeStyles.textPrimary,
    resize: 'vertical',
    outline: 'none',
  };

  const statusColor = saveStatus === 'ok' ? themeStyles.success
    : saveStatus === 'error' ? themeStyles.error
    : saveStatus === 'saving' ? themeStyles.accent
    : 'transparent';

  return (
    <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary, overflowY: 'auto', maxHeight: '100%' }}>
      <div style={{
        fontSize: '13px', fontWeight: '600', color: themeStyles.textSecondary,
        marginBottom: '8px', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '6px',
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg> editorUiPrefs.json
      </div>

      <div style={{ padding: '0 8px', marginBottom: '8px' }}>
        <textarea
          value={jsonText}
          onChange={e => { setJsonText(e.target.value); setParseError(null); }}
          spellCheck={false}
          style={textareaStyle}
        />
      </div>

      {parseError && (
        <div style={{ padding: '6px 8px', margin: '4px 8px', borderRadius: '4px', background: themeStyles.error + '22', color: themeStyles.error, fontSize: '11px', fontFamily: 'monospace' }}>
          ⚠ {parseError}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', padding: '4px 8px', alignItems: 'center' }}>
        <button
          type="button"
          onClick={handleApply}
          style={{
            padding: '6px 14px',
            fontSize: '12px',
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: '4px',
            background: themeStyles.bgButton,
            color: themeStyles.textPrimary,
            cursor: 'pointer',
          }}
        >
          {i18n('Apply')}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          style={{
            padding: '6px 14px',
            fontSize: '12px',
            border: 'none',
            borderRadius: '4px',
            background: themeStyles.accent,
            color: '#fff',
            cursor: saveStatus === 'saving' ? 'not-allowed' : 'pointer',
            opacity: saveStatus === 'saving' ? 0.6 : 1,
          }}
        >
          {saveStatus === 'saving' ? i18n('Saving...') : i18n('Apply & Save (Ctrl+S)')}
        </button>
        {saveStatus !== 'idle' && (
          <span style={{ fontSize: '11px', color: statusColor, marginLeft: '4px' }}>
            {saveStatus === 'ok' ? '✓ Saved' : saveStatus === 'error' ? '✗ Failed' : '...'}
          </span>
        )}
      </div>

      <div style={{ marginTop: '12px', padding: '6px 8px', color: themeStyles.textTertiary, fontSize: '10px', lineHeight: '1.6', borderTop: `1px solid ${themeStyles.borderPrimary}` }}>
        <div>Supported keys (see sanitizeBaseEditorUiPrefs):</div>
        <div style={{ marginTop: '2px', whiteSpace: 'pre-wrap' }}>
          explorerMode, editorRightPanelTab, rightPanelOpen, aiBottomOpen,
          explorerPanelWidth, problemsPanelWidth, aiPanelHeight,
          wsIndicatorOpen, displaySettings{`{ showProblemCount, showNodeNumber, showNodeCardTimestamps }`}
        </div>
      </div>
    </div>
  );
}
