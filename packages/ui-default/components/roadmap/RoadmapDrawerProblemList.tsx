import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from 'vj/utils';
import type {
  Problem,
  ProblemAiEval,
  ProblemFillBlank,
  ProblemFlip,
  ProblemMatching,
  ProblemMulti,
  ProblemSingle,
  ProblemSuperFlip,
  ProblemTrueFalse,
} from 'ejun/src/interface';
import {
  matchingColumnsNormalized,
  normalizeMultiAnswers,
  problemKind,
  superFlipNormalized,
} from 'ejun/src/model/problem';
import { RoadmapProblemMarkdown } from './RoadmapProblemMarkdown';

function problemDisplayTitle(problem: Problem, indexOneBased: number): string {
  const title = String(problem.title || '').trim();
  if (title) return title;
  const stem = String((problem as { stem?: string }).stem || '').trim();
  if (stem) return stem.replace(/<[^>]+>/g, '').slice(0, 80);
  return String(i18n('Outline card problems untitled item', indexOneBased));
}

function problemKindI18nKey(type?: string): string {
  switch (type) {
    case 'multi': return 'Problem kind multi';
    case 'true_false': return 'Problem kind true false';
    case 'flip': return 'Problem kind flip';
    case 'fill_blank': return 'Problem kind fill blank';
    case 'matching': return 'Problem kind matching';
    case 'super_flip': return 'Problem kind super flip';
    case 'ai_eval': return 'Problem kind ai eval';
    default: return 'Problem kind single';
  }
}

function problemKindBadge(problem: Problem): string {
  return i18n(problemKindI18nKey(problem.type));
}

type RevealState = {
  single?: boolean;
  multi?: Set<number>;
  trueFalse?: boolean;
  fillBlank?: Set<number>;
  flip?: boolean;
  matching?: Set<number>;
  superFlip?: boolean[][];
  aiEval?: Set<string>;
};

function emptyRevealState(): RevealState {
  return {};
}

function toggleSetItem(set: Set<number>, item: number): Set<number> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

function toggleStringSetItem(set: Set<string>, item: string): Set<string> {
  const next = new Set(set);
  if (next.has(item)) next.delete(item);
  else next.add(item);
  return next;
}

function optionLabel(index: number): string {
  return `${String.fromCharCode(65 + index)}.`;
}

