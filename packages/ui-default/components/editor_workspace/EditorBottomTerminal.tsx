import React, { useRef } from 'react';
import { i18n } from 'vj/utils';
import type { AiTerminalStyles } from './theme';
import { useAiTerminalInputPromptParts } from './theme';

export type EditorBottomTerminalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  height: number;
  maxHeight: number;
  isResizing: boolean;
  onResizeStart: (clientY: number) => void;
  terminalStyles: AiTerminalStyles;
  children?: React.ReactNode;
  inputValue?: string;
  onInputChange?: (value: string) => void;
  onInputSubmit?: () => void;
  inputDisabled?: boolean;
  inputPlaceholder?: string;
};

export function EditorBottomTerminal({
  open,
  onOpenChange,
  height,
  maxHeight,
  isResizing,
  onResizeStart,
  terminalStyles,
  children,
  inputValue = '',
  onInputChange,
  onInputSubmit,
  inputDisabled = false,
  inputPlaceholder,
}: EditorBottomTerminalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const promptParts = useAiTerminalInputPromptParts();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        style={{
          flexShrink: 0,
          width: '100%',
          padding: '4px 10px',
          border: 'none',
          borderTop: `1px solid ${terminalStyles.tabBorder}`,
          backgroundColor: terminalStyles.tabBarBg,
          color: terminalStyles.textDim,
          fontSize: '12px',
          cursor: 'pointer',
          fontWeight: 500,
          textAlign: 'left',
          fontFamily: terminalStyles.mono,
        }}
      >
        ▲ AI
      </button>
    );
  }

  return (
    <>
      <div
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          onResizeStart(e.clientY);
        }}
        style={{
          height: '8px',
          flexShrink: 0,
          cursor: 'row-resize',
          touchAction: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxSizing: 'border-box',
          borderTop: `1px solid ${terminalStyles.tabBorder}`,
          background: isResizing ? terminalStyles.resizeActive : terminalStyles.tabBarBg,
        }}
        role="separator"
        aria-orientation="horizontal"
        aria-label={i18n('Resize terminal panel')}
      >
        <div
          style={{
            width: '40px',
            height: '3px',
            borderRadius: '2px',
            background: isResizing ? terminalStyles.resizeActive : terminalStyles.resizeDefault,
            opacity: isResizing ? 1 : 0.55,
            pointerEvents: 'none',
          }}
        />
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          borderTop: 'none',
          backgroundColor: terminalStyles.shellBg,
          overflow: 'hidden',
          fontFamily: terminalStyles.mono,
          height,
          minHeight: 120,
          maxHeight,
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'space-between',
            minHeight: 28,
            backgroundColor: terminalStyles.tabBarBg,
            borderBottom: `1px solid ${terminalStyles.tabBorder}`,
            fontSize: '12px',
            color: terminalStyles.textDim,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 10px',
              backgroundColor: terminalStyles.tabActiveBg,
              borderTop: `2px solid ${terminalStyles.tabActiveTop}`,
              borderRight: `1px solid ${terminalStyles.tabBorder}`,
              color: terminalStyles.text,
              fontWeight: 500,
              marginBottom: -1,
              paddingBottom: 1,
            }}
          >
            AI
          </div>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            style={{
              background: 'none',
              border: 'none',
              borderLeft: `1px solid ${terminalStyles.tabBorder}`,
              cursor: 'pointer',
              color: terminalStyles.textDim,
              fontSize: '14px',
              lineHeight: 1,
              padding: '0 10px',
              fontFamily: 'inherit',
            }}
            aria-label={i18n('Collapse panel')}
            title={i18n('Collapse panel')}
          >
            ▼
          </button>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            backgroundColor: terminalStyles.shellBg,
            fontSize: '12px',
            lineHeight: 1.5,
          }}
        >
          {children}
        </div>
        <div
          style={{
            flexShrink: 0,
            borderTop: `1px solid ${terminalStyles.tabBorder}`,
            backgroundColor: terminalStyles.shellBg,
            padding: '4px 8px 6px',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              minHeight: 22,
              gap: 0,
              fontFamily: terminalStyles.mono,
              fontSize: '12px',
              lineHeight: '22px',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                flexShrink: 0,
                maxWidth: '42%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontFamily: terminalStyles.mono,
              }}
              title={promptParts.full}
            >
              <span style={{ color: terminalStyles.promptShellUser, flexShrink: 0 }}>{promptParts.uname}</span>
              <span style={{ color: terminalStyles.promptShellSep, flexShrink: 0, paddingLeft: 3, paddingRight: 3 }}>@</span>
              <span style={{ color: terminalStyles.promptShellHost, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {promptParts.domain}
              </span>
              <span style={{ color: terminalStyles.promptShellSep, flexShrink: 0 }}>:</span>
            </span>
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => onInputChange?.(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onInputSubmit?.();
                }
              }}
              autoComplete="off"
              spellCheck={false}
              disabled={inputDisabled}
              placeholder={inputPlaceholder}
              aria-label={i18n('Terminal input')}
              style={{
                flex: 1,
                minWidth: 0,
                padding: 0,
                margin: 0,
                border: 'none',
                outline: 'none',
                boxShadow: 'none',
                fontSize: '12px',
                lineHeight: '22px',
                fontFamily: 'inherit',
                backgroundColor: 'transparent',
                color: terminalStyles.text,
                caretColor: terminalStyles.promptShellHost,
              }}
            />
          </div>
        </div>
      </div>
    </>
  );
}
