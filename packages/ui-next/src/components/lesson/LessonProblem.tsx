import { useCallback, useMemo, useState } from 'react';
import type {
  Problem,
  ProblemAiEval,
  ProblemChain,
  ProblemFillBlank,
  ProblemFlip,
  ProblemMatching,
  ProblemMulti,
  ProblemSingle,
  ProblemSuperFlip,
  ProblemTrueFalse,
} from 'ejun/src/interface';
import {
  fillBlankResponseMatches,
  fillBlankSlotCount,
  flattenAiEvalRubricForScoring,
  matchingAllColumnsCorrect,
  matchingColumnsNormalized,
  normalizeChainRows,
  normalizeMultiAnswers,
  problemKind,
  setsEqualAsSorted,
  superFlipNormalized,
} from 'ejun/src/model/problem';
import { i18n } from '../../i18n';
import { renderMarkdown } from '../base-detail/markdown';
import { requestJson } from '../base-detail/base-detail-api';

export interface LessonGrading {
  selected: number;
  correct: boolean;
  fillAnswers?: string[];
}

interface Props {
  problem: Problem;
  domainId: string;
  locked: boolean;
  preview?: LessonGrading | null;
  onGraded: (grading: LessonGrading) => void;
  onSkip: () => void;
}

function bitmaskToIndices(mask: number): number[] {
  const out: number[] = [];
  for (let bit = 0; bit < 16; bit += 1) if (mask & (1 << bit)) out.push(bit);
  return out;
}

