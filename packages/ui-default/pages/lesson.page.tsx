import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';
import type { Problem, ProblemSingle, ProblemMulti, ProblemTrueFalse, ProblemFlip, ProblemFillBlank, ProblemMatching, ProblemSuperFlip } from 'ejun/src/interface';
import {
  problemKind,
  normalizeMultiAnswers,
  setsEqualAsSorted,
  fillBlankSlotCount,
  fillBlankResponseMatches,
  normalizeFillBlankText,
  getProblemTagList,
  sanitizeProblemTagRegistryList,
  normalizeProblemTagInput,
  matchingAllColumnsCorrect,
  MATCHING_COL_MIN,
  MATCHING_PAIR_MIN,
  matchingColumnsNormalized,
  superFlipNormalized,
  SUPER_FLIP_COL_MIN,
  SUPER_FLIP_ROW_MIN,
} from 'ejun/src/model/problem';

// Cache keys aligned with base outline (shared image Cache API).
const BASE_OUTLINE_CARD_CACHE_PREFIX = 'base-outline-card-';
const BASE_OUTLINE_IMAGES_CACHE_NAME = 'base-outline-images-v1';

/** Same as message index.page.ts: copy lives in locales/*.yaml; call i18n() only. */
function labelForFrozenLessonQueueMode(modeRaw: string | undefined): string {
  const m = String(modeRaw ?? 'deep').trim().toLowerCase();
  if (m === 'breadth') return i18n('Breadth learning mode');
  if (m === 'random') return i18n('Random learning mode');
  return i18n('Deep learning mode');
}

type QueuedProblem = Problem & { cardId: string };

/** 点击「继续」去下一题前保存，供「上一题」回到已提交、未点继续时的界面状态。 */
type LessonPreviousStackEntry = {
  problem: QueuedProblem;
  pendingLessonAdvance: 'next' | 'requeue' | 'correctMore';
  selectedAnswer: number | null;
  selectedMulti: number[];
  selectedTf: 0 | 1 | null;
  fillBlankDraft: string[];
  matchingSelections: Array<Array<number | null>>;
  matchingShuffleOrders: number[][];
  flipStage: 'a' | 'b';
  flipHintOpen: boolean;
  superFlipRevealed: boolean[][];
  superFlipMarkedOk: boolean | null;
  optionOrder: number[];
  problemAttemptSnapshot: number;
  isAnswered: boolean;
  showAnalysis: boolean;
};

/** 换卡时：1 题目条先满 →2 总进度条再跟上实时值 →3 清空题目条。 */
type LessonSecondBarExitHold =
  | null
  | { phase: 1; prevCardId: string; total: number; frozenSessionDone: number; sessionCardTotal: number }
  | { phase: 2; prevCardId: string; total: number };

function multiIndicesToBitmask(indices: number[]): number {
  let s = 0;
  for (const i of indices) {
    if (typeof i === 'number' && i >= 0 && i < 31) s |= 1 << i;
  }
  return s;
}

/** Lesson: empty or whitespace-only body cells never get a mask—they stay visibly blank. */
function superFlipCellHasContent(cellText: unknown): boolean {
  return String(cellText ?? '').trim().length > 0;
}

function superFlipAllFilledCellsRevealed(columns: string[][], revealed: boolean[][]): boolean {
  const ncol = columns.length;
  if (!ncol) return false;
  const nrow = columns[0]?.length ?? 0;
  if (revealed.length !== ncol) return false;
  for (let ci = 0; ci < ncol; ci++) {
    const col = columns[ci] || [];
    const rev = revealed[ci];
    if (!rev || rev.length !== nrow) return false;
    for (let ri = 0; ri < nrow; ri++) {
      if (!superFlipCellHasContent(col[ri])) continue;
      if (!rev[ri]) return false;
    }
  }
  return true;
}

function lessonProblemKindLabel(k: ReturnType<typeof problemKind>): string {
  const key =
    k === 'multi' ? 'Problem kind multi'
    : k === 'true_false' ? 'Problem kind true false'
    : k === 'flip' ? 'Problem kind flip'
    : k === 'fill_blank' ? 'Problem kind fill blank'
    : k === 'matching' ? 'Problem kind matching'
    : k === 'super_flip' ? 'Problem kind super flip'
    : 'Problem kind single';
  const t = i18n(key);
  return t !== key ? t : k;
}

function lessonProblemQueueTitleText(p: QueuedProblem): string {
  const titled = typeof p.title === 'string' ? p.title.trim() : '';
  if (titled) return titled;
  if (problemKind(p) === 'flip') {
    const f = p as ProblemFlip;
    return String(f.faceA || '').trim();
  }
  if (problemKind(p) === 'fill_blank') {
    return String((p as ProblemFillBlank).stem || '').trim();
  }
  if (problemKind(p) === 'matching') {
    const m = p as ProblemMatching;
    const st = typeof m.stem === 'string' ? m.stem.trim() : '';
    if (st) return st;
    const cols = matchingColumnsNormalized(m);
    const bits = cols.flatMap((col) => col.map((t) => String(t ?? '').trim()).filter(Boolean)).slice(0, 8);
    return bits.join(' · ') || '';
  }
  if (problemKind(p) === 'super_flip') {
    const s = p as ProblemSuperFlip;
    const st = typeof s.stem === 'string' ? s.stem.trim() : '';
    if (st) return st;
    const { headers, columns } = superFlipNormalized(s);
    const h = headers.map((t) => String(t ?? '').trim()).filter(Boolean).join(' · ');
    if (h) return h;
    const bits = columns.flatMap((col) => col.map((t) => String(t ?? '').trim()).filter(Boolean)).slice(0, 8);
    return bits.join(' · ') || '';
  }
  const stem = (p as ProblemSingle | ProblemMulti | ProblemTrueFalse).stem;
  return String(stem || '').trim();
}

interface Card {
  docId: string;
  title: string;
  content: string;
  cardFace?: string;
  problems?: Problem[];
  updateAt?: string;
}

interface Node {
  id: string;
  text: string;
}

type LessonNodeTreeItem = {
  type: 'node';
  id: string;
  title: string;
  children: Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }>;
};

/** 单节点跨卡题目队列侧栏：按卡片分组展示。 */
type LessonProblemQueueSidebarGroup = {
  cardId: string;
  cardTitle: string;
  items: Array<{ p: QueuedProblem; globalIndex: number }>;
};

type LessonUiState = {
  card: Card;
  node: Node;
  cards: Card[];
  currentIndex: number;
  domainId: string;
  baseDocId: string;
  lessonSessionId: string;
  isAlonePractice: boolean;
  isSingleNodeMode: boolean;
  isTodayMode: boolean;
  hasProblems: boolean;
  rootNodeId: string;
  rootNodeTitle: string;
  flatCards: Array<{
    nodeId: string;
    cardId: string;
    nodeTitle: string;
    cardTitle: string;
    domainId?: string;
    baseDocId?: number;
    learnSectionOrderIndex?: number;
    /** 今日任务：服务端按「起点前节 | 已掌握」标好的新/复习，侧栏 tag 优先用此字段。 */
    lessonTodayQueueKind?: 'new' | 'review';
  }>;
  nodeTree: LessonNodeTreeItem[];
  currentCardIndex: number;
  lessonReviewCardIds: string[];
  reviewCardId: string;
  lessonCardProvenanceLabel: string;
  lessonLearnSessionMode: string;
  /** Today task only: server-translated "主模式… · 副模式…". */
  lessonTodayModesConfigLine: string;
  lessonTodayCardKind: 'new' | 'review' | '';
  lessonTodayCardKindLabel: string;
  /** Section-order slot of learning start; -1 = omit new/review queue breakdown (e.g. single-card practice). */
  lessonSessionLearnStartSlot: number;
  /** Server-translated "n 新 · m 旧" (avoids missing `window.LOCALES` before UI rebuild). */
  lessonSessionQueueNewOldLabel: string;
  /** Base editor taxonomy tags (optional); server may omit to use []. */
  lessonProblemTagOptions: string[];
  /** User may PATCH card problems when owner or PERM_EDIT_DISCUSSION on base. */
  lessonCanEditProblemTags: boolean;
  /** Keys `slot:cardId` → times this card was completed on the learning path (domain.user). */
  learnPathCardPractiseCounts: Record<string, number>;
  /** Server `translate('Lesson path card practise count')` — avoids missing `window.LOCALES` entry. */
  lessonPathCardPractiseCountFmt: string;
  lessonPathCardPractiseCountTitle: string;
  /** 单节点：与 `flatCards` 顺序一致的整卡列表（含各卡 `problems`），用于跨子卡题目队列。 */
  flatQueueCards: Card[];
};

function normalizeCardFromServer(raw: unknown): Card {
  if (!raw || typeof raw !== 'object') return {} as Card;
  const c = raw as Record<string, unknown>;
  return {
    ...(c as unknown as Card),
    docId: c.docId != null ? String(c.docId) : '',
  };
}

/**
 * 单节点：按 `flatCards` 顺序展平练习题。`flatQueueCards` 经页面 JSON 时可能丢 `problems`，
 * 用同请求的 `cards`（当前节点列表）补全。
 */
function buildSingleNodeQueuedProblems(
  flatCards: LessonUiState['flatCards'],
  flatQueueCards: Card[],
  cards: Card[],
  fallbackCard: Card,
): QueuedProblem[] {
  const queueById = new Map<string, Card>();
  for (const c of flatQueueCards) {
    const id = String(c.docId ?? '').trim();
    if (id) queueById.set(id, c);
  }
  const listById = new Map<string, Card>();
  for (const c of cards) {
    const id = String(c.docId ?? '').trim();
    if (id) listById.set(id, c);
  }
  const problemsForCardId = (cid: string): Problem[] => {
    const q = queueById.get(cid);
    const l = listById.get(cid);
    const qn = q?.problems?.length ? q.problems : null;
    const ln = l?.problems?.length ? l.problems : null;
    if (qn) return qn;
    if (ln) return ln;
    if (String(fallbackCard.docId) === cid) return fallbackCard.problems || [];
    return [];
  };
  const out: QueuedProblem[] = [];
  const dedupe = new Set<string>();
  const order = flatCards.length > 0
    ? flatCards.map((fc) => String(fc.cardId))
    : [String(fallbackCard.docId)].filter(Boolean);
  for (const cid of order) {
    if (!cid) continue;
    for (const p of problemsForCardId(cid)) {
      const k = `${cid}::${p.pid}`;
      if (dedupe.has(k)) continue;
      dedupe.add(k);
      out.push({ ...p, cardId: cid } as QueuedProblem);
    }
  }
  return out;
}

/** Unwrap jQuery.ajax-style JSON; supports redirect url in nested body/data. */
function unwrapLearnPassResponse(raw: unknown) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const b = (r.body && typeof r.body === 'object' && !Array.isArray(r.body)) ? (r.body as Record<string, unknown>) : null;
  const d = (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? (r.data as Record<string, unknown>) : null;
  const pick = (k: string) => r[k] ?? b?.[k] ?? d?.[k];
  return {
    lesson: pick('lesson'),
    spaNext: pick('spaNext'),
    redirect: pick('redirect') ?? pick('url'),
  };
}

function lessonPayloadLooksValid(lesson: unknown): lesson is Record<string, unknown> {
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) return false;
  const card = (lesson as Record<string, unknown>).card;
  return typeof card === 'object' && card !== null;
}

/** 侧栏新/旧 tag：`window.LOCALES` 未更新时避免显示英文 key。 */
function i18nLearnQueueCardTag(kind: 'new' | 'old'): string {
  const key = kind === 'old' ? 'Learn queue card tag old' : 'Learn queue card tag new';
  const t = i18n(key);
  if (t !== key) return t;
  const lang = String((window as any).UserContext?.locale || document.documentElement.lang || 'zh').toLowerCase();
  if (lang.startsWith('en')) return kind === 'old' ? 'Old' : 'New';
  return kind === 'old' ? '旧' : '新';
}

/** 今日任务：`lessonTodayQueueKind`（节槽 vs 学习起点）优先；缺省按节槽 < 学习起点为旧。 */
function flatCardNewOldKind(
  fc: LessonUiState['flatCards'][number] | undefined,
  learnStartSlot: number,
): 'new' | 'old' | null {
  if (learnStartSlot < 0 || fc == null) return null;
  if (fc.lessonTodayQueueKind === 'review') return 'old';
  if (fc.lessonTodayQueueKind === 'new') return 'new';
  const start = Math.max(0, learnStartSlot);
  const slot = typeof fc.learnSectionOrderIndex === 'number' && fc.learnSectionOrderIndex >= 0
    ? fc.learnSectionOrderIndex
    : 0;
  return slot < start ? 'old' : 'new';
}

