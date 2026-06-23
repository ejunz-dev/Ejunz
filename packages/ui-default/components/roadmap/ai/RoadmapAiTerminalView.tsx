import React from 'react';
import { i18n } from 'vj/utils';
import type { AiTerminalStyles } from '../../editor_workspace/theme';
import type { RoadmapAiChatMessage } from './useRoadmapAiChat';

export type RoadmapAiTerminalViewProps = {
  messages: RoadmapAiChatMessage[];
  isLoading: boolean;
  terminalStyles: AiTerminalStyles;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  onToggleOperationExpanded: (index: number) => void;
  summarizeOperation: (op: Record<string, unknown>) => string;
};

export function RoadmapAiTerminalView({
  messages,
  isLoading,
  terminalStyles,
  messagesEndRef,
  onToggleOperationExpanded,
  summarizeOperation,
}: RoadmapAiTerminalViewProps) {
  if (!messages.length && !isLoading) {
    return (
      <div style={{ color: terminalStyles.textDim, fontSize: '12px' }}>
        <span style={{ color: terminalStyles.promptAi }}>[ai]</span>
        {' '}
        {i18n('Roadmap AI terminal hint')}
      </div>
    );
  }

  return (
    <>
        {messages.map((msg, index) => {
          if (msg.role === 'operation') {
            return (
              <div key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch' }}>
                <div
                  onClick={() => onToggleOperationExpanded(index)}
                  style={{
                    padding: '4px 8px',
                    background: terminalStyles.operationBg,
                    border: `1px solid ${terminalStyles.operationBorder}`,
                    color: terminalStyles.operationText,
                    fontSize: '12px',
                    cursor: 'pointer',
                    userSelect: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  <span style={{ color: terminalStyles.promptAi }}>[op]</span>
                  <span style={{ flex: 1 }}>{msg.content}</span>
                  <span style={{ color: terminalStyles.textDim, flexShrink: 0 }}>
                    {msg.isExpanded ? '▼' : '▶'}
                  </span>
                </div>
                {msg.isExpanded && msg.operations?.length ? (
                  <div
                    style={{
                      marginTop: '4px',
                      padding: '6px 8px',
                      background: terminalStyles.tabBarBg,
                      border: `1px solid ${terminalStyles.tabBorder}`,
                      fontSize: '11px',
                      color: terminalStyles.text,
                    }}
                  >
                    <ol style={{ margin: 0, paddingLeft: '18px' }}>
                      {msg.operations.map((op, opIndex) => (
                        <li key={opIndex}>{summarizeOperation(op as Record<string, unknown>)}</li>
                      ))}
                    </ol>
                  </div>
                ) : null}
              </div>
            );
          }

          return (
            <div
              key={index}
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: '6px',
                maxWidth: '100%',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  color: msg.role === 'user' ? terminalStyles.promptUser : terminalStyles.promptAi,
                  userSelect: 'none',
                }}
              >
                {msg.role === 'user' ? '$' : '>'}
              </span>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  color: terminalStyles.text,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {msg.content}
                {msg.role === 'assistant' && msg.streamOps?.receiving ? (
                  <div
                    style={{
                      marginTop: '6px',
                      padding: '6px 8px',
                      borderRadius: '4px',
                      border: `1px solid ${terminalStyles.tabBorder}`,
                      backgroundColor: terminalStyles.tabBarBg,
                      fontSize: '11px',
                      color: terminalStyles.text,
                    }}
                  >
                    <div style={{ color: terminalStyles.operationText, fontWeight: 600, marginBottom: '4px' }}>
                      {i18n('Roadmap AI receiving operations')}
                    </div>
                    {msg.streamOps.lines.length > 0 ? (
                      <ol style={{ margin: '0 0 0 18px', padding: 0, color: terminalStyles.text }}>
                        {msg.streamOps.lines.map((line, li) => (
                          <li key={`${li}-${line}`}>{line}</li>
                        ))}
                      </ol>
                    ) : (
                      <div style={{ color: terminalStyles.textDim, fontStyle: 'italic' }}>
                        {i18n('Roadmap AI waiting for operations')}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
        {isLoading ? (
          <div style={{ color: terminalStyles.textDim, fontSize: '12px' }}>
            <span style={{ color: terminalStyles.promptAi }}>...</span>
            {' '}
            {i18n('Roadmap AI processing')}
          </div>
        ) : null}
        <div ref={messagesEndRef} />
    </>
  );
}
