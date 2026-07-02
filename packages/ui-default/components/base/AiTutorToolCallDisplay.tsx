import React, { useState } from 'react';

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 15l6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <path d="M8 12l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export type ToolCallItem = {
  id: string;
  function: { name: string; arguments: string };
  result?: { content: string };
};

export type AiTutorToolCallDisplayProps = {
  toolCalls: ToolCallItem[];
};

function ToolCallDisplay({ toolCalls }: AiTutorToolCallDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div
      style={{
        margin: '8px 0',
        borderRadius: '8px',
        border: '1px solid #e0e0e0',
        background: '#fafafa',
        fontSize: '13px',
        overflow: 'hidden',
      }}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '8px 12px',
          cursor: 'pointer',
          userSelect: 'none',
          color: '#666',
        }}
      >
        <SearchIcon />
        <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {toolCalls.length === 1
            ? (() => {
                const tc = toolCalls[0];
                let argsDisplay = '';
                try {
                  const parsed = JSON.parse(tc.function.arguments);
                  argsDisplay = parsed.query || parsed.query === '' ? ` "${parsed.query}"` : '';
                } catch {}
                return `semantic_search${argsDisplay}`;
              })()
            : `${toolCalls.length} tool calls`}
        </span>
        <span style={{ fontSize: '11px', color: '#999' }}>
          {expanded ? 'Hide details' : 'View details'}
        </span>
        {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </div>

      {expanded
        ? toolCalls.map((tc, i) => {
            const argsRaw = tc.function.arguments || '{}';
            const resultRaw = tc.result?.content || '';
            let argsText = argsRaw;
            let resultText = resultRaw;
            let resultMessage = '';
            let resultInstructions: string[] = [];
            try {
              argsText = JSON.stringify(JSON.parse(argsRaw), null, 2);
            } catch {}
            if (resultRaw) {
              try {
                const parsed = JSON.parse(resultRaw);
                resultText = JSON.stringify(parsed, null, 2);
                resultMessage = parsed.message || '';
                resultInstructions = Array.isArray(parsed.instructions)
                  ? parsed.instructions
                  : typeof parsed.instructions === 'string'
                    ? [parsed.instructions]
                    : [];
              } catch {
                resultText = resultRaw;
              }
            }
            return (
              <div key={tc.id || i} style={{ borderTop: '1px solid #eee', padding: '8px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '6px' }}>
                  <code style={{
                    fontSize: '12px',
                    background: '#e8e8e8',
                    padding: '2px 6px',
                    borderRadius: '4px',
                    fontWeight: 600,
                  }}>
                    {tc.function.name}
                  </code>
                  {resultInstructions.length > 0 ? (
                    <span style={{ fontSize: '11px', color: '#4caf50', display: 'flex', alignItems: 'center', gap: '3px' }}>
                      <CheckCircleIcon />
                      {'success'}
                    </span>
                  ) : null}
                </div>

                {resultMessage ? (
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                    {resultMessage}
                  </div>
                ) : null}

                <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                  Input arguments:
                </div>
                <pre style={{
                  margin: '0 0 8px 0',
                  fontSize: '11px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: '#f5f5f5',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  overflow: 'auto',
                }}>
                  {argsText}
                </pre>

                {resultRaw ? (
                  <>
                    <div style={{ fontSize: '11px', color: '#888', marginBottom: '4px' }}>
                      Output result:
                    </div>
                    <pre style={{
                      margin: 0,
                      fontSize: '11px',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      background: '#f5f5f5',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      overflow: 'auto',
                    }}>
                      {resultText}
                    </pre>
                  </>
                ) : null}
              </div>
            );
          })
        : null}
    </div>
  );
}

export default ToolCallDisplay;
