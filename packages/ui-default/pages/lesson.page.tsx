import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';
import type { Problem, ProblemSingle, ProblemMulti, ProblemTrueFalse, ProblemFlip } from 'ejun/src/interface';
import { problemKind, normalizeMultiAnswers, setsEqualAsSorted } from 'ejun/src/model/problem';

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

function multiIndicesToBitmask(indices: number[]): number {
  let s = 0;
  for (const i of indices) {
    if (typeof i === 'number' && i >= 0 && i < 31) s |= 1 << i;
  }
  return s;
}

function lessonProblemKindLabel(k: ReturnType<typeof problemKind>): string {
  const key =
    k === 'multi' ? 'Problem kind multi'
    : k === 'true_false' ? 'Problem kind true false'
    : k === 'flip' ? 'Problem kind flip'
    : 'Problem kind single';
  const t = i18n(key);
  return t !== key ? t : k;
}

function lessonProblemQueueTitleText(p: QueuedProblem): string {
  if (problemKind(p) === 'flip') {
    const f = p as ProblemFlip;
    return String(f.faceA || '').trim();
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
  /** Keys `slot:cardId` → times this card was completed on the learning path (domain.user). */
  learnPathCardPractiseCounts: Record<string, number>;
  /** Server `translate('Lesson path card practise count')` — avoids missing `window.LOCALES` entry. */
  lessonPathCardPractiseCountFmt: string;
  lessonPathCardPractiseCountTitle: string;
};

function normalizeCardFromServer(raw: unknown): Card {
  if (!raw || typeof raw !== 'object') return {} as Card;
  const c = raw as Record<string, unknown>;
  return {
    ...(c as unknown as Card),
    docId: c.docId != null ? String(c.docId) : '',
  };
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

function initLessonUiState(): LessonUiState {
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
  };
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
  } = lessonUi;

  const hasLessonSidebar = (isSingleNodeMode || isTodayMode || isAlonePractice)
    && (nodeTree.length > 0 || (card.problems || []).length > 0);

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
    return (card.problems || []).map((p) => ({ ...p, cardId: String(card.docId) } as QueuedProblem));
  }, [card]);

  /** 单卡片 + 有练习题：左右栏按「已完成 / 待完成题目」分列，不用卡片队列。 */
  const splitProblemPracticeSidebars = isAlonePractice && allProblems.length > 0 && hasLessonSidebar;
  const splitQueueSidebars = hasLessonSidebar && (splitProblemPracticeSidebars || flatCards.length > 0);
  const showLessonProblemSessionProgress = splitProblemPracticeSidebars;
  const showCardQueueProgress = flatCards.length > 0
    && (isSingleNodeMode || isTodayMode || isAlonePractice)
    && !splitProblemPracticeSidebars;

  const [problemQueue, setProblemQueue] = useState<QueuedProblem[]>([]);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [selectedMulti, setSelectedMulti] = useState<number[]>([]);
  const [selectedTf, setSelectedTf] = useState<0 | 1 | null>(null);
  const [flipStage, setFlipStage] = useState<'a' | 'b'>('a');
  const [isAnswered, setIsAnswered] = useState(false);
  const [isPassed, setIsPassed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const hasCalledPassRef = useRef(false);
  const [answerHistory, setAnswerHistory] = useState<Array<{ problem: QueuedProblem; selected: number; correct: boolean; timeSpent: number; attempts: number }>>([]);
  /** Pids removed from queue after a full correct pass (excludes “need more” requeue / wrong). */
  const [practiceClearedPids, setPracticeClearedPids] = useState<Record<string, true>>({});
  const practiceProblemsDoneCount = Object.keys(practiceClearedPids).length;
  const practiceProblemsPendingCount = problemQueue.length;
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
    }));
    const nextCard = payload.card != null ? normalizeCardFromServer(payload.card) : null;
    const probs = (nextCard?.problems || []).map((p) => ({ ...p, cardId: String(nextCard!.docId) } as QueuedProblem));
    setProblemQueue(probs);
    setCurrentProblemIndex(0);
    setSelectedAnswer(null);
    setSelectedMulti([]);
    setSelectedTf(null);
    setFlipStage('a');
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
      setCurrentProblemIndex(0);
      setSelectedAnswer(null);
      setSelectedMulti([]);
      setSelectedTf(null);
      setFlipStage('a');
      setIsAnswered(false);
      setShowAnalysis(false);
      setPracticeClearedPids({});
    }
  }, [allProblems, problemQueue.length, answerHistory.length]);

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
    if (showLessonProblemSessionProgress) {
      const total = allProblems.length;
      const done = Object.keys(practiceClearedPids).length;
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      return (
        <div style={cardShell}>
          {modeBlock}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', marginBottom: '12px', gap: '12px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.accent }}>
              {done} / {total} {i18n('Lesson practice progress unit')} · {pct}%
            </span>
          </div>
          <div style={{
            height: '14px',
            borderRadius: '999px',
            backgroundColor: themeStyles.bgSecondary,
            border: `1px solid ${themeStyles.border}`,
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${pct}%`,
              height: '100%',
              borderRadius: '999px',
              background: `linear-gradient(90deg, ${themeStyles.accent}, ${themeStyles.success})`,
              transition: 'width 0.35s ease',
            }} />
          </div>
        </div>
      );
    }
    const total = flatCards.length;
    const done = lessonQueueDoneCount;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const newOldLine = lessonQueueNewOldLine(lessonSessionQueueNewOldLabel, lessonSessionNewOldCounts);
    const newOldPrefix = newOldLine ? `${newOldLine} · ` : '';
    return (
      <div style={cardShell}>
        {modeBlock}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', marginBottom: '12px', gap: '12px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.accent }}>
            {newOldPrefix}
            {done} / {total} {i18n('cards')} · {pct}%
          </span>
        </div>
        <div style={{
          height: '14px',
          borderRadius: '999px',
          backgroundColor: themeStyles.bgSecondary,
          border: `1px solid ${themeStyles.border}`,
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: '999px',
            background: `linear-gradient(90deg, ${themeStyles.accent}, ${themeStyles.success})`,
            transition: 'width 0.35s ease',
          }} />
        </div>
      </div>
    );
  }, [
    showLessonSessionProgressCard,
    showCardQueueProgress,
    showLessonProblemSessionProgress,
    lessonSessionModeLabel,
    isTodayMode,
    rootNodeId,
    lessonLearnSessionMode,
    lessonTodayModesConfigLine,
    flatCards.length,
    allProblems.length,
    practiceClearedPids,
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
    if (currentKind === 'flip') {
      return isAnswered;
    }
    return false;
  })();

  const allCorrect = problemQueue.length === 0 && answerHistory.length > 0;

  const formatPracticeHistoryUserAnswer = useCallback((h: { problem: QueuedProblem; selected: number }) => {
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
    if (k === 'flip') return i18n('Problem kind flip');
    return i18n('N/A');
  }, []);

  useLayoutEffect(() => {
    if (!currentProblem) return;
    const k = problemKind(currentProblem);
    setSelectedAnswer(null);
    setSelectedMulti([]);
    setSelectedTf(null);
    setFlipStage('a');
    setIsAnswered(false);
    setShowAnalysis(false);
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
    } else {
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
          selected: h.selected,
          correct: h.correct,
          timeSpent: h.timeSpent,
          attempts: h.attempts,
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
          };
          return updated;
        }
        return [...prev, { problem, selected, correct: true, timeSpent, attempts: currentAttempts }];
      });
      const need = correctNeeded[problemId] || 0;
      if (need > 0) {
        setCorrectNeeded((prev) => ({ ...prev, [problemId]: need - 1 }));
        setTimeout(() => handleCorrectButNeedMore(), 1500);
      } else {
        setTimeout(() => handleNextProblem(), 1500);
      }
    } else {
      setPeekCount((prev) => ({ ...prev, [problemId]: (prev[problemId] || 0) + 1 }));
      setCorrectNeeded((prev) => ({ ...prev, [problemId]: (prev[problemId] || 0) + 1 }));
      setTimeout(() => handleWrongAnswer(), 2000);
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
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'flip') return;
    setFlipStage('b');
  };

  const handleFlipComplete = () => {
    if (isAnswered || !currentProblem || problemKind(currentProblem) !== 'flip') return;
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts((prev) => ({ ...prev, [problemId]: currentAttempts }));
    recordCorrectOrWrong(currentProblem, 1, true, timeSpent, problemId, currentAttempts);
  };

  const handleNextProblem = () => {
    const donePid = problemQueue[currentProblemIndex]?.pid;
    if (donePid) setPracticeClearedPids((prev) => ({ ...prev, [donePid]: true }));
    setSelectedAnswer(null);
    setSelectedMulti([]);
    setSelectedTf(null);
    setFlipStage('a');
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
    setSelectedAnswer(null);
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

  const handlePeek = () => {
    setShowPeekCard(true);
  };

  const handlePeekClose = () => {
    if (currentProblem) {
      setPeekCount(prev => ({ ...prev, [currentProblem.pid]: (prev[currentProblem.pid] || 0) + 1 }));
      setCorrectNeeded(prev => ({ ...prev, [currentProblem.pid]: (prev[currentProblem.pid] || 0) + 1 }));
    }
    setShowPeekCard(false);
    handleWrongAnswer();
  };

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
      {!splitQueueSidebars && (
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

  const renderLessonProblemQueueRow = (p: QueuedProblem, orderIndex: number, isCurrent: boolean, isCleared: boolean) => {
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
      <div key={`lesson-problem-row-${orderIndex}-${p.pid}`} style={rowStyle}>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {allProblems.map((p, idx) => {
          const isCurrent = currentProblem?.pid === p.pid;
          const isCleared = !!practiceClearedPids[p.pid];
          return renderLessonProblemQueueRow(p, idx, isCurrent, isCleared);
        })}
      </div>
    </div>
  ) : null;

  const sidebarProblemPracticeDoneColumn = splitProblemPracticeSidebars ? (
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {allProblems.map((p, idx) => {
          if (!practiceClearedPids[p.pid]) return null;
          return renderLessonProblemQueueRow(p, idx, false, true);
        })}
        {practiceProblemsDoneCount === 0 ? (
          <div style={{ fontSize: '13px', color: themeStyles.textTertiary, padding: '8px 0' }}>
            {i18n('No completed problems yet')}
          </div>
        ) : null}
      </div>
    </>
  ) : null;

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
      {!splitProblemPracticeSidebars && sidebarMeta}
      {lessonProblemQueueSidebar}
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
      {sidebarMeta}
      {lessonProblemQueueSidebar}
      {isTodayMode && rootNodeId === 'today' ? todayFlatListAll : nodeTree.map((root, i) => renderNodeTreeItem(root, 0))}
    </>
  );

  /** Split sidebars: left done, right pending（单卡片有题时为题目队列，否则为今日/单节点卡片队列 + meta）。 */
  const lessonSidebarLeftColumn = splitQueueSidebars
    ? (splitProblemPracticeSidebars ? sidebarProblemPracticeDoneColumn : sidebarInnerRightSplit)
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
        {(isSingleNodeMode || isTodayMode || isAlonePractice) && (
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
          {!isAnswered && currentKind !== 'flip' && (
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
              {currentKind === 'flip' && isCorrect ? i18n('Done') : (isCorrect ? i18n('Correct') : i18n('Incorrect'))}
            </span>
          )}
          <span style={{ fontSize: '11px', color: themeStyles.textTertiary, marginLeft: '4px' }}>
            ({lessonProblemKindLabel(currentKind)})
          </span>
        </div>

        {currentKind === 'flip' ? (
          <>
            {flipStage === 'a' ? (
              <div style={{ fontSize: '18px', fontWeight: 500, marginBottom: '24px', color: themeStyles.stemColor, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {(currentProblem as ProblemFlip).faceA || i18n('No stem')}
              </div>
            ) : (
              <>
                <div style={{ fontSize: '13px', color: themeStyles.textTertiary, marginBottom: '8px', whiteSpace: 'pre-wrap' }}>{(currentProblem as ProblemFlip).faceA}</div>
                <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '24px', color: themeStyles.stemColor, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {(currentProblem as ProblemFlip).faceB}
                </div>
              </>
            )}
            {!isAnswered && flipStage === 'a' && (
              <button type="button" onClick={handleFlipShowBack} style={{ padding: '12px 24px', border: 'none', borderRadius: '8px', backgroundColor: themeStyles.accent, color: themeStyles.whiteOnAccent, cursor: 'pointer', fontSize: '15px', fontWeight: 600 }}>
                {i18n('Flip show back')}
              </button>
            )}
            {!isAnswered && flipStage === 'b' && (
              <button type="button" onClick={handleFlipComplete} style={{ padding: '12px 24px', border: 'none', borderRadius: '8px', backgroundColor: themeStyles.success, color: themeStyles.whiteOnAccent, cursor: 'pointer', fontSize: '15px', fontWeight: 600 }}>
                {i18n('Flip mark done')}
              </button>
            )}
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
            {currentKind === 'multi' && !isAnswered && (
              <button type="button" onClick={handleMultiConfirm} style={{ marginTop: '8px', padding: '10px 22px', border: 'none', borderRadius: '8px', backgroundColor: themeStyles.accent, color: themeStyles.whiteOnAccent, cursor: 'pointer', fontSize: '15px', fontWeight: 600 }}>
                {i18n('Submit answer')}
              </button>
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
