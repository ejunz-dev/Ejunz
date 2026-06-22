import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Notification from 'vj/components/notification';
import { request, i18n } from 'vj/utils';
import type {
  Problem,
  ProblemSingle,
  ProblemMulti,
  ProblemTrueFalse,
  ProblemFlip,
  ProblemMatching,
  ProblemSuperFlip,
  ProblemAiEval,
  ProblemAiEvalSubPoint,
  ProblemKind,
} from 'ejun/src/interface';
import {
  problemKind,
  problemChangeKind,
  clampOptionSlots,
  ensureOptionArrayLength,
  normalizeMultiAnswers,
  getProblemTagList,
  aiEvalRubricSumMax,
  matchingColumnsNormalized,
  superFlipNormalized,
  fillBlankSlotCount,
  syncFillBlankAnswersLen,
  MATCHING_PAIR_MIN,
  MATCHING_PAIR_MAX,
  MATCHING_COL_MIN,
  MATCHING_COL_MAX,
  SUPER_FLIP_ROW_MIN,
  SUPER_FLIP_ROW_MAX,
  SUPER_FLIP_COL_MIN,
  SUPER_FLIP_COL_MAX,
} from 'ejun/src/model/problem';

export type LearnProblemNotesDraftBatch = {
  cardId: string;
  pid: string;
  create: string[];
  update: Array<{ id: string; content: string }>;
  deleteIds: string[];
};

function baseProblemJsonStable(a: Problem, b: Problem): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function problemKindLabelI18n(k: ProblemKind): string {
  switch (k) {
    case 'single':
      return i18n('Problem kind single');
    case 'multi':
      return i18n('Problem kind multi');
    case 'true_false':
      return i18n('Problem kind true false');
    case 'flip':
      return i18n('Problem kind flip');
    case 'matching':
      return i18n('Problem kind matching');
    case 'super_flip':
      return i18n('Problem kind super flip');
    case 'fill_blank':
      return i18n('Problem kind fill blank');
    case 'ai_eval':
      return i18n('Problem kind ai eval');
    default:
      return k;
  }
}

