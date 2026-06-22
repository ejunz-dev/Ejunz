import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { i18n } from 'vj/utils';
import { EditorBottomTerminal } from './EditorBottomTerminal';
import {
  clampAiPanelHeight,
  clampLeftPanelWidth,
  clampRightPanelWidth,
  EDITOR_WORKSPACE_AI_MIN_H,
  EDITOR_WORKSPACE_LEFT_RAIL_PX,
  EDITOR_WORKSPACE_MAIN_MIN_H,
  EDITOR_WORKSPACE_RIGHT_RAIL_PX,
  readEditorWorkspaceLayoutPrefs,
  writeEditorWorkspaceLayoutPrefs,
  type EditorWorkspaceLayoutPrefs,
} from './layout_prefs';
import {
  buildAiTerminalStyles,
  buildEditorThemeStyles,
  useEditorTheme,
  type EditorThemeStyles,
} from './theme';

function PanelResizeHandle({
  orientation,
  active,
  themeStyles,
  onMouseDown,
}: {
  orientation: 'vertical' | 'horizontal';
  active: boolean;
  themeStyles: EditorThemeStyles;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const isVertical = orientation === 'vertical';
  return (
    <div
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={orientation}
      aria-label={isVertical ? i18n('Resize sidebar') : i18n('Resize terminal panel')}
      title={isVertical ? i18n('Resize sidebar') : i18n('Resize terminal panel')}
      style={{
        width: isVertical ? '4px' : '100%',
        height: isVertical ? '100%' : '8px',
        flexShrink: 0,
        alignSelf: 'stretch',
        background: active ? themeStyles.accent : themeStyles.borderPrimary,
        cursor: isVertical ? 'col-resize' : 'row-resize',
        position: 'relative',
        transition: active ? 'none' : 'background 0.2s ease',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = themeStyles.textSecondary;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = themeStyles.borderPrimary;
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: isVertical ? '-2px' : 0,
          top: isVertical ? 0 : '-2px',
          width: isVertical ? '8px' : '100%',
          height: isVertical ? '100%' : '8px',
          cursor: isVertical ? 'col-resize' : 'row-resize',
        }}
        aria-hidden
      />
    </div>
  );
}

export type EditorWorkspaceShellProps = {
  layoutStorageKey: string;
  leftRail?: React.ReactNode;
  leftPanel: React.ReactNode;
  leftPanelTitle?: string;
  centerHeader?: React.ReactNode;
  centerMain: React.ReactNode;
  centerMainId?: string;
  rightPanel?: React.ReactNode;
  rightPanelTitle?: string;
  rightRail?: React.ReactNode;
  rightPanelOpen?: boolean;
  onRightPanelOpenChange?: (open: boolean) => void;
  bottomTerminal?: React.ReactNode;
  bottomTerminalInputValue?: string;
  onBottomTerminalInputChange?: (value: string) => void;
  onBottomTerminalInputSubmit?: () => void;
  bottomTerminalInputDisabled?: boolean;
  hideBottomTerminal?: boolean;
  defaultLayout?: Partial<EditorWorkspaceLayoutPrefs>;
};

export function EditorWorkspaceShell({
  layoutStorageKey,
  leftRail,
  leftPanel,
  leftPanelTitle,
  centerHeader,
  centerMain,
  centerMainId = 'editor-container',
  rightPanel,
  rightPanelTitle,
  rightRail,
  rightPanelOpen: rightPanelOpenProp,
  onRightPanelOpenChange,
  bottomTerminal,
  bottomTerminalInputValue,
  onBottomTerminalInputChange,
  onBottomTerminalInputSubmit,
  bottomTerminalInputDisabled,
  hideBottomTerminal = false,
  defaultLayout,
}: EditorWorkspaceShellProps) {
  const theme = useEditorTheme();
  const themeStyles = buildEditorThemeStyles(theme);
  const terminalStyles = buildAiTerminalStyles(theme);

  const [layout, setLayout] = useState(() => readEditorWorkspaceLayoutPrefs(layoutStorageKey, defaultLayout));
  const [rightPanelOpenInternal, setRightPanelOpenInternal] = useState(layout.rightPanelOpen);
  const rightPanelOpen = rightPanelOpenProp ?? rightPanelOpenInternal;
  const setRightPanelOpen = useCallback((open: boolean) => {
    setRightPanelOpenInternal(open);
    onRightPanelOpenChange?.(open);
    setLayout((prev) => {
      const next = { ...prev, rightPanelOpen: open };
      writeEditorWorkspaceLayoutPrefs(layoutStorageKey, next);
      return next;
    });
  }, [layoutStorageKey, onRightPanelOpenChange]);

  const [aiBottomOpen, setAiBottomOpen] = useState(layout.aiBottomOpen);
  const [leftPanelWidth, setLeftPanelWidth] = useState(layout.leftPanelWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(layout.rightPanelWidth);
  const [aiPanelHeight, setAiPanelHeight] = useState(layout.aiPanelHeight);
  const [aiPanelMaxHeight, setAiPanelMaxHeight] = useState(640);

  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [isResizingAi, setIsResizingAi] = useState(false);

  const leftResizeStartXRef = useRef(0);
  const leftResizeStartWidthRef = useRef(layout.leftPanelWidth);
  const rightResizeStartXRef = useRef(0);
  const rightResizeStartWidthRef = useRef(layout.rightPanelWidth);
  const aiResizeStartYRef = useRef(0);
  const aiResizeStartHeightRef = useRef(layout.aiPanelHeight);
  const aiPanelMaxHeightRef = useRef(640);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);

  const persistLayout = useCallback((patch: Partial<EditorWorkspaceLayoutPrefs>) => {
    setLayout((prev) => {
      const next = { ...prev, ...patch };
      writeEditorWorkspaceLayoutPrefs(layoutStorageKey, next);
      return next;
    });
  }, [layoutStorageKey]);

  const handleAiBottomOpenChange = useCallback((open: boolean) => {
    setAiBottomOpen(open);
    persistLayout({ aiBottomOpen: open });
  }, [persistLayout]);

  useEffect(() => {
    const handleLeftMove = (e: MouseEvent) => {
      if (!isResizingLeft) return;
      const deltaX = e.clientX - leftResizeStartXRef.current;
      const next = clampLeftPanelWidth(leftResizeStartWidthRef.current + deltaX);
      setLeftPanelWidth(next);
    };
    const handleEnd = () => setIsResizingLeft(false);
    if (isResizingLeft) {
      document.addEventListener('mousemove', handleLeftMove);
      document.addEventListener('mouseup', handleEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleLeftMove);
      document.removeEventListener('mouseup', handleEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingLeft]);

  useEffect(() => {
    if (!isResizingLeft) {
      persistLayout({ leftPanelWidth });
    }
  }, [isResizingLeft, leftPanelWidth, persistLayout]);

  useEffect(() => {
    const handleRightMove = (e: MouseEvent) => {
      if (!isResizingRight) return;
      const deltaX = rightResizeStartXRef.current - e.clientX;
      const next = clampRightPanelWidth(rightResizeStartWidthRef.current + deltaX);
      setRightPanelWidth(next);
    };
    const handleEnd = () => setIsResizingRight(false);
    if (isResizingRight) {
      document.addEventListener('mousemove', handleRightMove);
      document.addEventListener('mouseup', handleEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    return () => {
      document.removeEventListener('mousemove', handleRightMove);
      document.removeEventListener('mouseup', handleEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingRight]);

  useEffect(() => {
    if (!isResizingRight) {
      persistLayout({ rightPanelWidth });
    }
  }, [isResizingRight, rightPanelWidth, persistLayout]);

  useLayoutEffect(() => {
    const el = editorContainerRef.current;
    if (!el) return undefined;
    const updateMax = () => {
      const h = el.getBoundingClientRect().height;
      const max = Math.max(EDITOR_WORKSPACE_AI_MIN_H, Math.floor(h - EDITOR_WORKSPACE_MAIN_MIN_H));
      aiPanelMaxHeightRef.current = max;
      setAiPanelMaxHeight(max);
      setAiPanelHeight((prev) => (prev > max ? max : prev));
    };
    updateMax();
    const ro = new ResizeObserver(updateMax);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const handleAiMove = (e: PointerEvent) => {
      if (!isResizingAi) return;
      const deltaY = aiResizeStartYRef.current - e.clientY;
      const cap = aiPanelMaxHeightRef.current;
      const next = clampAiPanelHeight(Math.min(cap, aiResizeStartHeightRef.current + deltaY));
      setAiPanelHeight(next);
    };
    const handleEnd = () => setIsResizingAi(false);
    if (isResizingAi) {
      document.addEventListener('pointermove', handleAiMove);
      document.addEventListener('pointerup', handleEnd);
      document.addEventListener('pointercancel', handleEnd);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.body.style.touchAction = 'none';
    }
    return () => {
      document.removeEventListener('pointermove', handleAiMove);
      document.removeEventListener('pointerup', handleEnd);
      document.removeEventListener('pointercancel', handleEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.style.touchAction = '';
    };
  }, [isResizingAi]);

  useEffect(() => {
    if (!isResizingAi) {
      persistLayout({ aiPanelHeight });
    }
  }, [aiPanelHeight, isResizingAi, persistLayout]);

  return (
    <div
      className="editor-workspace-shell"
      style={{
        display: 'flex',
        flexDirection: 'row',
        flex: 1,
        minHeight: 0,
        alignItems: 'stretch',
        overflow: 'hidden',
        height: '100%',
        width: '100%',
        backgroundColor: themeStyles.bgPrimary,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          flexShrink: 0,
          alignItems: 'stretch',
          alignSelf: 'stretch',
          minHeight: 0,
          maxHeight: '100%',
          height: '100%',
          overflow: 'hidden',
        }}
      >
        {leftRail ? (
          <div
            style={{
              width: `${EDITOR_WORKSPACE_LEFT_RAIL_PX}px`,
              padding: '8px 5px',
              borderRight: `1px solid ${themeStyles.borderPrimary}`,
              backgroundColor: themeStyles.bgPrimary,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'flex-start',
              gap: '6px',
              flexShrink: 0,
              alignSelf: 'stretch',
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          >
            {leftRail}
          </div>
        ) : null}

        <div
          style={{
            position: 'relative',
            width: leftPanelWidth,
            minWidth: 0,
            minHeight: 0,
            flexShrink: 0,
            alignSelf: 'stretch',
            height: '100%',
            maxHeight: '100%',
            borderRight: `1px solid ${themeStyles.borderPrimary}`,
            backgroundColor: themeStyles.bgSecondary,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          }}
        >
          {leftPanelTitle ? (
            <div
              style={{
                padding: '10px 14px',
                borderBottom: `1px solid ${themeStyles.borderPrimary}`,
                background: themeStyles.bgSecondary,
                color: themeStyles.textPrimary,
                fontWeight: 600,
                fontSize: '13px',
                flexShrink: 0,
              }}
            >
              {leftPanelTitle}
            </div>
          ) : null}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {leftPanel}
          </div>
        </div>

        <PanelResizeHandle
          orientation="vertical"
          active={isResizingLeft}
          themeStyles={themeStyles}
          onMouseDown={(e) => {
            e.preventDefault();
            leftResizeStartXRef.current = e.clientX;
            leftResizeStartWidthRef.current = leftPanelWidth;
            setIsResizingLeft(true);
          }}
        />
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {centerHeader ? (
          <div
            style={{
              padding: '8px 16px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              backgroundColor: themeStyles.bgPrimary,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '8px',
              flexShrink: 0,
            }}
          >
            {centerHeader}
          </div>
        ) : null}

        <div
          id={centerMainId}
          ref={editorContainerRef}
          style={{
            flex: 1,
            minHeight: 0,
            padding: 0,
            overflow: 'hidden',
            position: 'relative',
            backgroundColor: themeStyles.bgPrimary,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {centerMain}
          </div>

          {!hideBottomTerminal ? (
            <EditorBottomTerminal
              open={aiBottomOpen}
              onOpenChange={handleAiBottomOpenChange}
              height={aiPanelHeight}
              maxHeight={aiPanelMaxHeight}
              isResizing={isResizingAi}
              onResizeStart={(clientY) => {
                aiResizeStartYRef.current = clientY;
                aiResizeStartHeightRef.current = aiPanelHeight;
                setIsResizingAi(true);
              }}
              terminalStyles={terminalStyles}
              inputValue={bottomTerminalInputValue}
              onInputChange={onBottomTerminalInputChange}
              onInputSubmit={onBottomTerminalInputSubmit}
              inputDisabled={bottomTerminalInputDisabled}
            >
              {bottomTerminal}
            </EditorBottomTerminal>
          ) : null}
        </div>
      </div>

      {rightPanel && rightPanelOpen ? (
        <PanelResizeHandle
          orientation="vertical"
          active={isResizingRight}
          themeStyles={themeStyles}
          onMouseDown={(e) => {
            e.preventDefault();
            rightResizeStartXRef.current = e.clientX;
            rightResizeStartWidthRef.current = rightPanelWidth;
            setIsResizingRight(true);
          }}
        />
      ) : null}

      {rightPanel && rightPanelOpen ? (
        <div
          style={{
            width: `${rightPanelWidth}px`,
            height: '100%',
            minHeight: 0,
            alignSelf: 'stretch',
            flexShrink: 0,
            transition: isResizingRight ? 'none' : 'width 0.3s ease',
            borderLeft: `1px solid ${themeStyles.borderPrimary}`,
            display: 'flex',
            flexDirection: 'column',
            background: themeStyles.bgPrimary,
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: `1px solid ${themeStyles.borderPrimary}`,
              background: themeStyles.bgSecondary,
              color: themeStyles.textPrimary,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
              gap: 8,
            }}
          >
            <span style={{ fontWeight: 'bold', minWidth: 0 }}>{rightPanelTitle}</span>
            <button
              type="button"
              onClick={() => setRightPanelOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '18px',
                cursor: 'pointer',
                color: themeStyles.textTertiary,
                flexShrink: 0,
                lineHeight: 1,
                padding: '0 4px',
              }}
              aria-label={i18n('Close')}
            >
              &times;
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {rightPanel}
          </div>
        </div>
      ) : null}

      {rightRail ? (
        <div
          style={{
            alignSelf: 'stretch',
            width: `${EDITOR_WORKSPACE_RIGHT_RAIL_PX}px`,
            flexShrink: 0,
            borderLeft: `1px solid ${themeStyles.borderPrimary}`,
            backgroundColor: themeStyles.bgPrimary,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'flex-start',
            gap: '6px',
            padding: '8px 5px',
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
        >
          {rightRail}
        </div>
      ) : null}
    </div>
  );
}

export { EDITOR_WORKSPACE_RIGHT_RAIL_PX };