function Markdown({ text, inline = false, className }: { text: string; inline?: boolean; className?: string }) {
  const html = useMemo(() => renderMarkdown(text ?? '', inline), [text, inline]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function shuffledIndices(count: number, seed: number): number[] {
  const out = Array.from({ length: count }, (_, index) => index);
  let state = seed || 1;
  for (let i = count - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

function multiIndicesToBitmask(indices: number[]): number {
  return indices.reduce((acc, index) => acc | (1 << index), 0);
}

function optionLabel(index: number): string {
  return `${String.fromCharCode(65 + index)}`;
}

function superFlipCellHasContent(cell: unknown): boolean {
  return String(cell ?? '').trim().length > 0;
}

function superFlipAllFilledCellsRevealed(columns: string[][], revealed: boolean[][]): boolean {
  return columns.every((column, columnIndex) => column.every((cell, rowIndex) => (
    !superFlipCellHasContent(cell) || Boolean(revealed[columnIndex]?.[rowIndex])
  )));
}

function AnswerFeedback({
  correct,
  correctAnswer,
  analysis,
  extra,
}: {
  correct: boolean;
  correctAnswer?: string;
  analysis?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className={`lesson-feedback${correct ? ' is-correct' : ' is-wrong'}`} role="status">
      <div className="lesson-feedback__head">
        <span className="lesson-feedback__badge">{correct ? '✓' : '✗'} {correct ? i18n('Correct') : i18n('Incorrect')}</span>
        {correctAnswer ? (
          <span className="lesson-feedback__answer"><strong>{i18n('Correct Answer')}</strong>: {correctAnswer}</span>
        ) : null}
      </div>
      {extra}
      {analysis?.trim() ? (
        <div className="lesson-feedback__analysis">
          <strong>{i18n('Analysis')}</strong>
          <Markdown text={analysis} className="lesson-markdown" />
        </div>
      ) : null}
    </div>
  );
}

export function LessonProblem({ problem, domainId, locked, preview = null, onGraded, onSkip }: Props) {
  const kind = problemKind(problem);
  const pid = String(problem.pid || '');
  const [submitted, setSubmitted] = useState(Boolean(preview));
  const [singleChoice, setSingleChoice] = useState<number | null>(preview && kind === 'single' ? preview.selected : null);
  const [multiChoice, setMultiChoice] = useState<number[]>(preview && kind === 'multi' ? bitmaskToIndices(preview.selected) : []);
  const [trueFalseChoice, setTrueFalseChoice] = useState<0 | 1 | null>(preview && kind === 'true_false' ? (preview.selected === 1 ? 1 : 0) : null);
  const [flipStage, setFlipStage] = useState<'a' | 'b'>(preview && kind === 'flip' ? 'b' : 'a');
  const [fillDraft, setFillDraft] = useState<string[]>(preview?.fillAnswers ?? []);
  const [matchingPicks, setMatchingPicks] = useState<number[][]>([]);
  const [superFlipRevealed, setSuperFlipRevealed] = useState<boolean[][]>([]);
  const [chainRevealed, setChainRevealed] = useState<boolean[]>([]);
  const [aiDraft, setAiDraft] = useState<Record<string, string>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<{ score: number; feedback: string } | null>(null);
  const [correctAnswerText, setCorrectAnswerText] = useState('');
  const [grading, setGrading] = useState<LessonGrading | null>(preview);

  const submit = useCallback((result: LessonGrading, correctAnswer = '') => {
    setCorrectAnswerText(correctAnswer);
    setGrading(result);
    setSubmitted(true);
    onGraded(result);
  }, [onGraded]);

  const options = useMemo(() => {
    if (kind === 'single') return (problem as ProblemSingle).options || [];
    if (kind === 'multi') return (problem as ProblemMulti).options || [];
    return [];
  }, [kind, problem]);
  const optionOrder = useMemo(() => shuffledIndices(options.length, seedFrom(`${pid}:${kind}`)), [options.length, pid, kind]);

  const flip = problem as ProblemFlip;
  const fillBlank = problem as ProblemFillBlank;
  const fillBlankNeed = kind === 'fill_blank' ? fillBlankSlotCount(fillBlank.stem || '') : 0;
  const fillValues = useMemo(() => {
    const next = [...fillDraft];
    while (next.length < fillBlankNeed) next.push('');
    return next.slice(0, fillBlankNeed);
  }, [fillDraft, fillBlankNeed]);

  const matchingColumns = useMemo(
    () => (kind === 'matching' ? matchingColumnsNormalized(problem as ProblemMatching) : []),
    [kind, problem],
  );
  const matchingRowCount = matchingColumns[0]?.length ?? 0;
  const matchingSelectOrders = useMemo(() => {
    const orders: number[][][] = [];
    for (let row = 0; row < matchingRowCount; row += 1) {
      const perColumn: number[][] = [];
      for (let column = 0; column < matchingColumns.length; column += 1) {
        perColumn.push(shuffledIndices(matchingColumns[column]?.length ?? 0, seedFrom(`${pid}:${row}:${column}`)));
      }
      orders.push(perColumn);
    }
    return orders;
  }, [matchingColumns, matchingRowCount, pid]);

  const superFlip = useMemo(
    () => (kind === 'super_flip' ? superFlipNormalized(problem as ProblemSuperFlip) : { headers: [], columns: [] }),
    [kind, problem],
  );
  const chainRows = useMemo(
    () => (kind === 'chain' ? normalizeChainRows((problem as ProblemChain).rows) : []),
    [kind, problem],
  );

  const aiLeaves = useMemo(
    () => (kind === 'ai_eval' ? flattenAiEvalRubricForScoring((problem as ProblemAiEval).points || []) : []),
    [kind, problem],
  );

  const handleSingle = (displayedIndex: number) => {
    if (locked || submitted) return;
    const p = problem as ProblemSingle;
    const originalIndex = optionOrder[displayedIndex] ?? displayedIndex;
    setSingleChoice(originalIndex);
    submit({ selected: originalIndex, correct: originalIndex === p.answer }, optionLabel(p.answer));
  };

  const handleMultiConfirm = () => {
    if (locked || submitted || !multiChoice.length) return;
    const p = problem as ProblemMulti;
    const chosen = [...multiChoice].sort((a, b) => a - b);
    submit(
      { selected: multiIndicesToBitmask(chosen), correct: setsEqualAsSorted(normalizeMultiAnswers(p.answer), chosen) },
      normalizeMultiAnswers(p.answer).map(optionLabel).join(' '),
    );
  };

  const handleTrueFalse = (value: 0 | 1) => {
    if (locked || submitted) return;
    const p = problem as ProblemTrueFalse;
    setTrueFalseChoice(value);
    submit({ selected: value, correct: value === p.answer }, p.answer === 1 ? i18n('True') : i18n('False'));
  };

  const handleFlipComplete = () => {
    if (locked || submitted) return;
    submit({ selected: 1, correct: true });
  };

  const handleFillBlank = () => {
    if (locked || submitted) return;
    const user = fillValues.map((value) => String(value ?? ''));
    const correct = fillBlankResponseMatches(fillBlank.answers || [], user);
    submit({ selected: correct ? 1 : 0, correct, fillAnswers: user }, (fillBlank.answers || []).join(' / '));
  };

  const handleMatching = () => {
    if (locked || submitted || !matchingRowCount) return;
    const picks: number[][] = Array.from({ length: matchingRowCount }, () => new Array(matchingColumns.length).fill(0));
    for (let row = 0; row < matchingRowCount; row += 1) {
      picks[row][0] = row;
      for (let column = 1; column < matchingColumns.length; column += 1) {
        picks[row][column] = matchingPicks[row]?.[column] ?? -1;
      }
    }
    const correct = matchingAllColumnsCorrect(matchingRowCount, matchingColumns.length, picks);
    const fillAnswers = picks.map((row) => row.map((value) => String(value ?? '')).join(','));
    submit({ selected: correct ? 1 : 0, correct, fillAnswers });
  };

  const handleSuperFlipSubmit = () => {
    if (locked || submitted) return;
    if (!superFlipAllFilledCellsRevealed(superFlip.columns, superFlipRevealed)) return;
    submit({ selected: 1, correct: true });
  };

  const handleChainSubmit = () => {
    if (locked || submitted) return;
    const allFlipRevealed = chainRows.every((row, index) => row.rowType !== 'flip' || chainRevealed[index]);
    if (!allFlipRevealed) return;
    submit({ selected: 1, correct: true });
  };

  const handleAiEval = async () => {
    if (locked || submitted || aiBusy) return;
    const p = problem as ProblemAiEval;
    const passScore = typeof p.passScore === 'number' && Number.isFinite(p.passScore) ? p.passScore : 60;
    const rubricLines = aiLeaves.map((leaf, index) => (
      `${index + 1}. ${String(leaf.title || '').trim()} — ${String(leaf.content || '').trim()} (${leaf.max} ${i18n('Points')})`
    ));
    const answerLines = aiLeaves.map((leaf, index) => `${index + 1}. ${String(aiDraft[leaf.subPointId] ?? '').trim()}`);
    const prompt = [
      'You grade one learner answer against a rubric. Reply with JSON only.',
      `Question: ${String(p.stem || '').trim()}`,
      `Rubric:\n${rubricLines.join('\n')}`,
      `Learner answer (one line per rubric row):\n${answerLines.join('\n')}`,
      `Point scores must be integers within each row maximum and pointScores/pointReasons must each have exactly ${aiLeaves.length} entries.`,
      `Pass score: ${passScore}`,
      'JSON: {"score":0-100,"feedback":"...","pointScores":[...],"pointReasons":[...]}',
    ].join('\n\n');
    setAiBusy(true);
    setAiError(null);
    try {
      const response = await requestJson<{ message?: string }>('/ai/chat', {
        domainId,
        acceptJson: true,
        body: { message: prompt, stream: false },
      });
      const text = String(response?.message ?? '');
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error(i18n('Problem ai eval invalid point scores'));
      const parsed = JSON.parse(match[0]) as { score?: number; feedback?: string; pointScores?: number[] };
      const fullScores = aiLeaves.map((leaf) => Math.max(0, Math.round(leaf.max)));
      const sumFull = fullScores.reduce((sum, value) => sum + value, 0);
      const pointScores = Array.isArray(parsed.pointScores) ? parsed.pointScores : [];
      if (pointScores.length !== aiLeaves.length) throw new Error(i18n('Problem ai eval invalid point scores'));
      const earned = pointScores.reduce((sum, raw, index) => {
        const slot = String(aiDraft[aiLeaves[index].subPointId] ?? '').trim();
        if (!slot.length) return sum;
        const value = Number.isFinite(raw) ? Math.round(raw as number) : 0;
        return sum + Math.max(0, Math.min(fullScores[index], value));
      }, 0);
      const score = sumFull > 0 ? Math.max(0, Math.min(100, Math.round((earned / sumFull) * 100))) : 0;
      const feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim() ? parsed.feedback.trim() : text;
      setAiResult({ score, feedback });
      submit({ selected: score, correct: score >= passScore });
    } catch (error: any) {
      setAiError(typeof error?.message === 'string' ? error.message : String(error ?? ''));
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="lesson-problem" data-kind={kind}>
      {problem.title?.trim() ? <h3 className="lesson-problem__title">{problem.title}</h3> : null}

      {kind === 'flip' ? (
        <div className="lesson-flip">
          <Markdown text={flip.faceA || ''} className="lesson-markdown lesson-flip__face" />
          {flipStage === 'b' ? <Markdown text={flip.faceB || ''} className="lesson-markdown lesson-flip__face is-back" /> : null}
          {flipStage === 'b' && flip.hint?.trim() ? (
            <p className="lesson-flip__hint">{i18n('Flip hint label')}{flip.hint}</p>
          ) : null}
          <div className="lesson-problem__actions">
            {flipStage === 'a' ? (
              <button type="button" className="lesson-btn" disabled={locked || submitted} onClick={() => setFlipStage('b')}>
                {i18n('Flip show back')}
              </button>
            ) : (
              <button type="button" className="lesson-btn is-primary" disabled={locked || submitted} onClick={handleFlipComplete}>
                {i18n('Flip mark done')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <Markdown text={(problem as { stem?: string }).stem || ''} className="lesson-markdown lesson-problem__stem" />
      )}

      {kind === 'single' ? (
        <div className="lesson-options">
          {optionOrder.map((originalIndex, displayedIndex) => {
            const option = options[originalIndex];
            const isPicked = singleChoice === originalIndex;
            const isAnswer = submitted && originalIndex === (problem as ProblemSingle).answer;
            return (
              <button
                key={`option-${displayedIndex}`}
                type="button"
                className={`lesson-option${isPicked ? ' is-picked' : ''}${isAnswer ? ' is-correct' : ''}${isPicked && !isAnswer ? ' is-wrong' : ''}`}
                disabled={locked || submitted}
                onClick={() => handleSingle(displayedIndex)}
              >
                <span className="lesson-option__label">{optionLabel(displayedIndex)}</span>
                <Markdown text={String(option ?? '')} inline className="lesson-option__text" />
              </button>
            );
          })}
        </div>
      ) : null}

      {kind === 'multi' ? (
        <>
          <div className="lesson-options">
            {optionOrder.map((originalIndex, displayedIndex) => {
              const option = options[originalIndex];
              const isPicked = multiChoice.includes(originalIndex);
              const isAnswer = submitted && normalizeMultiAnswers((problem as ProblemMulti).answer).includes(originalIndex);
              return (
                <button
                  key={`option-${displayedIndex}`}
                  type="button"
                  className={`lesson-option${isPicked ? ' is-picked' : ''}${isAnswer ? ' is-correct' : ''}${isPicked && !isAnswer ? ' is-wrong' : ''}`}
                  disabled={locked || submitted}
                  onClick={() => setMultiChoice((prev) => (prev.includes(originalIndex) ? prev.filter((value) => value !== originalIndex) : [...prev, originalIndex]))}
                >
                  <span className="lesson-option__label">{optionLabel(displayedIndex)}</span>
                  <Markdown text={String(option ?? '')} inline className="lesson-option__text" />
                </button>
              );
            })}
          </div>
          <div className="lesson-problem__actions">
            <button type="button" className="lesson-btn is-primary" disabled={locked || submitted || !multiChoice.length} onClick={handleMultiConfirm}>
              {i18n('Submit')}
            </button>
          </div>
        </>
      ) : null}

      {kind === 'true_false' ? (
        <div className="lesson-problem__actions">
          <button
            type="button"
            className={`lesson-btn${submitted && trueFalseChoice === 1 ? ' is-picked' : ''}`}
            disabled={locked || submitted}
            onClick={() => handleTrueFalse(1)}
          >
            {i18n('True')}
          </button>
          <button
            type="button"
            className={`lesson-btn${submitted && trueFalseChoice === 0 ? ' is-picked' : ''}`}
            disabled={locked || submitted}
            onClick={() => handleTrueFalse(0)}
          >
            {i18n('False')}
          </button>
        </div>
      ) : null}

      {kind === 'fill_blank' ? (
        <>
          <div className="lesson-fill-blanks">
            {fillValues.map((value, index) => (
              <label key={`blank-${index}`} className="lesson-fill-blank">
                <span className="lesson-fill-blank__label">{i18n('Blank', index + 1)}</span>
                <input
                  type="text"
                  value={value}
                  disabled={locked || submitted}
                  onChange={(event) => {
                    const typed = event.currentTarget.value;
                    setFillDraft((prev) => {
                      const next = [...prev];
                      while (next.length < fillBlankNeed) next.push('');
                      next[index] = typed;
                      return next;
                    });
                  }}
                />
              </label>
            ))}
          </div>
          <div className="lesson-problem__actions">
            <button
              type="button"
              className="lesson-btn is-primary"
              disabled={locked || submitted || fillValues.every((value) => !String(value).trim())}
              onClick={handleFillBlank}
            >
              {i18n('Submit')}
            </button>
          </div>
        </>
      ) : null}

      {kind === 'matching' ? (
        <>
          <div className="lesson-matching">
            <div className="lesson-matching__row lesson-matching__row--head">
              {matchingColumns.map((_, column) => (
                <span key={`head-${column}`} className="lesson-matching__cell">{i18n('Column', column + 1)}</span>
              ))}
            </div>
            {Array.from({ length: matchingRowCount }, (_, row) => (
              <div key={`row-${row}`} className="lesson-matching__row">
                {matchingColumns.map((column, columnIndex) => (
                  <div key={`cell-${row}-${columnIndex}`} className="lesson-matching__cell">
                    {columnIndex === 0 ? (
                      <Markdown text={String(column[row] ?? '')} inline className="lesson-matching__text" />
                    ) : (
                      <select
                        value={matchingPicks[row]?.[columnIndex] ?? -1}
                        disabled={locked || submitted}
                        onChange={(event) => {
                          const picked = Number(event.currentTarget.value);
                          setMatchingPicks((prev) => {
                            const next = Array.from({ length: matchingRowCount }, (_, rowIndex) => (
                              prev[rowIndex] ? [...prev[rowIndex]] : new Array(matchingColumns.length).fill(-1)
                            ));
                            next[row][columnIndex] = picked;
                            return next;
                          });
                        }}
                      >
                        <option value={-1}>{i18n('Select')}</option>
                        {(matchingSelectOrders[row]?.[columnIndex] ?? []).map((optionIndex) => (
                          <option key={`option-${optionIndex}`} value={optionIndex}>{String(column[optionIndex] ?? '')}</option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="lesson-problem__actions">
            <button
              type="button"
              className="lesson-btn is-primary"
              disabled={locked || submitted || Array.from({ length: matchingRowCount }, (_, row) => row)
                .some((row) => (matchingPicks[row] || []).slice(1).some((value) => typeof value !== 'number' || value < 0))}
              onClick={handleMatching}
            >
              {i18n('Submit')}
            </button>
          </div>
        </>
      ) : null}

      {kind === 'super_flip' ? (
        <>
          <div className="lesson-table" style={{ gridTemplateColumns: `repeat(${Math.max(1, superFlip.columns.length)}, minmax(0, 1fr))` }}>
            {superFlip.headers.map((header, columnIndex) => (
              <div key={`header-${columnIndex}`} className="lesson-table__head">{header}</div>
            ))}
            {Array.from({ length: superFlip.columns[0]?.length ?? 0 }, (_, row) => superFlip.columns.map((column, columnIndex) => {
              const cell = String(column[row] ?? '');
              const hasContent = superFlipCellHasContent(cell);
              const revealed = Boolean(superFlipRevealed[columnIndex]?.[row]) || !hasContent;
              return (
                <button
                  key={`cell-${columnIndex}-${row}`}
                  type="button"
                  className={`lesson-table__cell${revealed ? ' is-revealed' : ' is-masked'}${hasContent ? '' : ' is-empty'}`}
                  disabled={locked || submitted || !hasContent}
                  onClick={() => setSuperFlipRevealed((prev) => {
                    const next = prev.map((entry) => [...entry]);
                    while (next.length < superFlip.columns.length) next.push([]);
                    if (!next[columnIndex]) next[columnIndex] = [];
                    next[columnIndex][row] = !next[columnIndex][row];
                    return next;
                  })}
                >
                  {revealed ? <Markdown text={cell} inline className="lesson-markdown" /> : i18n('Flip show front')}
                </button>
              );
            }))}
          </div>
          <div className="lesson-problem__actions">
            <button
              type="button"
              className="lesson-btn"
              disabled={locked || submitted}
              onClick={() => setSuperFlipRevealed(superFlip.columns.map((column) => column.map((cell) => superFlipCellHasContent(cell))))}
            >
              {i18n('Reveal all')}
            </button>
            <button
              type="button"
              className="lesson-btn"
              disabled={locked || submitted}
              onClick={() => setSuperFlipRevealed(superFlip.columns.map((column) => column.map(() => false)))}
            >
              {i18n('Cover all')}
            </button>
            <button
              type="button"
              className="lesson-btn is-primary"
              disabled={locked || submitted || !superFlipAllFilledCellsRevealed(superFlip.columns, superFlipRevealed)}
              onClick={handleSuperFlipSubmit}
            >
              {i18n('Know it')}
            </button>
            <button
              type="button"
              className="lesson-btn"
              disabled={locked || submitted}
              onClick={() => submit({ selected: 0, correct: false })}
            >
              {i18n('Not familiar')}
            </button>
          </div>
        </>
      ) : null}

      {kind === 'chain' ? (
        <>
          <div className="lesson-chain">
            {chainRows.map((row, index) => {
              const isFlip = row.rowType === 'flip';
              const revealed = !isFlip || Boolean(chainRevealed[index]);
              return (
                <button
                  key={`chain-${index}`}
                  type="button"
                  className={`lesson-chain__row${revealed ? ' is-revealed' : ' is-masked'}`}
                  disabled={locked || submitted || !isFlip}
                  onClick={() => setChainRevealed((prev) => {
                    const next = [...prev];
                    next[index] = !next[index];
                    return next;
                  })}
                >
                  {revealed ? <Markdown text={String(row.content ?? '')} inline className="lesson-markdown" /> : i18n('Flip show front')}
                </button>
              );
            })}
          </div>
          <div className="lesson-problem__actions">
            <button type="button" className="lesson-btn" disabled={locked || submitted} onClick={() => setChainRevealed(chainRows.map((row) => row.rowType === 'flip'))}>
              {i18n('Reveal all')}
            </button>
            <button type="button" className="lesson-btn" disabled={locked || submitted} onClick={() => setChainRevealed(chainRows.map(() => false))}>
              {i18n('Cover all')}
            </button>
            <button
              type="button"
              className="lesson-btn is-primary"
              disabled={locked || submitted || !chainRows.every((row, index) => row.rowType !== 'flip' || chainRevealed[index])}
              onClick={handleChainSubmit}
            >
              {i18n('Know it')}
            </button>
            <button type="button" className="lesson-btn" disabled={locked || submitted} onClick={() => submit({ selected: 0, correct: false })}>
              {i18n('Not familiar')}
            </button>
          </div>
        </>
      ) : null}

      {kind === 'ai_eval' ? (
        <>
          <div className="lesson-ai-eval">
            {aiLeaves.map((leaf, index) => (
              <label key={leaf.subPointId} className="lesson-ai-eval__slot">
                <span className="lesson-ai-eval__label">{index + 1}. {String(leaf.title || '').trim()}（{leaf.max} {i18n('Points')}）</span>
                <span className="lesson-ai-eval__rubric">{String(leaf.content || '').trim()}</span>
                <textarea
                  rows={2}
                  value={aiDraft[leaf.subPointId] ?? ''}
                  disabled={locked || submitted || aiBusy}
                  onChange={(event) => {
                    const typed = event.currentTarget.value;
                    setAiDraft((prev) => ({ ...prev, [leaf.subPointId]: typed }));
                  }}
                />
              </label>
            ))}
          </div>
          {aiError ? <p className="lesson-ai-eval__error">{aiError}</p> : null}
          <div className="lesson-problem__actions">
            <button
              type="button"
              className="lesson-btn is-primary"
              disabled={locked || submitted || aiBusy || aiLeaves.some((leaf) => !String(aiDraft[leaf.subPointId] ?? '').trim())}
              onClick={() => void handleAiEval()}
            >
              {aiBusy ? i18n('Loading...') : i18n('AI grade')}
            </button>
            <button type="button" className="lesson-btn" disabled={locked || submitted} onClick={onSkip}>
              {i18n('Lesson skip problem')}
            </button>
          </div>
          {aiResult ? (
            <p className="lesson-ai-eval__score">{i18n('Score')}: {aiResult.score} · {aiResult.feedback}</p>
          ) : null}
        </>
      ) : null}

      {grading ? (
        <AnswerFeedback
          correct={grading.correct}
          correctAnswer={correctAnswerText}
          analysis={String(problem.analysis || '')}
          extra={grading.fillAnswers?.length ? (
            <p className="lesson-feedback__answer">{i18n('Your answer')}: {grading.fillAnswers.join(' / ')}</p>
          ) : null}
        />
      ) : null}
    </div>
  );
}