export function makeBlankSingleProblem(): ProblemSingle {
  return {
    pid: `p_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    type: 'single',
    stem: '',
    options: ['', '', '', ''],
    answer: 0,
  };
}

type EditorLearnerNoteRow = {
  id: string;
  uid: number;
  uname: string;
  content: string;
  createdAt: string;
};

function cloneLearnerRows(rows: EditorLearnerNoteRow[]): EditorLearnerNoteRow[] {
  return rows.map((r) => ({ ...r }));
}

function computeLearnerNotesDraft(
  baseline: EditorLearnerNoteRow[],
  rows: EditorLearnerNoteRow[],
  cardId: string,
  pid: string,
): LearnProblemNotesDraftBatch | null {
  const baseMap = new Map(baseline.map((r) => [r.id, r]));
  const curIds = new Set(rows.map((r) => r.id));
  const deleteIds: string[] = [];
  for (const id of baseMap.keys()) {
    if (!curIds.has(id)) deleteIds.push(id);
  }
  const create: string[] = [];
  const update: Array<{ id: string; content: string }> = [];
  for (const r of rows) {
    if (r.id.startsWith('local_')) {
      const t = r.content.trim().slice(0, 4000);
      if (t) create.push(t);
      continue;
    }
    const b = baseMap.get(r.id);
    if (!b) continue;
    const t = r.content.trim().slice(0, 4000);
    if (!t) {
      if (!deleteIds.includes(r.id)) deleteIds.push(r.id);
    } else if (b.content.trim() !== t) {
      update.push({ id: r.id, content: t });
    }
  }
  const uniqDelete = [...new Set(deleteIds)];
  if (create.length === 0 && update.length === 0 && uniqDelete.length === 0) return null;
  return { cardId, pid, create, update, deleteIds: uniqDelete };
}

export const EditableProblem = React.memo(({
  problem,
  index,
  cardId: _cardId,
  borderColor,
  borderStyle,
  isNew,
  isEdited,
  originalProblem: _originalProblem,
  onUpdate,
  onDelete,
  onReorderUp,
  onReorderDown,
  reorderDisableUp,
  reorderDisableDown,
  docId,
  getBaseUrl,
  themeStyles,
  onProblemContextMenu,
  learnerNotesReloadEpoch = 0,
  onLearnerNotesDraftChange,
}: {
  problem: Problem;
  index: number;
  cardId: string;
  borderColor: string;
  borderStyle: string;
  isNew: boolean;
  isEdited: boolean;
  originalProblem?: Problem;
  onUpdate: (updated: Problem) => void;
  onDelete: () => void;
  /** When set together with {@link onReorderDown}, reorder buttons render left of delete. */
  onReorderUp?: () => void;
  onReorderDown?: () => void;
  reorderDisableUp?: boolean;
  reorderDisableDown?: boolean;
  docId: string;
  getBaseUrl: (path: string, docId: string) => string;
  themeStyles: any;
  onProblemContextMenu?: (event: React.MouseEvent) => void;
  /** Bumped after batch save so learner notes reload from server. */
  learnerNotesReloadEpoch?: number;
  onLearnerNotesDraftChange?: (draftKey: string, batch: LearnProblemNotesDraftBatch | null) => void;
}) => {
  const [model, setModel] = useState<Problem>(problem);
  /** Parent `problem` snapshot by JSON; resync local `model` when AI / agent replaces the same `pid` in-place. */
  const lastExternalProblemJsonRef = useRef<string>(JSON.stringify(problem));
  /** After syncing from parent, skip one outgoing `onUpdate` to avoid parent/model ping-pong (max update depth). */
  const skipNextOutgoingUpdateRef = useRef(false);

  useLayoutEffect(() => {
    const json = JSON.stringify(problem);
    if (json !== lastExternalProblemJsonRef.current) {
      lastExternalProblemJsonRef.current = json;
      skipNextOutgoingUpdateRef.current = true;
      setModel(problem);
    }
  }, [problem]);

  useEffect(() => {
    if (skipNextOutgoingUpdateRef.current) {
      skipNextOutgoingUpdateRef.current = false;
      return;
    }
    if (baseProblemJsonStable(model, problem)) return;
    onUpdate(model);
  }, [model, problem, onUpdate]);

  const kind = problemKind(model);

  const currentProblemTags = useMemo(() => getProblemTagList(model), [model]);

  const analysis = model.analysis || '';

  const editorDomainId = typeof window !== 'undefined' ? String((window as any).UiContext?.domainId ?? '').trim() : '';
  const isTempCard = String(_cardId).startsWith('temp-card-');
  const [learnerNoteRows, setLearnerNoteRows] = useState<EditorLearnerNoteRow[]>([]);
  const [learnerNotesLoading, setLearnerNotesLoading] = useState(false);
  const learnerNotesBaselineRef = useRef<EditorLearnerNoteRow[]>([]);
  const learnerDraftKeyPrevRef = useRef<string | null>(null);

  useEffect(() => {
    if (!onLearnerNotesDraftChange) return;
    const key = `${_cardId}\x1f${problem.pid}`;
    const prev = learnerDraftKeyPrevRef.current;
    if (prev && prev !== key) {
      onLearnerNotesDraftChange(prev, null);
    }
    learnerDraftKeyPrevRef.current = key;
  }, [_cardId, problem.pid, onLearnerNotesDraftChange]);

  useEffect(() => {
    if (!onLearnerNotesDraftChange) return;
    return () => {
      const k = learnerDraftKeyPrevRef.current;
      if (k) onLearnerNotesDraftChange(k, null);
    };
  }, [onLearnerNotesDraftChange]);

  useLayoutEffect(() => {
    setLearnerNoteRows([]);
    learnerNotesBaselineRef.current = [];
  }, [_cardId, problem.pid]);

  const reloadLearnerNotes = useCallback(async () => {
    if (!editorDomainId || !_cardId || !problem.pid || isTempCard) return;
    setLearnerNotesLoading(true);
    try {
      const res: any = await request.get(`/d/${editorDomainId}/learn/problem-notes`, { cardId: _cardId, pid: problem.pid });
      const list = Array.isArray(res?.learnerNotes) ? res.learnerNotes : [];
      const mapped: EditorLearnerNoteRow[] = list.map((x: any) => ({
        id: String(x.id || ''),
        uid: Number(x.uid) || 0,
        uname: String(x.uname || ''),
        content: String(x.content || ''),
        createdAt: String(x.createdAt || ''),
      }));
      setLearnerNoteRows(mapped);
      learnerNotesBaselineRef.current = cloneLearnerRows(mapped);
    } catch {
      setLearnerNoteRows([]);
      learnerNotesBaselineRef.current = [];
      Notification.error(i18n('Lesson problem notes load failed'));
    } finally {
      setLearnerNotesLoading(false);
    }
  }, [editorDomainId, _cardId, problem.pid, learnerNotesReloadEpoch, isTempCard]);

  useEffect(() => {
    void reloadLearnerNotes();
  }, [reloadLearnerNotes]);

  useEffect(() => {
    if (!onLearnerNotesDraftChange || !problem.pid || !_cardId) return;
    const key = `${_cardId}\x1f${problem.pid}`;
    if (isTempCard) {
      onLearnerNotesDraftChange(key, null);
      return;
    }
    const draft = computeLearnerNotesDraft(learnerNotesBaselineRef.current, learnerNoteRows, _cardId, problem.pid);
    onLearnerNotesDraftChange(key, draft);
  }, [learnerNoteRows, _cardId, problem.pid, onLearnerNotesDraftChange, isTempCard]);

  const setCommon = (patch: Partial<Pick<Problem, 'analysis' | 'title'>>) => {
    setModel((m) => ({ ...m, ...patch } as Problem));
  };

  const onKindChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const k = e.target.value as ProblemKind;
    if (k === problemKind(model)) return;
    setModel((m) => problemChangeKind(m, k));
  };

  const optionSlotsNow = (): number => {
    if (kind === 'single') {
      const m = model as ProblemSingle;
      return clampOptionSlots(m.optionSlots ?? m.options?.length);
    }
    if (kind === 'multi') {
      const m = model as ProblemMulti;
      return clampOptionSlots(m.optionSlots ?? m.options?.length);
    }
    return 4;
  };

  const applyOptionSlots = (raw: number) => {
    const slots = clampOptionSlots(raw);
    if (kind === 'single') {
      const m = model as ProblemSingle;
      const opts = ensureOptionArrayLength([...m.options], slots);
      let ans = m.answer;
      if (ans >= opts.length) ans = Math.max(0, opts.length - 1);
      setModel({ ...m, options: opts, optionSlots: slots, answer: ans });
    } else if (kind === 'multi') {
      const m = model as ProblemMulti;
      const opts = ensureOptionArrayLength([...m.options], slots);
      const cur = normalizeMultiAnswers(m.answer).filter((i) => i < opts.length);
      const nextAns = cur.length ? cur : [0];
      setModel({ ...m, options: opts, optionSlots: slots, answer: nextAns });
    }
  };

  const toggleMultiAnswer = (oi: number) => {
    const m = model as ProblemMulti;
    const cur = new Set(normalizeMultiAnswers(m.answer));
    if (cur.has(oi)) cur.delete(oi);
    else cur.add(oi);
    const arr = [...cur].sort((a, b) => a - b);
    setModel({ ...m, answer: arr.length ? arr : [oi] });
  };

  const taStyle: React.CSSProperties = {
    width: '100%',
    minHeight: '40px',
    resize: 'vertical' as const,
    fontSize: '12px',
    padding: '4px 6px',
    boxSizing: 'border-box',
    border: `1px solid ${themeStyles.borderPrimary}`,
    borderRadius: '2px',
    backgroundColor: themeStyles.bgPrimary,
    color: themeStyles.textPrimary,
  };
  const inpStyle: React.CSSProperties = {
    fontSize: '12px',
    padding: '3px 6px',
    boxSizing: 'border-box',
    border: `1px solid ${themeStyles.borderPrimary}`,
    borderRadius: '2px',
    backgroundColor: themeStyles.bgPrimary,
    color: themeStyles.textPrimary,
  };

  const reorderBar = !!(onReorderUp && onReorderDown);
  const headerPadRight = reorderBar ? 96 : 28;

  return (
    <div
      onContextMenu={(e) => {
        if (!onProblemContextMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onProblemContextMenu(e);
      }}
      style={{
        border: `1px ${borderStyle} ${borderColor}`,
        borderRadius: '4px',
        padding: '6px 8px',
        marginBottom: '6px',
        background: themeStyles.bgPrimary,
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '4px',
          right: '4px',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        {reorderBar ? (
          <>
            <button
              type="button"
              aria-label={String(i18n('Problem reorder up'))}
              title={String(i18n('Problem reorder up'))}
              disabled={!!reorderDisableUp}
              onClick={(e) => {
                e.stopPropagation();
                onReorderUp!();
              }}
              style={{
                width: '20px',
                height: '20px',
                padding: 0,
                flexShrink: 0,
                fontSize: '11px',
                lineHeight: '18px',
                borderRadius: '3px',
                border: `1px solid ${themeStyles.borderPrimary}`,
                background: reorderDisableUp ? themeStyles.bgSecondary : themeStyles.bgPrimary,
                color: themeStyles.textPrimary,
                cursor: reorderDisableUp ? 'not-allowed' : 'pointer',
                opacity: reorderDisableUp ? 0.45 : 1,
              }}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={String(i18n('Problem reorder down'))}
              title={String(i18n('Problem reorder down'))}
              disabled={!!reorderDisableDown}
              onClick={(e) => {
                e.stopPropagation();
                onReorderDown!();
              }}
              style={{
                width: '20px',
                height: '20px',
                padding: 0,
                flexShrink: 0,
                fontSize: '11px',
                lineHeight: '18px',
                borderRadius: '3px',
                border: `1px solid ${themeStyles.borderPrimary}`,
                background: reorderDisableDown ? themeStyles.bgSecondary : themeStyles.bgPrimary,
                color: themeStyles.textPrimary,
                cursor: reorderDisableDown ? 'not-allowed' : 'pointer',
                opacity: reorderDisableDown ? 0.45 : 1,
              }}
            >
              ↓
            </button>
          </>
        ) : null}
        <div
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          style={{
            width: '20px',
            height: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            borderRadius: '3px',
            backgroundColor: '#f44336',
            color: '#fff',
            fontSize: '12px',
            fontWeight: 'bold',
            userSelect: 'none',
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = '#d32f2f';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = '#f44336';
          }}
          title={String(i18n('Delete problem'))}
        >
          ×
        </div>
      </div>
      <div style={{
        fontSize: '12px',
        fontWeight: 500,
        marginBottom: '6px',
        paddingRight: `${headerPadRight}px`,
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
      }}
      >
        <span>
          Q{index + 1}
          （
          {problemKindLabelI18n(kind)}
          ）
        </span>
        <label style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: 4, color: themeStyles.textPrimary }}>
          {i18n('Problem field type')}
          <select value={kind} onChange={onKindChange} style={{ ...inpStyle, minWidth: 88 }}>
            <option value="single">{i18n('Problem kind single')}</option>
            <option value="multi">{i18n('Problem kind multi')}</option>
            <option value="true_false">{i18n('Problem kind true false')}</option>
            <option value="flip">{i18n('Problem kind flip')}</option>
            <option value="matching">{i18n('Problem kind matching')}</option>
            <option value="super_flip">{i18n('Problem kind super flip')}</option>
            <option value="fill_blank">{i18n('Problem kind fill blank')}</option>
            <option value="ai_eval">{i18n('Problem kind ai eval')}</option>
          </select>
        </label>
        <div
          style={{
            fontSize: '11px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 6,
            color: themeStyles.textPrimary,
            flexWrap: 'wrap',
            maxWidth: '100%',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
            <span style={{ flexShrink: 0 }}>{i18n('Problem tag')}</span>
            <span style={{ fontSize: '10px', color: themeStyles.textTertiary, flex: '1 1 120px', minWidth: 0 }}>
              {i18n('Problem tag editor read only hint')}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
            {currentProblemTags.length > 0
              ? currentProblemTags.map((t) => (
                <span
                  key={t}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    backgroundColor: themeStyles.bgSecondary ?? themeStyles.bgPrimary,
                    fontSize: '11px',
                    fontWeight: 600,
                    maxWidth: '100%',
                    wordBreak: 'break-word',
                  }}
                >
                  {t}
                </span>
              ))
              : (
                <span style={{ fontSize: '11px', color: themeStyles.textSecondary, fontStyle: 'italic' }}>
                  {i18n('Problem tag none')}
                </span>
              )}
          </div>
        </div>
        {isNew && <span style={{ fontSize: '10px', color: themeStyles.success }}>{i18n('New')}</span>}
        {isEdited && !isNew && <span style={{ fontSize: '10px', color: themeStyles.warning }}>{i18n('Edited')}</span>}
      </div>

      <div style={{ marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>
          {i18n('Problem title')}
        </div>
        <input
          type="text"
          value={typeof model.title === 'string' ? model.title : ''}
          onChange={(e) => setCommon({ title: e.target.value })}
          style={{ ...inpStyle, width: '100%' }}
        />
      </div>

      {kind === 'flip' ? (
        <>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>{i18n('Problem face A label')}</div>
            <textarea
              value={(model as ProblemFlip).faceA}
              onChange={(e) => setModel({ ...(model as ProblemFlip), faceA: e.target.value })}
              placeholder={i18n('Problem face A placeholder')}
              style={taStyle}
            />
          </div>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>{i18n('Problem face B label')}</div>
            <textarea
              value={(model as ProblemFlip).faceB}
              onChange={(e) => setModel({ ...(model as ProblemFlip), faceB: e.target.value })}
              placeholder={i18n('Problem face B placeholder')}
              style={taStyle}
            />
          </div>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>{i18n('Problem flip hint label')}</div>
            <textarea
              value={(model as ProblemFlip).hint ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                const cur = { ...(model as ProblemFlip) };
                if (v.trim()) cur.hint = v;
                else delete cur.hint;
                setModel(cur);
              }}
              placeholder={i18n('Problem flip hint placeholder')}
              style={taStyle}
            />
          </div>
        </>
      ) : kind === 'fill_blank' ? (
        <>
          <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 6 }}>
            {i18n('Problem fill blank stem hint')}
          </div>
          <div style={{ marginBottom: '4px' }}>
            <textarea
              value={(model as ProblemFillBlank).stem}
              onChange={(e) => {
                const stem = e.target.value;
                const m = model as ProblemFillBlank;
                const n = fillBlankSlotCount(stem);
                setModel({
                  ...m,
                  stem,
                  answers: syncFillBlankAnswersLen(m.answers, n),
                });
              }}
              placeholder={i18n('Stem')}
              style={taStyle}
            />
          </div>
          <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 4 }}>
            {i18n('Problem fill blank answers label')}
          </div>
          {(model as ProblemFillBlank).answers.map((ans, bi) => (
            <div key={bi} style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, color: themeStyles.textPrimary, minWidth: 52 }}>
                {i18n('Problem fill blank slot label', bi + 1)}
              </span>
              <input
                value={ans}
                onChange={(e) => {
                  const m = model as ProblemFillBlank;
                  const next = [...m.answers];
                  next[bi] = e.target.value;
                  setModel({ ...m, answers: next });
                }}
                placeholder={i18n('Correct answer')}
                style={{ ...inpStyle, flex: 1 }}
              />
            </div>
          ))}
        </>
      ) : kind === 'matching' ? (
        <>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>{i18n('Stem')}</div>
            <textarea
              value={(model as ProblemMatching).stem ?? ''}
              onChange={(e) =>
                setModel({ ...(model as ProblemMatching), stem: e.target.value.trim() ? e.target.value : undefined })
              }
              placeholder={i18n('Problem matching stem optional')}
              style={taStyle}
            />
          </div>
          <div
            style={{
              marginBottom: '8px',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              color: themeStyles.textPrimary,
            }}
          >
            <span>{i18n('Problem matching pair count')}</span>
            <select
              value={matchingColumnsNormalized(model as ProblemMatching)[0]?.length || MATCHING_PAIR_MIN}
              onChange={(e) => {
                const mm = model as ProblemMatching;
                const nRows = Math.min(MATCHING_PAIR_MAX, Math.max(MATCHING_PAIR_MIN, parseInt(e.target.value, 10) || MATCHING_PAIR_MIN));
                let cols = matchingColumnsNormalized(mm);
                cols = cols.map((col) => {
                  const next = [...col];
                  while (next.length < nRows) next.push('');
                  return next.slice(0, nRows);
                });
                const norm = normalizeMatchingColumns(cols);
                setModel({
                  ...mm,
                  columns: norm,
                  left: norm[0],
                  right: norm[norm.length - 1],
                });
              }}
              style={{ ...inpStyle, minWidth: 52 }}
            >
              {Array.from({ length: MATCHING_PAIR_MAX - MATCHING_PAIR_MIN + 1 }, (_, i) => MATCHING_PAIR_MIN + i).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>{i18n('Problem matching column count')}</span>
            <select
              value={matchingColumnsNormalized(model as ProblemMatching).length}
              onChange={(e) => {
                const mm = model as ProblemMatching;
                const ncol = Math.min(MATCHING_COL_MAX, Math.max(MATCHING_COL_MIN, parseInt(e.target.value, 10) || MATCHING_COL_MIN));
                let cols = matchingColumnsNormalized(mm);
                const nrow = cols[0]?.length ?? MATCHING_PAIR_MIN;
                const nextCols: string[][] = [];
                for (let c = 0; c < ncol; c++) {
                  const prev = cols[c] || [];
                  const pad = [...prev];
                  while (pad.length < nrow) pad.push('');
                  nextCols.push(pad.slice(0, nrow));
                }
                const norm = normalizeMatchingColumns(nextCols);
                setModel({
                  ...mm,
                  columns: norm,
                  left: norm[0],
                  right: norm[norm.length - 1],
                });
              }}
              style={{ ...inpStyle, minWidth: 52 }}
            >
              {Array.from({ length: MATCHING_COL_MAX - MATCHING_COL_MIN + 1 }, (_, i) => MATCHING_COL_MIN + i).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 6 }}>
            {i18n('Problem matching pairs hint')}
          </div>
          <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {matchingColumnsNormalized(model as ProblemMatching).map((_, ci) => (
              <span key={`mch-${ci}`} style={{ minWidth: 56 }}>{String(i18n('Problem matching column label', ci + 1))}</span>
            ))}
          </div>
          {(() => {
            const mm = model as ProblemMatching;
            const cols = matchingColumnsNormalized(mm);
            const nRows = cols[0]?.length ?? MATCHING_PAIR_MIN;
            return Array.from({ length: nRows }, (_, mi) => (
              <div key={mi} style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: themeStyles.textSecondary, minWidth: 64 }}>
                  {String(i18n('Problem matching row label', mi + 1))}
                </span>
                {cols.map((col, ci) => (
                  <input
                    key={`${mi}-${ci}`}
                    value={col[mi] ?? ''}
                    onChange={(e) => {
                      const cur = matchingColumnsNormalized(mm);
                      const nextCols = cur.map((c) => [...c]);
                      nextCols[ci][mi] = e.target.value;
                      const norm = normalizeMatchingColumns(nextCols);
                      setModel({
                        ...mm,
                        columns: norm,
                        left: norm[0],
                        right: norm[norm.length - 1],
                      });
                    }}
                    placeholder={i18n('Problem matching cell')}
                    style={{ ...inpStyle, flex: '1 1 100px', minWidth: '90px', maxWidth: '220px' }}
                  />
                ))}
              </div>
            ));
          })()}
        </>
      ) : kind === 'super_flip' ? (
        <>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>{i18n('Stem')}</div>
            <textarea
              value={(model as ProblemSuperFlip).stem ?? ''}
              onChange={(e) =>
                setModel({ ...(model as ProblemSuperFlip), stem: e.target.value.trim() ? e.target.value : undefined })
              }
              placeholder={i18n('Problem matching stem optional')}
              style={taStyle}
            />
          </div>
          <div
            style={{
              marginBottom: '8px',
              fontSize: '11px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
              color: themeStyles.textPrimary,
            }}
          >
            <span>{i18n('Problem super flip row count')}</span>
            <select
              value={superFlipNormalized(model as ProblemSuperFlip).columns[0]?.length || SUPER_FLIP_ROW_MIN}
              onChange={(e) => {
                const sf = model as ProblemSuperFlip;
                const nRows = Math.min(
                  SUPER_FLIP_ROW_MAX,
                  Math.max(SUPER_FLIP_ROW_MIN, parseInt(e.target.value, 10) || SUPER_FLIP_ROW_MIN),
                );
                let { headers, columns } = superFlipNormalized(sf);
                columns = columns.map((col) => {
                  const next = [...col];
                  while (next.length < nRows) next.push('');
                  return next.slice(0, nRows);
                });
                const norm = normalizeSuperFlipColumns(columns);
                headers = headers.slice(0, norm.length);
                while (headers.length < norm.length) headers.push('');
                setModel({ ...sf, headers, columns: norm });
              }}
              style={{ ...inpStyle, minWidth: 52 }}
            >
              {Array.from({ length: SUPER_FLIP_ROW_MAX - SUPER_FLIP_ROW_MIN + 1 }, (_, i) => SUPER_FLIP_ROW_MIN + i).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            <span>{i18n('Problem super flip column count')}</span>
            <select
              value={superFlipNormalized(model as ProblemSuperFlip).columns.length}
              onChange={(e) => {
                const sf = model as ProblemSuperFlip;
                const ncol = Math.min(
                  SUPER_FLIP_COL_MAX,
                  Math.max(SUPER_FLIP_COL_MIN, parseInt(e.target.value, 10) || SUPER_FLIP_COL_MIN),
                );
                let { headers, columns } = superFlipNormalized(sf);
                const nrow = columns[0]?.length ?? SUPER_FLIP_ROW_MIN;
                const nextCols: string[][] = [];
                for (let c = 0; c < ncol; c++) {
                  const prev = columns[c] || [];
                  const pad = [...prev];
                  while (pad.length < nrow) pad.push('');
                  nextCols.push(pad.slice(0, nrow));
                }
                const norm = normalizeSuperFlipColumns(nextCols);
                let nextHeaders = headers.slice(0, norm.length);
                while (nextHeaders.length < norm.length) nextHeaders.push('');
                nextHeaders = nextHeaders.slice(0, norm.length);
                setModel({ ...sf, headers: nextHeaders, columns: norm });
              }}
              style={{ ...inpStyle, minWidth: 52 }}
            >
              {Array.from({ length: SUPER_FLIP_COL_MAX - SUPER_FLIP_COL_MIN + 1 }, (_, i) => SUPER_FLIP_COL_MIN + i).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 6 }}>
            {i18n('Problem super flip editor hint')}
          </div>
          <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {superFlipNormalized(model as ProblemSuperFlip).headers.map((_, ci) => (
              <span key={`sfh-label-${ci}`} style={{ minWidth: 56, display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
                <span>{String(i18n('Problem super flip column header label', ci + 1))}</span>
                <input
                  value={superFlipNormalized(model as ProblemSuperFlip).headers[ci] ?? ''}
                  onChange={(e) => {
                    const sf = model as ProblemSuperFlip;
                    const { headers: hs, columns: cols } = superFlipNormalized(sf);
                    const nh = [...hs];
                    nh[ci] = e.target.value;
                    setModel({ ...sf, headers: nh, columns: cols });
                  }}
                  placeholder={i18n('Problem super flip header placeholder')}
                  style={{ ...inpStyle, minWidth: '90px', maxWidth: '220px' }}
                />
              </span>
            ))}
          </div>
          {(() => {
            const sf = model as ProblemSuperFlip;
            const { columns } = superFlipNormalized(sf);
            const nRows = columns[0]?.length ?? SUPER_FLIP_ROW_MIN;
            return Array.from({ length: nRows }, (_, mi) => (
              <div key={mi} style={{ marginBottom: 10, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: themeStyles.textSecondary, minWidth: 64 }}>
                  {String(i18n('Problem matching row label', mi + 1))}
                </span>
                {columns.map((col, ci) => (
                  <input
                    key={`${mi}-${ci}`}
                    value={col[mi] ?? ''}
                    onChange={(e) => {
                      const cur = superFlipNormalized(sf).columns;
                      const nextCols = cur.map((c) => [...c]);
                      nextCols[ci][mi] = e.target.value;
                      const norm = normalizeSuperFlipColumns(nextCols);
                      const { headers: hh } = superFlipNormalized(sf);
                      let nh = hh.slice(0, norm.length);
                      while (nh.length < norm.length) nh.push('');
                      nh = nh.slice(0, norm.length);
                      setModel({ ...sf, headers: nh, columns: norm });
                    }}
                    placeholder={i18n('Problem matching cell')}
                    style={{ ...inpStyle, flex: '1 1 100px', minWidth: '90px', maxWidth: '220px' }}
                  />
                ))}
              </div>
            ));
          })()}
        </>
      ) : kind === 'ai_eval' ? (
        <>
          <div style={{ marginBottom: '4px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 2 }}>
              {i18n('Stem')}
            </div>
            <textarea
              value={(model as ProblemAiEval).stem}
              onChange={(e) => setModel({ ...(model as ProblemAiEval), stem: e.target.value })}
              placeholder={i18n('Problem ai eval stem placeholder')}
              style={taStyle}
            />
          </div>
          <div style={{ marginBottom: '8px' }}>
            <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: 6 }}>
              {i18n('Problem ai eval points')}
            </div>
            {(Array.isArray((model as ProblemAiEval).points) ? (model as ProblemAiEval).points : []).map((pt, pi) => (
              <div key={pt.id || `pt-${pi}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6, border: `1px solid ${themeStyles.borderPrimary}`, borderRadius: 4, padding: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    value={pt.title ?? ''}
                    onChange={(e) => {
                      const m = model as ProblemAiEval;
                      const pts = Array.isArray(m.points) ? [...m.points] : [];
                      pts[pi] = { ...pts[pi], title: e.target.value };
                      setModel({ ...m, points: pts });
                    }}
                    placeholder={i18n('Problem ai eval point title placeholder')}
                    style={{ ...inpStyle, flex: 1 }}
                  />
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={typeof pt.score === 'number' ? pt.score : 0}
                    onChange={(e) => {
                      const m = model as ProblemAiEval;
                      const pts = Array.isArray(m.points) ? [...m.points] : [];
                      const n = parseInt(e.target.value, 10);
                      pts[pi] = { ...pts[pi], score: Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : 0 };
                      setModel({ ...m, points: pts });
                    }}
                    style={{ ...inpStyle, width: 86 }}
                    title={Array.isArray(pt.subPoints) && pt.subPoints.length > 0 ? i18n('Problem ai eval parent score hint') : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const m = model as ProblemAiEval;
                      const pts = Array.isArray(m.points) ? [...m.points] : [];
                      pts.splice(pi, 1);
                      setModel({ ...m, points: pts });
                    }}
                    style={{
                      padding: '2px 8px',
                      fontSize: '11px',
                      borderRadius: '3px',
                      border: `1px solid ${themeStyles.danger}`,
                      background: themeStyles.bgPrimary,
                      color: themeStyles.danger,
                      cursor: 'pointer',
                    }}
                  >
                    {i18n('Delete')}
                  </button>
                </div>
                <div style={{ marginLeft: 4, paddingLeft: 8, borderLeft: `2px solid ${themeStyles.borderPrimary}` }}>
                  <div style={{ fontSize: '10px', color: themeStyles.textSecondary, marginBottom: 4 }}>
                    {i18n('Problem ai eval sub points')}
                  </div>
                  {(Array.isArray(pt.subPoints) ? pt.subPoints : []).map((sp, si) => (
                    <div key={sp.id || `sub-${pi}-${si}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          value={sp.title ?? ''}
                          onChange={(e) => {
                            const m = model as ProblemAiEval;
                            const pts = [...(m.points || [])];
                            const subs = [...(pts[pi].subPoints || [])];
                            subs[si] = { ...subs[si], title: e.target.value };
                            pts[pi] = { ...pts[pi], subPoints: subs };
                            setModel({ ...m, points: pts });
                          }}
                          placeholder={i18n('Problem ai eval sub point title placeholder')}
                          style={{ ...inpStyle, flex: 1 }}
                        />
                        <input
                          type="number"
                          min={0}
                          max={1000}
                          value={typeof sp.score === 'number' ? sp.score : 0}
                          onChange={(e) => {
                            const m = model as ProblemAiEval;
                            const pts = [...(m.points || [])];
                            const subs = [...(pts[pi].subPoints || [])];
                            const n = parseInt(e.target.value, 10);
                            subs[si] = { ...subs[si], score: Number.isFinite(n) ? Math.max(0, Math.min(1000, n)) : 0 };
                            pts[pi] = { ...pts[pi], subPoints: subs };
                            setModel({ ...m, points: pts });
                          }}
                          style={{ ...inpStyle, width: 72 }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const m = model as ProblemAiEval;
                            const pts = [...(m.points || [])];
                            const subs = [...(pts[pi].subPoints || [])];
                            subs.splice(si, 1);
                            pts[pi] = { ...pts[pi], subPoints: subs.length ? subs : [] };
                            setModel({ ...m, points: pts });
                          }}
                          style={{
                            padding: '2px 6px',
                            fontSize: '10px',
                            borderRadius: '3px',
                            border: `1px solid ${themeStyles.danger}`,
                            background: themeStyles.bgPrimary,
                            color: themeStyles.danger,
                            cursor: 'pointer',
                          }}
                        >
                          {i18n('Delete')}
                        </button>
                      </div>
                      <input
                        value={sp.content ?? ''}
                        onChange={(e) => {
                          const m = model as ProblemAiEval;
                          const pts = [...(m.points || [])];
                          const subs = [...(pts[pi].subPoints || [])];
                          subs[si] = { ...subs[si], content: e.target.value };
                          pts[pi] = { ...pts[pi], subPoints: subs };
                          setModel({ ...m, points: pts });
                        }}
                        placeholder={i18n('Problem ai eval sub point content placeholder')}
                        style={{ ...inpStyle, width: '100%' }}
                      />
                      {(Array.isArray(sp.answerAliases) ? sp.answerAliases : []).map((al, ai) => (
                        <div key={`al-${sp.id}-${ai}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <input
                            value={al}
                            onChange={(e) => {
                              const m = model as ProblemAiEval;
                              const pts = [...(m.points || [])];
                              const subs = [...(pts[pi].subPoints || [])];
                              const als = [...(subs[si].answerAliases || [])];
                              als[ai] = e.target.value;
                              subs[si] = { ...subs[si], answerAliases: als };
                              pts[pi] = { ...pts[pi], subPoints: subs };
                              setModel({ ...m, points: pts });
                            }}
                            placeholder={i18n('Problem ai eval alias input placeholder')}
                            style={{ ...inpStyle, flex: 1 }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const m = model as ProblemAiEval;
                              const pts = [...(m.points || [])];
                              const subs = [...(pts[pi].subPoints || [])];
                              const als = [...(subs[si].answerAliases || [])];
                              als.splice(ai, 1);
                              subs[si] = {
                                ...subs[si],
                                answerAliases: als.length ? als : undefined,
                              };
                              pts[pi] = { ...pts[pi], subPoints: subs };
                              setModel({ ...m, points: pts });
                            }}
                            style={{
                              padding: '2px 6px',
                              fontSize: '10px',
                              borderRadius: '3px',
                              border: `1px solid ${themeStyles.danger}`,
                              background: themeStyles.bgPrimary,
                              color: themeStyles.danger,
                              cursor: 'pointer',
                            }}
                          >
                            {i18n('Delete')}
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          const m = model as ProblemAiEval;
                          const pts = [...(m.points || [])];
                          const subs = [...(pts[pi].subPoints || [])];
                          const cur = subs[si];
                          const als = [...(cur.answerAliases || [])];
                          if (als.length >= 24) return;
                          als.push('');
                          subs[si] = { ...cur, answerAliases: als };
                          pts[pi] = { ...pts[pi], subPoints: subs };
                          setModel({ ...m, points: pts });
                        }}
                        style={{
                          padding: '2px 8px',
                          fontSize: '10px',
                          borderRadius: '3px',
                          border: `1px solid ${themeStyles.border}`,
                          background: themeStyles.bgPrimary,
                          color: themeStyles.textSecondary,
                          cursor: 'pointer',
                          alignSelf: 'flex-start',
                        }}
                        aria-label="+"
                      >
                        +
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => {
                      const m = model as ProblemAiEval;
                      const pts = [...(m.points || [])];
                      const cur = pts[pi];
                      const subs = [...(cur.subPoints || [])];
                      const sp: ProblemAiEvalSubPoint = {
                        id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                        title: '',
                        content: '',
                        score: 5,
                        answerAliases: [],
                      };
                      subs.push(sp);
                      pts[pi] = { ...cur, subPoints: subs };
                      setModel({ ...m, points: pts });
                    }}
                    style={{
                      padding: '2px 8px',
                      fontSize: '11px',
                      borderRadius: '3px',
                      border: `1px solid ${themeStyles.border}`,
                      background: themeStyles.bgPrimary,
                      color: themeStyles.textSecondary,
                      cursor: 'pointer',
                    }}
                  >
                    {i18n('Problem ai eval add sub point')}
                  </button>
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  const m = model as ProblemAiEval;
                  const pts = Array.isArray(m.points) ? [...m.points] : [];
                  pts.push({
                    id: `pt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    title: '',
                    score: 0,
                    subPoints: [{
                      id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                      title: '',
                      content: '',
                      score: 10,
                      answerAliases: [],
                    }],
                  });
                  setModel({ ...m, points: pts });
                }}
                style={{
                  padding: '2px 8px',
                  fontSize: '11px',
                  borderRadius: '3px',
                  border: `1px solid ${themeStyles.accent}`,
                  background: themeStyles.bgPrimary,
                  color: themeStyles.accent,
                  cursor: 'pointer',
                }}
              >
                {i18n('Problem ai eval add point')}
              </button>
              <span style={{ fontSize: '11px', color: themeStyles.textSecondary }}>
                {i18n('Problem ai eval total score')}: {aiEvalRubricSumMax(Array.isArray((model as ProblemAiEval).points) ? (model as ProblemAiEval).points : [])}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: '4px', flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, color: themeStyles.textPrimary, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span>{i18n('Problem ai eval pass score')}</span>
              <input
                type="number"
                min={0}
                max={100}
                value={typeof (model as ProblemAiEval).passScore === 'number' ? (model as ProblemAiEval).passScore : 60}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  const passScore = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 60;
                  setModel({ ...(model as ProblemAiEval), passScore });
                }}
                style={{ ...inpStyle, width: 72 }}
              />
            </label>
            <label style={{ fontSize: 12, color: themeStyles.textPrimary, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span>{i18n('Problem ai eval max attempts')}</span>
              <input
                type="number"
                min={1}
                max={20}
                value={typeof (model as ProblemAiEval).maxAttempts === 'number' ? (model as ProblemAiEval).maxAttempts : 3}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  const maxAttempts = Number.isFinite(n) ? Math.max(1, Math.min(20, n)) : 3;
                  setModel({ ...(model as ProblemAiEval), maxAttempts });
                }}
                style={{ ...inpStyle, width: 72 }}
              />
            </label>
          </div>
        </>
      ) : kind === 'true_false' ? (
        <div style={{ marginBottom: '4px' }}>
          <textarea
            value={(model as ProblemTrueFalse).stem}
            onChange={(e) => setModel({ ...(model as ProblemTrueFalse), stem: e.target.value })}
            placeholder={i18n('Stem')}
            style={taStyle}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, fontSize: 12, color: themeStyles.textPrimary }}>
            <span>{i18n('Correct answer')}:</span>
            <label style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name={`tf-${problem.pid}`}
                checked={(model as ProblemTrueFalse).answer === 1}
                onChange={() => setModel({ ...(model as ProblemTrueFalse), answer: 1 })}
                style={{ marginRight: 4 }}
              />
              {i18n('Problem answer true')}
            </label>
            <label style={{ cursor: 'pointer' }}>
              <input
                type="radio"
                name={`tf-${problem.pid}`}
                checked={(model as ProblemTrueFalse).answer === 0}
                onChange={() => setModel({ ...(model as ProblemTrueFalse), answer: 0 })}
                style={{ marginRight: 4 }}
              />
              {i18n('Problem answer false')}
            </label>
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: '4px' }}>
            <textarea
              value={kind === 'single' ? (model as ProblemSingle).stem : (model as ProblemMulti).stem}
              onChange={(e) => {
                if (kind === 'single') setModel({ ...(model as ProblemSingle), stem: e.target.value });
                else setModel({ ...(model as ProblemMulti), stem: e.target.value });
              }}
              placeholder={i18n('Stem')}
              style={taStyle}
            />
          </div>
          <div style={{ marginBottom: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: 8, color: themeStyles.textPrimary }}>
            <span>{i18n('Problem option slots')}</span>
            <select
              value={optionSlotsNow()}
              onChange={(e) => applyOptionSlots(parseInt(e.target.value, 10))}
              style={{ ...inpStyle, minWidth: 52 }}
            >
              {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {kind === 'multi' && (
              <span style={{ color: themeStyles.textSecondary }}>{i18n('Problem multi all correct')}</span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', marginBottom: '4px' }}>
            {(kind === 'single' ? (model as ProblemSingle).options : (model as ProblemMulti).options).map((opt, oi) => (
              <input
                key={oi}
                value={opt}
                onChange={(e) => {
                  if (kind === 'single') {
                    const m = model as ProblemSingle;
                    const next = [...m.options];
                    next[oi] = e.target.value;
                    setModel({ ...m, options: next });
                  } else {
                    const m = model as ProblemMulti;
                    const next = [...m.options];
                    next[oi] = e.target.value;
                    setModel({ ...m, options: next });
                  }
                }}
                placeholder={`${i18n('Option')} ${String.fromCharCode(65 + oi)}`}
                style={inpStyle}
              />
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: '4px', fontSize: '12px', color: themeStyles.textPrimary, flexWrap: 'wrap', gap: 4 }}>
            <span style={{ marginRight: 4 }}>{i18n('Correct answer')}:</span>
            {kind === 'single'
              ? (model as ProblemSingle).options.map((_, oi) => (
                <label key={oi} style={{ marginRight: 6, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name={`problem-answer-${problem.pid}`}
                    checked={(model as ProblemSingle).answer === oi}
                    onChange={() => setModel({ ...(model as ProblemSingle), answer: oi })}
                    style={{ marginRight: 2 }}
                  />
                  {String.fromCharCode(65 + oi)}
                </label>
              ))
              : (model as ProblemMulti).options.map((_, oi) => (
                <label key={oi} style={{ marginRight: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={normalizeMultiAnswers((model as ProblemMulti).answer).includes(oi)}
                    onChange={() => toggleMultiAnswer(oi)}
                    style={{ marginRight: 2 }}
                  />
                  {String.fromCharCode(65 + oi)}
                </label>
              ))}
          </div>
        </>
      )}

      {editorDomainId && _cardId && problem.pid && !isTempCard ? (
        <div style={{ marginBottom: '8px' }}>
          <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginBottom: '4px' }}>
            {i18n('Problem editor notes title')}
            {learnerNotesLoading ? ` (${i18n('Loading...')})` : ''}
          </div>
          {!learnerNotesLoading && learnerNoteRows.length === 0 ? (
            <div style={{ fontSize: '11px', color: themeStyles.textTertiary, marginBottom: '6px' }}>
              {i18n('Problem editor notes empty')}
            </div>
          ) : null}
          {learnerNoteRows.map((n) => (
            <div key={n.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
              <div style={{ fontSize: '10px', color: themeStyles.textSecondary }}>
                {n.uname}
                {n.createdAt ? ` · ${n.createdAt}` : ''}
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <textarea
                  value={n.content}
                  onChange={(e) => {
                    const v = e.target.value;
                    setLearnerNoteRows((prev) => prev.map((r) => (r.id === n.id ? { ...r, content: v } : r)));
                  }}
                  placeholder={i18n('Lesson problem notes placeholder')}
                  style={{ ...taStyle, flex: 1, minHeight: 56 }}
                  disabled={!!learnerNotesLoading}
                />
                <button
                  type="button"
                  disabled={!!learnerNotesLoading}
                  onClick={() => setLearnerNoteRows((prev) => prev.filter((r) => r.id !== n.id))}
                  title={i18n('Problem editor notes remove row')}
                  style={{
                    flexShrink: 0,
                    padding: '4px 8px',
                    fontSize: 11,
                    borderRadius: 4,
                    border: `1px solid ${themeStyles.borderPrimary}`,
                    background: themeStyles.bgSecondary,
                    color: themeStyles.textPrimary,
                    cursor: learnerNotesLoading ? 'not-allowed' : 'pointer',
                  }}
                >
                  {i18n('Problem editor notes delete')}
                </button>
              </div>
            </div>
          ))}
          <div style={{ marginTop: 4 }}>
            <button
              type="button"
              disabled={!!learnerNotesLoading}
              onClick={() => {
                setLearnerNoteRows((prev) => [
                  ...prev,
                  { id: `local_${nanoid()}`, uid: 0, uname: '', content: '', createdAt: '' },
                ]);
              }}
              style={{
                padding: '2px 10px',
                fontSize: 11,
                borderRadius: 4,
                border: `1px solid ${themeStyles.accent}`,
                background: (themeStyles as { accentMutedBg?: string }).accentMutedBg ?? themeStyles.bgSecondary,
                color: themeStyles.accent,
                cursor: learnerNotesLoading ? 'not-allowed' : 'pointer',
                opacity: learnerNotesLoading ? 0.5 : 1,
              }}
            >
              {i18n('Problem editor notes add')}
            </button>
          </div>
        </div>
      ) : null}

      <div style={{ marginBottom: '4px' }}>
        <textarea
          value={analysis}
          onChange={(e) => setCommon({ analysis: e.target.value || undefined })}
          placeholder={i18n('Analysis (optional)')}
          style={{ ...taStyle, minHeight: '32px' }}
        />
      </div>
    </div>
  );
});

EditableProblem.displayName = 'EditableProblem';
