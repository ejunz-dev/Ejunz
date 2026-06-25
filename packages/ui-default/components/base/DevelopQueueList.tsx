import React from 'react';
import { i18n } from 'vj/utils';
import { resolveDevelopQueueRowStats, normDevelopBranch, developQueueGoalCaption } from './utils';
import type { DevelopEditorContextWire } from './types';

export function DevelopQueueList({
  items,
  currentIndex,
  devCtx,
  themeStyles,
  theme,
  busyIndex,
  onGo,
}: {
  items: Array<{ baseDocId: number; branch: string }>;
  currentIndex: number;
  devCtx: DevelopEditorContextWire;
  themeStyles: any;
  theme: 'light' | 'dark';
  busyIndex: number | null;
  onGo: (baseDocId: number, branch: string, idx: number) => void;
}) {
  const unset = i18n('Develop goal unset');
  const track = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px', minHeight: 0 }}>
      <div style={{ fontSize: 11, color: themeStyles.textSecondary, marginBottom: 10, lineHeight: 1.4 }}>
        {i18n('Develop queue sidebar hint')}
      </div>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, idx) => {
          const st = resolveDevelopQueueRowStats(devCtx, item.baseDocId, item.branch);
          const isCurrent = idx === currentIndex;
          const busy = busyIndex !== null;
          const cap = (cur: number, goal: number) => developQueueGoalCaption(cur, goal, unset);
          return (
            <li key={`${item.baseDocId}-${item.branch}-${idx}`}>
              <button
                type="button"
                disabled={busy}
                onClick={() => onGo(item.baseDocId, item.branch, idx)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 10px',
                  borderRadius: 8,
                  border: `1px solid ${isCurrent ? themeStyles.accent : themeStyles.borderSecondary}`,
                  background: isCurrent
                    ? (theme === 'dark' ? 'rgba(56, 189, 248, 0.12)' : 'rgba(14, 165, 233, 0.08)')
                    : themeStyles.bgSecondary,
                  color: themeStyles.textPrimary,
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy && busyIndex !== idx ? 0.65 : 1,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 12, flex: 1, minWidth: 0 }}>
                    <span style={{ color: themeStyles.textTertiary, fontWeight: 600, marginRight: 6 }}>{idx + 1}.</span>
                    {st.baseTitle}
                    <span style={{ color: themeStyles.textSecondary, fontWeight: 500 }}>{` · ${normDevelopBranch(item.branch)}`}</span>
                  </span>
                  {isCurrent ? (
                    <span style={{ fontSize: 10, fontWeight: 700, color: themeStyles.accent, flexShrink: 0 }}>{i18n('Develop queue current')}</span>
                  ) : null}
                </div>
                <div style={{ fontSize: 10, color: themeStyles.textSecondary, lineHeight: 1.5, marginBottom: 6 }}>
                  <span style={{ color: themeStyles.statNode }}>{i18n('Develop today nodes')} {cap(st.todayNodes, st.dailyNodeGoal)}</span>
                  <span style={{ margin: '0 5px', color: themeStyles.textTertiary }}>|</span>
                  <span style={{ color: themeStyles.statCard }}>{i18n('Develop today cards')} {cap(st.todayCards, st.dailyCardGoal)}</span>
                  <span style={{ margin: '0 5px', color: themeStyles.textTertiary }}>|</span>
                  <span style={{ color: themeStyles.statProblem }}>{i18n('Develop today problems')} {cap(st.todayProblems, st.dailyProblemGoal)}</span>
                </div>
                <div style={{ height: 3, borderRadius: 2, background: track, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(() => {
                        const parts: number[] = [];
                        if (st.dailyNodeGoal > 0) {
                          parts.push(Math.min(100, (st.todayNodes / st.dailyNodeGoal) * 100));
                        }
                        if (st.dailyCardGoal > 0) {
                          parts.push(Math.min(100, (st.todayCards / st.dailyCardGoal) * 100));
                        }
                        if (st.dailyProblemGoal > 0) {
                          parts.push(Math.min(100, (st.todayProblems / st.dailyProblemGoal) * 100));
                        }
                        if (!parts.length) return 0;
                        return Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
                      })()}%`,
                      height: '100%',
                      background: themeStyles.accent,
                      borderRadius: 1,
                      transition: 'width 0.2s ease',
                    }}
                  />
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