/** Match server `learnPassPlacementKey` / `learnPathCardPractiseCounts` keys. */
function pathLoopCountForFlatCard(
  fc: LessonUiState['flatCards'][number] | undefined,
  counts: Record<string, number>,
): number {
  if (!fc) return 0;
  const slot = typeof fc.learnSectionOrderIndex === 'number' && fc.learnSectionOrderIndex >= 0
    ? fc.learnSectionOrderIndex
    : 0;
  const key = `${slot}:${String(fc.cardId)}`;
  const n = counts[key];
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function normalizeLearnPathPractiseCountsMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** 进度条旁新/旧行：优先服务端文案，其次 i18n，再按语言兜底。 */
function lessonQueueNewOldLine(
  serverLabel: string,
  counts: { newN: number; reviewN: number } | null,
): string {
  const trimmed = String(serverLabel || '').trim();
  if (trimmed) return trimmed;
  if (!counts) return '';
  const tpl = i18n('Lesson session new old counts');
  const filled = tpl
    .replace(/\{0\}/g, String(counts.newN))
    .replace(/\{1\}/g, String(counts.reviewN));
  if (filled !== 'Lesson session new old counts') return filled;
  const lang = String((window as any).UserContext?.locale || document.documentElement.lang || 'zh').toLowerCase();
  if (lang.startsWith('en')) return `${counts.newN} new · ${counts.reviewN} review`;
  return `${counts.newN} 张新 · ${counts.reviewN} 张旧`;
}

/** Deep-enough duplicate of problem list onto every in-memory slot that mirrors this card (`card`, `cards[]`, `flatQueueCards`). */
function mergeLessonUiCardProblems(prev: LessonUiState, cardId: string, nextProblems: Problem[]): LessonUiState {
  const cid = String(cardId).trim();
  const list = nextProblems.map((p) => ({ ...p }));
  const patchCard = (c: Card): Card =>
    (String(c.docId ?? '').trim() !== cid ? c : { ...c, problems: list.map((x) => ({ ...x })) });
  return {
    ...prev,
    card: patchCard(prev.card),
    cards: prev.cards.map(patchCard),
    flatQueueCards: prev.flatQueueCards.map(patchCard),
  };
}

/** Floating panel body: CRUD `Problem.tags` (multiple). */
function LessonProblemTagPanelBody(props: {
  problem: QueuedProblem;
  registry: string[];
  canEdit: boolean;
  saving: boolean;
  registerSaving: boolean;
  bgPrimary: string;
  bgSecondary: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentMutedBg: string;
  onPersist: (nextTags: string[]) => void;
  onRegisterOnly: (tag: string) => Promise<void>;
}) {
  const {
    problem,
    registry,
    canEdit,
    saving,
    registerSaving,
    bgPrimary,
    bgSecondary,
    border,
    textPrimary,
    textSecondary,
    textTertiary,
    accent,
    accentMutedBg,
    onPersist,
    onRegisterOnly,
  } = props;
  const tagsNow = getProblemTagList(problem as Problem);
  const tagsKey = tagsNow.join('\n');
  const merged = [...new Set([...registry, ...tagsNow])].sort((a, b) => a.localeCompare(b));
  const [customDraft, setCustomDraft] = useState('');
  useEffect(() => {
    setCustomDraft('');
  }, [problem.pid, problem.cardId, tagsKey]);

  const registerCustom = async () => {
    const t = normalizeProblemTagInput(customDraft);
    if (!t || tagsNow.includes(t)) return;
    try {
      await onRegisterOnly(t);
      onPersist([...new Set([...tagsNow, t])]);
      setCustomDraft('');
    } catch {
      /* parent shows Notification */
    }
  };

  const draftNorm = normalizeProblemTagInput(customDraft);

  const fld: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: `1px solid ${border}`,
    backgroundColor: bgPrimary,
    color: textSecondary,
    fontSize: 14,
    boxSizing: 'border-box',
  };

  const btnPri: React.CSSProperties = {
    padding: '10px 18px',
    borderRadius: 8,
    border: `1px solid ${accent}`,
    backgroundColor: accent,
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: saving || registerSaving ? 'not-allowed' : 'pointer',
    opacity: saving || registerSaving ? 0.65 : 1,
  };

  const btnSec: React.CSSProperties = {
    padding: '10px 18px',
    borderRadius: 8,
    border: `1px solid ${border}`,
    backgroundColor: bgSecondary,
    color: textPrimary,
    fontSize: 14,
    fontWeight: 600,
    cursor: saving || registerSaving ? 'not-allowed' : 'pointer',
    opacity: saving || registerSaving ? 0.65 : 1,
  };

  const btnDangerOutline: React.CSSProperties = {
    ...btnSec,
    borderColor: 'rgba(244, 67, 54, 0.45)',
    color: '#f44336',
  };

  const chip: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 10px',
    borderRadius: 999,
    border: `1px solid ${border}`,
    backgroundColor: bgSecondary,
    color: textPrimary,
    fontSize: 14,
    fontWeight: 600,
    maxWidth: '100%',
    wordBreak: 'break-word',
  };

  const appendFromRegistry = (raw: string) => {
    const t = normalizeProblemTagInput(raw);
    if (!t || tagsNow.includes(t)) return;
    onPersist([...tagsNow, t]);
  };

  const removeTag = (t: string) => {
    onPersist(tagsNow.filter((x) => x !== t));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: textTertiary, marginBottom: 6 }}>
          {i18n('Lesson problem tag panel current')}
        </div>
        <div style={{
          padding: '12px 14px',
          borderRadius: 8,
          border: `1px solid ${border}`,
          backgroundColor: accentMutedBg,
          minHeight: 48,
        }}
        >
          {tagsNow.length === 0 ? (
            <div style={{ fontSize: 16, fontWeight: 700, color: textSecondary }}>
              {i18n('Lesson problem tag panel empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {tagsNow.map((t) => (
                <span key={t} style={chip}>
                  <span>{t}</span>
                  {canEdit ? (
                    <button
                      type="button"
                      title={i18n('Lesson problem tag chip remove')}
                      onClick={() => removeTag(t)}
                      disabled={saving || registerSaving}
                      style={{
                        flexShrink: 0,
                        border: 'none',
                        background: 'transparent',
                        color: textTertiary,
                        cursor: saving || registerSaving ? 'not-allowed' : 'pointer',
                        fontSize: 16,
                        lineHeight: 1,
                        padding: 0,
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {!canEdit ? (
        <p style={{ margin: 0, fontSize: 13, color: textTertiary, lineHeight: 1.5 }}>
          {i18n('Lesson problem tag panel readonly hint')}
        </p>
      ) : (
        <>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: textSecondary, display: 'block', marginBottom: 8 }} htmlFor="lesson-tag-panel-append">
              {i18n('Lesson problem tag panel append registered')}
            </label>
            <select
              id="lesson-tag-panel-append"
              value=""
              disabled={saving || registerSaving}
              onChange={(e) => {
                appendFromRegistry(e.target.value);
                e.target.value = '';
              }}
              style={fld}
            >
              <option value="">{i18n('Lesson problem tag panel add registered placeholder')}</option>
              {merged.filter((t) => !tagsNow.includes(t)).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 600, color: textSecondary, display: 'block', marginBottom: 8 }} htmlFor="lesson-tag-panel-custom">
              {i18n('Lesson problem tag panel new')}
            </label>
            <input
              id="lesson-tag-panel-custom"
              type="text"
              maxLength={64}
              value={customDraft}
              disabled={saving || registerSaving}
              placeholder={i18n('Lesson problem tag new placeholder')}
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void registerCustom();
                }
              }}
              style={fld}
            />
            <div style={{ marginTop: 10, fontSize: 12, color: textTertiary, lineHeight: 1.45 }}>
              {i18n('Lesson problem tag new hint')}
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button
              type="button"
              style={btnPri}
              disabled={saving || registerSaving || !draftNorm || tagsNow.includes(draftNorm)}
              onClick={() => { void registerCustom(); }}
            >
              {i18n('Lesson problem tag apply new')}
            </button>
            <button
              type="button"
              style={btnDangerOutline}
              disabled={saving || registerSaving || tagsNow.length === 0}
              onClick={() => onPersist([])}
            >
              {i18n('Lesson problem tag panel clear')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function createInitialLessonUiState(): LessonUiState {
  const U = (window as any).UiContext || {};
  const nodeRaw = U.node || {};
  const nodeObj = typeof nodeRaw === 'object' && nodeRaw !== null ? nodeRaw as Record<string, unknown> : {};
  return {
    card: normalizeCardFromServer(U.card),
    node: {
      id: String(nodeObj.id ?? ''),
      text: String(nodeObj.text ?? nodeObj.title ?? ''),
    },
    cards: (Array.isArray(U.cards) ? U.cards : []).map(normalizeCardFromServer),
    currentIndex: Number(U.currentIndex) || 0,
    domainId: String(U.domainId || ''),
    baseDocId: String(U.baseDocId || ''),
    lessonSessionId: String(U.lessonSessionId || '').trim(),
    isAlonePractice: !!U.isAlonePractice,
    isSingleNodeMode: !!U.isSingleNodeMode,
    isTodayMode: !!U.isTodayMode,
    hasProblems: !!U.hasProblems,
    rootNodeId: String(U.rootNodeId || ''),
    rootNodeTitle: String(U.rootNodeTitle || ''),
    flatCards: Array.isArray(U.flatCards) ? U.flatCards : [],
    nodeTree: Array.isArray(U.nodeTree) ? U.nodeTree : [],
    currentCardIndex: typeof U.currentCardIndex === 'number' ? U.currentCardIndex : 0,
    lessonReviewCardIds: Array.isArray(U.lessonReviewCardIds) ? U.lessonReviewCardIds.map(String) : [],
    reviewCardId: String(U.reviewCardId || ''),
    lessonCardProvenanceLabel: String(U.lessonCardProvenanceLabel || ''),
    lessonLearnSessionMode: String(U.lessonLearnSessionMode || ''),
    lessonTodayModesConfigLine: String(U.lessonTodayModesConfigLine || ''),
    lessonTodayCardKind: U.lessonTodayCardKind === 'review' ? 'review' : U.lessonTodayCardKind === 'new' ? 'new' : '',
    lessonTodayCardKindLabel: String(U.lessonTodayCardKindLabel || ''),
    lessonSessionLearnStartSlot: typeof U.lessonSessionLearnStartSlot === 'number' ? U.lessonSessionLearnStartSlot : -1,
    lessonSessionQueueNewOldLabel: String(U.lessonSessionQueueNewOldLabel || ''),
    learnPathCardPractiseCounts: normalizeLearnPathPractiseCountsMap(U.learnPathCardPractiseCounts),
    lessonPathCardPractiseCountFmt: String(U.lessonPathCardPractiseCountFmt || ''),
    lessonPathCardPractiseCountTitle: String(U.lessonPathCardPractiseCountTitle || ''),
    flatQueueCards: Array.isArray(U.flatQueueCards) ? (U.flatQueueCards as unknown[]).map(normalizeCardFromServer) : [],
    lessonProblemTagOptions: Array.isArray(U.lessonProblemTagOptions)
      ? (U.lessonProblemTagOptions as unknown[]).map((x) => String(x)).filter(Boolean)
      : [],
    lessonCanEditProblemTags: !!U.lessonCanEditProblemTags,
  };
}

const initLessonUiState: LessonUiState = createInitialLessonUiState();

function cardTitleForLessonProblemQueueSidebar(
  cardId: string,
  flatCards: LessonUiState['flatCards'],
  flatQueueCards: Card[],
): string {
  const cid = String(cardId);
  const fc = flatCards.find((f) => String(f.cardId) === cid);
  if (fc?.cardTitle?.trim()) return String(fc.cardTitle).trim();
  const qc = flatQueueCards.find((c) => String(c.docId) === cid);
  if (qc?.title?.trim()) return String(qc.title).trim();
  return i18n('Unnamed Card');
}

function LessonPage() {
  const [lessonUi, setLessonUi] = useState<LessonUiState>(initLessonUiState);
  const {
    card,
    node,
    cards,
    currentIndex,
    domainId,
    baseDocId,
    lessonSessionId,
    isAlonePractice,
    isSingleNodeMode,
    isTodayMode,
    hasProblems,
    rootNodeId,
    rootNodeTitle,
    flatCards,
    nodeTree,
    currentCardIndex,
    lessonReviewCardIds,
    reviewCardId,
    lessonCardProvenanceLabel,
    lessonLearnSessionMode,
    lessonTodayModesConfigLine,
    lessonTodayCardKind,
    lessonTodayCardKindLabel,
    lessonSessionLearnStartSlot,
    lessonSessionQueueNewOldLabel,
    learnPathCardPractiseCounts,
    lessonPathCardPractiseCountFmt,
    lessonPathCardPractiseCountTitle,
    flatQueueCards,
    lessonProblemTagOptions,
    lessonCanEditProblemTags,
  } = lessonUi;

  const flatQueueCardsRef = useRef<Card[]>(flatQueueCards);
  flatQueueCardsRef.current = flatQueueCards;
  const flatCardsRef = useRef(flatCards);
  flatCardsRef.current = flatCards;
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const cardRef = useRef(card);
  cardRef.current = card;
  const isSingleNodeModeRef = useRef(isSingleNodeMode);
  isSingleNodeModeRef.current = isSingleNodeMode;

  const hasLessonSidebar = (isSingleNodeMode || isTodayMode || isAlonePractice)
    && (nodeTree.length > 0 || (card.problems || []).length > 0 || hasProblems);

  const showLessonSessionProgressCard = isSingleNodeMode || isTodayMode || isAlonePractice;

  const passSession = lessonSessionId ? { session: lessonSessionId } : {};
  const lessonApiDomainId = domainId;

  const [liveLessonSession, setLiveLessonSession] = useState<Record<string, unknown> | null>(null);
  const [nextCardFromPassedLoading, setNextCardFromPassedLoading] = useState(false);
  const cardIdToFlatIndex = useMemo(() => {
    const m: Record<string, number> = {};
    flatCards.forEach((item, idx) => {
      m[String(item.cardId)] = idx;
    });
    return m;
  }, [flatCards]);

  const getTheme = useCallback(() => {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) {
        return (window as any).Ejunz.utils.getTheme();
      }
      if ((window as any).UserContext?.theme) {
        return (window as any).UserContext.theme === 'dark' ? 'dark' : 'light';
      }
    } catch (e) {
      console.warn('Failed to get theme:', e);
    }
    return 'light';
  }, []);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => getTheme());

  useEffect(() => {
    const checkTheme = () => {
      const next = getTheme();
      if (next !== theme) setTheme(next);
    };
    checkTheme();
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme, getTheme]);

  const themeStyles = useMemo(() => {
    const dark = theme === 'dark';
    return {
      bgPrimary: dark ? '#0f0f0f' : '#fff',
      bgPage: dark
        ? 'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(76, 175, 80, 0.06) 0%, transparent 50%), #0f0f0f'
        : '#fafafa',
      bgCard: dark ? 'rgba(38, 39, 41, 0.92)' : '#fff',
      bgSecondary: dark ? '#262729' : '#f5f5f5',
      bgHover: dark ? '#3a3b3d' : '#f3f4f6',
      textPrimary: dark ? '#f0f0f0' : '#333',
      textSecondary: dark ? '#9ca3af' : '#666',
      textTertiary: dark ? '#6b7280' : '#999',
      border: dark ? 'rgba(255,255,255,0.1)' : '#e0e0e0',
      accent: dark ? '#38bdf8' : '#2196f3',
      accentMutedBg: dark ? 'rgba(56, 189, 248, 0.14)' : '#e3f2fd',
      accentMutedFg: dark ? '#7dd3fc' : '#1976d2',
      reviewBg: dark ? 'rgba(251, 146, 60, 0.16)' : '#fff3e0',
      reviewFg: dark ? '#fdba74' : '#e65100',
      doneBg: dark ? 'rgba(34, 197, 94, 0.14)' : '#e8f5e9',
      doneFg: dark ? '#4ade80' : '#2e7d32',
      liveSync: dark ? '#4ade80' : '#2e7d32',
      success: dark ? '#4ade80' : '#4caf50',
      successBg: dark ? 'rgba(34, 197, 94, 0.16)' : '#e8f5e9',
      danger: '#f44336',
      dangerBg: dark ? 'rgba(244, 67, 54, 0.16)' : '#ffebee',
      orange: '#ff9800',
      drawerScrim: 'rgba(0,0,0,0.45)',
      stemColor: dark ? '#e5e5e5' : '#333',
      bodyText: dark ? '#d1d5db' : '#555',
      optionNeutral: dark ? '#262729' : '#fff',
      optionBorderMuted: dark ? 'rgba(255,255,255,0.12)' : '#e0e0e0',
      passedBannerBg: dark ? 'rgba(34, 197, 94, 0.12)' : '#e8f5e9',
      passedBannerBorder: dark ? 'rgba(74, 222, 128, 0.45)' : '#4caf50',
      passedTitle: dark ? '#86efac' : '#2e7d32',
      modalShadow: dark ? '0 4px 24px rgba(0,0,0,0.55)' : '0 4px 20px rgba(0,0,0,0.15)',
      whiteOnAccent: '#fff',
      drawerAsideShadow: dark ? '2px 0 16px rgba(0,0,0,0.5)' : '2px 0 8px rgba(0,0,0,0.15)',
      drawerAsideShadowRight: dark ? '-2px 0 16px rgba(0,0,0,0.5)' : '-2px 0 8px rgba(0,0,0,0.15)',
      /** Fill-in-the-blank: inputs sit on card — avoid near-black bgPrimary */
      fillBlankInputBg: dark ? 'rgba(56, 189, 248, 0.12)' : '#f0f7ff',
      fillBlankInputBorder: dark ? 'rgba(125, 211, 252, 0.5)' : 'rgba(33, 150, 243, 0.4)',
      fillBlankStemWellBg: dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
    };
  }, [theme]);

  useEffect(() => {
    const sockPath = String((window as any).UiContext?.sessionMeSocketQuery || '').trim();
    const wsPrefix = String((window as any).UiContext?.ws_prefix || '').trim();
    if (!sockPath || !wsPrefix) return;
    let sock: { close: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { default: WebSocketCtor } = await import('../components/socket');
        if (cancelled) return;
        const ws: any = new WebSocketCtor(wsPrefix + sockPath, false, true);
        sock = ws;
        ws.onmessage = (_ev: unknown, raw: string) => {
          try {
            const data = JSON.parse(String(raw || '{}'));
            if (data?.type === 'learnSession' && data?.session && typeof data.session === 'object') {
              setLiveLessonSession(data.session as Record<string, unknown>);
            }
          } catch {
            /* ignore non-JSON */
          }
        };
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      try {
        sock?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const [renderedContent, setRenderedContent] = useState<string>('');
  const [renderedCardFace, setRenderedCardFace] = useState<string>('');
  const imageCacheRef = useRef<Cache | null>(null);

  // Shared image Cache API with base outline.
  const initImageCache = useCallback(async () => {
    if ('caches' in window && !imageCacheRef.current) {
      try {
        imageCacheRef.current = await caches.open(BASE_OUTLINE_IMAGES_CACHE_NAME);
      } catch (error) {
        console.error('Failed to open image cache:', error);
      }
    }
  }, []);

  const getCachedImage = useCallback(async (url: string): Promise<string> => {
    if (!imageCacheRef.current) await initImageCache();
    if (!imageCacheRef.current) return url;
    try {
      const cachedResponse = await imageCacheRef.current.match(url);
      if (cachedResponse) {
        const blob = await cachedResponse.blob();
        return URL.createObjectURL(blob);
      }
      const response = await fetch(url);
      if (response.ok) {
        const responseClone = response.clone();
        await imageCacheRef.current.put(url, responseClone);
        const blob = await response.blob();
        return URL.createObjectURL(blob);
      }
    } catch (error) {
      console.error('Failed to cache image:', error);
    }
    return url;
  }, [initImageCache]);

  const replaceImagesWithCache = useCallback(async (html: string): Promise<string> => {
    if (!html) return html;
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const imageUrls: string[] = [];
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      const url = match[1];
      if (url && !url.startsWith('blob:') && !url.startsWith('data:')) imageUrls.push(url);
    }
    if (imageUrls.length === 0) return html;
    await initImageCache();
    const urlMap = new Map<string, string>();
    await Promise.all(imageUrls.map(async (originalUrl) => {
      try {
        const cachedUrl = await getCachedImage(originalUrl);
        if (cachedUrl !== originalUrl) urlMap.set(originalUrl, cachedUrl);
      } catch (e) {
        console.error('Failed to get cached image:', e);
      }
    }));
    let updatedHtml = html;
    urlMap.forEach((cachedUrl, originalUrl) => {
      const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      updatedHtml = updatedHtml.replace(new RegExp(escapedUrl, 'g'), cachedUrl);
    });
    return updatedHtml;
  }, [initImageCache, getCachedImage]);

  const preloadAndCacheImages = useCallback(async (html: string): Promise<void> => {
    if (!html) return;
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    const imageUrls: string[] = [];
    let match;
    while ((match = imgRegex.exec(html)) !== null) {
      const url = match[1];
      if (url && !url.startsWith('blob:') && !url.startsWith('data:')) imageUrls.push(url);
    }
    if (imageUrls.length === 0) return;
    await initImageCache();
    await Promise.all(imageUrls.map((url) => getCachedImage(url)));
  }, [initImageCache, getCachedImage]);

  // Use base outline cache: read-through on miss (same as base outline).
  useEffect(() => {
    const cardIdStr = card?.docId != null ? String(card.docId) : '';
    if (!cardIdStr) return;

    if (!card.content) {
      setRenderedContent('');
      return;
    }

    const cacheKey = `${BASE_OUTLINE_CARD_CACHE_PREFIX}${cardIdStr}`;
    const cachedDataStr = localStorage.getItem(cacheKey);

    if (cachedDataStr) {
      try {
        const cachedData = JSON.parse(cachedDataStr);
        const cachedHtml = cachedData?.html ?? (typeof cachedDataStr === 'string' ? cachedDataStr : '');
        if (cachedHtml) {
          const updateAt = (card as Card).updateAt ?? '';
          if (cachedData.updateAt != null && updateAt && cachedData.updateAt !== updateAt) {
            localStorage.removeItem(cacheKey);
          } else {
            replaceImagesWithCache(cachedHtml)
              .then((htmlWithImages) => setRenderedContent(htmlWithImages))
              .catch(() => setRenderedContent(cachedHtml));
            return;
          }
        }
      } catch {
        const cachedHtml = typeof cachedDataStr === 'string' ? cachedDataStr : '';
        if (cachedHtml) {
          replaceImagesWithCache(cachedHtml)
            .then((htmlWithImages) => setRenderedContent(htmlWithImages))
            .catch(() => setRenderedContent(cachedHtml));
          return;
        }
      }
    }

    // Cold path: POST /markdown then store (same as base).
    fetch('/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: card.content, inline: false }),
    })
      .then((response) => {
        if (!response.ok) throw new Error('Failed to render markdown');
        return response.text();
      })
      .then(async (html) => {
        setRenderedContent(html);
        try {
          const cacheData = {
            html,
            updateAt: (card as Card).updateAt ?? '',
          };
          localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (e) {
          console.error('Failed to save to localStorage:', e);
        }
        preloadAndCacheImages(html).catch((e) => console.error('Failed to preload images:', e));
      })
      .catch(() => setRenderedContent(card.content));
  }, [card?.docId, card?.content, (card as Card).updateAt, replaceImagesWithCache, preloadAndCacheImages]);

  // Card-face markdown (with Know it / No impression).
  useEffect(() => {
    if (!card?.cardFace) {
      setRenderedCardFace('');
      return;
    }
    fetch('/markdown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: card.cardFace, inline: false }),
    })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error('Failed to render'))))
      .then((html) => replaceImagesWithCache(html).then(setRenderedCardFace).catch(() => setRenderedCardFace(html)))
      .catch(() => setRenderedCardFace(card.cardFace || ''));
  }, [card?.docId, card?.cardFace, replaceImagesWithCache]);

  const allProblems = useMemo((): QueuedProblem[] => {
    if (isSingleNodeMode && flatQueueCards.length > 0) {
      const out: QueuedProblem[] = [];
      for (const c of flatQueueCards) {
        const cid = String(c.docId ?? '');
        for (const p of c.problems || []) {
          out.push({ ...p, cardId: cid } as QueuedProblem);
        }
      }
      return out;
    }
    return (card.problems || []).map((p) => ({ ...p, cardId: String(card.docId) } as QueuedProblem));
  }, [isSingleNodeMode, flatQueueCards, card]);

  /** 单节点：侧栏题目队列按卡片嵌套（与 `allProblems` 顺序一致）。 */
  const singleNodeLessonProblemGroups = useMemo((): LessonProblemQueueSidebarGroup[] | null => {
    if (!isSingleNodeMode || flatQueueCards.length === 0 || allProblems.length === 0) return null;
    const groups: LessonProblemQueueSidebarGroup[] = [];
    let globalIndex = 0;
    for (const p of allProblems) {
      const cid = String(p.cardId);
      const title = cardTitleForLessonProblemQueueSidebar(cid, flatCards, flatQueueCards);
      const last = groups[groups.length - 1];
      if (last && last.cardId === cid) {
        last.items.push({ p, globalIndex: globalIndex++ });
      } else {
        groups.push({ cardId: cid, cardTitle: title, items: [{ p, globalIndex: globalIndex++ }] });
      }
    }
    return groups.length > 0 ? groups : null;
  }, [isSingleNodeMode, flatQueueCards, allProblems, flatCards]);

  /** 侧栏题目按卡嵌套：单节点用 flatQueue 分组；单卡练习等则用 allProblems 按 cardId 分组（与右侧/全队列侧栏一致）。 */
  const lessonProblemSidebarGroups = useMemo((): LessonProblemQueueSidebarGroup[] | null => {
    if (singleNodeLessonProblemGroups !== null) return singleNodeLessonProblemGroups;
    if (allProblems.length === 0) return null;
    const groups: LessonProblemQueueSidebarGroup[] = [];
    let globalIndex = 0;
    for (const p of allProblems) {
      const cid = String(p.cardId);
      const title = cardTitleForLessonProblemQueueSidebar(cid, flatCards, flatQueueCards);
      const last = groups[groups.length - 1];
      if (last && last.cardId === cid) {
        last.items.push({ p, globalIndex: globalIndex++ });
      } else {
        groups.push({ cardId: cid, cardTitle: title, items: [{ p, globalIndex: globalIndex++ }] });
      }
    }
    return groups.length > 0 ? groups : null;
  }, [singleNodeLessonProblemGroups, allProblems, flatCards, flatQueueCards]);

  /** 单节点跨卡做题：卡片队列与题目队列合并，仅保留嵌套题目侧栏。 */
  const mergeSingleNodeCardQueueIntoProblemSidebar =
    isSingleNodeMode && singleNodeLessonProblemGroups !== null && allProblems.length > 0;

  /** 单卡片 + 有练习题：左右栏按「已完成 / 待完成题目」分列，不用卡片队列。 */
  const splitProblemPracticeSidebars = isAlonePractice && allProblems.length > 0 && hasLessonSidebar;
  const splitQueueSidebars = hasLessonSidebar && (splitProblemPracticeSidebars || flatCards.length > 0);
  const showLessonProblemSessionProgress = splitProblemPracticeSidebars;
  const showCardQueueProgress = flatCards.length > 0
    && (isSingleNodeMode || isTodayMode || isAlonePractice)
    && !splitProblemPracticeSidebars;

  const [problemQueue, setProblemQueue] = useState<QueuedProblem[]>([]);
  const [lessonPreviousStack, setLessonPreviousStack] = useState<LessonPreviousStackEntry[]>([]);
  const lessonPreviousStackRef = useRef<LessonPreviousStackEntry[]>([]);
  lessonPreviousStackRef.current = lessonPreviousStack;
  const lessonPendingRestoreRef = useRef<LessonPreviousStackEntry | null>(null);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [selectedMulti, setSelectedMulti] = useState<number[]>([]);
  const [selectedTf, setSelectedTf] = useState<0 | 1 | null>(null);
  const [flipStage, setFlipStage] = useState<'a' | 'b'>('a');
  const [flipHintOpen, setFlipHintOpen] = useState(false);
  const [fillBlankDraft, setFillBlankDraft] = useState<string[]>([]);
  /** Per left row index: chosen original index of right column (correct answer is identity i↔i). */
  /** Per-row array: one chosen original row index per selectable column after the anchor column (each column shuffle is independent). */
  const [matchingSelections, setMatchingSelections] = useState<Array<Array<number | null>>>([]);
  /** Per-selectable-column shuffled display order.length === row count each. */
  const [matchingShuffleOrders, setMatchingShuffleOrders] = useState<number[][]>([]);
  /** `superFlipRevealed[col][row]` — body cell revealed in super-flip table. */
  const [superFlipRevealed, setSuperFlipRevealed] = useState<boolean[][]>([]);
  /** Super flip: learner marked done (mastered); false = 「不熟悉」, null = unanswered. */
  const [superFlipMarkedOk, setSuperFlipMarkedOk] = useState<boolean | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [isPassed, setIsPassed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [pendingLessonAdvance, setPendingLessonAdvance] = useState<
    null | 'next' | 'requeue' | 'correctMore'
  >(null);
  const hasCalledPassRef = useRef(false);
  const [answerHistory, setAnswerHistory] = useState<Array<{
    problem: QueuedProblem;
    selected: number;
    correct: boolean;
    timeSpent: number;
    attempts: number;
    fillAnswers?: string[];
  }>>([]);
  /** Pids removed from queue after a full correct pass (excludes “need more” requeue / wrong). */
  const [practiceClearedPids, setPracticeClearedPids] = useState<Record<string, true>>({});
  const practiceProblemsDoneCount = useMemo(() => {
    if (!lessonProblemSidebarGroups || !mergeSingleNodeCardQueueIntoProblemSidebar) {
      return Object.keys(practiceClearedPids).length;
    }
    let n = 0;
    for (const group of lessonProblemSidebarGroups) {
      const flatIdx = cardIdToFlatIndex[group.cardId];
      const inReview = lessonReviewCardIds.includes(group.cardId);
      if (typeof flatIdx === 'number' && flatIdx < currentCardIndex && !inReview) {
        n += group.items.length;
      } else {
        n += group.items.filter(({ p }) => !!practiceClearedPids[p.pid]).length;
      }
    }
    return n;
  }, [
    lessonProblemSidebarGroups,
    mergeSingleNodeCardQueueIntoProblemSidebar,
    cardIdToFlatIndex,
    lessonReviewCardIds,
    currentCardIndex,
    practiceClearedPids,
  ]);
  const practiceProblemsPendingCount = problemQueue.length;
  /** 左栏「已完成卡片」：按张数索引已过，或该卡在整段题目队列中的题已全部 cleared。 */
  const mergeModeCompletedCardCount = useMemo(() => {
    if (!mergeSingleNodeCardQueueIntoProblemSidebar) return 0;
    let n = 0;
    flatCards.forEach((item, idx) => {
      const inReview = lessonReviewCardIds.includes(String(item.cardId));
      const byIndex = idx < currentCardIndex && !inReview;
      const pids = allProblems.filter((p) => String(p.cardId) === String(item.cardId)).map((p) => p.pid);
      const byProblems = pids.length > 0 && pids.every((pid) => !!practiceClearedPids[pid]);
      if (byIndex || byProblems) n += 1;
    });
    return n;
  }, [
    mergeSingleNodeCardQueueIntoProblemSidebar,
    flatCards,
    currentCardIndex,
    lessonReviewCardIds,
    allProblems,
    practiceClearedPids,
  ]);

  /** 顶部第二段进度条：当前队列指针所在卡片（与 `lessonSessionProgressCard` 内逻辑一致）。 */
  const secondBarCardIdFromQueue = useMemo(() => {
    const pq = problemQueue[currentProblemIndex] as QueuedProblem | undefined;
    return String(pq?.cardId || card?.docId || '');
  }, [problemQueue, currentProblemIndex, card?.docId]);

  /** 换卡 exit 动画里用 ref 读最新队列/卡片，避免 effect 依赖 allProblems/card 导致 cleanup 打断 520ms 定时器。 */
  const allProblemsForSecondBarExitRef = useRef(allProblems);
  allProblemsForSecondBarExitRef.current = allProblems;
  const cardForSecondBarExitRef = useRef(card);
  cardForSecondBarExitRef.current = card;
  const flatCardsLenForSecondBarExitRef = useRef(flatCards.length);
  flatCardsLenForSecondBarExitRef.current = flatCards.length;
  const showCardQueueProgressForExitRef = useRef(showCardQueueProgress);
  showCardQueueProgressForExitRef.current = showCardQueueProgress;

  /** 与「当前第二段进度条卡片 id」同步：仅在非 exit 动画时写入，换卡当帧用于冻结总进度条分子。 */
  const sessionFrozenBackupRef = useRef(0);
  const prevSidForSessionFrozenSyncRef = useRef<string | null>(null);

  const prevSecondBarCardIdRef = useRef<string | null>(null);
  const secondBarExitAnimLockRef = useRef(false);
  const secondBarExitPhase1TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const secondBarExitPhase2TimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SECOND_BAR_EXIT_PHASE1_MS = 380;
  const SECOND_BAR_EXIT_PHASE2_MS = 400;
  /** 换卡：题目条先满 → 总条更新 → 再清空题目条。 */
  const [secondBarExitHold, setSecondBarExitHold] = useState<LessonSecondBarExitHold>(null);

  useEffect(() => {
    const nextSid = secondBarCardIdFromQueue;
    const prev = prevSecondBarCardIdRef.current;
    if (prev === null) {
      prevSecondBarCardIdRef.current = nextSid;
      return;
    }
    if (prev === nextSid) return;
    if (secondBarExitAnimLockRef.current) return;

    const prevFromAll = allProblemsForSecondBarExitRef.current.filter((p) => String(p.cardId) === prev);
    const cardSnap = cardForSecondBarExitRef.current;
    const prevTotal = prevFromAll.length > 0
      ? prevFromAll.length
      : (String(cardSnap.docId) === prev ? (cardSnap.problems?.length ?? 0) : 0);

    if (prevTotal <= 0) {
      prevSecondBarCardIdRef.current = nextSid;
      return;
    }

    secondBarExitAnimLockRef.current = true;
    const frozenSessionDone = sessionFrozenBackupRef.current;
    const sessionCardTotalSnap = flatCardsLenForSecondBarExitRef.current;
    setSecondBarExitHold({
      phase: 1,
      prevCardId: prev,
      total: prevTotal,
      frozenSessionDone,
      sessionCardTotal: sessionCardTotalSnap,
    });
    if (secondBarExitPhase1TimerRef.current) clearTimeout(secondBarExitPhase1TimerRef.current);
    if (secondBarExitPhase2TimerRef.current) clearTimeout(secondBarExitPhase2TimerRef.current);
    secondBarExitPhase1TimerRef.current = setTimeout(() => {
      secondBarExitPhase1TimerRef.current = null;
      setSecondBarExitHold((h) => (h?.phase === 1 ? { phase: 2, prevCardId: prev, total: prevTotal } : h));
      const phase2Ms = showCardQueueProgressForExitRef.current ? SECOND_BAR_EXIT_PHASE2_MS : 60;
      secondBarExitPhase2TimerRef.current = setTimeout(() => {
        setSecondBarExitHold(null);
        prevSecondBarCardIdRef.current = nextSid;
        secondBarExitAnimLockRef.current = false;
        secondBarExitPhase2TimerRef.current = null;
      }, phase2Ms);
    }, SECOND_BAR_EXIT_PHASE1_MS);

    return () => {
      if (secondBarExitPhase1TimerRef.current) {
        clearTimeout(secondBarExitPhase1TimerRef.current);
        secondBarExitPhase1TimerRef.current = null;
      }
      if (secondBarExitPhase2TimerRef.current) {
        clearTimeout(secondBarExitPhase2TimerRef.current);
        secondBarExitPhase2TimerRef.current = null;
      }
      secondBarExitAnimLockRef.current = false;
    };
  }, [secondBarCardIdFromQueue]);

  const [problemStartTime, setProblemStartTime] = useState<number>(Date.now());
  const [problemAttempts, setProblemAttempts] = useState<Record<string, number>>({});
  const sessionStartTimeRef = useRef<number>(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [cardTimesMs, setCardTimesMs] = useState<number[]>(() => {
    const fromServer = (window as any).UiContext?.lessonCardTimesMs;
    return Array.isArray(fromServer) ? fromServer : [];
  });
  const [showPeekCard, setShowPeekCard] = useState(false);
  const [peekCount, setPeekCount] = useState<Record<string, number>>({});
  const [correctNeeded, setCorrectNeeded] = useState<Record<string, number>>({});
  const [optionOrder, setOptionOrder] = useState<number[]>([]);
  const [shuffleTrigger, setShuffleTrigger] = useState(0);
  const [browseFlipped, setBrowseFlipped] = useState(false);
  const [browseNoImpression, setBrowseNoImpression] = useState(false);
  const [browseSubmitting, setBrowseSubmitting] = useState(false);
  const [lessonCardNavLoading, setLessonCardNavLoading] = useState(false);

  const applySpaLesson = useCallback((payload: Record<string, unknown>) => {
    const normalizeNodeFromPayload = (raw: unknown): Node => {
      if (!raw || typeof raw !== 'object') return { id: '', text: '' };
      const n = raw as Record<string, unknown>;
      return {
        id: String(n.id ?? ''),
        text: String(n.text ?? n.title ?? ''),
      };
    };
    setLessonUi((prev) => ({
      ...prev,
      card: payload.card != null ? normalizeCardFromServer(payload.card) : prev.card,
      node: payload.node != null ? normalizeNodeFromPayload(payload.node) : prev.node,
      cards: Array.isArray(payload.cards) ? (payload.cards as unknown[]).map(normalizeCardFromServer) : prev.cards,
      currentIndex: typeof payload.currentIndex === 'number' ? payload.currentIndex : prev.currentIndex,
      domainId: typeof payload.domainId === 'string' ? payload.domainId : prev.domainId,
      baseDocId: typeof payload.baseDocId === 'string' ? payload.baseDocId : prev.baseDocId,
      lessonSessionId: typeof payload.lessonSessionId === 'string' ? String(payload.lessonSessionId).trim() : prev.lessonSessionId,
      currentCardIndex: typeof payload.currentCardIndex === 'number' ? payload.currentCardIndex : prev.currentCardIndex,
      flatCards: Array.isArray(payload.flatCards) ? (payload.flatCards as LessonUiState['flatCards']) : prev.flatCards,
      nodeTree: Array.isArray(payload.nodeTree) ? (payload.nodeTree as LessonNodeTreeItem[]) : prev.nodeTree,
      hasProblems: typeof payload.hasProblems === 'boolean' ? payload.hasProblems : prev.hasProblems,
      lessonReviewCardIds: Array.isArray(payload.lessonReviewCardIds)
        ? (payload.lessonReviewCardIds as unknown[]).map(String)
        : prev.lessonReviewCardIds,
      reviewCardId: payload.reviewCardId != null ? String(payload.reviewCardId) : prev.reviewCardId,
      isSingleNodeMode: typeof payload.isSingleNodeMode === 'boolean' ? payload.isSingleNodeMode : prev.isSingleNodeMode,
      isTodayMode: typeof payload.isTodayMode === 'boolean' ? payload.isTodayMode : prev.isTodayMode,
      isAlonePractice: typeof payload.isAlonePractice === 'boolean' ? payload.isAlonePractice : prev.isAlonePractice,
      rootNodeId: typeof payload.rootNodeId === 'string' ? payload.rootNodeId : prev.rootNodeId,
      rootNodeTitle: typeof payload.rootNodeTitle === 'string' ? payload.rootNodeTitle : prev.rootNodeTitle,
      lessonCardProvenanceLabel: typeof payload.lessonCardProvenanceLabel === 'string'
        ? payload.lessonCardProvenanceLabel
        : prev.lessonCardProvenanceLabel,
      lessonLearnSessionMode: typeof payload.lessonLearnSessionMode === 'string'
        ? payload.lessonLearnSessionMode
        : prev.lessonLearnSessionMode,
      lessonTodayModesConfigLine: typeof payload.lessonTodayModesConfigLine === 'string'
        ? payload.lessonTodayModesConfigLine
        : prev.lessonTodayModesConfigLine,
      lessonTodayCardKind: payload.lessonTodayCardKind === 'review'
        ? 'review'
        : payload.lessonTodayCardKind === 'new'
          ? 'new'
          : prev.lessonTodayCardKind,
      lessonTodayCardKindLabel: typeof payload.lessonTodayCardKindLabel === 'string'
        ? payload.lessonTodayCardKindLabel
        : prev.lessonTodayCardKindLabel,
      lessonSessionLearnStartSlot: typeof payload.lessonSessionLearnStartSlot === 'number'
        ? payload.lessonSessionLearnStartSlot
        : prev.lessonSessionLearnStartSlot,
      lessonSessionQueueNewOldLabel: typeof payload.lessonSessionQueueNewOldLabel === 'string'
        ? payload.lessonSessionQueueNewOldLabel
        : prev.lessonSessionQueueNewOldLabel,
      learnPathCardPractiseCounts: payload.learnPathCardPractiseCounts != null
        && typeof payload.learnPathCardPractiseCounts === 'object'
        && !Array.isArray(payload.learnPathCardPractiseCounts)
        ? normalizeLearnPathPractiseCountsMap(payload.learnPathCardPractiseCounts)
        : prev.learnPathCardPractiseCounts,
      lessonPathCardPractiseCountFmt: typeof payload.lessonPathCardPractiseCountFmt === 'string'
        ? payload.lessonPathCardPractiseCountFmt
        : prev.lessonPathCardPractiseCountFmt,
      lessonPathCardPractiseCountTitle: typeof payload.lessonPathCardPractiseCountTitle === 'string'
        ? payload.lessonPathCardPractiseCountTitle
        : prev.lessonPathCardPractiseCountTitle,
      flatQueueCards: Array.isArray(payload.flatQueueCards)
        ? (payload.flatQueueCards as unknown[]).map(normalizeCardFromServer)
        : prev.flatQueueCards,
      lessonProblemTagOptions: Array.isArray(payload.lessonProblemTagOptions)
        ? (payload.lessonProblemTagOptions as unknown[]).map((x) => String(x)).filter(Boolean)
        : prev.lessonProblemTagOptions,
      lessonCanEditProblemTags: typeof payload.lessonCanEditProblemTags === 'boolean'
        ? payload.lessonCanEditProblemTags
        : prev.lessonCanEditProblemTags,
    }));
    const nextCard = payload.card != null ? normalizeCardFromServer(payload.card) : null;
    const payloadHasFlatQKey = Object.prototype.hasOwnProperty.call(payload, 'flatQueueCards');
    const nextFlatQFromPayload = payloadHasFlatQKey && Array.isArray(payload.flatQueueCards)
      ? (payload.flatQueueCards as unknown[]).map(normalizeCardFromServer)
      : null;
    const probs = (() => {
      if (nextFlatQFromPayload && nextFlatQFromPayload.length > 0) {
        const out: QueuedProblem[] = [];
        for (const c of nextFlatQFromPayload) {
          const cid = String(c.docId ?? '');
          for (const p of c.problems || []) {
            out.push({ ...p, cardId: cid } as QueuedProblem);
          }
        }
        return out;
      }
      if (payloadHasFlatQKey && nextFlatQFromPayload && nextFlatQFromPayload.length === 0) {
        return [];
      }
      const retain = flatQueueCardsRef.current;
      if (retain.length > 0) {
        const out: QueuedProblem[] = [];
        for (const c of retain) {
          const cid = String(c.docId ?? '');
          for (const p of c.problems || []) {
            out.push({ ...p, cardId: cid } as QueuedProblem);
          }
        }
        return out;
      }
      return (nextCard?.problems || []).map((p) => ({ ...p, cardId: String(nextCard!.docId) } as QueuedProblem));
    })();
    if (secondBarExitPhase1TimerRef.current) {
      clearTimeout(secondBarExitPhase1TimerRef.current);
      secondBarExitPhase1TimerRef.current = null;
    }
    if (secondBarExitPhase2TimerRef.current) {
      clearTimeout(secondBarExitPhase2TimerRef.current);
      secondBarExitPhase2TimerRef.current = null;
    }
    secondBarExitAnimLockRef.current = false;
    prevSecondBarCardIdRef.current = null;
    setSecondBarExitHold(null);

    setProblemQueue(probs);
    setLessonPreviousStack([]);
    setCurrentProblemIndex(0);
    setSelectedAnswer(null);
    setSelectedMulti([]);
    setSelectedTf(null);
    setFlipStage('a');
    setFlipHintOpen(false);
    setIsAnswered(false);
    setShowAnalysis(false);
    setIsPassed(false);
    hasCalledPassRef.current = false;
    sessionStartTimeRef.current = Date.now();
    setProblemStartTime(Date.now());
    setAnswerHistory([]);
    setPracticeClearedPids({});
    setProblemAttempts({});
    setPeekCount({});
    setCorrectNeeded({});
    setOptionOrder([]);
    setMatchingSelections([]);
    setMatchingShuffleOrders([]);
    setShowPeekCard(false);
    setBrowseFlipped(false);
    setBrowseNoImpression(false);
    setShuffleTrigger((x) => x + 1);
    setElapsedMs(0);
    if (Array.isArray(payload.lessonCardTimesMs)) {
      setCardTimesMs(payload.lessonCardTimesMs as number[]);
    }
  }, []);

  const MOBILE_BREAKPOINT = 768;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const showSidebarInNav = hasLessonSidebar;

  useEffect(() => {
    if (allProblems.length > 0 && problemQueue.length === 0 && answerHistory.length === 0) {
      setProblemQueue(allProblems);
      setLessonPreviousStack([]);
      setCurrentProblemIndex(0);
      setSelectedAnswer(null);
      setSelectedMulti([]);
      setSelectedTf(null);
      setFlipStage('a');
      setFlipHintOpen(false);
      setIsAnswered(false);
      setShowAnalysis(false);
      setPracticeClearedPids({});
    }
  }, [allProblems, problemQueue.length, answerHistory.length]);

  const [lessonProblemTagSaveKey, setLessonProblemTagSaveKey] = useState<string | null>(null);
  const [lessonProblemTagRegisterBusy, setLessonProblemTagRegisterBusy] = useState(false);
  const [lessonProblemTagPanelOpen, setLessonProblemTagPanelOpen] = useState(false);

  const lessonCurrentProblemSlotKey = problemQueue[currentProblemIndex]
    ? `${String(problemQueue[currentProblemIndex].cardId)}:${problemQueue[currentProblemIndex].pid}`
    : '';

  useEffect(() => {
    setLessonProblemTagPanelOpen(false);
  }, [lessonCurrentProblemSlotKey]);

  useEffect(() => {
    if (!lessonProblemTagPanelOpen) return;
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLessonProblemTagPanelOpen(false);
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [lessonProblemTagPanelOpen]);

  const persistLessonProblemTag = useCallback(async (cardIdRaw: string, pid: string, nextTags: string[]) => {
    if (!lessonApiDomainId || !baseDocId || !lessonCanEditProblemTags) return;
    const cardIdStr = String(cardIdRaw).trim();
    const saveKey = `${cardIdStr}:${pid}`;
    const nextSan = sanitizeProblemTagRegistryList(nextTags, 32);
    const findCardSnapshot = (): Card | null => {
      if (String(card.docId) === cardIdStr) return card;
      for (const c of cards) {
        if (String(c.docId) === cardIdStr) return c;
      }
      for (const c of flatQueueCards) {
        if (String(c.docId) === cardIdStr) return c;
      }
      return null;
    };
    const cdoc = findCardSnapshot();
    if (!cdoc) {
      Notification.error(i18n('Lesson problem tag save no card'));
      return;
    }
    const nodeId = String((cdoc as unknown as { nodeId?: string }).nodeId || '').trim();
    if (!nodeId) {
      Notification.error(i18n('Lesson problem tag save missing node'));
      return;
    }
    const orderRaw = (cdoc as unknown as { order?: number }).order;
    const order =
      typeof orderRaw === 'number' && Number.isFinite(orderRaw) && orderRaw > 0 ? orderRaw : 1;
    const prevProblems = cdoc.problems || [];
    const nextProblems = prevProblems.map((pr) => {
      if (pr.pid !== pid) return pr;
      const copy = { ...pr } as Problem & Record<string, unknown>;
      if (nextSan.length === 0) delete copy.tags;
      else copy.tags = nextSan;
      return copy;
    });
    setLessonProblemTagSaveKey(saveKey);
    try {
      await request.post(`/d/${lessonApiDomainId}/base/card/${encodeURIComponent(cardIdStr)}`, {
        operation: 'update',
        docId: Number(baseDocId),
        nodeId,
        title: String(cdoc.title ?? ''),
        content: String(cdoc.content ?? ''),
        order,
        problems: nextProblems,
      });
      setLessonUi((prev) => mergeLessonUiCardProblems(prev, cardIdStr, nextProblems));
      setProblemQueue((q) =>
        q.map((pr) => {
          if (String(pr.cardId) !== cardIdStr || pr.pid !== pid) return pr;
          const qp = { ...pr } as QueuedProblem & Record<string, unknown>;
          if (nextSan.length === 0) delete qp.tags;
          else qp.tags = nextSan;
          return qp as QueuedProblem;
        }),
      );
      setAnswerHistory((hist) =>
        hist.map((row) => {
          if (String(row.problem.cardId) !== cardIdStr || row.problem.pid !== pid) return row;
          const np = { ...row.problem } as QueuedProblem & Record<string, unknown>;
          if (nextSan.length === 0) delete np.tags;
          else np.tags = nextSan;
          return { ...row, problem: np as QueuedProblem };
        }),
      );
      Notification.success(i18n('Saved successfully'));
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        ?? (err as Error)?.message
        ?? i18n('Lesson problem tag save failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setLessonProblemTagSaveKey(null);
    }
  }, [lessonApiDomainId, baseDocId, lessonCanEditProblemTags, card, cards, flatQueueCards]);

  const registerLessonProblemTagToRegistry = useCallback(async (tagRaw: string) => {
    const tag = normalizeProblemTagInput(tagRaw);
    if (!lessonApiDomainId || !baseDocId || !lessonCanEditProblemTags || !tag) return;
    const bid = Number(baseDocId);
    if (!Number.isFinite(bid) || bid <= 0) {
      Notification.error(i18n('Lesson problem tag register failed'));
      throw new Error('invalid base');
    }
    setLessonProblemTagRegisterBusy(true);
    try {
      const res: any = await request.post(
        `/d/${lessonApiDomainId}/base/${bid}/problem-tag-register`,
        { tag },
      );
      const listRaw = res?.problemTags;
      if (Array.isArray(listRaw)) {
        setLessonUi((prev) => ({
          ...prev,
          lessonProblemTagOptions: listRaw.map((x: unknown) => String(x)).filter(Boolean),
        }));
      } else {
        setLessonUi((prev) => ({
          ...prev,
          lessonProblemTagOptions: [...new Set([...prev.lessonProblemTagOptions, tag])].sort((a, b) => a.localeCompare(b)),
        }));
      }
      Notification.success(i18n('Lesson problem tag register ok'));
    } catch (e: unknown) {
      const msg = (e as Error)?.message || i18n('Lesson problem tag register failed');
      Notification.error(msg);
      throw e;
    } finally {
      setLessonProblemTagRegisterBusy(false);
    }
  }, [lessonApiDomainId, baseDocId, lessonCanEditProblemTags]);

  const isNodeOrToday = isSingleNodeMode || isTodayMode;
  const cardTimesStorageKey = domainId && rootNodeId
    ? `lesson-card-times-${domainId}-${rootNodeId}`
    : '';

  useEffect(() => {
    if (!cardTimesStorageKey || !isNodeOrToday) return;
    if (currentCardIndex === 0) {
      try {
        sessionStorage.removeItem(cardTimesStorageKey);
      } catch (_) {}
      setCardTimesMs([]);
      return;
    }
    const fromServer = (window as any).UiContext?.lessonCardTimesMs;
    const serverArr = Array.isArray(fromServer) ? fromServer : [];
    try {
      const raw = sessionStorage.getItem(cardTimesStorageKey);
      const fromStorage = raw ? JSON.parse(raw) : [];
      const arr = Array.isArray(fromStorage) ? fromStorage : [];
      if (arr.length >= serverArr.length) {
        setCardTimesMs(arr);
      } else if (serverArr.length > 0) {
        setCardTimesMs(serverArr);
      } else {
        setCardTimesMs(arr);
      }
    } catch (_) {
      setCardTimesMs(serverArr.length > 0 ? serverArr : []);
    }
  }, [cardTimesStorageKey, isNodeOrToday, currentCardIndex]);

  useEffect(() => {
    const tick = () => setElapsedMs(Date.now() - sessionStartTimeRef.current);
    const id = setInterval(tick, 1000);
    tick();
    return () => clearInterval(id);
  }, []);

  const cumulativeMs = cardTimesMs.reduce((a, b) => a + b, 0) + (isNodeOrToday ? elapsedMs : 0);
  const currentCardCumulativeMs = elapsedMs + (cardTimesMs[currentCardIndex] ?? 0);

  const showPathCardPractiseCount = isSingleNodeMode || isTodayMode || isAlonePractice;
  const currentPathCardLoopCount = useMemo(
    () => pathLoopCountForFlatCard(flatCards[currentCardIndex], learnPathCardPractiseCounts),
    [flatCards, currentCardIndex, learnPathCardPractiseCounts],
  );
  const pathCardLoopCountText = useMemo(() => {
    const fromServer = (lessonPathCardPractiseCountFmt || '').trim();
    const tpl = fromServer || i18n('Lesson path card practise count');
    if (tpl.includes('{0}')) return tpl.replace(/\{0\}/g, String(currentPathCardLoopCount));
    return `${tpl} ${currentPathCardLoopCount}`;
  }, [currentPathCardLoopCount, lessonPathCardPractiseCountFmt]);

  const pathCardPractiseTooltip = useMemo(() => {
    const s = (lessonPathCardPractiseCountTitle || '').trim();
    if (s) return s;
    const t = i18n('Lesson path card practise count title');
    return t !== 'Lesson path card practise count title' ? t : undefined;
  }, [lessonPathCardPractiseCountTitle]);

  const lessonSessionModeLabel = useMemo(() => {
    if (isTodayMode && rootNodeId === 'today') return i18n('Today task');
    if (isTodayMode) return i18n('Today session');
    if (isSingleNodeMode) return i18n('Single-node session');
    if (isAlonePractice) return i18n('Single-card session');
    return '';
  }, [isTodayMode, rootNodeId, isSingleNodeMode, isAlonePractice]);

  const lessonQueueDoneCount = useMemo(() => {
    if (!showCardQueueProgress) return 0;
    let n = 0;
    flatCards.forEach((item, idx) => {
      const inReview = lessonReviewCardIds.includes(String(item.cardId));
      if (idx < currentCardIndex && !inReview) n += 1;
    });
    return n;
  }, [showCardQueueProgress, flatCards, currentCardIndex, lessonReviewCardIds]);

  const lessonQueuePendingCount = useMemo(() => {
    if (!showCardQueueProgress) return 0;
    return Math.max(0, flatCards.length - lessonQueueDoneCount);
  }, [showCardQueueProgress, flatCards.length, lessonQueueDoneCount]);

  useLayoutEffect(() => {
    if (secondBarExitHold !== null) return;
    const liveDone = mergeSingleNodeCardQueueIntoProblemSidebar
      ? mergeModeCompletedCardCount
      : lessonQueueDoneCount;
    const prevS = prevSidForSessionFrozenSyncRef.current;
    if (prevS !== null && prevS === secondBarCardIdFromQueue) {
      sessionFrozenBackupRef.current = liveDone;
    }
    prevSidForSessionFrozenSyncRef.current = secondBarCardIdFromQueue;
  }, [
    secondBarCardIdFromQueue,
    secondBarExitHold,
    mergeSingleNodeCardQueueIntoProblemSidebar,
    mergeModeCompletedCardCount,
    lessonQueueDoneCount,
  ]);

  const lessonSessionNewOldCounts = useMemo(() => {
    if (!showCardQueueProgress || flatCards.length === 0) return null;
    if (!isTodayMode && !isSingleNodeMode) return null;
    if (typeof lessonSessionLearnStartSlot !== 'number' || lessonSessionLearnStartSlot < 0) return null;
    let newN = 0;
    let reviewN = 0;
    for (const c of flatCards) {
      const k = flatCardNewOldKind(c, lessonSessionLearnStartSlot);
      if (k === 'old') reviewN += 1;
      else newN += 1;
    }
    return { newN, reviewN };
  }, [showCardQueueProgress, flatCards, isTodayMode, isSingleNodeMode, lessonSessionLearnStartSlot]);

  const lessonSessionProgressCard = useMemo(() => {
    if (!showLessonSessionProgressCard) return null;
    const modeLabel = lessonSessionModeLabel || i18n('Learn session');
    const modeBlock = (
      <div style={{ marginBottom: (showCardQueueProgress || showLessonProblemSessionProgress) ? '12px' : 0 }}>
        <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginBottom: '4px' }}>
          {i18n('Session type')}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' }}>
          <span style={{ fontSize: '15px', fontWeight: 700, color: themeStyles.accent }}>
            {modeLabel}
          </span>
          {isTodayMode && (
            <>
              <span style={{ fontSize: '14px', color: themeStyles.textTertiary }} aria-hidden>·</span>
              <span style={{ fontSize: '14px', fontWeight: 600, color: themeStyles.textPrimary }}>
                {labelForFrozenLessonQueueMode(lessonLearnSessionMode)}
              </span>
            </>
          )}
        </div>
        {isTodayMode && rootNodeId === 'today' && lessonTodayModesConfigLine ? (
          <div style={{
            fontSize: '12px',
            color: themeStyles.textTertiary,
            marginTop: '8px',
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}>
            {lessonTodayModesConfigLine}
          </div>
        ) : null}
      </div>
    );
    const cardShell = {
      marginBottom: '24px',
      padding: '20px 24px',
      backgroundColor: themeStyles.bgCard,
      borderRadius: '12px',
      border: `1px solid ${themeStyles.border}`,
      boxShadow: theme === 'dark' ? '0 2px 12px rgba(0,0,0,0.25)' : '0 2px 10px rgba(0,0,0,0.06)',
    } as const;
    if (!showCardQueueProgress && !showLessonProblemSessionProgress) {
      return (
        <div style={cardShell}>
          {modeBlock}
        </div>
      );
    }

    const trackStyle: React.CSSProperties = {
      height: '14px',
      borderRadius: '999px',
      backgroundColor: themeStyles.bgSecondary,
      border: `1px solid ${themeStyles.border}`,
      overflow: 'hidden',
    };
    const fillStyle = (pct: number): React.CSSProperties => ({
      width: `${pct}%`,
      height: '100%',
      borderRadius: '999px',
      background: `linear-gradient(90deg, ${themeStyles.accent}, ${themeStyles.success})`,
      transition: 'width 0.35s ease',
    });

    const sessionCardTotal =
      secondBarExitHold?.phase === 1
        ? secondBarExitHold.sessionCardTotal
        : flatCards.length;
    const sessionCardDoneLive = mergeSingleNodeCardQueueIntoProblemSidebar
      ? mergeModeCompletedCardCount
      : lessonQueueDoneCount;
    const sessionCardDone =
      secondBarExitHold?.phase === 1
        ? secondBarExitHold.frozenSessionDone
        : sessionCardDoneLive;
    const showSessionCardBar = showCardQueueProgress && sessionCardTotal > 0;
    const sessionCardPct = sessionCardTotal > 0
      ? Math.min(100, Math.round((sessionCardDone / sessionCardTotal) * 100))
      : 0;
    const newOldLine = lessonQueueNewOldLine(lessonSessionQueueNewOldLabel, lessonSessionNewOldCounts);
    const newOldPrefix = newOldLine ? `${newOldLine} · ` : '';

    const inExitHold = secondBarExitHold !== null;
    const displaySecondBarCardId = inExitHold ? secondBarExitHold.prevCardId : secondBarCardIdFromQueue;
    const fromAllForBar = allProblems.filter((p) => String(p.cardId) === displaySecondBarCardId);
    const currentCardProblemPids = inExitHold
      ? []
      : (fromAllForBar.length > 0
        ? fromAllForBar.map((p) => String(p.pid))
        : (card.problems || []).map((p) => String((p as { pid?: string }).pid || '')).filter(Boolean));
    const currentCardProblemTotal = inExitHold ? secondBarExitHold!.total : currentCardProblemPids.length;
    const currentCardProblemDone = inExitHold
      ? secondBarExitHold!.total
      : currentCardProblemPids.filter((pid) => !!practiceClearedPids[pid]).length;
    const showCurrentCardProblemsBar = inExitHold ? secondBarExitHold!.total > 0 : currentCardProblemTotal > 0;
    const currentCardPct = currentCardProblemTotal > 0
      ? Math.min(100, Math.round((currentCardProblemDone / currentCardProblemTotal) * 100))
      : 0;

    return (
      <div style={cardShell}>
        {modeBlock}
        {showSessionCardBar ? (
          <div style={{ marginBottom: showCurrentCardProblemsBar ? '18px' : 0 }}>
            <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginBottom: '6px' }}>
              {i18n('Lesson progress session cards')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', marginBottom: '10px', gap: '12px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.accent }}>
                {newOldPrefix}
                {sessionCardDone} / {sessionCardTotal} {i18n('cards')} · {sessionCardPct}%
              </span>
            </div>
            <div style={trackStyle}>
              <div style={fillStyle(sessionCardPct)} />
            </div>
          </div>
        ) : null}
        {showCurrentCardProblemsBar ? (
          <div>
            <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginBottom: '6px' }}>
              {i18n('Lesson progress current card problems')}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', marginBottom: '10px', gap: '12px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.accent }}>
                {currentCardProblemDone} / {currentCardProblemTotal} {i18n('Lesson practice progress unit')} · {currentCardPct}%
              </span>
            </div>
            <div style={trackStyle}>
              <div style={fillStyle(currentCardPct)} />
            </div>
          </div>
        ) : null}
      </div>
    );
  }, [
    showLessonSessionProgressCard,
    showCardQueueProgress,
    showLessonProblemSessionProgress,
    mergeSingleNodeCardQueueIntoProblemSidebar,
    mergeModeCompletedCardCount,
    card,
    lessonSessionModeLabel,
    isTodayMode,
    rootNodeId,
    lessonLearnSessionMode,
    lessonTodayModesConfigLine,
    flatCards,
    allProblems,
    practiceClearedPids,
    problemQueue,
    currentProblemIndex,
    secondBarCardIdFromQueue,
    secondBarExitHold,
    lessonQueueDoneCount,
    lessonSessionNewOldCounts,
    lessonSessionQueueNewOldLabel,
    themeStyles,
    theme,
    i18n,
  ]);

  const showTodayLearnKindBadge = isTodayMode && rootNodeId === 'today' && !!lessonTodayCardKindLabel;
  const todayLearnKindIsReview = lessonTodayCardKind === 'review';
  const lessonProvenanceTopRow = useMemo(() => {
    if (!showLessonSessionProgressCard || (!lessonCardProvenanceLabel && !showTodayLearnKindBadge)) return null;
    return (
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '8px',
        fontSize: '12px',
        color: themeStyles.textTertiary,
        marginBottom: '8px',
        lineHeight: 1.45,
        wordBreak: 'break-word',
      }}>
        {showTodayLearnKindBadge ? (
          <span
            style={{
              flexShrink: 0,
              fontSize: '11px',
              fontWeight: 700,
              padding: '3px 8px',
              borderRadius: '6px',
              letterSpacing: '0.02em',
              backgroundColor: todayLearnKindIsReview ? themeStyles.reviewBg : themeStyles.accentMutedBg,
              color: todayLearnKindIsReview ? themeStyles.reviewFg : themeStyles.accentMutedFg,
            }}
          >
            {lessonTodayCardKindLabel}
          </span>
        ) : null}
        {lessonCardProvenanceLabel ? (
          <span style={{ flex: '1 1 160px', minWidth: 0 }}>{lessonCardProvenanceLabel}</span>
        ) : null}
      </div>
    );
  }, [
    showLessonSessionProgressCard,
    lessonCardProvenanceLabel,
    showTodayLearnKindBadge,
    todayLearnKindIsReview,
    lessonTodayCardKindLabel,
    themeStyles,
  ]);

  useEffect(() => {
    if (!isMobile || !showSidebarInNav) return;
    const leftEl = document.getElementById('header-mobile-extra-left');
    const rightEl = document.getElementById('header-mobile-extra');
    const openLeft = () => {
      setLeftDrawerOpen(true);
      setRightDrawerOpen(false);
    };
    const openRight = () => {
      setRightDrawerOpen(true);
      setLeftDrawerOpen(false);
    };
    const leftWrap = leftEl ? (() => {
      const w = document.createElement('div');
      leftEl.appendChild(w);
      return w;
    })() : null;
    const rightWrap = splitQueueSidebars && rightEl ? (() => {
      const w = document.createElement('div');
      rightEl.appendChild(w);
      return w;
    })() : null;
    if (leftWrap) {
      const leftLabel = splitQueueSidebars
        ? (splitProblemPracticeSidebars
          ? `${i18n('Lesson practice sidebar completed')} (${practiceProblemsDoneCount})`
          : mergeSingleNodeCardQueueIntoProblemSidebar
            ? `${i18n('Lesson practice sidebar completed')} (${practiceProblemsDoneCount})`
            : `${i18n('Completed sections')} (${lessonQueueDoneCount})`)
        : i18n('Progress');
      ReactDOM.render(
        <button
          type="button"
          onClick={openLeft}
          aria-label={leftLabel}
        >
          ☰ {leftLabel}
        </button>,
        leftWrap,
      );
    }
    if (rightWrap) {
      const rightLabel = splitProblemPracticeSidebars
        ? `${i18n('Lesson practice sidebar pending')} (${practiceProblemsPendingCount})`
        : mergeSingleNodeCardQueueIntoProblemSidebar
          ? `${i18n('Lesson problem queue')} (${practiceProblemsPendingCount})`
          : `${i18n('Uncompleted')} (${lessonQueuePendingCount})`;
      ReactDOM.render(
        <button
          type="button"
          onClick={openRight}
          aria-label={rightLabel}
        >
          {rightLabel} ☰
        </button>,
        rightWrap,
      );
    }
    return () => {
      if (leftWrap) {
        ReactDOM.unmountComponentAtNode(leftWrap);
        leftWrap.remove();
      }
      if (rightWrap) {
        ReactDOM.unmountComponentAtNode(rightWrap);
        rightWrap.remove();
      }
    };
  }, [
    isMobile,
    showSidebarInNav,
    splitQueueSidebars,
    splitProblemPracticeSidebars,
    mergeSingleNodeCardQueueIntoProblemSidebar,
    mergeModeCompletedCardCount,
    allProblems.length,
    flatCards.length,
    lessonQueueDoneCount,
    lessonQueuePendingCount,
    practiceProblemsDoneCount,
    practiceProblemsPendingCount,
    i18n,
  ]);

  const showQueueNameNewOld = (isTodayMode || isSingleNodeMode)
    && typeof lessonSessionLearnStartSlot === 'number'
    && lessonSessionLearnStartSlot >= 0;

  const queueNewOldTagBeforeName = (fc: LessonUiState['flatCards'][number] | undefined) => {
    if (!showQueueNameNewOld || fc == null) return null;
    const k = flatCardNewOldKind(fc, lessonSessionLearnStartSlot);
    if (!k) return null;
    const isOld = k === 'old';
    return (
      <span style={{
        marginRight: '6px',
        fontSize: '11px',
        fontWeight: 600,
        flexShrink: 0,
        padding: '2px 6px',
        borderRadius: '4px',
        backgroundColor: isOld ? themeStyles.reviewBg : themeStyles.accentMutedBg,
        color: isOld ? themeStyles.reviewFg : themeStyles.accentMutedFg,
      }}>
        {i18nLearnQueueCardTag(isOld ? 'old' : 'new')}
      </span>
    );
  };

  /** 左右队列侧栏：路径练习次数（仅数字）与用时并列 */
  const sidebarQueuePathLoopAndTime = (pathLoopCount: number, timeText: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '8px', flexShrink: 0 }}>
      <span style={{ fontSize: '12px', color: themeStyles.textTertiary, fontVariantNumeric: 'tabular-nums' }}>
        {pathLoopCount}
      </span>
      <span style={{ fontSize: '12px', color: themeStyles.textTertiary }}>{timeText}</span>
    </span>
  );

  const renderNodeTreeItem = (item: { type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }, depth: number): React.ReactNode => {
    if (item.type === 'card') {
      const idx = cardIdToFlatIndex[item.id];
      const inReview = lessonReviewCardIds.includes(item.id);
      const isDone = typeof idx === 'number' && idx < currentCardIndex && !inReview;
      const isCurrent = typeof idx === 'number' && idx === currentCardIndex;
      const fc = typeof idx === 'number' ? flatCards[idx] : undefined;
      let timeText = '—';
      if (typeof idx === 'number') {
        if (isCurrent) timeText = `${(currentCardCumulativeMs / 1000).toFixed(1)}s`;
        else if (idx < cardTimesMs.length) timeText = `${(cardTimesMs[idx] / 1000).toFixed(1)}s`;
      }
      const cardStyle: React.CSSProperties = {
        padding: '6px 10px',
        marginLeft: `${depth * 12}px`,
        marginBottom: '2px',
        fontSize: '13px',
        borderRadius: '6px',
        backgroundColor: isCurrent ? themeStyles.accentMutedBg : inReview ? themeStyles.reviewBg : isDone ? themeStyles.doneBg : 'transparent',
        color: isCurrent ? themeStyles.accentMutedFg : inReview ? themeStyles.reviewFg : isDone ? themeStyles.doneFg : themeStyles.textSecondary,
        fontWeight: isCurrent ? 600 : 400,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
      };
      const content = (
        <>
          <span>
            {isDone && <span style={{ marginRight: '6px' }}>✓</span>}
            {inReview && <span style={{ marginRight: '6px', fontSize: '11px', color: themeStyles.reviewFg, fontWeight: 600 }}>{i18n('Review')}</span>}
            {queueNewOldTagBeforeName(fc)}
            {item.title || i18n('Unnamed Card')}
          </span>
          {sidebarQueuePathLoopAndTime(
            pathLoopCountForFlatCard(fc, learnPathCardPractiseCounts),
            timeText,
          )}
        </>
      );
      return (
        <div key={`card-${item.id}`} style={cardStyle}>
          {content}
        </div>
      );
    }
    const nodeItem = item as { type: 'node'; id: string; title: string; children: Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }> };
    return (
      <div key={`node-${nodeItem.id}`} style={{ marginBottom: '4px' }}>
        <div style={{
          padding: '6px 10px',
          marginLeft: `${depth * 12}px`,
          fontSize: '13px',
          fontWeight: 600,
          color: themeStyles.textPrimary,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
        }}>
          <span>{nodeItem.title || i18n('Unnamed Node')}</span>
        </div>
        {(nodeItem.children || []).map((child, i) => (
          <React.Fragment key={i}>{renderNodeTreeItem(child as { type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }, depth + 1)}</React.Fragment>
        ))}
      </div>
    );
  };

  useEffect(() => {
    const handleImageClick = async (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName !== 'IMG' || !target.closest('.lesson-markdown-body')) return;
      e.preventDefault();
      e.stopPropagation();
      const src = (target as HTMLImageElement).src;
      if (!src) return;
      try {
        let previewImage = (window as any).Ejunz?.components?.preview?.previewImage;
        if (!previewImage) {
          await import('vj/components/preview/preview.page');
          previewImage = (window as any).Ejunz?.components?.preview?.previewImage;
        }
        if (previewImage) {
          await previewImage(src);
        } else {
          const { InfoDialog } = await import('vj/components/dialog/index');
          const $ = (await import('jquery')).default;
          const isMobile = window.innerWidth <= 600;
          const maxHeight = isMobile ? 'calc(90vh - 60px)' : 'calc(80vh - 45px)';
          const padding = isMobile ? '10px' : '20px';
          const $img = $(`<img src="${src}" style="max-width: 100%; max-height: ${maxHeight}; width: auto; height: auto; cursor: pointer;" />`);
          const dialog = new InfoDialog({
            $body: $(`<div class="typo" style="padding: ${padding}; text-align: center;"></div>`).append($img),
            $action: null,
            cancelByClickingBack: true,
            cancelByEsc: true,
          });
          await dialog.open();
        }
      } catch (err) {
        console.error('Image preview failed:', err);
        Notification.error(i18n('Image preview failed'));
      }
    };
    document.addEventListener('click', handleImageClick, true);
    return () => document.removeEventListener('click', handleImageClick, true);
  }, []);

  const currentProblem = problemQueue[currentProblemIndex];
  const currentKind = currentProblem ? problemKind(currentProblem) : 'single';
  const currentSingle = currentKind === 'single' && currentProblem ? (currentProblem as ProblemSingle) : null;
  const displayOrder = currentSingle?.options
    && optionOrder.length === currentSingle.options.length
    ? optionOrder
    : (currentSingle?.options ? currentSingle.options.map((_, i) => i) : []);
  const displayOrderMulti = currentProblem && currentKind === 'multi' && (currentProblem as ProblemMulti).options
    && optionOrder.length === (currentProblem as ProblemMulti).options.length
    ? optionOrder
    : (currentProblem && currentKind === 'multi' && (currentProblem as ProblemMulti).options
      ? (currentProblem as ProblemMulti).options.map((_, i) => i)
      : []);

  const isCorrect = (() => {
    if (!currentProblem || !isAnswered) return false;
    if (currentKind === 'single') {
      const ps = currentProblem as ProblemSingle;
      if (selectedAnswer === null || !ps.options?.length) return false;
      const order = displayOrder.length === ps.options.length ? displayOrder : ps.options.map((_, i) => i);
      const originalIdx = order[selectedAnswer] ?? selectedAnswer;
      return originalIdx === ps.answer;
    }
    if (currentKind === 'multi') {
      const pm = currentProblem as ProblemMulti;
      const want = normalizeMultiAnswers(pm.answer);
      const got = [...selectedMulti].sort((a, b) => a - b);
      return setsEqualAsSorted(want, got);
    }
    if (currentKind === 'true_false') {
      const pt = currentProblem as ProblemTrueFalse;
      return selectedTf !== null && selectedTf === pt.answer;
    }
    if (currentKind === 'fill_blank') {
      const pf = currentProblem as ProblemFillBlank;
      const need = fillBlankSlotCount(pf.stem);
      const u = fillBlankDraft.slice(0, need);
      while (u.length < need) u.push('');
      return fillBlankResponseMatches(pf.answers || [], u);
    }
    if (currentKind === 'matching') {
      const pm = currentProblem as ProblemMatching;
      const cols = matchingColumnsNormalized(pm);
      const n = (cols[0] || []).length;
      const ncol = cols.length;
      return (
        n >= MATCHING_PAIR_MIN
        && ncol >= MATCHING_COL_MIN
        && matchingAllColumnsCorrect(n, ncol, matchingSelections)
      );
    }
    if (currentKind === 'flip') {
      return isAnswered;
    }
    if (currentKind === 'super_flip') {
      return isAnswered && superFlipMarkedOk === true;
    }
    return false;
  })();

  const allCorrect = problemQueue.length === 0 && answerHistory.length > 0;

  const formatPracticeHistoryUserAnswer = useCallback((h: {
    problem: QueuedProblem;
    selected: number;
    correct: boolean;
    fillAnswers?: string[];
  }) => {
    const k = problemKind(h.problem);
    if (k === 'single') {
      const ps = h.problem as ProblemSingle;
      const t = ps.options?.[h.selected];
      return typeof t === 'string' && t.trim() ? t : i18n('N/A');
    }
    if (k === 'multi') {
      const pm = h.problem as ProblemMulti;
      const opts = pm.options || [];
      const bits = h.selected;
      const indices: number[] = [];
      for (let i = 0; i < Math.min(opts.length, 31); i++) {
        if (bits & (1 << i)) indices.push(i);
      }
      if (indices.length === 0) return i18n('N/A');
      return indices.map((i) => String(opts[i] ?? '')).filter(Boolean).join('；') || i18n('N/A');
    }
    if (k === 'true_false') {
      if (h.selected === 1) return i18n('Problem answer true');
      if (h.selected === 0) return i18n('Problem answer false');
      return i18n('N/A');
    }
    if (k === 'flip') return i18n('Done');
    if (k === 'super_flip') return h.correct ? i18n('Done') : i18n('Problem super flip not familiar');
    if (k === 'fill_blank') {
      if (h.fillAnswers?.length) return h.fillAnswers.map((s) => String(s ?? '').trim()).filter(Boolean).join('；') || i18n('N/A');
      return i18n('N/A');
    }
    if (k === 'matching') {
      const pm = h.problem as ProblemMatching;
      const cols = matchingColumnsNormalized(pm);
      const n = cols[0]?.length ?? 0;
      const fullLen = cols.length;
      const picksFromFill = Array.isArray(h.fillAnswers)
        ? h.fillAnswers.map((cell) =>
            String(cell ?? '')
              .split(',')
              .map((p) => p.trim())
              .filter(Boolean)
              .map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : NaN)),
          )
        : [];
      const cellFromPick = (colIdx: number, pj: number | undefined) => {
        const colData = cols[colIdx] || [];
        return typeof pj === 'number' && Number.isFinite(pj) && pj >= 0 && pj < colData.length
          ? String(colData[pj] ?? '').trim()
          : '?';
      };
      const rows: string[] = [];
      for (let ii = 0; ii < n; ii++) {
        const pickRow = picksFromFill[ii];
        let chosenTexts: string[] = [];
        if (pickRow && pickRow.length === fullLen) {
          for (let ck = 0; ck < fullLen; ck++) {
            chosenTexts.push(cellFromPick(ck, pickRow[ck]));
          }
        } else {
          chosenTexts = [];
        }
        if (!chosenTexts.some((x) => x !== '?' && x !== '')) {
          rows.push(String(i18n('Problem matching row label', ii + 1)));
          continue;
        }
        rows.push(chosenTexts.join(' · '));
      }
      return rows.join('； ') || i18n('N/A');
    }
    return i18n('N/A');
  }, []);

  const formatPracticeHistoryCorrectAnswer = useCallback((p: QueuedProblem) => {
    const k = problemKind(p);
    if (k === 'single') {
      const ps = p as ProblemSingle;
      const t = ps.options?.[ps.answer];
      return typeof t === 'string' && t.trim() ? t : i18n('N/A');
    }
    if (k === 'multi') {
      const pm = p as ProblemMulti;
      const want = normalizeMultiAnswers(pm.answer);
      const opts = pm.options || [];
      if (want.length === 0) return i18n('N/A');
      return want.map((i) => String(opts[i] ?? '')).filter(Boolean).join('；') || i18n('N/A');
    }
    if (k === 'true_false') {
      const pt = p as ProblemTrueFalse;
      return pt.answer === 1 ? i18n('Problem answer true') : i18n('Problem answer false');
    }
    if (k === 'fill_blank') {
      const pf = p as ProblemFillBlank;
      const a = pf.answers || [];
      if (!a.length) return i18n('N/A');
      return a.map((s) => String(s ?? '').trim()).filter(Boolean).join('；') || i18n('N/A');
    }
    if (k === 'matching') {
      const pm = p as ProblemMatching;
      const cols = matchingColumnsNormalized(pm);
      const n = cols[0]?.length ?? 0;
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const cells = cols.map((c) => String(c[i] ?? '').trim()).filter(Boolean);
        if (cells.length) parts.push(cells.join(' ↔ '));
      }
      return parts.join('； ') || i18n('N/A');
    }
    if (k === 'super_flip') {
      const sf = p as ProblemSuperFlip;
      const { headers, columns } = superFlipNormalized(sf);
      const nrow = columns[0]?.length ?? 0;
      const parts: string[] = [];
      for (let ri = 0; ri < nrow; ri++) {
        const cells = columns.map((col, ci) => {
          const h = String(headers[ci] ?? '').trim();
          const body = String(col[ri] ?? '').trim();
          return body ? (h ? `${h}: ${body}` : body) : '';
        }).filter(Boolean);
        if (cells.length) parts.push(cells.join(' · '));
      }
      return parts.join('； ') || i18n('N/A');
    }
    if (k === 'flip') return i18n('Problem kind flip');
    return i18n('N/A');
  }, []);

  useLayoutEffect(() => {
    if (!currentProblem) return;
    const restore = lessonPendingRestoreRef.current;
    if (restore && restore.problem.pid === currentProblem.pid) {
      lessonPendingRestoreRef.current = null;
      const r = restore;
      setSelectedAnswer(r.selectedAnswer);
      setSelectedMulti([...r.selectedMulti]);
      setSelectedTf(r.selectedTf);
      setFillBlankDraft([...r.fillBlankDraft]);
      setMatchingSelections(r.matchingSelections.map((row) => [...row]));
      setMatchingShuffleOrders(r.matchingShuffleOrders.map((row) => [...row]));
      setFlipStage(r.flipStage);
      setFlipHintOpen(r.flipHintOpen);
      setSuperFlipRevealed(r.superFlipRevealed.map((col) => [...col]));
      setSuperFlipMarkedOk(r.superFlipMarkedOk);
      setOptionOrder([...r.optionOrder]);
      setIsAnswered(r.isAnswered);
      setShowAnalysis(r.showAnalysis);
      setPendingLessonAdvance(r.pendingLessonAdvance);
      setProblemAttempts((prev) => ({ ...prev, [r.problem.pid]: r.problemAttemptSnapshot }));
      setProblemStartTime(Date.now());
      return;
    }
    const k = problemKind(currentProblem);
    setSuperFlipRevealed([]);
    setSuperFlipMarkedOk(null);
    setSelectedAnswer(null);
    setSelectedMulti([]);
    setSelectedTf(null);
    setFlipStage('a');
    setFlipHintOpen(false);
    setFillBlankDraft(
      k === 'fill_blank'
        ? Array.from({ length: fillBlankSlotCount((currentProblem as ProblemFillBlank).stem) }, () => '')
        : [],
    );
    setMatchingSelections([]);
    setMatchingShuffleOrders([]);
    setIsAnswered(false);
    setShowAnalysis(false);
    setPendingLessonAdvance(null);
    setProblemStartTime(Date.now());
    if (k === 'single') {
      const ps = currentProblem as ProblemSingle;
      if (!ps.options?.length) {
        setOptionOrder([]);
        return;
      }
      const indices = ps.options.map((_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      setOptionOrder(indices);
    } else if (k === 'multi' && (currentProblem as ProblemMulti).options?.length) {
      const indices = (currentProblem as ProblemMulti).options.map((_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      setOptionOrder(indices);
    } else if (k === 'matching') {
      const pm = currentProblem as ProblemMatching;
      const cols = matchingColumnsNormalized(pm);
      const n = cols[0]?.length ?? 0;
      const ncol = cols.length;
      if (n >= MATCHING_PAIR_MIN && ncol >= MATCHING_COL_MIN) {
        const orders: number[][] = [];
        for (let ck = 0; ck < ncol; ck++) {
          const indices = Array.from({ length: n }, (_, i) => i);
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          orders.push(indices);
        }
        setMatchingShuffleOrders(orders);
        setMatchingSelections(Array.from({ length: n }, () => Array.from({ length: ncol }, () => null)));
      } else {
        setMatchingShuffleOrders([]);
        setMatchingSelections([]);
      }
      setOptionOrder([]);
    } else if (k === 'super_flip') {
      const sf = currentProblem as ProblemSuperFlip;
      const { columns } = superFlipNormalized(sf);
      const ncol = columns.length;
      const nrow = columns[0]?.length ?? 0;
      setSuperFlipRevealed(Array.from({ length: ncol }, () => Array.from({ length: nrow }, () => false)));
      setOptionOrder([]);
    } else {
      setMatchingShuffleOrders([]);
      setOptionOrder([]);
    }
  }, [currentProblemIndex, currentProblem?.pid, shuffleTrigger]);

  const currentPeekCount = currentProblem ? (peekCount[currentProblem.pid] || 0) : 0;
  const currentCorrectNeeded = currentProblem ? (correctNeeded[currentProblem.pid] || 0) : 0;

  const handlePass = async () => {
    if (isPassed || isSubmitting || hasCalledPassRef.current) return;
    
    hasCalledPassRef.current = true;
    setIsSubmitting(true);
    try {
      const totalTimeMs = Date.now() - sessionStartTimeRef.current;
      let nextTimes: number[] | null = null;
      if (cardTimesStorageKey && isNodeOrToday) {
        try {
          const raw = sessionStorage.getItem(cardTimesStorageKey);
          const arr = raw ? JSON.parse(raw) : [];
          const isReviewCard = lessonReviewCardIds.includes(String(card.docId)) || (reviewCardId && String(card.docId) === reviewCardId);
          if (isReviewCard && currentCardIndex >= 0 && currentCardIndex < (Array.isArray(arr) ? arr.length : 0)) {
            nextTimes = Array.isArray(arr) ? [...arr] : [];
            nextTimes[currentCardIndex] = (nextTimes[currentCardIndex] ?? 0) + totalTimeMs;
          } else {
            nextTimes = Array.isArray(arr) ? [...arr, totalTimeMs] : [totalTimeMs];
          }
          sessionStorage.setItem(cardTimesStorageKey, JSON.stringify(nextTimes));
        } catch (_) {}
      }
      const canSpaNextCard = isSingleNodeMode || isTodayMode;
      const result = await request.post(`/d/${lessonApiDomainId}/learn/lesson/pass`, {
        ...passSession,
        answerHistory: answerHistory.map(h => ({
          problemId: h.problem.pid,
          cardId: String((h.problem as QueuedProblem).cardId || card.docId),
          selected: h.selected,
          correct: h.correct,
          timeSpent: h.timeSpent,
          attempts: h.attempts,
          ...(h.fillAnswers ? { fillAnswers: h.fillAnswers } : {}),
        })),
        totalTime: totalTimeMs,
        isAlonePractice: isAlonePractice && !isSingleNodeMode && !isTodayMode,
        cardId: (isAlonePractice || isSingleNodeMode || isTodayMode) ? card.docId : undefined,
        singleNodeMode: isSingleNodeMode || undefined,
        todayMode: isTodayMode || undefined,
        nodeId: isSingleNodeMode ? rootNodeId : undefined,
        spaNext: canSpaNextCard ? true : undefined,
      });
      const { lesson: spaLessonPayload, spaNext: spaNextFlag, redirect: passRedirect } = unwrapLearnPassResponse(result);
      const spaOk = spaNextFlag === true || spaNextFlag === 'true' || spaNextFlag === 1;
      if (canSpaNextCard && lessonPayloadLooksValid(spaLessonPayload) && (spaOk || spaNextFlag === undefined)) {
        applySpaLesson(spaLessonPayload);
        const hasServerTimes = Array.isArray(spaLessonPayload.lessonCardTimesMs);
        if (nextTimes && !hasServerTimes) setCardTimesMs(nextTimes);
        return;
      }
      setIsPassed(true);
      if (nextTimes) setCardTimesMs(nextTimes);
      const redirect = typeof passRedirect === 'string' ? passRedirect : '';
      if (redirect) {
        window.location.href = redirect;
        return;
      }
    } catch (error: any) {
      console.error('Failed to submit practice result:', error);
      setIsPassed(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePassBrowse = async (noImpression: boolean) => {
    if (browseSubmitting) return;
    setBrowseSubmitting(true);
    try {
      const totalTimeMs = Date.now() - sessionStartTimeRef.current;
      let nextTimes: number[] | null = null;
      if (cardTimesStorageKey && isNodeOrToday) {
        try {
          const raw = sessionStorage.getItem(cardTimesStorageKey);
          const arr = raw ? JSON.parse(raw) : [];
          const isReviewCard = lessonReviewCardIds.includes(String(card.docId)) || (reviewCardId && String(card.docId) === reviewCardId);
          if (isReviewCard && currentCardIndex >= 0 && currentCardIndex < (Array.isArray(arr) ? arr.length : 0)) {
            nextTimes = Array.isArray(arr) ? [...arr] : [];
            nextTimes[currentCardIndex] = (nextTimes[currentCardIndex] ?? 0) + totalTimeMs;
          } else {
            nextTimes = Array.isArray(arr) ? [...arr, totalTimeMs] : [totalTimeMs];
          }
          sessionStorage.setItem(cardTimesStorageKey, JSON.stringify(nextTimes));
        } catch (_) {}
      }
      const canSpaNextBrowse = isSingleNodeMode || isTodayMode;
      const result = await request.post(`/d/${lessonApiDomainId}/learn/lesson/pass`, {
        ...passSession,
        answerHistory: [],
        totalTime: totalTimeMs,
        isAlonePractice: isAlonePractice && !isSingleNodeMode && !isTodayMode,
        cardId: card.docId,
        singleNodeMode: isSingleNodeMode || undefined,
        todayMode: isTodayMode || undefined,
        nodeId: (isSingleNodeMode || isTodayMode) && rootNodeId ? rootNodeId : undefined,
        noImpression: (isSingleNodeMode || isAlonePractice) ? noImpression : undefined,
        spaNext: canSpaNextBrowse ? true : undefined,
      });
      const { lesson: spaBrowseLesson, spaNext: spaBrowseNext, redirect: browseRedirect } = unwrapLearnPassResponse(result);
      const browseSpaOk = spaBrowseNext === true || spaBrowseNext === 'true' || spaBrowseNext === 1;
      if (
        canSpaNextBrowse
        && lessonPayloadLooksValid(spaBrowseLesson)
        && (browseSpaOk || spaBrowseNext === undefined)
      ) {
        applySpaLesson(spaBrowseLesson);
        const hasServerTimes = Array.isArray(spaBrowseLesson.lessonCardTimesMs);
        if (nextTimes && !hasServerTimes) setCardTimesMs(nextTimes);
        return;
      }
      if (nextTimes) setCardTimesMs(nextTimes);
      const redirect = typeof browseRedirect === 'string' ? browseRedirect : '';
      if (redirect) {
        window.location.href = redirect;
        return;
      }
    } catch (error: any) {
      console.error('Failed to submit browse pass:', error);
    } finally {
      setBrowseSubmitting(false);
    }
  };

  const handleLessonCardNav = useCallback(async (dir: 'prev' | 'skip') => {
    if (lessonCardNavLoading || isSubmitting || browseSubmitting) return;
    if ((!isSingleNodeMode && !isTodayMode) || !lessonSessionId) return;
    if (reviewCardId) return;
    if (dir === 'prev' && currentCardIndex <= 0) return;
    const canSpaNav = isSingleNodeMode || isTodayMode;
    setLessonCardNavLoading(true);
    try {
      const result = await request.post(`/d/${lessonApiDomainId}/learn/lesson/navigate`, {
        ...(lessonSessionId ? { session: lessonSessionId } : {}),
        lessonCardNav: dir,
        spaNext: canSpaNav ? true : undefined,
        todayMode: isTodayMode ? true : undefined,
        singleNodeMode: isSingleNodeMode ? true : undefined,
        nodeId: isSingleNodeMode ? rootNodeId : undefined,
      });
      const { lesson: spaNavLesson, spaNext: spaNavFlag, redirect: navRedirectRaw } = unwrapLearnPassResponse(result);
      const navSpaOk = spaNavFlag === true || spaNavFlag === 'true' || spaNavFlag === 1;
      if (
        canSpaNav
        && lessonPayloadLooksValid(spaNavLesson)
        && (navSpaOk || spaNavFlag === undefined)
      ) {
        applySpaLesson(spaNavLesson);
        return;
      }
      const navRedirect = typeof navRedirectRaw === 'string' ? navRedirectRaw : '';
      if (navRedirect) {
        window.location.href = navRedirect;
        return;
      }
    } catch (err: any) {
      console.error('Lesson card navigate failed:', err);
      Notification.error(err?.message || i18n('Lesson card navigation failed'));
    } finally {
      setLessonCardNavLoading(false);
    }
  }, [
    lessonCardNavLoading,
    isSubmitting,
    browseSubmitting,
    isSingleNodeMode,
    isTodayMode,
    lessonSessionId,
    reviewCardId,
    currentCardIndex,
    lessonApiDomainId,
    rootNodeId,
    applySpaLesson,
    i18n,
  ]);

  useEffect(() => {
    if (allCorrect && !isPassed && !isSubmitting && allProblems.length > 0) {
      handlePass();
    }
  }, [allCorrect, isPassed, isSubmitting, allProblems.length]);

  const recordCorrectOrWrong = (
    problem: QueuedProblem,
    selected: number,
    correct: boolean,
    timeSpent: number,
    problemId: string,
    currentAttempts: number,
    fillAnswers?: string[],
  ) => {
    if (correct) {
      setAnswerHistory((prev) => {
        const existingIndex = prev.findIndex((h) => h.problem.pid === problemId && h.correct);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            problem,
            selected,
            correct: true,
            timeSpent: updated[existingIndex].timeSpent + timeSpent,
            attempts: currentAttempts,
            ...(fillAnswers ? { fillAnswers } : {}),
          };
          return updated;
        }
        return [...prev, {
          problem,
          selected,
          correct: true,
          timeSpent,
          attempts: currentAttempts,
          ...(fillAnswers ? { fillAnswers } : {}),
        }];
      });
      const need = correctNeeded[problemId] || 0;
      if (need > 0) {
        setCorrectNeeded((prev) => ({ ...prev, [problemId]: need - 1 }));
        setPendingLessonAdvance('correctMore');
      } else {
        setPendingLessonAdvance('next');
      }
    } else {
      setPeekCount((prev) => ({ ...prev, [problemId]: (prev[problemId] || 0) + 1 }));
      setCorrectNeeded((prev) => ({ ...prev, [problemId]: (prev[problemId] || 0) + 1 }));
      setPendingLessonAdvance('requeue');
    }
  };

  const handleAnswerSelect = (displayedIndex: number) => {
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'single') return;
    const ps = currentProblem as ProblemSingle;
    if (!ps.options?.length) return;
    const order = displayOrder.length === ps.options.length ? displayOrder : ps.options.map((_, i) => i);
    const originalIndex = order[displayedIndex] ?? displayedIndex;
    const correct = originalIndex === ps.answer;
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;

    setSelectedAnswer(displayedIndex);
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));

    recordCorrectOrWrong(currentProblem, originalIndex, correct, timeSpent, problemId, currentAttempts);
  };

  const handleMultiToggle = (displayedIndex: number) => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'multi') return;
    const pm = currentProblem as ProblemMulti;
    if (!pm.options?.length) return;
    const order = displayOrderMulti.length === pm.options.length ? displayOrderMulti : pm.options.map((_, i) => i);
    const originalIndex = order[displayedIndex] ?? displayedIndex;
    setSelectedMulti((prev) => {
      const s = new Set(prev);
      if (s.has(originalIndex)) s.delete(originalIndex);
      else s.add(originalIndex);
      return [...s].sort((a, b) => a - b);
    });
  };

  const handleMultiConfirm = () => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'multi') return;
    const pm = currentProblem as ProblemMulti;
    const want = normalizeMultiAnswers(pm.answer);
    const got = [...selectedMulti].sort((a, b) => a - b);
    const correct = setsEqualAsSorted(want, got);
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    recordCorrectOrWrong(currentProblem, multiIndicesToBitmask(got), correct, timeSpent, problemId, currentAttempts);
  };

  const handleTfSelect = (v: 0 | 1) => {
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'true_false') return;
    const pt = currentProblem as ProblemTrueFalse;
    const correct = v === pt.answer;
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setSelectedTf(v);
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    recordCorrectOrWrong(currentProblem, v, correct, timeSpent, problemId, currentAttempts);
  };

  const handleFlipShowBack = () => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'flip') return;
    setFlipStage('b');
  };

  const handleFlipComplete = () => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'flip') return;
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    recordCorrectOrWrong(currentProblem, 1, true, timeSpent, problemId, currentAttempts);
  };

  const handleSuperFlipCellToggle = (ci: number, ri: number) => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'super_flip') return;
    const colsData = superFlipNormalized(currentProblem as ProblemSuperFlip).columns;
    if (!superFlipCellHasContent(colsData[ci]?.[ri])) return;
    setSuperFlipRevealed((prev) => {
      const next = prev.map((col) => [...col]);
      if (!next[ci] || next[ci][ri] === undefined) return prev;
      next[ci][ri] = !next[ci][ri];
      return next;
    });
  };

  const handleSuperFlipRevealAll = () => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'super_flip') return;
    const cols = superFlipNormalized(currentProblem as ProblemSuperFlip).columns;
    const ncol = cols.length;
    const nrow = cols[0]?.length ?? 0;
    if (!ncol || !nrow) return;
    setSuperFlipRevealed(
      Array.from({ length: ncol }, (_, ci) =>
        Array.from({ length: nrow }, (_, ri) => (superFlipCellHasContent(cols[ci]?.[ri]) ? true : false)),
      ),
    );
  };

  const handleSuperFlipCoverAll = () => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'super_flip') return;
    const cols = superFlipNormalized(currentProblem as ProblemSuperFlip).columns;
    const ncol = cols.length;
    const nrow = cols[0]?.length ?? 0;
    if (!ncol || !nrow) return;
    setSuperFlipRevealed(
      Array.from({ length: ncol }, (_, ci) =>
        Array.from({ length: nrow }, (_, ri) => false),
      ),
    );
  };

  const handleSuperFlipNotFamiliar = () => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'super_flip') return;
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setSuperFlipMarkedOk(false);
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    recordCorrectOrWrong(currentProblem, 0, false, timeSpent, problemId, currentAttempts);
  };

  const handleSuperFlipSubmit = () => {
    if (!isAnswered && pendingLessonAdvance) return;
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'super_flip') return;
    const cols = superFlipNormalized(currentProblem as ProblemSuperFlip).columns;
    const ncol = cols.length;
    const nrow = cols[0]?.length ?? 0;
    if (!(ncol >= SUPER_FLIP_COL_MIN && nrow >= SUPER_FLIP_ROW_MIN)) return;
    if (
      superFlipRevealed.length !== ncol
      || !superFlipRevealed.every((c) => c.length === nrow)
      || !superFlipAllFilledCellsRevealed(cols, superFlipRevealed)
    ) {
      return;
    }
    setSuperFlipMarkedOk(true);
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    recordCorrectOrWrong(currentProblem, 1, true, timeSpent, problemId, currentAttempts);
  };

  const handleFillBlankSubmit = () => {
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'fill_blank') return;
    const pf = currentProblem as ProblemFillBlank;
    const need = fillBlankSlotCount(pf.stem);
    const user = fillBlankDraft.slice(0, need);
    while (user.length < need) user.push('');
    const correct = fillBlankResponseMatches(pf.answers || [], user);
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    recordCorrectOrWrong(currentProblem, correct ? 1 : 0, correct, timeSpent, problemId, currentAttempts, user);
  };

  const handleMatchingSubmit = () => {
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'matching') return;
    const pm = currentProblem as ProblemMatching;
    const cols = matchingColumnsNormalized(pm);
    const n = cols[0]?.length ?? 0;
    const ncol = cols.length;
    const correct = matchingAllColumnsCorrect(n, ncol, matchingSelections);
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    const fillAnswers = matchingSelections.slice(0, n).map((row) =>
      (row.slice(0, ncol).map((v) => String(v ?? ''))).join(','),
    );
    recordCorrectOrWrong(currentProblem, correct ? 1 : 0, correct, timeSpent, problemId, currentAttempts, fillAnswers);
  };

  const handleNextProblem = () => {
    setPendingLessonAdvance(null);
    const removed = problemQueue[currentProblemIndex];
    const donePid = removed?.pid;
    if (donePid) setPracticeClearedPids((prev) => ({ ...prev, [donePid]: true }));
    setSelectedAnswer(null);
    setSelectedMulti([]);
    setSelectedTf(null);
    setFlipStage('a');
    setFlipHintOpen(false);
    setFillBlankDraft([]);
    setMatchingSelections([]);
    setMatchingShuffleOrders([]);
    setSuperFlipRevealed([]);
    setSuperFlipMarkedOk(null);
    setIsAnswered(false);
    setShowAnalysis(false);
    setShuffleTrigger((t) => t + 1);
    const newQueue = [...problemQueue];
    newQueue.splice(currentProblemIndex, 1);
    setProblemQueue(newQueue);
    if (newQueue.length > 0) {
      const nextIndex = currentProblemIndex < newQueue.length ? currentProblemIndex : 0;
      setCurrentProblemIndex(nextIndex);
    } else {
      setCurrentProblemIndex(0);
    }
  };

  const requeueCurrent = () => {
    setPendingLessonAdvance(null);
    setSelectedAnswer(null);
    setSuperFlipMarkedOk(null);
    setIsAnswered(false);
    setShowAnalysis(false);
    setShuffleTrigger((t) => t + 1);
    const newQueue = [...problemQueue];
    const problem = newQueue[currentProblemIndex];
    newQueue.splice(currentProblemIndex, 1);
    newQueue.push(problem);
    setProblemQueue(newQueue);
    const nextIndex = currentProblemIndex < newQueue.length - 1 ? currentProblemIndex : 0;
    setCurrentProblemIndex(nextIndex);
  };

  const handleWrongAnswer = () => {
    requeueCurrent();
  };

  const handleCorrectButNeedMore = () => {
    requeueCurrent();
  };

  const handleContinueAfterAnswer = () => {
    const kind = pendingLessonAdvance;
    if (!kind) return;
    if (kind === 'next') {
      const cur = problemQueue[currentProblemIndex];
      if (cur && isAnswered && showAnalysis) {
        const entry: LessonPreviousStackEntry = {
          problem: cur,
          pendingLessonAdvance: kind,
          selectedAnswer,
          selectedMulti: [...selectedMulti],
          selectedTf,
          fillBlankDraft: [...fillBlankDraft],
          matchingSelections: matchingSelections.map((row) => [...row]),
          matchingShuffleOrders: matchingShuffleOrders.map((row) => [...row]),
          flipStage,
          flipHintOpen,
          superFlipRevealed: superFlipRevealed.map((col) => [...col]),
          superFlipMarkedOk,
          optionOrder: [...optionOrder],
          problemAttemptSnapshot: problemAttempts[cur.pid] ?? 0,
          isAnswered: true,
          showAnalysis: true,
        };
        setLessonPreviousStack((s) => [...s, entry]);
      }
    }
    setPendingLessonAdvance(null);
    if (kind === 'next') handleNextProblem();
    else if (kind === 'requeue') handleWrongAnswer();
    else if (kind === 'correctMore') handleCorrectButNeedMore();
  };

  /** Wrong / peek 「继续」前：本题立刻清空作答并重排洗牌，不改变队列顺序。 */
  const handleRedoCurrentLessonQuestion = () => {
    setShuffleTrigger((t) => t + 1);
  };

  const handlePeek = () => {
    setShowPeekCard(true);
  };

  const handlePeekClose = () => {
    if (currentProblem) {
      setPeekCount(prev => ({ ...prev, [currentProblem.pid]: (prev[currentProblem.pid] || 0) + 1 }));
      setCorrectNeeded(prev => ({ ...prev, [currentProblem.pid]: (prev[currentProblem.pid] || 0) + 1 }));
    }
    setShowPeekCard(false);
    /** 关闭偷看后不立刻换题：与作答后一致，在主界面点「继续」再重排队列。 */
    setPendingLessonAdvance('requeue');
  };

  const canLessonGoPrevious =
    lessonPreviousStack.length > 0 || currentProblemIndex > 0;

  const handleLessonPreviousProblem = useCallback(() => {
    const stack = lessonPreviousStackRef.current;
    if (stack.length > 0) {
      const entry = stack[stack.length - 1];
      lessonPendingRestoreRef.current = entry;
      setLessonPreviousStack(stack.slice(0, -1));
      setProblemQueue((q) => [entry.problem, ...q]);
      setCurrentProblemIndex(0);
      setShuffleTrigger((t) => t + 1);
      return;
    }
    if (currentProblemIndex <= 0) return;
    setCurrentProblemIndex((i) => i - 1);
    setShuffleTrigger((t) => t + 1);
  }, [currentProblemIndex]);

  const handleLessonSkipCurrentProblem = useCallback(() => {
    if (problemQueue.length <= 1) return;
    const idx = currentProblemIndex;
    const newQueue = [...problemQueue];
    const cur = newQueue[idx];
    newQueue.splice(idx, 1);
    newQueue.push(cur);
    setProblemQueue(newQueue);
    const nextIndex = idx < newQueue.length - 1 ? idx : 0;
    setCurrentProblemIndex(nextIndex);
    setShuffleTrigger((t) => t + 1);
  }, [problemQueue, currentProblemIndex]);

  const handleLessonRedoResetProgress = useCallback(() => {
    if (!currentProblem) return;
    const pid = currentProblem.pid;
    lessonPendingRestoreRef.current = null;
    setPracticeClearedPids((prev) => {
      const n = { ...prev };
      delete n[pid];
      return n;
    });
    setAnswerHistory((prev) => prev.filter((h) => h.problem.pid !== pid));
    setProblemAttempts((prev) => {
      const n = { ...prev };
      delete n[pid];
      return n;
    });
    setPeekCount((prev) => {
      const n = { ...prev };
      delete n[pid];
      return n;
    });
    setCorrectNeeded((prev) => {
      const n = { ...prev };
      delete n[pid];
      return n;
    });
    setShuffleTrigger((t) => t + 1);
  }, [currentProblem]);

  if (allCorrect && !isPassed && !isSubmitting) {
    if (!hasCalledPassRef.current) {
      handlePass();
    }
    return (
      <div style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        textAlign: 'center',
        minHeight: '100vh',
        background: themeStyles.bgPage,
      }}>
        <div style={{
          padding: '40px',
          color: themeStyles.textTertiary,
        }}>
          {i18n('Saving progress...')}
        </div>
      </div>
    );
  }

  if (allCorrect && isPassed) {
    const correctCount = answerHistory.filter(h => h.correct).length;
    const totalCount = allProblems.length;
    const accuracy = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
    const totalTimeMs = Date.now() - sessionStartTimeRef.current;

    return (
      <div style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        minHeight: '100vh',
        background: themeStyles.bgPage,
      }}>
        <div style={{
          marginBottom: '20px',
          padding: '16px',
          backgroundColor: themeStyles.bgSecondary,
          borderRadius: '8px',
        }}>
          {lessonProvenanceTopRow}
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0, color: themeStyles.textPrimary }}>
            {card.title || i18n('Unnamed Card')}
          </h1>
        </div>

        {card.content && (
          <div style={{
            marginBottom: '30px',
            padding: '20px',
            backgroundColor: themeStyles.bgCard,
            borderRadius: '8px',
            border: `1px solid ${themeStyles.border}`,
          }}>
            <h2 style={{ fontSize: '18px', marginBottom: '12px', color: themeStyles.textPrimary }}>
              {i18n('Content')}
            </h2>
            <div
              className="lesson-markdown-body"
              style={{
                fontSize: '16px',
                lineHeight: '1.6',
                color: themeStyles.bodyText,
              }}
              dangerouslySetInnerHTML={{ __html: renderedContent || card.content }}
            />
          </div>
        )}

        <div style={{
          marginBottom: '30px',
          padding: '30px',
          backgroundColor: themeStyles.bgCard,
          borderRadius: '8px',
          border: `1px solid ${themeStyles.border}`,
        }}>
          <h2 style={{ fontSize: '20px', marginBottom: '20px', color: themeStyles.textPrimary }}>
            {i18n('Practice Results')}
          </h2>
          <div style={{
            display: 'flex',
            justifyContent: 'space-around',
            marginBottom: '30px',
            padding: '20px',
            backgroundColor: themeStyles.bgSecondary,
            borderRadius: '8px',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: themeStyles.success, marginBottom: '8px' }}>
                {correctCount}/{totalCount}
              </div>
              <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('Correct')}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: themeStyles.accent, marginBottom: '8px' }}>
                {accuracy}%
              </div>
              <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('Accuracy')}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: themeStyles.orange, marginBottom: '8px' }}>
                {(totalTimeMs / 1000).toFixed(1)}s
              </div>
              <div style={{ fontSize: '14px', color: themeStyles.textSecondary }}>{i18n('Total Time')}</div>
            </div>
          </div>

          <div style={{ marginTop: '20px' }}>
            <h3 style={{ fontSize: '16px', marginBottom: '16px', color: themeStyles.textPrimary }}>
              {i18n('Question Details')}
            </h3>
            {answerHistory.map((history, idx) => {
              let cumulativeTime = 0;
              for (let i = 0; i <= idx; i++) {
                cumulativeTime += answerHistory[i].timeSpent;
              }
              return (
                <div
                  key={idx}
                  style={{
                    padding: '16px',
                    marginBottom: '12px',
                    borderRadius: '6px',
                    backgroundColor: history.correct ? themeStyles.successBg : themeStyles.dangerBg,
                    border: `1px solid ${history.correct ? themeStyles.success : themeStyles.danger}`,
                  }}
                >
                  <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '8px', color: themeStyles.textPrimary }}>
                    {i18n('Question')} {idx + 1}: {lessonProblemQueueTitleText(history.problem)}
                  </div>
                  <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginBottom: '4px' }}>
                    {i18n('Time Spent')}: {(history.timeSpent / 1000).toFixed(1)}s
                    {idx > 0 && (
                      <> ({i18n('Cumulative')}: {(cumulativeTime / 1000).toFixed(1)}s)</>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginBottom: '4px' }}>
                    {i18n('Attempts')}: {history.attempts}
                  </div>
                  <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginBottom: '4px' }}>
                    {i18n('Your Answer')}: {formatPracticeHistoryUserAnswer(history)}
                    {history.correct ? (
                      <span style={{ color: themeStyles.success, marginLeft: '8px' }}>✓</span>
                    ) : (
                      <span style={{ color: themeStyles.danger, marginLeft: '8px' }}>✗</span>
                    )}
                  </div>
                  {!history.correct && (
                    <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginTop: '4px' }}>
                      {i18n('Correct Answer')}: {formatPracticeHistoryCorrectAnswer(history.problem)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div style={{
          textAlign: 'center',
          padding: '20px',
        }}>
          {!isAlonePractice && (
            <div style={{
              padding: '40px',
              backgroundColor: themeStyles.passedBannerBg,
              borderRadius: '12px',
              border: `2px solid ${themeStyles.passedBannerBorder}`,
              marginBottom: '20px',
            }}>
              <div style={{ fontSize: '48px', marginBottom: '20px', color: themeStyles.passedTitle }}>✓</div>
              <h2 style={{ fontSize: '28px', color: themeStyles.passedTitle, marginBottom: '16px' }}>
                {i18n('Lesson Passed')}
              </h2>
              <p style={{ fontSize: '16px', color: themeStyles.bodyText, marginBottom: '30px' }}>
                {i18n('Congratulations! You have completed all practice questions correctly.')}
              </p>
            </div>
          )}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            {!isAlonePractice && (
              <button
                type="button"
                disabled={nextCardFromPassedLoading}
                onClick={async () => {
                  const canSpa = isSingleNodeMode || isTodayMode;
                  if (!canSpa) {
                    const sid = lessonSessionId ? `?session=${encodeURIComponent(lessonSessionId)}` : '';
                    window.location.href = `/d/${domainId}/learn/lesson${sid}`;
                    return;
                  }
                  setNextCardFromPassedLoading(true);
                  try {
                    const qs: Record<string, string> = { format: 'json' };
                    if (lessonSessionId) qs.session = lessonSessionId;
                    const res = await request.get(`/d/${lessonApiDomainId}/learn/lesson`, qs);
                    const { lesson: spaL, spaNext: spaOkRaw } = unwrapLearnPassResponse(res);
                    const spaOk = spaOkRaw === true || spaOkRaw === 'true' || spaOkRaw === 1;
                    if (lessonPayloadLooksValid(spaL) && (spaOk || spaOkRaw === undefined)) {
                      applySpaLesson(spaL);
                      return;
                    }
                  } catch (e) {
                    console.error('Failed to load next lesson snapshot:', e);
                  } finally {
                    setNextCardFromPassedLoading(false);
                  }
                  const sid = lessonSessionId ? `?session=${encodeURIComponent(lessonSessionId)}` : '';
                  window.location.href = `/d/${lessonApiDomainId}/learn/lesson${sid}`;
                }}
                style={{
                  padding: '12px 32px',
                  border: 'none',
                  borderRadius: '6px',
                  backgroundColor: themeStyles.accent,
                  color: themeStyles.whiteOnAccent,
                  cursor: nextCardFromPassedLoading ? 'not-allowed' : 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}
              >
                {nextCardFromPassedLoading ? i18n('Loading') : i18n('Next Card')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                window.location.href = `/d/${lessonApiDomainId}/learn`;
              }}
              style={{
                padding: '12px 32px',
                border: 'none',
                borderRadius: '6px',
                backgroundColor: themeStyles.success,
                color: themeStyles.whiteOnAccent,
                cursor: 'pointer',
                fontSize: '16px',
                fontWeight: 'bold',
              }}
            >
              {i18n('Back to Learn')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const showLessonCardQueueNav = (isSingleNodeMode || isTodayMode) && !!lessonSessionId && !reviewCardId && flatCards.length > 0;
  const lessonCardNavDisabled = lessonCardNavLoading || isSubmitting || browseSubmitting;
  const lessonCardQueueNavControls = showLessonCardQueueNav ? (
    <div
      role="group"
      aria-label={i18n('Lesson card queue navigation')}
      style={{
        marginTop: '12px',
        marginBottom: '12px',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '10px',
      }}
    >
      <button
        type="button"
        onClick={() => { void handleLessonCardNav('prev'); }}
        disabled={lessonCardNavDisabled || currentCardIndex <= 0}
        style={{
          padding: '10px 18px',
          borderRadius: '8px',
          border: `1px solid ${themeStyles.border}`,
          backgroundColor: themeStyles.bgSecondary,
          color: themeStyles.textPrimary,
          fontSize: '14px',
          fontWeight: 600,
          cursor: lessonCardNavDisabled || currentCardIndex <= 0 ? 'not-allowed' : 'pointer',
          opacity: lessonCardNavDisabled || currentCardIndex <= 0 ? 0.5 : 1,
        }}
      >
        {lessonCardNavLoading ? i18n('Redirecting') : i18n('Previous card')}
      </button>
      <button
        type="button"
        onClick={() => { void handleLessonCardNav('skip'); }}
        disabled={lessonCardNavDisabled}
        style={{
          padding: '10px 18px',
          borderRadius: '8px',
          border: `1px solid ${themeStyles.optionBorderMuted}`,
          backgroundColor: themeStyles.bgSecondary,
          color: themeStyles.textSecondary,
          fontSize: '14px',
          fontWeight: 600,
          cursor: lessonCardNavDisabled ? 'not-allowed' : 'pointer',
          opacity: lessonCardNavDisabled ? 0.55 : 1,
        }}
      >
        {lessonCardNavLoading ? i18n('Redirecting') : i18n('Skip card')}
      </button>
      <span style={{ fontSize: '12px', color: themeStyles.textTertiary, flex: '1 1 160px', minWidth: 0 }}>
        {i18n('Lesson skip card hint')}
      </span>
    </div>
  ) : null;

  // Card view when there are no problems; otherwise use problem queue below. Single-card without problems matches node-without-problems.
  const useCardViewMode = (isSingleNodeMode || isTodayMode || isAlonePractice) && !hasProblems && allProblems.length === 0;
  let cardViewContent: React.ReactNode = null;
  if (useCardViewMode) {
    cardViewContent = (
      <div style={{
        maxWidth: '900px',
        width: '100%',
        margin: '0 auto',
        padding: '20px',
        minHeight: '100%',
        background: themeStyles.bgPage,
      }}>
        {lessonSessionProgressCard}
        <div style={{
          marginBottom: '20px',
          padding: '16px',
          backgroundColor: themeStyles.bgSecondary,
          borderRadius: '8px',
        }}>
          {lessonProvenanceTopRow}
          {lessonCardQueueNavControls}
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', color: themeStyles.textPrimary }}>
            {card.title || i18n('Unnamed Card')}
            {(isAlonePractice ? (reviewCardId && String(card.docId) === reviewCardId) : (lessonReviewCardIds.includes(String(card.docId)) || (reviewCardId && String(card.docId) === reviewCardId))) && (
              <span style={{ fontSize: '14px', fontWeight: 600, color: themeStyles.reviewFg, backgroundColor: themeStyles.reviewBg, padding: '4px 10px', borderRadius: '6px' }}>
                {i18n('Review')}
              </span>
            )}
          </h1>
          <div style={{ fontSize: '14px', color: themeStyles.accent, marginTop: '8px', fontWeight: 600 }}>
            {i18n('This card')}: {(currentCardCumulativeMs / 1000).toFixed(1)}s
          </div>
          {showPathCardPractiseCount ? (
            <div
              style={{ fontSize: '13px', color: themeStyles.textSecondary, marginTop: '6px', fontWeight: 500 }}
              title={pathCardPractiseTooltip}
            >
              {pathCardLoopCountText}
            </div>
          ) : null}
        </div>

        {!browseFlipped ? (
          <>
            {card.cardFace && (renderedCardFace || card.cardFace) && (
              <div style={{
                marginBottom: '24px',
                padding: '20px',
                backgroundColor: themeStyles.bgCard,
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
              }}>
                <div
                  className="lesson-markdown-body"
                  style={{ fontSize: '16px', lineHeight: '1.6', color: themeStyles.bodyText }}
                  dangerouslySetInnerHTML={{ __html: renderedCardFace || card.cardFace }}
                />
              </div>
            )}
            <div style={{
              marginBottom: '30px',
              padding: '30px',
              backgroundColor: themeStyles.bgCard,
              borderRadius: '8px',
              border: `1px solid ${themeStyles.border}`,
              display: 'flex',
              gap: '16px',
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}>
              <button
                type="button"
                onClick={() => { setBrowseFlipped(true); setBrowseNoImpression(false); }}
                style={{
                  padding: '12px 28px',
                  border: 'none',
                  borderRadius: '8px',
                  backgroundColor: themeStyles.success,
                  color: themeStyles.whiteOnAccent,
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}
              >
                {i18n('Know it')}
              </button>
              <button
                type="button"
                onClick={() => { setBrowseFlipped(true); setBrowseNoImpression(true); }}
                style={{
                  padding: '12px 28px',
                  border: 'none',
                  borderRadius: '8px',
                  backgroundColor: themeStyles.orange,
                  color: themeStyles.whiteOnAccent,
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}
              >
                {i18n('No impression')}
              </button>
            </div>
          </>
        ) : (
          <>
            {card.content && (
              <div style={{
                marginBottom: '24px',
                padding: '20px',
                backgroundColor: themeStyles.bgCard,
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
              }}>
                <h2 style={{ fontSize: '18px', marginBottom: '12px', color: themeStyles.textPrimary }}>
                  {i18n('Content')}
                </h2>
                <div
                  className="lesson-markdown-body"
                  style={{ fontSize: '16px', lineHeight: '1.6', color: themeStyles.bodyText }}
                  dangerouslySetInnerHTML={{ __html: renderedContent || card.content }}
                />
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'center', padding: '20px' }}>
              <button
                type="button"
                disabled={browseSubmitting}
                onClick={() => handlePassBrowse(browseNoImpression)}
                style={{
                  padding: '12px 32px',
                  border: 'none',
                  borderRadius: '8px',
                  backgroundColor: themeStyles.accent,
                  color: themeStyles.whiteOnAccent,
                  cursor: browseSubmitting ? 'not-allowed' : 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}
              >
                {browseSubmitting ? i18n('Redirecting') : i18n('Next Card')}
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const sidebarMeta = (
    <>
      {!(isTodayMode && rootNodeId === 'today') && (
        <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginBottom: '8px', textTransform: 'uppercase' }}>
          {i18n('Progress')}
        </div>
      )}
      {!(isTodayMode && rootNodeId === 'today') && (
        <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: themeStyles.textPrimary }}>
          {rootNodeTitle || i18n('Unnamed Node')}
        </div>
      )}
      {!splitQueueSidebars && !mergeSingleNodeCardQueueIntoProblemSidebar && (
        <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginBottom: '12px' }}>
          {currentCardIndex + 1} / {flatCards.length} {i18n('cards')}
          {!(isTodayMode && rootNodeId === 'today') && liveLessonSession && Array.isArray(liveLessonSession.lessonCardQueue) && (
            <span style={{ display: 'block', fontSize: '11px', color: themeStyles.liveSync, marginTop: '4px' }}>
              {i18n('Live session') || 'Live session synced'} · {(liveLessonSession.lessonCardQueue as unknown[]).length} {i18n('cards')}
            </span>
          )}
        </div>
      )}
      {!(isTodayMode && rootNodeId === 'today') && (
        <div style={{ fontSize: '12px', color: themeStyles.textPrimary, marginBottom: '12px', fontWeight: 600 }}>
          {i18n('Cumulative')}: {(cumulativeMs / 1000).toFixed(1)}s
        </div>
      )}
    </>
  );

  const lessonStemPreview = (stem: string) => {
    const plain = String(stem || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return plain.length > 56 ? `${plain.slice(0, 56)}…` : plain || '—';
  };

  const renderLessonProblemQueueRow = (
    p: QueuedProblem,
    orderIndex: number,
    isCurrent: boolean,
    isCleared: boolean,
    reactKey?: string,
  ) => {
    const k = problemKind(p);
    const rowStyle: React.CSSProperties = {
      padding: '6px 8px',
      fontSize: '12px',
      borderRadius: '6px',
      border: `1px solid ${isCurrent ? themeStyles.accent : themeStyles.border}`,
      backgroundColor: isCurrent ? themeStyles.accentMutedBg : isCleared ? themeStyles.doneBg : themeStyles.bgSecondary,
      color: isCurrent ? themeStyles.accentMutedFg : isCleared ? themeStyles.doneFg : themeStyles.textSecondary,
      fontWeight: isCurrent ? 600 : 400,
    };
    return (
      <div key={reactKey ?? `lesson-problem-row-${orderIndex}-${p.pid}`} style={rowStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px', flexWrap: 'wrap' }}>
          <span style={{ flexShrink: 0, opacity: 0.9 }}>#{orderIndex + 1}</span>
          <span style={{
            fontSize: '10px',
            padding: '1px 5px',
            borderRadius: '4px',
            backgroundColor: themeStyles.bgPage,
            flexShrink: 0,
          }}
          >
            {lessonProblemKindLabel(k)}
          </span>
          {isCleared ? <span style={{ marginLeft: 'auto', flexShrink: 0 }} aria-hidden>✓</span> : null}
        </div>
        <div style={{ fontSize: '11px', lineHeight: 1.35, opacity: 0.95, wordBreak: 'break-word' }}>
          {lessonStemPreview(lessonProblemQueueTitleText(p))}
        </div>
      </div>
    );
  };

  const lessonPracticeDoneProblemsFragment = (
    <>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '8px',
      }}>
        <span style={{ fontSize: '12px', color: themeStyles.textTertiary, textTransform: 'uppercase' }}>
          {i18n('Lesson practice sidebar completed')}
        </span>
        <span style={{ fontSize: '14px', fontWeight: 700, color: themeStyles.success, flexShrink: 0 }}>
          {practiceProblemsDoneCount}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {lessonProblemSidebarGroups ? (
          lessonProblemSidebarGroups.map((group) => {
            const flatIdx = cardIdToFlatIndex[group.cardId];
            const inReview = lessonReviewCardIds.includes(group.cardId);
            const cardDoneBySessionIndex =
              !!mergeSingleNodeCardQueueIntoProblemSidebar
              && typeof flatIdx === 'number'
              && flatIdx < currentCardIndex
              && !inReview;
            const doneItems = group.items.filter(
              ({ p }) => cardDoneBySessionIndex || !!practiceClearedPids[p.pid],
            );
            if (doneItems.length === 0) return null;
            const isDone = typeof flatIdx === 'number' && flatIdx < currentCardIndex && !inReview;
            const isCurrent = typeof flatIdx === 'number' && flatIdx === currentCardIndex;
            const fc = typeof flatIdx === 'number' ? flatCards[flatIdx] : undefined;
            let timeText = '—';
            if (typeof flatIdx === 'number') {
              if (isCurrent) timeText = `${(currentCardCumulativeMs / 1000).toFixed(1)}s`;
              else if (flatIdx < cardTimesMs.length) timeText = `${(cardTimesMs[flatIdx] / 1000).toFixed(1)}s`;
            }
            const cardHeaderStyle: React.CSSProperties = {
              padding: '6px 10px',
              marginBottom: '6px',
              fontSize: '12px',
              borderRadius: '6px',
              backgroundColor: isCurrent ? themeStyles.accentMutedBg : inReview ? themeStyles.reviewBg : isDone ? themeStyles.doneBg : themeStyles.bgSecondary,
              color: isCurrent ? themeStyles.accentMutedFg : inReview ? themeStyles.reviewFg : isDone ? themeStyles.doneFg : themeStyles.textSecondary,
              fontWeight: isCurrent ? 600 : 400,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
              border: `1px solid ${themeStyles.border}`,
              wordBreak: 'break-word',
            };
            const displayTitle = (fc?.cardTitle?.trim() && String(fc.cardTitle).trim()) || group.cardTitle;
            return (
              <div key={`lesson-practice-done-group-${group.cardId}`}>
                <div style={cardHeaderStyle}>
                  <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px', minWidth: 0 }}>
                    {isDone ? <span style={{ marginRight: '2px', flexShrink: 0 }} aria-hidden>✓</span> : null}
                    {inReview ? (
                      <span style={{ marginRight: '4px', fontSize: '11px', color: themeStyles.reviewFg, fontWeight: 600, flexShrink: 0 }}>
                        {i18n('Review')}
                      </span>
                    ) : null}
                    {queueNewOldTagBeforeName(fc)}
                    <span>{displayTitle}</span>
                  </span>
                  {sidebarQueuePathLoopAndTime(
                    pathLoopCountForFlatCard(fc, learnPathCardPractiseCounts),
                    timeText,
                  )}
                </div>
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  paddingLeft: '8px',
                  borderLeft: `2px solid ${themeStyles.border}`,
                }}
                >
                  {doneItems.map(({ p, globalIndex }) => {
                    const isCurrent = currentProblem?.pid === p.pid;
                    const rowCleared = cardDoneBySessionIndex || !!practiceClearedPids[p.pid];
                    return renderLessonProblemQueueRow(
                      p,
                      globalIndex,
                      isCurrent,
                      rowCleared,
                      `lesson-practice-done-${group.cardId}-${globalIndex}-${p.pid}`,
                    );
                  })}
                </div>
              </div>
            );
          })
        ) : (
          allProblems.map((p, idx) => {
            if (!practiceClearedPids[p.pid]) return null;
            return renderLessonProblemQueueRow(p, idx, false, true);
          })
        )}
        {practiceProblemsDoneCount === 0 ? (
          <div style={{ fontSize: '13px', color: themeStyles.textTertiary, padding: '8px 0' }}>
            {i18n('No completed problems yet')}
          </div>
        ) : null}
      </div>
    </>
  );

  const lessonProblemQueueSidebar = allProblems.length > 0 && !splitProblemPracticeSidebars ? (
    <div style={{ marginTop: '16px', marginBottom: '12px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '8px',
      }}>
        <span style={{ fontSize: '12px', color: themeStyles.textTertiary, textTransform: 'uppercase' }}>
          {i18n('Lesson problem queue')}
        </span>
        <span style={{ fontSize: '12px', fontWeight: 600, color: themeStyles.textSecondary, flexShrink: 0 }}>
          {practiceProblemsDoneCount}/{allProblems.length}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {singleNodeLessonProblemGroups ? (
          singleNodeLessonProblemGroups.map((group) => {
            const flatIdx = cardIdToFlatIndex[group.cardId];
            const inReview = lessonReviewCardIds.includes(group.cardId);
            const isDone = typeof flatIdx === 'number' && flatIdx < currentCardIndex && !inReview;
            const isCurrent = typeof flatIdx === 'number' && flatIdx === currentCardIndex;
            const fc = typeof flatIdx === 'number' ? flatCards[flatIdx] : undefined;
            let timeText = '—';
            if (typeof flatIdx === 'number') {
              if (isCurrent) timeText = `${(currentCardCumulativeMs / 1000).toFixed(1)}s`;
              else if (flatIdx < cardTimesMs.length) timeText = `${(cardTimesMs[flatIdx] / 1000).toFixed(1)}s`;
            }
            const cardHeaderStyle: React.CSSProperties = {
              padding: '6px 10px',
              marginBottom: '6px',
              fontSize: '12px',
              borderRadius: '6px',
              backgroundColor: isCurrent ? themeStyles.accentMutedBg : inReview ? themeStyles.reviewBg : isDone ? themeStyles.doneBg : themeStyles.bgSecondary,
              color: isCurrent ? themeStyles.accentMutedFg : inReview ? themeStyles.reviewFg : isDone ? themeStyles.doneFg : themeStyles.textSecondary,
              fontWeight: isCurrent ? 600 : 400,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
              border: `1px solid ${themeStyles.border}`,
              wordBreak: 'break-word',
            };
            const displayTitle = (fc?.cardTitle?.trim() && String(fc.cardTitle).trim()) || group.cardTitle;
            return (
            <div key={`lesson-problem-card-group-${group.cardId}`}>
              <div style={cardHeaderStyle}>
                <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px', minWidth: 0 }}>
                  {isDone ? <span style={{ marginRight: '2px', flexShrink: 0 }} aria-hidden>✓</span> : null}
                  {inReview ? (
                    <span style={{ marginRight: '4px', fontSize: '11px', color: themeStyles.reviewFg, fontWeight: 600, flexShrink: 0 }}>
                      {i18n('Review')}
                    </span>
                  ) : null}
                  {queueNewOldTagBeforeName(fc)}
                  <span>{displayTitle}</span>
                </span>
                {sidebarQueuePathLoopAndTime(
                  pathLoopCountForFlatCard(fc, learnPathCardPractiseCounts),
                  timeText,
                )}
              </div>
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                paddingLeft: '8px',
                borderLeft: `2px solid ${themeStyles.border}`,
              }}
              >
                {group.items.map(({ p, globalIndex }) => {
                  const isCurrent = currentProblem?.pid === p.pid;
                  const isCleared = !!practiceClearedPids[p.pid];
                  return renderLessonProblemQueueRow(
                    p,
                    globalIndex,
                    isCurrent,
                    isCleared,
                    `lesson-problem-row-${group.cardId}-${globalIndex}-${p.pid}`,
                  );
                })}
              </div>
            </div>
            );
          })
        ) : (
          allProblems.map((p, idx) => {
            const isCurrent = currentProblem?.pid === p.pid;
            const isCleared = !!practiceClearedPids[p.pid];
            return renderLessonProblemQueueRow(p, idx, isCurrent, isCleared);
          })
        )}
      </div>
    </div>
  ) : null;

  /** 分栏右列：仅未完成题目（与左栏已完成题目对应）。 */
  const lessonProblemQueueSidebarPendingOnly =
    mergeSingleNodeCardQueueIntoProblemSidebar && allProblems.length > 0 && !splitProblemPracticeSidebars ? (
      <div style={{ marginTop: '16px', marginBottom: '12px' }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '8px',
        }}>
          <span style={{ fontSize: '12px', color: themeStyles.textTertiary, textTransform: 'uppercase' }}>
            {i18n('Lesson problem queue')}
          </span>
          <span style={{ fontSize: '12px', fontWeight: 600, color: themeStyles.textSecondary, flexShrink: 0 }}>
            {practiceProblemsPendingCount}/{allProblems.length}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {singleNodeLessonProblemGroups
            ? singleNodeLessonProblemGroups.map((group) => {
              const pendingItems = group.items.filter(({ p }) => !practiceClearedPids[p.pid]);
              if (pendingItems.length === 0) return null;
              const flatIdx = cardIdToFlatIndex[group.cardId];
              const inReview = lessonReviewCardIds.includes(group.cardId);
              const isDone = typeof flatIdx === 'number' && flatIdx < currentCardIndex && !inReview;
              const isCurrent = typeof flatIdx === 'number' && flatIdx === currentCardIndex;
              const fc = typeof flatIdx === 'number' ? flatCards[flatIdx] : undefined;
              let timeText = '—';
              if (typeof flatIdx === 'number') {
                if (isCurrent) timeText = `${(currentCardCumulativeMs / 1000).toFixed(1)}s`;
                else if (flatIdx < cardTimesMs.length) timeText = `${(cardTimesMs[flatIdx] / 1000).toFixed(1)}s`;
              }
              const cardHeaderStyle: React.CSSProperties = {
                padding: '6px 10px',
                marginBottom: '6px',
                fontSize: '12px',
                borderRadius: '6px',
                backgroundColor: isCurrent ? themeStyles.accentMutedBg : inReview ? themeStyles.reviewBg : isDone ? themeStyles.doneBg : themeStyles.bgSecondary,
                color: isCurrent ? themeStyles.accentMutedFg : inReview ? themeStyles.reviewFg : isDone ? themeStyles.doneFg : themeStyles.textSecondary,
                fontWeight: isCurrent ? 600 : 400,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '8px',
                border: `1px solid ${themeStyles.border}`,
                wordBreak: 'break-word',
              };
              const displayTitle = (fc?.cardTitle?.trim() && String(fc.cardTitle).trim()) || group.cardTitle;
              return (
                <div key={`lesson-problem-pending-group-${group.cardId}`}>
                  <div style={cardHeaderStyle}>
                    <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px', minWidth: 0 }}>
                      {isDone ? <span style={{ marginRight: '2px', flexShrink: 0 }} aria-hidden>✓</span> : null}
                      {inReview ? (
                        <span style={{ marginRight: '4px', fontSize: '11px', color: themeStyles.reviewFg, fontWeight: 600, flexShrink: 0 }}>
                          {i18n('Review')}
                        </span>
                      ) : null}
                      {queueNewOldTagBeforeName(fc)}
                      <span>{displayTitle}</span>
                    </span>
                    {sidebarQueuePathLoopAndTime(
                      pathLoopCountForFlatCard(fc, learnPathCardPractiseCounts),
                      timeText,
                    )}
                  </div>
                  <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    paddingLeft: '8px',
                    borderLeft: `2px solid ${themeStyles.border}`,
                  }}
                  >
                    {pendingItems.map(({ p, globalIndex }) => {
                      const isCurrent = currentProblem?.pid === p.pid;
                      return renderLessonProblemQueueRow(
                        p,
                        globalIndex,
                        isCurrent,
                        false,
                        `lesson-problem-pending-${group.cardId}-${globalIndex}-${p.pid}`,
                      );
                    })}
                  </div>
                </div>
              );
            })
            : allProblems.filter((p) => !practiceClearedPids[p.pid]).map((p, i) => {
              const idx = allProblems.findIndex((x) => x.pid === p.pid);
              const isCurrent = currentProblem?.pid === p.pid;
              return renderLessonProblemQueueRow(p, idx >= 0 ? idx : i, isCurrent, false, `lesson-problem-pending-flat-${p.pid}`);
            })}
          {practiceProblemsPendingCount === 0 ? (
            <div style={{ fontSize: '13px', color: themeStyles.textTertiary, padding: '8px 0' }}>
              {i18n('No pending sections')}
            </div>
          ) : null}
        </div>
      </div>
    ) : null;

  /** 合并题目队列：左侧只保留「已完成题目」嵌套列表，不再重复列出已完成卡片（与题目行重复）。 */
  const singleNodeMergeLeftSidebar = mergeSingleNodeCardQueueIntoProblemSidebar ? (
    <>{lessonPracticeDoneProblemsFragment}</>
  ) : null;

  const sidebarProblemPracticeDoneColumn = splitProblemPracticeSidebars ? lessonPracticeDoneProblemsFragment : null;

  const sidebarProblemPracticePendingColumn = splitProblemPracticeSidebars ? (
    <>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '8px',
      }}>
        <span style={{ fontSize: '12px', color: themeStyles.textTertiary, textTransform: 'uppercase' }}>
          {i18n('Lesson practice sidebar pending')}
        </span>
        <span style={{ fontSize: '14px', fontWeight: 700, color: themeStyles.accent, flexShrink: 0 }}>
          {practiceProblemsPendingCount}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {problemQueue.map((p, queueIdx) => {
          const orderIndex = allProblems.findIndex((x) => x.pid === p.pid);
          const idx = orderIndex >= 0 ? orderIndex : queueIdx;
          return renderLessonProblemQueueRow(p, idx, queueIdx === currentProblemIndex, false);
        })}
      </div>
    </>
  ) : null;

  const todayFlatListAll = isTodayMode && rootNodeId === 'today' ? (
    <div>
      {flatCards.map((item, idx) => {
        const inReview = lessonReviewCardIds.includes(String(item.cardId));
        const isDone = idx < currentCardIndex && !inReview;
        const isCurrent = idx === currentCardIndex;
        const cardStyle: React.CSSProperties = {
          padding: '6px 10px',
          marginBottom: '2px',
          fontSize: '13px',
          borderRadius: '6px',
          backgroundColor: isCurrent ? themeStyles.accentMutedBg : inReview ? themeStyles.reviewBg : isDone ? themeStyles.doneBg : 'transparent',
          color: isCurrent ? themeStyles.accentMutedFg : inReview ? themeStyles.reviewFg : isDone ? themeStyles.doneFg : themeStyles.textSecondary,
          fontWeight: isCurrent ? 600 : 400,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
        };
        let timeText = '—';
        if (isCurrent) timeText = `${(currentCardCumulativeMs / 1000).toFixed(1)}s`;
        else if (idx < cardTimesMs.length) timeText = `${(cardTimesMs[idx] / 1000).toFixed(1)}s`;
        return (
          <div key={`today-card-${idx}-${String(item.cardId)}`} style={cardStyle}>
            <span>
              {isDone && <span style={{ marginRight: '6px' }}>✓</span>}
              {inReview && (
                <span style={{ marginRight: '6px', fontSize: '11px', color: themeStyles.reviewFg, fontWeight: 600 }}>
                  {i18n('Review')}
                </span>
              )}
              {queueNewOldTagBeforeName(item)}
              {item.cardTitle || i18n('Unnamed Card')}
            </span>
            {sidebarQueuePathLoopAndTime(pathLoopCountForFlatCard(item, learnPathCardPractiseCounts), timeText)}
          </div>
        );
      })}
    </div>
  ) : null;

  const todayFlatListDoneOnly = splitQueueSidebars ? (
    <div>
      {flatCards.map((item, idx) => {
        const inReview = lessonReviewCardIds.includes(String(item.cardId));
        const isDone = idx < currentCardIndex && !inReview;
        if (!isDone) return null;
        const timeText = idx < cardTimesMs.length ? `${(cardTimesMs[idx] / 1000).toFixed(1)}s` : '—';
        return (
          <div
            key={`today-done-${idx}-${String(item.cardId)}`}
            style={{
              padding: '6px 10px',
              marginBottom: '2px',
              fontSize: '13px',
              borderRadius: '6px',
              backgroundColor: themeStyles.doneBg,
              color: themeStyles.doneFg,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span>
              <span style={{ marginRight: '6px' }}>✓</span>
              {queueNewOldTagBeforeName(item)}
              {item.cardTitle || i18n('Unnamed Card')}
            </span>
            {sidebarQueuePathLoopAndTime(pathLoopCountForFlatCard(item, learnPathCardPractiseCounts), timeText)}
          </div>
        );
      })}
      {lessonQueueDoneCount === 0 && (
        <div style={{ fontSize: '13px', color: themeStyles.textTertiary, padding: '8px 0' }}>
          {i18n('No completed cards')}
        </div>
      )}
    </div>
  ) : null;

  const todayFlatListPendingOnly = splitQueueSidebars ? (
    <div>
      {flatCards.map((item, idx) => {
        const inReview = lessonReviewCardIds.includes(String(item.cardId));
        const isDone = idx < currentCardIndex && !inReview;
        if (isDone) return null;
        const isCurrent = idx === currentCardIndex;
        let timeText = '—';
        if (isCurrent) timeText = `${(currentCardCumulativeMs / 1000).toFixed(1)}s`;
        else if (idx < cardTimesMs.length) timeText = `${(cardTimesMs[idx] / 1000).toFixed(1)}s`;
        const cardStyle: React.CSSProperties = {
          padding: '6px 10px',
          marginBottom: '2px',
          fontSize: '13px',
          borderRadius: '6px',
          backgroundColor: isCurrent ? themeStyles.accentMutedBg : inReview ? themeStyles.reviewBg : 'transparent',
          color: isCurrent ? themeStyles.accentMutedFg : inReview ? themeStyles.reviewFg : themeStyles.textSecondary,
          fontWeight: isCurrent ? 600 : 400,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '8px',
        };
        return (
          <div key={`today-pending-${idx}-${String(item.cardId)}`} style={cardStyle}>
            <span>
              {inReview && (
                <span style={{ marginRight: '6px', fontSize: '11px', color: themeStyles.reviewFg, fontWeight: 600 }}>
                  {i18n('Review')}
                </span>
              )}
              {queueNewOldTagBeforeName(item)}
              {item.cardTitle || i18n('Unnamed Card')}
            </span>
            {sidebarQueuePathLoopAndTime(pathLoopCountForFlatCard(item, learnPathCardPractiseCounts), timeText)}
          </div>
        );
      })}
    </div>
  ) : null;

  const sidebarInnerLeftSplit = (
    <>
      {!splitProblemPracticeSidebars && !mergeSingleNodeCardQueueIntoProblemSidebar && sidebarMeta}
      {mergeSingleNodeCardQueueIntoProblemSidebar ? lessonProblemQueueSidebarPendingOnly : lessonProblemQueueSidebar}
      {!mergeSingleNodeCardQueueIntoProblemSidebar && (
        <>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
            marginBottom: '8px',
          }}>
            <span style={{ fontSize: '12px', color: themeStyles.textTertiary, textTransform: 'uppercase' }}>
              {i18n('Uncompleted')}
            </span>
            <span style={{ fontSize: '14px', fontWeight: 700, color: themeStyles.accent, flexShrink: 0 }}>
              {lessonQueuePendingCount}
            </span>
          </div>
          {todayFlatListPendingOnly}
        </>
      )}
    </>
  );

  const sidebarInnerRightSplit = (
    <>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '8px',
        marginBottom: '8px',
      }}>
        <span style={{ fontSize: '12px', color: themeStyles.textTertiary, textTransform: 'uppercase' }}>
          {i18n('Completed sections')}
        </span>
        <span style={{ fontSize: '14px', fontWeight: 700, color: themeStyles.success, flexShrink: 0 }}>
          {lessonQueueDoneCount}
        </span>
      </div>
      {todayFlatListDoneOnly}
    </>
  );

  const sidebarInner = (
    <>
      {!mergeSingleNodeCardQueueIntoProblemSidebar && sidebarMeta}
      {mergeSingleNodeCardQueueIntoProblemSidebar && !splitQueueSidebars ? (
        <>
          {singleNodeMergeLeftSidebar}
          {lessonProblemQueueSidebarPendingOnly}
        </>
      ) : (
        <>
          {lessonProblemQueueSidebar}
          {isTodayMode && rootNodeId === 'today'
            ? todayFlatListAll
            : mergeSingleNodeCardQueueIntoProblemSidebar
              ? null
              : nodeTree.map((root, i) => renderNodeTreeItem(root, 0))}
        </>
      )}
    </>
  );

  /** Split sidebars: left done, right pending（单卡片有题时为题目队列，否则为今日/单节点卡片队列 + meta）。 */
  const lessonSidebarLeftColumn = splitQueueSidebars
    ? (splitProblemPracticeSidebars
      ? sidebarProblemPracticeDoneColumn
      : mergeSingleNodeCardQueueIntoProblemSidebar
        ? singleNodeMergeLeftSidebar
        : sidebarInnerRightSplit)
    : sidebarInner;
  const lessonSidebarRightColumn = splitQueueSidebars
    ? (splitProblemPracticeSidebars ? sidebarProblemPracticePendingColumn : sidebarInnerLeftSplit)
    : null;

  const asideBaseStyle: React.CSSProperties = {
    padding: '16px',
    backgroundColor: themeStyles.bgCard,
    borderRight: `1px solid ${themeStyles.border}`,
    overflowY: 'auto',
  };

  const asideRightBaseStyle: React.CSSProperties = {
    padding: '16px',
    backgroundColor: themeStyles.bgCard,
    borderLeft: `1px solid ${themeStyles.border}`,
    overflowY: 'auto',
  };

  const drawerCloseBtnStyle: React.CSSProperties = {
    marginTop: '12px',
    padding: '8px 16px',
    width: '100%',
    border: `1px solid ${themeStyles.border}`,
    borderRadius: '6px',
    background: themeStyles.bgSecondary,
    color: themeStyles.textPrimary,
    cursor: 'pointer',
    fontSize: '14px',
  };

  const closeBothDrawers = () => {
    setLeftDrawerOpen(false);
    setRightDrawerOpen(false);
  };

  // Card view and problem mode share sidebar layout; mobile uses drawers.
  if (cardViewContent) {
    const showSidebarHere = hasLessonSidebar;
    if (showSidebarHere) {
      if (isMobile) {
        return (
          <>
            {(leftDrawerOpen || rightDrawerOpen) && (
              <div
                role="presentation"
                style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: themeStyles.drawerScrim }}
                onClick={closeBothDrawers}
                aria-hidden
              />
            )}
            <aside style={{
              ...asideBaseStyle,
              position: 'fixed',
              left: 0,
              top: 0,
              bottom: 0,
              width: '280px',
              maxWidth: '85vw',
              zIndex: 1002,
              transform: leftDrawerOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.2s ease-out',
              boxShadow: leftDrawerOpen ? themeStyles.drawerAsideShadow : 'none',
            }}>
              {lessonSidebarLeftColumn}
              <button type="button" onClick={closeBothDrawers} style={drawerCloseBtnStyle}>
                {i18n('Close')}
              </button>
            </aside>
            {splitQueueSidebars && lessonSidebarRightColumn && (
              <aside style={{
                ...asideRightBaseStyle,
                position: 'fixed',
                right: 0,
                left: 'auto',
                top: 0,
                bottom: 0,
                width: '280px',
                maxWidth: '85vw',
                zIndex: 1002,
                transform: rightDrawerOpen ? 'translateX(0)' : 'translateX(100%)',
                transition: 'transform 0.2s ease-out',
                boxShadow: rightDrawerOpen ? themeStyles.drawerAsideShadowRight : 'none',
              }}>
                {lessonSidebarRightColumn}
                <button type="button" onClick={closeBothDrawers} style={drawerCloseBtnStyle}>
                  {i18n('Close')}
                </button>
              </aside>
            )}
            <main style={{ flex: 1, overflowY: 'auto', paddingTop: '24px', paddingLeft: '12px', paddingRight: '12px', paddingBottom: '24px', minHeight: '100vh', background: themeStyles.bgPage }}>
              {cardViewContent}
            </main>
          </>
        );
      }
      return (
        <div style={{ display: 'flex', minHeight: '100vh', background: themeStyles.bgPage }}>
          <aside style={{ width: '240px', flexShrink: 0, ...asideBaseStyle }}>
            {lessonSidebarLeftColumn}
          </aside>
          <main style={{ flex: 1, overflowY: 'auto', background: themeStyles.bgPage }}>
            {cardViewContent}
          </main>
          {splitQueueSidebars && lessonSidebarRightColumn && (
            <aside style={{ width: '240px', flexShrink: 0, ...asideRightBaseStyle }}>
              {lessonSidebarRightColumn}
            </aside>
          )}
        </div>
      );
    }
    return (
      <div style={{ minHeight: '100vh', background: themeStyles.bgPage }}>
        {cardViewContent}
      </div>
    );
  }

  if (allProblems.length > 0 && problemQueue.length > 0 && !currentProblem && !allCorrect) {
    return (
      <div style={{
        minHeight: '100vh',
        background: themeStyles.bgPage,
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        textAlign: 'center',
      }}>
        <div style={{ padding: '40px', color: themeStyles.textTertiary }}>{i18n('Loading...')}</div>
      </div>
    );
  }

  if (!currentProblem && !allCorrect && answerHistory.length === 0) {
    return (
      <div style={{
        minHeight: '100vh',
        background: themeStyles.bgPage,
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        textAlign: 'center',
      }}>
        <div style={{
          padding: '40px',
          color: themeStyles.textTertiary,
        }}>
          {i18n('No content or practice questions available.')}
        </div>
      </div>
    );
  }

  if (!currentProblem) {
    if (allCorrect) {
      return null;
    }
    return (
      <div style={{
        minHeight: '100vh',
        background: themeStyles.bgPage,
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        textAlign: 'center',
      }}>
        <div style={{ padding: '40px', color: themeStyles.textTertiary }}>{i18n('Loading...')}</div>
      </div>
    );
  }

  const contentPadding = isMobile ? '12px' : '20px';
  const lessonNavSecondaryBtn: React.CSSProperties = {
    padding: '11px 18px',
    borderRadius: '8px',
    border: `1px solid ${themeStyles.border}`,
    backgroundColor: themeStyles.bgSecondary,
    color: themeStyles.textPrimary,
    fontSize: '15px',
    fontWeight: 600,
  };
  const renderLessonPracticeActionRow = (submitOrActions: React.ReactNode, marginTop = '2px') => (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px', marginTop }}>
      <button
        type="button"
        onClick={handleLessonPreviousProblem}
        disabled={!canLessonGoPrevious}
        style={{
          ...lessonNavSecondaryBtn,
          cursor: !canLessonGoPrevious ? 'not-allowed' : 'pointer',
          opacity: !canLessonGoPrevious ? 0.5 : 1,
        }}
      >
        {i18n('Previous')}
      </button>
      <button
        type="button"
        onClick={handleLessonSkipCurrentProblem}
        disabled={problemQueue.length <= 1}
        style={{
          ...lessonNavSecondaryBtn,
          cursor: problemQueue.length <= 1 ? 'not-allowed' : 'pointer',
          opacity: problemQueue.length <= 1 ? 0.5 : 1,
        }}
      >
        {i18n('Lesson skip problem')}
      </button>
      <button
        type="button"
        onClick={handleLessonRedoResetProgress}
        disabled={!currentProblem}
        style={{
          ...lessonNavSecondaryBtn,
          cursor: currentProblem ? 'pointer' : 'not-allowed',
          opacity: currentProblem ? 1 : 0.5,
        }}
      >
        {i18n('Lesson practice redo')}
      </button>
      {submitOrActions}
    </div>
  );
  const mainContent = (
    <div style={{
      maxWidth: '900px',
      width: '100%',
      margin: '0 auto',
      padding: contentPadding,
    }}>
      {lessonSessionProgressCard}
      <div style={{
        marginBottom: '20px',
        padding: '16px',
        backgroundColor: themeStyles.bgSecondary,
        borderRadius: '8px',
      }}>
        {lessonProvenanceTopRow}
        {lessonCardQueueNavControls}
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0, display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', color: themeStyles.textPrimary }}>
          {card.title || i18n('Unnamed Card')}
          {(isAlonePractice ? (reviewCardId && String(card.docId) === reviewCardId) : lessonReviewCardIds.includes(String(card.docId))) && (
            <span style={{ fontSize: '14px', fontWeight: 600, color: themeStyles.reviewFg, backgroundColor: themeStyles.reviewBg, padding: '4px 10px', borderRadius: '6px' }}>
              {i18n('Review')}
            </span>
          )}
        </h1>
        <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginTop: '8px' }}>
          {i18n('Question')} {allProblems.length - problemQueue.length + 1} / {allProblems.length}
          {problemQueue.length > 0 && ` (${i18n('Remaining')}: ${problemQueue.length})`}
        </div>
        {(isSingleNodeMode || isTodayMode || isAlonePractice) && !mergeSingleNodeCardQueueIntoProblemSidebar && (
          <div style={{ fontSize: '14px', color: themeStyles.accent, marginTop: '8px', fontWeight: 600 }}>
            {i18n('This card')}: {(elapsedMs / 1000).toFixed(1)}s
          </div>
        )}
        {showPathCardPractiseCount ? (
          <div
            style={{ fontSize: '13px', color: themeStyles.textSecondary, marginTop: '6px', fontWeight: 500 }}
            title={pathCardPractiseTooltip}
          >
            {pathCardLoopCountText}
          </div>
        ) : null}
      </div>


      <div style={{
        marginBottom: '30px',
        padding: isMobile ? '16px' : '30px',
        backgroundColor: themeStyles.bgCard,
        borderRadius: '8px',
        border: `1px solid ${themeStyles.border}`,
      }}>
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <span style={{
            display: 'inline-block',
            padding: '4px 8px',
            backgroundColor: themeStyles.accent,
            color: themeStyles.whiteOnAccent,
            borderRadius: '4px',
            fontSize: '12px',
            marginRight: '8px',
          }}>
            {i18n('Question')}
          </span>
          {!isAnswered && currentKind !== 'flip' && currentKind !== 'super_flip' && (
            <button
              type="button"
              onClick={handlePeek}
              style={{
                padding: '6px 14px',
                border: `1px solid ${themeStyles.orange}`,
                borderRadius: '6px',
                backgroundColor: themeStyles.reviewBg,
                color: themeStyles.reviewFg,
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 500,
              }}
            >
              {i18n('Peek')}
            </button>
          )}
          {currentProblem && (currentPeekCount > 0 || currentCorrectNeeded > 0) && (
            <span style={{
              display: 'inline-block',
              padding: '4px 8px',
              backgroundColor: themeStyles.orange,
              color: themeStyles.whiteOnAccent,
              borderRadius: '4px',
              fontSize: '12px',
            }}>
              {i18n('To review')}
              {currentPeekCount > 1 ? ` ×${currentPeekCount}` : ''}
              {currentCorrectNeeded > 0 ? ` · ${i18n('Correct needed')} ${currentCorrectNeeded}` : ''}
            </span>
          )}
          {isAnswered && (
            <span style={{
              display: 'inline-block',
              padding: '4px 8px',
              backgroundColor: isCorrect ? themeStyles.success : themeStyles.danger,
              color: themeStyles.whiteOnAccent,
              borderRadius: '4px',
              fontSize: '12px',
            }}>
              {(currentKind === 'flip' && isCorrect)
                || (currentKind === 'super_flip' && isAnswered && isCorrect)
                ? i18n('Done')
                : currentKind === 'super_flip' && isAnswered && !isCorrect
                  ? i18n('Problem super flip not familiar')
                  : (isCorrect ? i18n('Correct') : i18n('Incorrect'))}
            </span>
          )}
          <span style={{ fontSize: '11px', color: themeStyles.textTertiary, marginLeft: '4px' }}>
            ({lessonProblemKindLabel(currentKind)})
          </span>
          {currentProblem ? (
            <button
              type="button"
              aria-label={i18n('Lesson problem tag panel open')}
              onClick={() => setLessonProblemTagPanelOpen(true)}
              style={{
                marginLeft: 'auto',
                padding: '6px 14px',
                border: `1px solid ${themeStyles.accent}`,
                borderRadius: '6px',
                backgroundColor: themeStyles.accentMutedBg,
                color: themeStyles.accent,
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: 600,
              }}
            >
              {(() => {
                const list = getProblemTagList(currentProblem as Problem);
                return list.length ? list.join(' · ') : i18n('Lesson problem tag panel empty');
              })()}
            </button>
          ) : null}
        </div>

        {(() => {
          const ttl = typeof currentProblem.title === 'string' ? currentProblem.title.trim() : '';
          const queueCore = lessonProblemQueueTitleText(currentProblem);
          const preview = lessonStemPreview(queueCore);
          const line = ttl || (preview !== '—' ? preview : '');
          if (!line) return null;
          const fromTitleField = !!ttl;
          return (
            <div style={{
              marginBottom: '18px',
              paddingBottom: '14px',
              borderBottom: `1px solid ${themeStyles.border}`,
            }}>
              <div style={{
                fontSize: fromTitleField ? '22px' : '17px',
                fontWeight: 700,
                color: themeStyles.textPrimary,
                lineHeight: 1.4,
                wordBreak: 'break-word',
              }}>
                {line}
              </div>
            </div>
          );
        })()}

        {currentKind === 'flip' ? (
          <>
            {(() => {
              const fb = currentProblem as ProblemFlip;
              const flipHintText = typeof fb.hint === 'string' ? fb.hint.trim() : '';
              const hintBoxStyle: React.CSSProperties = {
                marginBottom: '16px',
                padding: '12px 14px',
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
                backgroundColor: themeStyles.reviewBg,
                color: themeStyles.textPrimary,
                fontSize: '14px',
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
              };
              const hintBtnStyle: React.CSSProperties = {
                padding: '8px 16px',
                marginBottom: '12px',
                border: `1px solid ${themeStyles.accent}`,
                borderRadius: '8px',
                backgroundColor: 'transparent',
                color: themeStyles.accent,
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 600,
              };
              const hintBlock =
                !flipHintText ? null : !isAnswered ? (
                  <>
                    <button type="button" onClick={() => setFlipHintOpen((v) => !v)} style={hintBtnStyle}>
                      {flipHintOpen ? i18n('Flip hide hint') : i18n('Flip show hint')}
                    </button>
                    {flipHintOpen ? <div style={hintBoxStyle}>{flipHintText}</div> : null}
                  </>
                ) : (
                  <div style={{ ...hintBoxStyle, marginTop: flipStage === 'a' ? 0 : '8px' }}>
                    <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginBottom: '6px' }}>{i18n('Flip hint label')}</div>
                    {flipHintText}
                  </div>
                );
              return (
                <>
                  {flipStage === 'a' ? (
                    <>
                      <div style={{ fontSize: '18px', fontWeight: 500, marginBottom: '24px', color: themeStyles.stemColor, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {fb.faceA || i18n('No stem')}
                      </div>
                      {hintBlock}
                      {!isAnswered && renderLessonPracticeActionRow(
                        <button type="button" onClick={handleFlipShowBack} style={{ padding: '12px 24px', border: 'none', borderRadius: '8px', backgroundColor: themeStyles.accent, color: themeStyles.whiteOnAccent, cursor: 'pointer', fontSize: '15px', fontWeight: 600 }}>
                          {i18n('Flip show back')}
                        </button>,
                        '2px',
                      )}
                    </>
                  ) : (
                    <>
                      <div style={{ fontSize: '13px', color: themeStyles.textTertiary, marginBottom: '8px', whiteSpace: 'pre-wrap' }}>{fb.faceA}</div>
                      {hintBlock}
                      <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '24px', color: themeStyles.stemColor, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                        {fb.faceB}
                      </div>
                      {!isAnswered && renderLessonPracticeActionRow(
                        <button type="button" onClick={handleFlipComplete} style={{ padding: '12px 24px', border: 'none', borderRadius: '8px', backgroundColor: themeStyles.success, color: themeStyles.whiteOnAccent, cursor: 'pointer', fontSize: '15px', fontWeight: 600 }}>
                          {i18n('Flip mark done')}
                        </button>,
                        '2px',
                      )}
                    </>
                  )}
                </>
              );
            })()}
          </>
        ) : currentKind === 'super_flip' ? (
          <>
            {(() => {
              const sf = currentProblem as ProblemSuperFlip;
              const { headers, columns } = superFlipNormalized(sf);
              const stemText = typeof sf.stem === 'string' ? sf.stem.trim() : '';
              const ncol = columns.length;
              const nrow = columns[0]?.length ?? 0;
              const revealed = superFlipRevealed;
              const allRevealed =
                ncol >= SUPER_FLIP_COL_MIN
                && nrow >= SUPER_FLIP_ROW_MIN
                && superFlipAllFilledCellsRevealed(columns, revealed);
              const thStyle: React.CSSProperties = {
                border: `1px solid ${themeStyles.border}`,
                padding: '10px 12px',
                fontSize: '15px',
                fontWeight: 600,
                backgroundColor: themeStyles.bgSecondary,
                color: themeStyles.textPrimary,
                textAlign: 'left',
              };
              const tdStyle: React.CSSProperties = {
                border: `1px solid ${themeStyles.border}`,
                padding: '4px',
                verticalAlign: 'middle',
                backgroundColor: themeStyles.bgPrimary,
              };
              return (
                <>
                  {stemText ? (
                    <div style={{ fontSize: '17px', fontWeight: 500, marginBottom: '14px', color: themeStyles.stemColor, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {stemText}
                    </div>
                  ) : null}
                  <div style={{ overflowX: 'auto', marginBottom: '18px' }}>
                    <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '280px' }}>
                      <thead>
                        <tr>
                          {headers.map((h, ci) => (
                            <th key={`sf-th-${currentProblem.pid}-${ci}`} style={thStyle}>
                              {String(h ?? '').trim() ? String(h) : '—'}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: nrow }, (_, ri) => (
                          <tr key={`sf-tr-${currentProblem.pid}-${ri}`}>
                            {columns.map((col, ci) => {
                              const raw = col[ri];
                              const text = raw == null ? '' : String(raw);
                              const hasFlip = superFlipCellHasContent(text);
                              const flipped =
                                !hasFlip || isAnswered || showAnalysis || !!(revealed[ci] && revealed[ci][ri]);
                              const emptyCellBox: React.CSSProperties = {
                                minHeight: '52px',
                                padding: '10px 12px',
                                borderRadius: '6px',
                                fontSize: '15px',
                                lineHeight: 1.45,
                                boxSizing: 'border-box' as const,
                                backgroundColor: themeStyles.bgSecondary,
                                color: themeStyles.textTertiary,
                              };
                              const cellBtn: React.CSSProperties = {
                                width: '100%',
                                minHeight: '52px',
                                padding: '10px 12px',
                                border: 'none',
                                borderRadius: '6px',
                                fontSize: '15px',
                                fontWeight: flipped ? 500 : 600,
                                lineHeight: 1.45,
                                textAlign: 'left' as const,
                                cursor: isAnswered ? 'default' : 'pointer',
                                whiteSpace: 'pre-wrap' as const,
                                wordBreak: 'break-word' as const,
                                boxSizing: 'border-box' as const,
                                backgroundColor: flipped ? themeStyles.bgSecondary : themeStyles.optionNeutral,
                                color: flipped ? themeStyles.textPrimary : themeStyles.textTertiary,
                              };
                              if (!hasFlip) {
                                return (
                                  <td key={`sf-td-${ci}-${ri}`} style={tdStyle}>
                                    <div style={emptyCellBox} aria-hidden />
                                  </td>
                                );
                              }
                              return (
                                <td key={`sf-td-${ci}-${ri}`} style={tdStyle}>
                                  <button
                                    type="button"
                                    disabled={isAnswered}
                                    onClick={() => handleSuperFlipCellToggle(ci, ri)}
                                    style={cellBtn}
                                    aria-pressed={flipped}
                                  >
                                    {flipped ? (text.trim() ? text : '—') : String(i18n('Problem super flip masked'))}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!isAnswered && renderLessonPracticeActionRow(
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
                      <button
                        type="button"
                        onClick={handleSuperFlipRevealAll}
                        disabled={ncol < SUPER_FLIP_COL_MIN || nrow < SUPER_FLIP_ROW_MIN}
                        style={{
                          padding: '10px 18px',
                          borderRadius: '8px',
                          border: `1px solid ${themeStyles.border}`,
                          backgroundColor: themeStyles.bgSecondary,
                          color: themeStyles.textPrimary,
                          cursor: ncol >= SUPER_FLIP_COL_MIN && nrow >= SUPER_FLIP_ROW_MIN ? 'pointer' : 'not-allowed',
                          opacity: ncol >= SUPER_FLIP_COL_MIN && nrow >= SUPER_FLIP_ROW_MIN ? 1 : 0.55,
                          fontSize: '14px',
                          fontWeight: 600,
                        }}
                      >
                        {i18n('Problem super flip reveal all')}
                      </button>
                      <button
                        type="button"
                        onClick={handleSuperFlipCoverAll}
                        disabled={ncol < SUPER_FLIP_COL_MIN || nrow < SUPER_FLIP_ROW_MIN}
                        style={{
                          padding: '10px 18px',
                          borderRadius: '8px',
                          border: `1px solid ${themeStyles.border}`,
                          backgroundColor: themeStyles.bgSecondary,
                          color: themeStyles.textPrimary,
                          cursor: ncol >= SUPER_FLIP_COL_MIN && nrow >= SUPER_FLIP_ROW_MIN ? 'pointer' : 'not-allowed',
                          opacity: ncol >= SUPER_FLIP_COL_MIN && nrow >= SUPER_FLIP_ROW_MIN ? 1 : 0.55,
                          fontSize: '14px',
                          fontWeight: 600,
                        }}
                      >
                        {i18n('Problem super flip cover all')}
                      </button>
                      <button
                        type="button"
                        onClick={handleSuperFlipNotFamiliar}
                        style={{
                          padding: '10px 18px',
                          borderRadius: '8px',
                          border: `1px solid ${themeStyles.orange}`,
                          backgroundColor: themeStyles.reviewBg,
                          color: themeStyles.reviewFg,
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: 600,
                        }}
                      >
                        {i18n('Problem super flip not familiar')}
                      </button>
                      <button
                        type="button"
                        onClick={handleSuperFlipSubmit}
                        disabled={!allRevealed}
                        style={{
                          padding: '11px 24px',
                          border: 'none',
                          borderRadius: '8px',
                          backgroundColor: themeStyles.success,
                          color: themeStyles.whiteOnAccent,
                          cursor: allRevealed ? 'pointer' : 'not-allowed',
                          opacity: allRevealed ? 1 : 0.55,
                          fontSize: '15px',
                          fontWeight: 600,
                        }}
                      >
                        {i18n('Flip mark done')}
                      </button>
                    </div>,
                    '0px',
                  )}
                </>
              );
            })()}
          </>
        ) : currentKind === 'fill_blank' ? (
          <>
            <div
              style={{
                padding: '16px 18px',
                borderRadius: '10px',
                backgroundColor: themeStyles.fillBlankStemWellBg,
                border: `1px solid ${themeStyles.border}`,
                marginBottom: '20px',
              }}
            >
              <div
                style={{
                  fontSize: '18px',
                  fontWeight: 500,
                  color: themeStyles.stemColor,
                  lineHeight: 1.75,
                  display: 'flex',
                  flexDirection: 'row',
                  flexWrap: 'wrap',
                  alignItems: 'baseline',
                  columnGap: 6,
                  rowGap: 8,
                }}
              >
                {(() => {
                  const pf = currentProblem as ProblemFillBlank;
                  const stemStr = pf.stem || '';
                  const hasMarks = stemStr.includes('___');
                  const segs = hasMarks ? stemStr.split('___') : [stemStr];
                  const need = fillBlankSlotCount(stemStr);
                  const expected = pf.answers || [];
                  const stemBlockStyle: React.CSSProperties = {
                    whiteSpace: 'pre-wrap',
                  };
                  const fillInputStyle = (slot: number): React.CSSProperties => {
                    const base: React.CSSProperties = {
                      display: 'inline-block',
                      verticalAlign: 'baseline',
                      minWidth: '6.5em',
                      maxWidth: 'min(100%, 18rem)',
                      width: 'auto',
                      padding: '6px 10px',
                      borderRadius: '6px',
                      borderWidth: '1.5px',
                      borderStyle: 'solid',
                      borderColor: themeStyles.fillBlankInputBorder,
                      fontSize: '17px',
                      fontWeight: 500,
                      lineHeight: 1.35,
                      letterSpacing: '0.01em',
                      backgroundColor: themeStyles.fillBlankInputBg,
                      color: themeStyles.textPrimary,
                      boxShadow: theme === 'dark' ? 'inset 0 1px 0 rgba(255,255,255,0.05)' : 'inset 0 1px 2px rgba(0,0,0,0.04)',
                      boxSizing: 'border-box',
                    };
                    if (!showAnalysis) return base;
                    const ok = normalizeFillBlankText(expected[slot] ?? '') === normalizeFillBlankText(fillBlankDraft[slot] ?? '');
                    return {
                      ...base,
                      borderColor: ok ? themeStyles.success : themeStyles.danger,
                      backgroundColor: ok ? themeStyles.successBg : themeStyles.dangerBg,
                      boxShadow: 'none',
                    };
                  };
                  const onDraft = (slot: number, val: string) => {
                    setFillBlankDraft((prev) => {
                      const next = [...prev];
                      while (next.length < need) next.push('');
                      next[slot] = val;
                      return next;
                    });
                  };
                  if (!hasMarks) {
                    return (
                      <>
                        <span style={stemBlockStyle}>{segs[0] || i18n('No stem')}</span>
                        <input
                          aria-label={String(i18n('Problem fill blank slot label', 1))}
                          disabled={isAnswered}
                          value={fillBlankDraft[0] ?? ''}
                          onChange={(e) => onDraft(0, e.target.value)}
                          style={fillInputStyle(0)}
                        />
                      </>
                    );
                  }
                  const rows: React.ReactNode[] = [];
                  for (let i = 0; i < segs.length; i++) {
                    rows.push(
                      <span key={`fbs-t-${currentProblem.pid}-${i}`} style={stemBlockStyle}>{segs[i]}</span>,
                    );
                    if (i < segs.length - 1) {
                      rows.push(
                        <input
                          key={`fbs-i-${currentProblem.pid}-${i}`}
                          aria-label={String(i18n('Problem fill blank slot label', i + 1))}
                          disabled={isAnswered}
                          value={fillBlankDraft[i] ?? ''}
                          onChange={(e) => onDraft(i, e.target.value)}
                          style={fillInputStyle(i)}
                        />,
                      );
                    }
                  }
                  return rows;
                })()}
              </div>
            </div>
            {!isAnswered && renderLessonPracticeActionRow(
              <button
                type="button"
                onClick={handleFillBlankSubmit}
                style={{
                  padding: '11px 24px',
                  border: 'none',
                  borderRadius: '8px',
                  backgroundColor: themeStyles.accent,
                  color: themeStyles.whiteOnAccent,
                  cursor: 'pointer',
                  fontSize: '15px',
                  fontWeight: 600,
                  boxShadow: theme === 'dark' ? '0 2px 8px rgba(56, 189, 248, 0.25)' : '0 2px 6px rgba(33, 150, 243, 0.25)',
                }}
              >
                {i18n('Submit answer')}
              </button>,
              '2px',
            )}
          </>
        ) : currentKind === 'matching' ? (
          <>
            {(() => {
              const pm = currentProblem as ProblemMatching;
              const cols = matchingColumnsNormalized(pm);
              const n = cols[0]?.length ?? 0;
              const ncol = cols.length;
              const stemText = typeof pm.stem === 'string' ? pm.stem.trim() : '';
              return (
                <>
                  {stemText ? (
                    <div style={{ fontSize: '17px', fontWeight: 500, marginBottom: '18px', color: themeStyles.stemColor, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {stemText}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
                    {Array.from({ length: n }, (_, rowIdx) => {
                      const rowPicks = matchingSelections[rowIdx] || [];
                      return (
                        <div key={`match-row-${currentProblem.pid}-${rowIdx}`} style={{ display: 'flex', alignItems: 'stretch', gap: '8px', flexWrap: 'wrap' }}>
                          {Array.from({ length: ncol }, (_, ck) => {
                              const colSrc = cols[ck] || [];
                              const shuffleOrder =
                                matchingShuffleOrders[ck]?.length === n
                                  ? matchingShuffleOrders[ck]!
                                  : Array.from({ length: n }, (_, i) => i);
                              const picked = rowPicks[ck] ?? null;
                              const pickOk =
                                typeof picked === 'number' && Number.isFinite(picked) && picked === rowIdx;
                              const selStyle: React.CSSProperties = {
                                flex: '1 1 120px',
                                minWidth: '120px',
                                padding: '10px 12px',
                                borderRadius: '8px',
                                border:
                                  showAnalysis
                                    ? `2px solid ${pickOk ? themeStyles.success : themeStyles.danger}`
                                    : `2px solid ${themeStyles.border}`,
                                backgroundColor:
                                  showAnalysis
                                    ? pickOk ? themeStyles.successBg : themeStyles.dangerBg
                                    : themeStyles.bgSecondary,
                                color: themeStyles.textPrimary,
                                fontSize: '14px',
                              };
                              return (
                                <select
                                  key={`m-sel-${rowIdx}-${ck}`}
                                  aria-label={`${String(i18n('Problem matching row label', rowIdx + 1))} · ${String(i18n('Problem matching column label', ck + 1))}`}
                                  disabled={isAnswered}
                                  value={picked === null || picked === undefined ? '' : String(picked)}
                                  onChange={(e) => {
                                    const raw = e.target.value;
                                    const v = raw === '' ? NaN : parseInt(raw, 10);
                                    setMatchingSelections((prev) => {
                                      const mat = [...prev];
                                      while (mat.length < n) mat.push([]);
                                      let rowArr = [...(mat[rowIdx] ?? [])];
                                      while (rowArr.length < ncol) rowArr.push(null);
                                      rowArr[ck] = Number.isFinite(v) ? v : null;
                                      mat[rowIdx] = rowArr;
                                      return mat;
                                    });
                                  }}
                                  style={{ ...selStyle, alignSelf: 'center', maxWidth: '100%' }}
                                >
                                  <option value="">{i18n('Problem matching choose')}</option>
                                  {shuffleOrder.filter((ori) => ori >= 0 && ori < n).map((origIdx) => (
                                    <option key={`m-${rowIdx}-${ck}-${origIdx}`} value={origIdx}>{String(colSrc?.[origIdx] ?? '').trim() || `—`}</option>
                                  ))}
                                </select>
                              );
                            })}
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
            {!isAnswered &&
              (() => {
                const pm = currentProblem as ProblemMatching;
                const ncolm = matchingColumnsNormalized(pm);
                const nn = ncolm[0]?.length ?? 0;
                const scc = ncolm.length;
                let bad =
                  nn <= 0 || scc < MATCHING_COL_MIN
                  || matchingSelections.length < nn
                  || !(matchingSelections.slice(0, nn).every((row) => {
                    const r = row ?? [];
                    if (r.length < scc) return false;
                    for (let ck = 0; ck < scc; ck++) {
                      if (r[ck] === null || r[ck] === undefined) return false;
                    }
                    return true;
                  }));
                return renderLessonPracticeActionRow(
                  <button
                    type="button"
                    onClick={handleMatchingSubmit}
                    disabled={bad}
                    style={{
                      marginTop: '2px',
                      padding: '11px 24px',
                      border: 'none',
                      borderRadius: '8px',
                      backgroundColor: themeStyles.accent,
                      color: themeStyles.whiteOnAccent,
                      cursor: bad ? 'not-allowed' : 'pointer',
                      opacity: bad ? 0.55 : 1,
                      fontSize: '15px',
                      fontWeight: 600,
                      boxShadow:
                        theme === 'dark'
                          ? '0 2px 8px rgba(56, 189, 248, 0.25)'
                          : '0 2px 6px rgba(33, 150, 243, 0.25)',
                    }}
                  >
                    {i18n('Submit answer')}
                  </button>,
                  '2px',
                );
              })()}
          </>
        ) : currentKind === 'true_false' ? (
          <>
            <div style={{ fontSize: '18px', fontWeight: '500', marginBottom: '24px', color: themeStyles.stemColor, lineHeight: '1.6' }}>
              {(currentProblem as ProblemTrueFalse).stem || i18n('No stem')}
            </div>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
              {([1, 0] as const).map((v) => {
                const pt = currentProblem as ProblemTrueFalse;
                const isSel = selectedTf === v;
                const isAns = pt.answer === v;
                const baseStyle: React.CSSProperties = {
                  flex: 1,
                  minWidth: '120px',
                  padding: '16px',
                  borderRadius: '8px',
                  cursor: isAnswered ? 'not-allowed' : 'pointer',
                  fontSize: '16px',
                  fontWeight: 600,
                  border: '2px solid',
                };
                let st: React.CSSProperties;
                if (showAnalysis) {
                  if (isAns) st = { ...baseStyle, borderColor: themeStyles.success, backgroundColor: themeStyles.successBg, color: themeStyles.textPrimary };
                  else if (isSel) st = { ...baseStyle, borderColor: themeStyles.danger, backgroundColor: themeStyles.dangerBg, color: themeStyles.textPrimary };
                  else st = { ...baseStyle, borderColor: themeStyles.optionBorderMuted, backgroundColor: themeStyles.optionNeutral, opacity: 0.55, color: themeStyles.textSecondary };
                } else if (isSel) st = { ...baseStyle, borderColor: themeStyles.accent, backgroundColor: themeStyles.accentMutedBg, color: themeStyles.textPrimary };
                else st = { ...baseStyle, borderColor: themeStyles.optionBorderMuted, backgroundColor: themeStyles.optionNeutral, color: themeStyles.textPrimary };
                return (
                  <button key={v} type="button" disabled={isAnswered} onClick={() => handleTfSelect(v)} style={st}>
                    {v === 1 ? i18n('Problem answer true') : i18n('Problem answer false')}
                  </button>
                );
              })}
            </div>
            {!isAnswered && renderLessonPracticeActionRow(null, '12px')}
          </>
        ) : (
          <>
            <div style={{
              fontSize: '18px',
              fontWeight: '500',
              marginBottom: '24px',
              color: themeStyles.stemColor,
              lineHeight: '1.6',
            }}>
              {(currentProblem as ProblemSingle | ProblemMulti).stem || i18n('No stem')}
            </div>

            <div style={{ marginBottom: '20px' }} key={`options-${currentProblem?.pid}-${currentProblemIndex}-${shuffleTrigger}`}>
              {(currentKind === 'single' && (currentProblem as ProblemSingle).options && Array.isArray((currentProblem as ProblemSingle).options) ? displayOrder : []).map((originalIdx, displayIdx) => {
                const ps = currentProblem as ProblemSingle;
                const option = ps.options[originalIdx];
                const isSelected = selectedAnswer === displayIdx;
                const isAnswer = originalIdx === ps.answer;
                const baseStyle: React.CSSProperties = {
                  padding: isMobile ? '16px' : '14px',
                  marginBottom: '12px',
                  borderRadius: '6px',
                  cursor: isAnswered ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  ...(isMobile ? { minHeight: '48px', display: 'flex', alignItems: 'center' } : {}),
                };
                let optionStyle: React.CSSProperties;
                if (showAnalysis) {
                  if (isAnswer) {
                    optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.success}`, backgroundColor: themeStyles.successBg };
                  } else if (isSelected) {
                    optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.danger}`, backgroundColor: themeStyles.dangerBg };
                  } else {
                    optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.optionBorderMuted}`, backgroundColor: themeStyles.optionNeutral, opacity: 0.6 };
                  }
                } else if (isSelected) {
                  optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.accent}`, backgroundColor: themeStyles.accentMutedBg };
                } else {
                  optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.optionBorderMuted}`, backgroundColor: themeStyles.optionNeutral };
                }

                return (
                  <div
                    key={`${currentProblem.pid || currentProblemIndex}-${displayIdx}`}
                    onClick={() => !isAnswered && handleAnswerSelect(displayIdx)}
                    style={optionStyle}
                  >
                    <span style={{ marginRight: '10px', fontWeight: 'bold', fontSize: '16px', color: themeStyles.textPrimary }}>
                      {String.fromCharCode(65 + displayIdx)}.
                    </span>
                    <span style={{ fontSize: '16px', color: themeStyles.textPrimary }}>{option}</span>
                  </div>
                );
              })}
              {(currentKind === 'multi' && (currentProblem as ProblemMulti).options && Array.isArray((currentProblem as ProblemMulti).options) ? displayOrderMulti : []).map((originalIdx, displayIdx) => {
                const pm = currentProblem as ProblemMulti;
                const option = pm.options[originalIdx];
                const picked = selectedMulti.includes(originalIdx);
                const should = normalizeMultiAnswers(pm.answer).includes(originalIdx);
                const baseStyle: React.CSSProperties = {
                  padding: isMobile ? '16px' : '14px',
                  marginBottom: '12px',
                  borderRadius: '6px',
                  cursor: isAnswered ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s',
                  ...(isMobile ? { minHeight: '48px', display: 'flex', alignItems: 'center' } : {}),
                };
                let optionStyle: React.CSSProperties;
                if (showAnalysis) {
                  if (should) {
                    optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.success}`, backgroundColor: themeStyles.successBg };
                  } else if (picked) {
                    optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.danger}`, backgroundColor: themeStyles.dangerBg };
                  } else {
                    optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.optionBorderMuted}`, backgroundColor: themeStyles.optionNeutral, opacity: 0.6 };
                  }
                } else if (picked) {
                  optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.accent}`, backgroundColor: themeStyles.accentMutedBg };
                } else {
                  optionStyle = { ...baseStyle, border: `2px solid ${themeStyles.optionBorderMuted}`, backgroundColor: themeStyles.optionNeutral };
                }
                return (
                  <div
                    key={`m-${currentProblem.pid}-${displayIdx}`}
                    onClick={() => !isAnswered && handleMultiToggle(displayIdx)}
                    style={optionStyle}
                  >
                    <span style={{ marginRight: '10px', fontWeight: 'bold', fontSize: '16px', color: themeStyles.textPrimary }}>
                      {String.fromCharCode(65 + displayIdx)}.
                    </span>
                    <span style={{ fontSize: '16px', color: themeStyles.textPrimary }}>{option}</span>
                  </div>
                );
              })}
            </div>
            {currentKind === 'single' && !isAnswered && renderLessonPracticeActionRow(null, '12px')}
            {currentKind === 'multi' && !isAnswered && renderLessonPracticeActionRow(
              <button
                type="button"
                onClick={handleMultiConfirm}
                style={{ padding: '10px 22px', border: 'none', borderRadius: '8px', backgroundColor: themeStyles.accent, color: themeStyles.whiteOnAccent, cursor: 'pointer', fontSize: '15px', fontWeight: 600 }}
              >
                {i18n('Submit answer')}
              </button>,
              '8px',
            )}
          </>
        )}

        {showAnalysis && currentProblem.analysis && (
          <div style={{
            marginTop: '20px',
            padding: '16px',
            backgroundColor: themeStyles.bgSecondary,
            borderRadius: '6px',
            fontSize: '15px',
            color: themeStyles.textSecondary,
            lineHeight: '1.6',
          }}>
            <strong style={{ color: themeStyles.textPrimary }}>{i18n('Analysis')}:</strong> {currentProblem.analysis}
          </div>
        )}

        {pendingLessonAdvance && (
          <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' }}>
            <button
              type="button"
              onClick={handleContinueAfterAnswer}
              style={{
                padding: '11px 24px',
                border: 'none',
                borderRadius: '8px',
                backgroundColor: themeStyles.accent,
                color: themeStyles.whiteOnAccent,
                cursor: 'pointer',
                fontSize: '15px',
                fontWeight: 600,
                boxShadow: theme === 'dark' ? '0 2px 8px rgba(56, 189, 248, 0.25)' : '0 2px 6px rgba(33, 150, 243, 0.25)',
              }}
            >
              {i18n('Continue')}
            </button>
            {pendingLessonAdvance === 'requeue' ? (
              <button
                type="button"
                onClick={handleRedoCurrentLessonQuestion}
                style={{
                  padding: '11px 24px',
                  borderRadius: '8px',
                  border: `1px solid ${themeStyles.border}`,
                  backgroundColor: themeStyles.bgSecondary,
                  color: themeStyles.textPrimary,
                  cursor: 'pointer',
                  fontSize: '15px',
                  fontWeight: 600,
                }}
              >
                {i18n('Lesson redo question')}
              </button>
            ) : null}
          </div>
        )}

        {showPeekCard && (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: themeStyles.drawerScrim,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 9999,
              padding: '20px',
            }}
            onClick={(e) => e.target === e.currentTarget && handlePeekClose()}
          >
            <div
              style={{
                maxWidth: '640px',
                maxHeight: '85vh',
                overflow: 'auto',
                backgroundColor: themeStyles.bgCard,
                borderRadius: '12px',
                padding: '24px',
                border: `1px solid ${themeStyles.border}`,
                boxShadow: themeStyles.modalShadow,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ margin: '0 0 16px', fontSize: '18px', color: themeStyles.textPrimary }}>
                {i18n('Source card')}: {card.title || i18n('Unnamed Card')}
              </h3>
              <div
                className="lesson-markdown-body"
                style={{
                  fontSize: '15px',
                  lineHeight: '1.6',
                  color: themeStyles.bodyText,
                  marginBottom: '20px',
                }}
                dangerouslySetInnerHTML={{ __html: renderedContent || card.content || '' }}
              />
              <div style={{ textAlign: 'right' }}>
                <button
                  type="button"
                  onClick={handlePeekClose}
                  style={{
                    padding: '10px 20px',
                    border: 'none',
                    borderRadius: '6px',
                    backgroundColor: themeStyles.orange,
                    color: themeStyles.whiteOnAccent,
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: 600,
                  }}
                >
                  {i18n('Close and retry')}
                </button>
              </div>
            </div>
          </div>
        )}
        {lessonProblemTagPanelOpen && currentProblem && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={i18n('Lesson problem tag panel title')}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 10001,
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'stretch',
              justifyContent: 'flex-end',
            }}
          >
            <div
              role="presentation"
              style={{ flex: 1, minWidth: 0, backgroundColor: themeStyles.drawerScrim }}
              onClick={() => setLessonProblemTagPanelOpen(false)}
              aria-hidden
            />
            <div
              style={{
                width: 'min(400px, 100vw)',
                maxHeight: '100vh',
                overflowY: 'auto',
                backgroundColor: themeStyles.bgCard,
                borderLeft: `1px solid ${themeStyles.border}`,
                boxShadow: themeStyles.drawerAsideShadowRight,
                padding: '20px',
                boxSizing: 'border-box',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: themeStyles.textPrimary, lineHeight: 1.3 }}>
                  {i18n('Lesson problem tag panel title')}
                </h2>
                <button
                  type="button"
                  onClick={() => setLessonProblemTagPanelOpen(false)}
                  style={{
                    flexShrink: 0,
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: `1px solid ${themeStyles.border}`,
                    backgroundColor: themeStyles.bgSecondary,
                    color: themeStyles.textPrimary,
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {i18n('Close')}
                </button>
              </div>
              <LessonProblemTagPanelBody
                problem={currentProblem}
                registry={lessonProblemTagOptions}
                canEdit={lessonCanEditProblemTags}
                saving={lessonProblemTagSaveKey === `${String(currentProblem.cardId)}:${currentProblem.pid}`}
                registerSaving={lessonProblemTagRegisterBusy}
                bgPrimary={themeStyles.bgPrimary}
                bgSecondary={themeStyles.bgSecondary}
                border={themeStyles.border}
                textPrimary={themeStyles.textPrimary}
                textSecondary={themeStyles.textSecondary}
                textTertiary={themeStyles.textTertiary}
                accent={themeStyles.accent}
                accentMutedBg={themeStyles.accentMutedBg}
                onPersist={(nextTags) => {
                  if (!lessonCanEditProblemTags) return;
                  void persistLessonProblemTag(String(currentProblem.cardId), currentProblem.pid, nextTags);
                }}
                onRegisterOnly={registerLessonProblemTagToRegistry}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const showSidebar = hasLessonSidebar;
  if (showSidebar) {
    if (isMobile) {
      return (
        <>
          {(leftDrawerOpen || rightDrawerOpen) && (
            <div
              role="presentation"
              style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: themeStyles.drawerScrim }}
              onClick={closeBothDrawers}
              aria-hidden
            />
          )}
          <aside style={{
            ...asideBaseStyle,
            position: 'fixed',
            left: 0,
            top: 0,
            bottom: 0,
            width: '280px',
            maxWidth: '85vw',
            zIndex: 1002,
            transform: leftDrawerOpen ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 0.2s ease-out',
            boxShadow: leftDrawerOpen ? themeStyles.drawerAsideShadow : 'none',
          }}>
            {lessonSidebarLeftColumn}
            <button type="button" onClick={closeBothDrawers} style={drawerCloseBtnStyle}>
              {i18n('Close')}
            </button>
          </aside>
          {splitQueueSidebars && lessonSidebarRightColumn && (
            <aside style={{
              ...asideRightBaseStyle,
              position: 'fixed',
              right: 0,
              left: 'auto',
              top: 0,
              bottom: 0,
              width: '280px',
              maxWidth: '85vw',
              zIndex: 1002,
              transform: rightDrawerOpen ? 'translateX(0)' : 'translateX(100%)',
              transition: 'transform 0.2s ease-out',
              boxShadow: rightDrawerOpen ? themeStyles.drawerAsideShadowRight : 'none',
            }}>
              {lessonSidebarRightColumn}
              <button type="button" onClick={closeBothDrawers} style={drawerCloseBtnStyle}>
                {i18n('Close')}
              </button>
            </aside>
          )}
          <main style={{ flex: 1, overflowY: 'auto', paddingTop: '24px', paddingLeft: '12px', paddingRight: '12px', paddingBottom: '24px', minHeight: '100vh', background: themeStyles.bgPage }}>
            {mainContent}
          </main>
        </>
      );
    }
    return (
      <div style={{ display: 'flex', minHeight: '100vh', background: themeStyles.bgPage }}>
        <aside style={{ width: '240px', flexShrink: 0, ...asideBaseStyle }}>
          {lessonSidebarLeftColumn}
        </aside>
        <main style={{ flex: 1, overflowY: 'auto', background: themeStyles.bgPage }}>
          {mainContent}
        </main>
        {splitQueueSidebars && lessonSidebarRightColumn && (
          <aside style={{ width: '240px', flexShrink: 0, ...asideRightBaseStyle }}>
            {lessonSidebarRightColumn}
          </aside>
        )}
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: themeStyles.bgPage }}>
      {mainContent}
    </div>
  );
}

const page = new NamedPage('lessonPage', async () => {
  try {
    const container = document.getElementById('lesson-container');
    if (!container) {
      return;
    }
    ReactDOM.render(<LessonPage />, container);
  } catch (error: any) {
  }
});

export default page;