function RoadmapDrawerProblemItem({
  problem,
  indexOneBased,
  expanded,
  reveal,
  selected,
  onToggle,
  onSelect,
  onRevealChange,
}: {
  problem: Problem;
  indexOneBased: number;
  expanded: boolean;
  reveal: RevealState;
  selected?: boolean;
  onToggle: () => void;
  onSelect?: () => void;
  onRevealChange: (next: RevealState) => void;
}) {
  const kind = problemKind(problem);
  const title = problemDisplayTitle(problem, indexOneBased);

  const renderOptions = () => {
    if (kind === 'single') {
      const p = problem as ProblemSingle;
      const options = p.options || [];
      return (
        <div className="roadmap-detail-drawer__problem-options">
          {options.map((option, idx) => (
            <div key={`opt-${idx}`} className="roadmap-detail-drawer__problem-option">
              <span className="roadmap-detail-drawer__problem-option-label">{optionLabel(idx)}</span>
              <RoadmapProblemMarkdown markdown={option} inline className="roadmap-detail-drawer__problem-option-text typo" />
            </div>
          ))}
        </div>
      );
    }
    if (kind === 'multi') {
      const p = problem as ProblemMulti;
      const options = p.options || [];
      return (
        <div className="roadmap-detail-drawer__problem-options">
          {options.map((option, idx) => (
            <div key={`opt-${idx}`} className="roadmap-detail-drawer__problem-option">
              <span className="roadmap-detail-drawer__problem-option-label">{optionLabel(idx)}</span>
              <RoadmapProblemMarkdown markdown={option} inline className="roadmap-detail-drawer__problem-option-text typo" />
            </div>
          ))}
        </div>
      );
    }
    if (kind === 'true_false') {
      return (
        <div className="roadmap-detail-drawer__problem-options">
          <div className="roadmap-detail-drawer__problem-option">
            <span className="roadmap-detail-drawer__problem-option-label">A.</span>
            <span>{i18n('Correct')}</span>
          </div>
          <div className="roadmap-detail-drawer__problem-option">
            <span className="roadmap-detail-drawer__problem-option-label">B.</span>
            <span>{i18n('Incorrect')}</span>
          </div>
        </div>
      );
    }
    return null;
  };

  const renderStem = () => {
    if (kind === 'flip') {
      const p = problem as ProblemFlip;
      return (
        <RoadmapProblemMarkdown
          markdown={p.faceA || ''}
          className="roadmap-detail-drawer__problem-stem typo"
        />
      );
    }
    if (kind === 'fill_blank') {
      const p = problem as ProblemFillBlank;
      const stemStr = p.stem || '';
      const answers = p.answers || [];
      if (!stemStr.trim()) {
        return <RoadmapProblemMarkdown markdown="" className="roadmap-detail-drawer__problem-stem typo" />;
      }
      const segments = stemStr.includes('___') ? stemStr.split('___') : [stemStr, ''];
      const revealed = reveal.fillBlank || new Set<number>();
      return (
        <div className="roadmap-detail-drawer__problem-stem roadmap-detail-drawer__problem-stem--fill">
          {segments.map((segment, segIdx) => (
            <React.Fragment key={`fb-${segIdx}`}>
              <RoadmapProblemMarkdown markdown={segment} inline className="typo" />
              {segIdx < segments.length - 1 ? (
                <button
                  type="button"
                  className={`roadmap-detail-drawer__problem-blank${revealed.has(segIdx) ? ' is-revealed' : ''}`}
                  onClick={() => {
                    onRevealChange({
                      ...reveal,
                      fillBlank: toggleSetItem(revealed, segIdx),
                    });
                  }}
                >
                  {revealed.has(segIdx)
                    ? (answers[segIdx] || '—')
                    : '___'}
                </button>
              ) : null}
            </React.Fragment>
          ))}
        </div>
      );
    }
    if (kind === 'matching') {
      const p = problem as ProblemMatching;
      const cols = matchingColumnsNormalized(p);
      const rowCount = cols.length ? Math.max(...cols.map((col) => col.length), 0) : 0;
      const revealedRows = reveal.matching || new Set<number>();
      return (
        <>
          {p.stem?.trim() ? (
            <RoadmapProblemMarkdown markdown={p.stem} className="roadmap-detail-drawer__problem-stem typo" />
          ) : null}
          <div className="roadmap-detail-drawer__problem-table-wrap">
            <table className="roadmap-detail-drawer__problem-table">
              <thead>
                <tr>
                  <th>#</th>
                  {cols.map((_, colIdx) => (
                    <th key={`mh-${colIdx}`}>{i18n('Problem matching column label', colIdx + 1)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rowCount }, (_, rowIdx) => {
                  const rowRevealed = revealedRows.has(rowIdx);
                  return (
                    <tr key={`mr-${rowIdx}`}>
                      <td>{rowIdx + 1}</td>
                      {cols.map((col, colIdx) => {
                        const cell = String(col[rowIdx] ?? '').trim();
                        if (rowRevealed || colIdx === 0) {
                          if (colIdx === 0 || !rowRevealed) {
                            return (
                              <td key={`mc-${colIdx}-${rowIdx}`}>
                                {cell || '—'}
                              </td>
                            );
                          }
                          return (
                            <td key={`mc-${colIdx}-${rowIdx}`}>
                              <button
                                type="button"
                                className="roadmap-detail-drawer__problem-reveal is-revealed"
                                onClick={() => {
                                  onRevealChange({
                                    ...reveal,
                                    matching: toggleSetItem(revealedRows, rowIdx),
                                  });
                                }}
                              >
                                {cell || '—'}
                              </button>
                            </td>
                          );
                        }
                        return (
                          <td key={`mc-${colIdx}-${rowIdx}`}>
                            <button
                              type="button"
                              className="roadmap-detail-drawer__problem-reveal"
                              onClick={() => {
                                onRevealChange({
                                  ...reveal,
                                  matching: toggleSetItem(revealedRows, rowIdx),
                                });
                              }}
                            >
                              {i18n('Problem super flip masked')}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      );
    }
    if (kind === 'super_flip') {
      const p = problem as ProblemSuperFlip;
      const { headers, columns } = superFlipNormalized(p);
      const colCount = columns.length;
      const rowCount = colCount ? Math.max(0, ...columns.map((col) => col.length)) : 0;
      const revealed = reveal.superFlip || Array.from({ length: colCount }, () => Array.from({ length: rowCount }, () => false));
      return (
        <>
          {p.stem?.trim() ? (
            <RoadmapProblemMarkdown markdown={p.stem} className="roadmap-detail-drawer__problem-stem typo" />
          ) : null}
          <div className="roadmap-detail-drawer__problem-table-wrap">
            <table className="roadmap-detail-drawer__problem-table">
              <thead>
                <tr>
                  {headers.map((header, colIdx) => (
                    <th key={`sh-${colIdx}`}>{header || i18n('Problem matching column label', colIdx + 1)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rowCount }, (_, rowIdx) => (
                  <tr key={`sr-${rowIdx}`}>
                    {columns.map((col, colIdx) => {
                      const cell = String(col[rowIdx] ?? '').trim();
                      const isRevealed = !!(revealed[colIdx] && revealed[colIdx][rowIdx]);
                      if (!cell) return <td key={`sc-${colIdx}-${rowIdx}`} />;
                      if (!isRevealed) {
                        return (
                          <td key={`sc-${colIdx}-${rowIdx}`}>
                            <button
                              type="button"
                              className="roadmap-detail-drawer__problem-reveal"
                              onClick={() => {
                                const next = revealed.map((colRev) => [...colRev]);
                                while (next.length <= colIdx) next.push([]);
                                while (next[colIdx].length <= rowIdx) next[colIdx].push(false);
                                next[colIdx][rowIdx] = true;
                                onRevealChange({ ...reveal, superFlip: next });
                              }}
                            >
                              {i18n('Problem super flip masked')}
                            </button>
                          </td>
                        );
                      }
                      return (
                        <td key={`sc-${colIdx}-${rowIdx}`}>
                          <button
                            type="button"
                            className="roadmap-detail-drawer__problem-reveal is-revealed"
                            onClick={() => {
                              const next = revealed.map((colRev) => [...colRev]);
                              while (next.length <= colIdx) next.push([]);
                              while (next[colIdx].length <= rowIdx) next[colIdx].push(false);
                              next[colIdx][rowIdx] = false;
                              onRevealChange({ ...reveal, superFlip: next });
                            }}
                          >
                            {cell}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      );
    }
    if (kind === 'ai_eval') {
      const p = problem as ProblemAiEval;
      const revealed = reveal.aiEval || new Set<string>();
      const rubricItems: Array<{ id: string; label: string; content: string; score: number }> = [];
      (p.points || []).forEach((point, pointIdx) => {
        const subs = Array.isArray(point.subPoints) ? point.subPoints : [];
        if (subs.length) {
          subs.forEach((sub, subIdx) => {
            const parent = String(point.title || '').trim();
            const child = String(sub.title || '').trim();
            rubricItems.push({
              id: sub.id || `ae-${pointIdx}-${subIdx}`,
              label: parent && child ? `${parent} · ${child}` : (child || parent || `#${rubricItems.length + 1}`),
              content: String(sub.content || '').trim(),
              score: typeof sub.score === 'number' ? sub.score : 0,
            });
          });
        }
      });
      return (
        <>
          <RoadmapProblemMarkdown markdown={p.stem || ''} className="roadmap-detail-drawer__problem-stem typo" />
          <div className="roadmap-detail-drawer__problem-rubric">
            {rubricItems.map((item) => {
              const isRevealed = revealed.has(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`roadmap-detail-drawer__problem-rubric-item${isRevealed ? ' is-revealed' : ''}`}
                  onClick={() => {
                    onRevealChange({
                      ...reveal,
                      aiEval: toggleStringSetItem(revealed, item.id),
                    });
                  }}
                >
                  <span className="roadmap-detail-drawer__problem-rubric-label">{item.label}</span>
                  {isRevealed ? (
                    <span className="roadmap-detail-drawer__problem-rubric-body">
                      {item.content || '—'}
                      <span className="roadmap-detail-drawer__problem-rubric-score">
                        {item.score}
                      </span>
                    </span>
                  ) : (
                    <span className="roadmap-detail-drawer__problem-rubric-mask">
                      {i18n('Problem super flip masked')}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      );
    }
    const stem = String((problem as { stem?: string }).stem || '');
    return (
      <RoadmapProblemMarkdown markdown={stem} className="roadmap-detail-drawer__problem-stem typo" />
    );
  };

  const renderAnswerReveals = () => {
    if (kind === 'single') {
      const p = problem as ProblemSingle;
      const options = p.options || [];
      const answerIdx = typeof p.answer === 'number' ? p.answer : -1;
      const revealed = !!reveal.single;
      return (
        <div className="roadmap-detail-drawer__problem-answers">
          <div className="roadmap-detail-drawer__problem-answers-title">{i18n('Correct Answer')}</div>
          {!revealed ? (
            <button
              type="button"
              className="roadmap-detail-drawer__problem-reveal"
              onClick={() => onRevealChange({ ...reveal, single: true })}
            >
              {i18n('Roadmap drawer problem tap reveal answer')}
            </button>
          ) : (
            <button
              type="button"
              className="roadmap-detail-drawer__problem-answer is-revealed"
              onClick={() => onRevealChange({ ...reveal, single: false })}
            >
              <span className="roadmap-detail-drawer__problem-option-label">
                {answerIdx >= 0 ? optionLabel(answerIdx) : ''}
              </span>
              <RoadmapProblemMarkdown
                markdown={answerIdx >= 0 && options[answerIdx] != null ? String(options[answerIdx]) : '—'}
                inline
                className="typo"
              />
            </button>
          )}
        </div>
      );
    }
    if (kind === 'multi') {
      const p = problem as ProblemMulti;
      const options = p.options || [];
      const correct = normalizeMultiAnswers(p.answer);
      const revealed = reveal.multi || new Set<number>();
      return (
        <div className="roadmap-detail-drawer__problem-answers">
          <div className="roadmap-detail-drawer__problem-answers-title">{i18n('Correct Answer')}</div>
          <div className="roadmap-detail-drawer__problem-answer-list">
            {correct.map((idx) => {
              const isRevealed = revealed.has(idx);
              if (!isRevealed) {
                return (
                  <button
                    key={`ans-${idx}`}
                    type="button"
                    className="roadmap-detail-drawer__problem-reveal"
                    onClick={() => {
                      onRevealChange({
                        ...reveal,
                        multi: toggleSetItem(revealed, idx),
                      });
                    }}
                  >
                    {i18n('Roadmap drawer problem tap reveal answer')}
                    {correct.length > 1 ? ` (${optionLabel(idx)})` : ''}
                  </button>
                );
              }
              return (
                <button
                  key={`ans-${idx}`}
                  type="button"
                  className="roadmap-detail-drawer__problem-answer is-revealed"
                  onClick={() => {
                    onRevealChange({
                      ...reveal,
                      multi: toggleSetItem(revealed, idx),
                    });
                  }}
                >
                  <span className="roadmap-detail-drawer__problem-option-label">{optionLabel(idx)}</span>
                  <RoadmapProblemMarkdown markdown={String(options[idx] ?? '—')} inline className="typo" />
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    if (kind === 'true_false') {
      const p = problem as ProblemTrueFalse;
      const revealed = !!reveal.trueFalse;
      const answerText = p.answer === 1 ? i18n('Correct') : i18n('Incorrect');
      return (
        <div className="roadmap-detail-drawer__problem-answers">
          <div className="roadmap-detail-drawer__problem-answers-title">{i18n('Correct Answer')}</div>
          {!revealed ? (
            <button
              type="button"
              className="roadmap-detail-drawer__problem-reveal"
              onClick={() => onRevealChange({ ...reveal, trueFalse: true })}
            >
              {i18n('Roadmap drawer problem tap reveal answer')}
            </button>
          ) : (
            <button
              type="button"
              className="roadmap-detail-drawer__problem-answer is-revealed"
              onClick={() => onRevealChange({ ...reveal, trueFalse: false })}
            >
              {answerText}
            </button>
          )}
        </div>
      );
    }
    if (kind === 'flip') {
      const p = problem as ProblemFlip;
      const revealed = !!reveal.flip;
      return (
        <div className="roadmap-detail-drawer__problem-answers">
          <div className="roadmap-detail-drawer__problem-answers-title">{i18n('Correct Answer')}</div>
          {!revealed ? (
            <button
              type="button"
              className="roadmap-detail-drawer__problem-reveal"
              onClick={() => onRevealChange({ ...reveal, flip: true })}
            >
              {i18n('Roadmap drawer problem reveal back')}
            </button>
          ) : (
            <button
              type="button"
              className="roadmap-detail-drawer__problem-answer is-revealed roadmap-detail-drawer__problem-answer--block"
              onClick={() => onRevealChange({ ...reveal, flip: false })}
            >
              <RoadmapProblemMarkdown markdown={p.faceB || '—'} className="typo" />
            </button>
          )}
        </div>
      );
    }
    return null;
  };

  const hideSeparateAnswers = kind === 'fill_blank' || kind === 'matching' || kind === 'super_flip' || kind === 'ai_eval';

  return (
    <div className={`roadmap-detail-drawer__problem${expanded ? ' is-expanded' : ''}${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="roadmap-detail-drawer__problem-head"
        aria-expanded={expanded}
        onClick={() => { onSelect?.(); onToggle(); }}
      >
        <span className="roadmap-detail-drawer__resource-badge">{problemKindBadge(problem)}</span>
        <span className="roadmap-detail-drawer__problem-head-title">{title}</span>
        <span className="roadmap-detail-drawer__problem-chevron" aria-hidden>{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        <div className="roadmap-detail-drawer__problem-body">
          {renderStem()}
          {renderOptions()}
          {!hideSeparateAnswers ? renderAnswerReveals() : null}
        </div>
      ) : null}
    </div>
  );
}

export function RoadmapDrawerProblemList({
  problems,
  resetKey,
  selectedProblemId,
  onSelectProblem,
}: {
  problems: Problem[];
  resetKey: string;
  selectedProblemId?: string | null;
  onSelectProblem?: (pid: string) => void;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [revealById, setRevealById] = useState<Record<string, RevealState>>({});

  useEffect(() => {
    setExpandedIds(new Set());
    setRevealById({});
  }, [resetKey]);

  const toggleExpanded = useCallback((pid: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) {
        next.delete(pid);
        setRevealById((reveals) => {
          const copy = { ...reveals };
          delete copy[pid];
          return copy;
        });
      } else {
        next.add(pid);
      }
      return next;
    });
  }, []);

  const setReveal = useCallback((pid: string, next: RevealState) => {
    setRevealById((prev) => ({ ...prev, [pid]: next }));
  }, []);

  if (!problems.length) {
    return <p className="roadmap-detail-drawer__empty">{i18n('Roadmap drawer problems empty')}</p>;
  }

  return (
    <div className="roadmap-detail-drawer__problem-list">
      {problems.map((problem, idx) => {
        const pid = String(problem.pid || `p-${idx}`);
        return (
          <RoadmapDrawerProblemItem
            key={pid}
            problem={problem}
            indexOneBased={idx + 1}
            expanded={expandedIds.has(pid)}
            selected={selectedProblemId === pid}
            reveal={revealById[pid] || emptyRevealState()}
            onToggle={() => toggleExpanded(pid)}
            onSelect={() => onSelectProblem?.(pid)}
            onRevealChange={(next) => setReveal(pid, next)}
          />
        );
      })}
    </div>
  );
}
