import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import moment from 'moment';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import { request } from 'vj/utils';
import Notification from 'vj/components/notification';
import { ContributionWall, type ContributionDetail } from '../components/ContributionWall';

interface SectionProgress {
  _id: string;
  title: string;
  passed: number;
  total: number;
  slotIndex?: number;
}

interface CompletedCardToday {
  cardId: string;
  resultId: string;
  cardTitle: string;
  nodeTitle: string;
  completedAt?: Date | string;
}

interface PendingNodeCard {
  cardId: string;
  title: string;
  problems?: Array<{ stem?: string }>;
}

interface PendingNode {
  orderIndex: number;
  _id: string;
  title: string;
  cards: PendingNodeCard[];
}

interface MapCard {
  cardId: string;
  title: string;
  order?: number;
  problemCount?: number;
  problems?: Array<{ stem?: string }>;
}

interface MapDAGNode {
  _id: string;
  title: string;
  requireNids?: string[];
  cards?: MapCard[];
  order?: number;
}

interface LearnBaseLearnOption {
  docId: number;
  title?: string;
  branches?: string[];
}

type LearnSessionModeUi = 'deep' | 'breadth' | 'random';

type LearnNewReviewOrderUi = 'new_first' | 'old_first' | 'shuffle';

type LearnSessionCardFilterUi = 'all' | 'with_problems' | 'without_problems';

/** Values in dropdown order (must match server `ratioOptionLabels`). */
const LEARN_NEW_REVIEW_RATIO_UI_VALUES = [0, -1, 1, 2, 3, 4, 5] as const;

type LearnWallSessionRow = {
  sessionId: string;
  sessionHistoryUrl: string;
  timeUtc: string;
  recordCount: number;
  statusLabel: string;
  progressText: string | null;
  baseDocId: number;
  branch: string;
};

type LearnWallDayDetail = ContributionDetail & {
  checkedIn?: boolean;
  sessions?: LearnWallSessionRow[];
};

/** Server `this.translate()` strings for learn new vs review ratio (matches user UI language). */
interface LearnSubModeStringsFromServer {
  label?: string;
  hint?: string;
  ratioAria?: string;
  failedSave?: string;
  ratioOptionLabels?: string[];
  orderLabel?: string;
  orderHint?: string;
  orderAria?: string;
  orderOptionNewFirst?: string;
  orderOptionOldFirst?: string;
  orderOptionShuffle?: string;
  pathCardLoopCountFmt?: string;
  pathCardLoopCountTitle?: string;
  /** Server-translated (avoids stale client lang-*.js missing new keys). */
  sectionOrderLink?: string;
  sessionPreferences?: string;
}

function normalizeLearnSessionModeFromUi(raw: unknown): LearnSessionModeUi {
  const s = String(raw ?? 'deep').trim().toLowerCase();
  if (s === 'breadth' || s === 'random') return s;
  return 'deep';
}

function normalizeLearnNewReviewRatioFromUi(raw: unknown): number {
  const n = parseInt(String(raw ?? '1'), 10);
  if (n === -1 || n === 0) return n;
  if ([1, 2, 3, 4, 5].includes(n)) return n;
  return 1;
}

function normalizeLearnNewReviewOrderFromUi(raw: unknown): LearnNewReviewOrderUi {
  const s = String(raw ?? 'new_first').trim().toLowerCase().replace(/-/g, '_');
  if (s === 'old_first' || s === 'shuffle') return s;
  return 'new_first';
}

function normalizeLearnSessionCardFilterFromUi(raw: unknown): LearnSessionCardFilterUi {
  const s = String(raw ?? 'all').trim().toLowerCase().replace(/-/g, '_');
  if (s === 'with_problems') return 'with_problems';
  if (s === 'without_problems') return 'without_problems';
  return 'all';
}

type LearnSessionProblemTagModeUi = 'off' | 'include' | 'exclude';

const LEARN_PROBLEM_SESSION_TAG_LIMIT = 32;

function normalizeProblemTagUi(raw: string): string | undefined {
  const v = String(raw ?? '').trim().slice(0, 64);
  if (!v || v.toLowerCase() === 'default') return undefined;
  return v;
}

/** Align with server `normalizeLearnSessionProblemTagList` semantics (bounded list for session picker). */
function normalizeLearnProblemTagSelectionList(tags: unknown, maxEntries = LEARN_PROBLEM_SESSION_TAG_LIMIT): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of tags) {
    const t = normalizeProblemTagUi(typeof x === 'string' ? x : String(x ?? ''));
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxEntries) break;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function normalizeLearnSessionProblemTagModeFromUi(raw: unknown): LearnSessionProblemTagModeUi {
  const s = String(raw ?? 'off').trim().toLowerCase().replace(/-/g, '_');
  if (s === 'include' || s === 'exclude') return s;
  return 'off';
}

function learnProblemTagsEqual(a: string[], b: string[]): boolean {
  return JSON.stringify(normalizeLearnProblemTagSelectionList(a))
    === JSON.stringify(normalizeLearnProblemTagSelectionList(b));
}

function getChildren(nodeId: string, sections: MapDAGNode[], dag: MapDAGNode[]): MapDAGNode[] {
  const list: MapDAGNode[] = [];
  dag.forEach((n) => {
    const parentId = n.requireNids?.[n.requireNids.length - 1];
    if (parentId === nodeId) list.push(n);
  });
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function collectCardsUnder(nodeId: string, sections: MapDAGNode[], dag: MapDAGNode[], collected: Set<string>): MapCard[] {
  if (collected.has(nodeId)) return [];
  collected.add(nodeId);
  const nodeMap = new Map<string, MapDAGNode>();
  sections.forEach((s) => nodeMap.set(s._id, s));
  dag.forEach((n) => nodeMap.set(n._id, n));
  const node = nodeMap.get(nodeId);
  if (!node) return [];
  const cards = [...(node.cards || [])];
  const children = getChildren(nodeId, sections, dag);
  for (const child of children) {
    cards.push(...collectCardsUnder(child._id, sections, dag, collected));
  }
  return cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

function LearnPage() {
  const domainId = (window as any).UiContext?.domainId as string;
  const currentProgress = (window as any).UiContext?.currentProgress || 0;
  const totalProgress = (window as any).UiContext?.totalProgress || 0;
  const totalCards = (window as any).UiContext?.totalCards || 0;
  const totalCheckinDays = (window as any).UiContext?.totalCheckinDays ?? 0;
  const consecutiveDays = (window as any).UiContext?.consecutiveDays || 0;
  const dailyGoal = (window as any).UiContext?.dailyGoal || 0;
  const todayCompletedCount = (window as any).UiContext?.todayCompletedCount ?? 0;
  const pendingNodeList = ((window as any).UiContext?.pendingNodeList || []) as PendingNode[];
  const completedCardsToday = ((window as any).UiContext?.completedCardsToday || []) as CompletedCardToday[];
  const nextCard = (window as any).UiContext?.nextCard as { nodeId: string; cardId: string } | null;
  const sections = ((window as any).UiContext?.sections || []) as MapDAGNode[];
  const fullDag = ((window as any).UiContext?.fullDag || []) as MapDAGNode[];
  const pathSectionsRaw = ((window as any).UiContext?.pathSections || []) as MapDAGNode[];
  const pathFullDagRaw = ((window as any).UiContext?.pathFullDag || []) as MapDAGNode[];
  const pathCurrentSectionId = String((window as any).UiContext?.pathCurrentSectionId || '').trim() || null;
  const pathCurrentLearnStartCardId = String((window as any).UiContext?.pathCurrentLearnStartCardId || '').trim() || null;
  /** When path payload exists, prefer pathSections/pathFullDag from server (full outline); else current sections/fullDag. */
  const useTrainingPath = pathSectionsRaw.length > 0;
  const pathSectionsView = useTrainingPath ? pathSectionsRaw : sections;
  const pathFullDagView = useTrainingPath ? pathFullDagRaw : fullDag;
  const pathListLen = pathSectionsView.length;
  const currentSectionIndex = (window as any).UiContext?.currentSectionIndex as number | undefined;
  const passedCardKeysSet = new Set<string>((window as any).UiContext?.passedCardKeys || []);
  const passedLegacyCardIdsSet = new Set<string>((window as any).UiContext?.passedLegacyCardIds || []);
  const learnBases = ((window as any).UiContext?.learnBases || []) as LearnBaseLearnOption[];
  const selectedLearnBaseDocId =
    (window as any).UiContext?.selectedLearnBaseDocId != null && (window as any).UiContext?.selectedLearnBaseDocId !== ''
      ? Number((window as any).UiContext.selectedLearnBaseDocId)
      : null;
  const learnBranchUi = String((window as any).UiContext?.learnBranch || 'main').trim() || 'main';
  const requireBaseSelection = !!(window as any).UiContext?.requireBaseSelection;
  const initialLearnSessionMode = useMemo(
    () => normalizeLearnSessionModeFromUi((window as any).UiContext?.learnSessionMode),
    [],
  );
  const initialLearnNewReviewRatio = useMemo(
    () => normalizeLearnNewReviewRatioFromUi((window as any).UiContext?.learnNewReviewRatio),
    [],
  );
  const initialLearnNewReviewOrder = useMemo(
    () => normalizeLearnNewReviewOrderFromUi((window as any).UiContext?.learnNewReviewOrder),
    [],
  );
  const initialLearnSessionCardFilter = useMemo(
    () => normalizeLearnSessionCardFilterFromUi((window as any).UiContext?.learnSessionCardFilter),
    [],
  );
  const initialLearnSessionProblemTagMode = useMemo(
    () => normalizeLearnSessionProblemTagModeFromUi((window as any).UiContext?.learnSessionProblemTagMode),
    [],
  );
  const initialLearnSessionProblemTags = useMemo(
    () => normalizeLearnProblemTagSelectionList((window as any).UiContext?.learnSessionProblemTags),
    [],
  );
  const learnProblemTagOptionsFromUi = useMemo(() => {
    const raw = (window as any).UiContext?.learnProblemTagOptions;
    if (!Array.isArray(raw)) return [] as string[];
    return raw.map((x: unknown) => String(x)).filter((s) => normalizeProblemTagUi(s));
  }, []);
  const learnSubModeStrings = useMemo(
    () => ((window as any).UiContext?.learnSubModeStrings || {}) as LearnSubModeStringsFromServer,
    [],
  );
  const learnPathCardPractiseCounts = useMemo(
    () => ((window as any).UiContext?.learnPathCardPractiseCounts || {}) as Record<string, number>,
    [],
  );
  const todayLessonResumeUrl = String((window as any).UiContext?.todayLessonResumeUrl || '').trim();
  const todayLessonCardProgressText = String((window as any).UiContext?.todayLessonCardProgressText || '').trim();
  const hasTodayLessonResume = !!todayLessonResumeUrl;
  const learnWallContributions = ((window as any).UiContext?.learnWallContributions || []) as Array<{
    date: string;
    type: 'node' | 'card' | 'problem';
    count: number;
  }>;
  const learnWallContributionDetails = ((window as any).UiContext?.learnWallContributionDetails || {}) as Record<
    string,
    LearnWallDayDetail[]
  >;
  const selectedLearnBase =
    selectedLearnBaseDocId != null && Number.isFinite(selectedLearnBaseDocId) && selectedLearnBaseDocId > 0
      ? (learnBases.find((b) => Number(b.docId) === Number(selectedLearnBaseDocId)) || null)
      : null;

  const [goal, setGoal] = useState(dailyGoal);
  const [learnSessionMode, setLearnSessionMode] = useState<LearnSessionModeUi>(initialLearnSessionMode);
  const [learnNewReviewRatio, setLearnNewReviewRatio] = useState(initialLearnNewReviewRatio);
  const [learnNewReviewOrder, setLearnNewReviewOrder] = useState<LearnNewReviewOrderUi>(initialLearnNewReviewOrder);
  const [learnSessionCardFilter, setLearnSessionCardFilter] = useState<LearnSessionCardFilterUi>(initialLearnSessionCardFilter);
  const [learnSessionProblemTagMode] = useState<LearnSessionProblemTagModeUi>(initialLearnSessionProblemTagMode);
  const [learnSessionProblemTags] = useState<string[]>(() => [...initialLearnSessionProblemTags]);
  const [learnPrefsOpen, setLearnPrefsOpen] = useState(false);
  const [draftSessionMode, setDraftSessionMode] = useState<LearnSessionModeUi>(initialLearnSessionMode);
  const [draftRatio, setDraftRatio] = useState(initialLearnNewReviewRatio);
  const [draftOrder, setDraftOrder] = useState<LearnNewReviewOrderUi>(initialLearnNewReviewOrder);
  const [draftCardFilter, setDraftCardFilter] = useState<LearnSessionCardFilterUi>(initialLearnSessionCardFilter);
  const [draftTagMode, setDraftTagMode] = useState<LearnSessionProblemTagModeUi>(initialLearnSessionProblemTagMode);
  const [draftTags, setDraftTags] = useState<string[]>(() => [...initialLearnSessionProblemTags]);
  const [draftDailyGoal, setDraftDailyGoal] = useState(dailyGoal);
  const [savingLearnPrefs, setSavingLearnPrefs] = useState(false);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [showConsecutiveTip, setShowConsecutiveTip] = useState(false);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'progress' | 'path' | 'contributions'>('progress');
  /** Path view expands by section slot index so duplicate node _ids in custom order do not clash keys/expand state. */
  const [expandedPathSectionSlots, setExpandedPathSectionSlots] = useState<Set<number>>(new Set());
  const [expandedPathCardIds, setExpandedPathCardIds] = useState<Set<string>>(new Set());
  const consecutiveBubbleRef = useRef<HTMLButtonElement>(null);

  const tagOptionsForPicker = useMemo(
    () => normalizeLearnProblemTagSelectionList([...learnProblemTagOptionsFromUi, ...learnSessionProblemTags], 256),
    [learnProblemTagOptionsFromUi, learnSessionProblemTags],
  );

  const getLatestLearnWallDate = useCallback(() => {
    const dates = Object.keys(learnWallContributionDetails);
    if (dates.length === 0) return null;
    return dates.sort((a, b) => moment(b).valueOf() - moment(a).valueOf())[0];
  }, [learnWallContributionDetails]);

  const [selectedLearnWallDate, setSelectedLearnWallDate] = useState<string | null>(() => getLatestLearnWallDate());

  useEffect(() => {
    if (selectedLearnWallDate == null && Object.keys(learnWallContributionDetails).length > 0) {
      const k = getLatestLearnWallDate();
      if (k) setSelectedLearnWallDate(k);
    }
  }, [learnWallContributionDetails, getLatestLearnWallDate, selectedLearnWallDate]);

  const togglePathCardExpand = useCallback((placementKey: string) => {
    setExpandedPathCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(placementKey)) next.delete(placementKey);
      else next.add(placementKey);
      return next;
    });
  }, []);

  useEffect(() => {
    if (pathListLen > 0 && expandedPathSectionSlots.size === 0) {
      setExpandedPathSectionSlots(new Set(Array.from({ length: pathListLen }, (_, i) => i)));
    }
  }, [pathListLen]);

  const toggleNodeExpand = useCallback((nodeKey: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeKey)) next.delete(nodeKey);
      else next.add(nodeKey);
      return next;
    });
  }, []);

  const toggleCardStems = useCallback((cardKey: string) => {
    setExpandedCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardKey)) next.delete(cardKey);
      else next.add(cardKey);
      return next;
    });
  }, []);

  const handleConsecutiveBubbleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConsecutiveTip(true);
    setTimeout(() => setShowConsecutiveTip(false), 2000);
  }, []);

  useEffect(() => {
    if (!showConsecutiveTip) return;
    const onDocClick = (e: MouseEvent) => {
      if (consecutiveBubbleRef.current && !consecutiveBubbleRef.current.contains(e.target as Node)) {
        setShowConsecutiveTip(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [showConsecutiveTip]);

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
      const newTheme = getTheme();
      if (newTheme !== theme) {
        setTheme(newTheme);
      }
    };

    checkTheme();
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme, getTheme]);

  const themeStyles = {
    bgPrimary: theme === 'dark' ? '#0f0f0f' : '#fff',
    bgPage: theme === 'dark' ? 'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(76, 175, 80, 0.06) 0%, transparent 50%), #0f0f0f' : '#fafbfc',
    bgCard: theme === 'dark' ? 'rgba(38, 39, 41, 0.8)' : '#fff',
    bgSecondary: theme === 'dark' ? '#262729' : '#f6f8fa',
    bgHover: theme === 'dark' ? '#3a3b3d' : '#f3f4f6',
    textPrimary: theme === 'dark' ? '#f0f0f0' : '#1a1a1a',
    textSecondary: theme === 'dark' ? '#9ca3af' : '#6b7280',
    textTertiary: theme === 'dark' ? '#6b7280' : '#9ca3af',
    border: theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    primary: theme === 'dark' ? '#22c55e' : '#16a34a',
    primaryGlow: theme === 'dark' ? 'rgba(34, 197, 94, 0.35)' : 'rgba(22, 163, 74, 0.25)',
    accent: theme === 'dark' ? '#38bdf8' : '#0ea5e9',
    accentGlow: theme === 'dark' ? 'rgba(56, 189, 248, 0.25)' : 'rgba(14, 165, 233, 0.2)',
    statNode: theme === 'dark' ? '#64b5f6' : '#2196F3',
    statCard: theme === 'dark' ? '#81c784' : '#4CAF50',
    statProblem: theme === 'dark' ? '#ffb74d' : '#FF9800',
  };

  const handleStart = useCallback(async () => {
    if (!domainId) return;
    if (todayLessonResumeUrl) {
      window.location.href = todayLessonResumeUrl;
      return;
    }
    try {
      const res: any = await request.post(`/d/${domainId}/learn/lesson/start`, { mode: 'today' });
      const redir = res?.redirect ?? res?.body?.redirect ?? res?.data?.redirect;
      if (redir) {
        window.location.href = redir;
        return;
      }
      if (res && res.success === false) {
        const msg =
          typeof res.error?.message === 'string' && res.error.message.trim()
            ? res.error.message
            : i18n('Learn today queue empty');
        Notification.error(msg);
        return;
      }
    } catch (e: any) {
      const msg =
        typeof e?.message === 'string' && e.message.trim()
          ? e.message
          : i18n('Learn today queue empty');
      Notification.error(msg);
      return;
    }
    Notification.error(i18n('Learn lesson start missing redirect'));
  }, [domainId, todayLessonResumeUrl]);

  const toggleDraftProblemTag = useCallback((tag: string) => {
    const t = normalizeProblemTagUi(tag);
    if (!t) return;
    setDraftTags((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else {
        if (next.size >= LEARN_PROBLEM_SESSION_TAG_LIMIT) return prev;
        next.add(t);
      }
      return [...next].sort((a, b) => a.localeCompare(b));
    });
  }, []);

  const openLearnPrefsModal = useCallback(() => {
    setDraftDailyGoal(goal);
    setDraftSessionMode(learnSessionMode);
    setDraftRatio(learnNewReviewRatio);
    setDraftOrder(learnNewReviewOrder);
    setDraftCardFilter(learnSessionCardFilter);
    setDraftTagMode(learnSessionProblemTagMode);
    setDraftTags([...learnSessionProblemTags]);
    setLearnPrefsOpen(true);
  }, [
    goal,
    learnSessionMode,
    learnNewReviewRatio,
    learnNewReviewOrder,
    learnSessionCardFilter,
    learnSessionProblemTagMode,
    learnSessionProblemTags,
  ]);

  const saveLearnPrefsModal = useCallback(async () => {
    if (!domainId || savingLearnPrefs) return;
    const goalChanged = draftDailyGoal !== goal;
    const modeChanged = draftSessionMode !== learnSessionMode;
    const ratioChanged = draftRatio !== learnNewReviewRatio;
    const orderChanged = draftOrder !== learnNewReviewOrder;
    const cardFilterChanged = draftCardFilter !== learnSessionCardFilter;
    const tagModeChanged = draftTagMode !== learnSessionProblemTagMode;
    const tagsChanged = !learnProblemTagsEqual(draftTags, learnSessionProblemTags);
    const subChanged = ratioChanged || orderChanged || cardFilterChanged || tagModeChanged || tagsChanged;
    if (!goalChanged && !modeChanged && !subChanged) {
      setLearnPrefsOpen(false);
      return;
    }
    setSavingLearnPrefs(true);
    try {
      if (goalChanged) {
        await request.post(`/d/${domainId}/learn/daily-goal`, { dailyGoal: draftDailyGoal });
      }
      if (modeChanged) {
        await request.post(`/d/${domainId}/learn/session-mode`, { learnSessionMode: draftSessionMode });
      }
      if (subChanged) {
        const body: Record<string, unknown> = {};
        if (ratioChanged) body.learnNewReviewRatio = draftRatio;
        if (orderChanged) body.learnNewReviewOrder = draftOrder;
        if (cardFilterChanged) body.learnSessionCardFilter = draftCardFilter;
        if (tagModeChanged) body.learnSessionProblemTagMode = draftTagMode;
        if (tagsChanged) body.learnSessionProblemTags = normalizeLearnProblemTagSelectionList(draftTags);
        await request.post(`/d/${domainId}/learn/sub-mode`, body);
      }
      window.location.reload();
    } catch (error: any) {
      console.error('Failed to save learn preferences:', error);
      const msg = error?.response?.data?.message ?? error?.response?.data?.error ?? error?.message
        ?? (learnSubModeStrings.failedSave || i18n('Failed to save daily goal'));
      Notification.error(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(' ') : String(msg)));
    } finally {
      setSavingLearnPrefs(false);
    }
  }, [
    domainId,
    savingLearnPrefs,
    draftDailyGoal,
    draftSessionMode,
    draftRatio,
    draftOrder,
    draftCardFilter,
    draftTagMode,
    draftTags,
    goal,
    learnSessionMode,
    learnNewReviewRatio,
    learnNewReviewOrder,
    learnSessionCardFilter,
    learnSessionProblemTagMode,
    learnSessionProblemTags,
    learnSubModeStrings.failedSave,
  ]);

  useEffect(() => {
    if (!learnPrefsOpen) return;
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !savingLearnPrefs) setLearnPrefsOpen(false);
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, [learnPrefsOpen, savingLearnPrefs]);

  const progressPercentage = totalProgress > 0 ? Math.round((currentProgress / totalProgress) * 100) : 0;

  const sidebarWidth = 220;
  const collapsedWidth = 36;

  const MOBILE_BREAKPOINT = 768;
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_BREAKPOINT);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const openLeftSidebar = () => { setLeftSidebarOpen(true); setRightSidebarOpen(false); };
    const openRightSidebar = () => { setRightSidebarOpen(true); setLeftSidebarOpen(false); };
    const leftEl = document.getElementById('header-mobile-extra-left');
    const rightEl = document.getElementById('header-mobile-extra');
    const leftWrap = leftEl ? (() => { const w = document.createElement('div'); leftEl.appendChild(w); return w; })() : null;
    const rightWrap = rightEl ? (() => { const w = document.createElement('div'); rightEl.appendChild(w); return w; })() : null;
    if (leftWrap) {
      ReactDOM.render(
        <button type="button" onClick={openLeftSidebar}>☰ {i18n('Completed cards')}</button>,
        leftWrap,
      );
    }
    if (rightWrap) {
      ReactDOM.render(
        <button type="button" onClick={openRightSidebar}>{i18n('Pending sections')} ☰</button>,
        rightWrap,
      );
    }
    return () => {
      if (leftWrap) { ReactDOM.unmountComponentAtNode(leftWrap); leftWrap.remove(); }
      if (rightWrap) { ReactDOM.unmountComponentAtNode(rightWrap); rightWrap.remove(); }
    };
  }, [isMobile]);

  return (
    <div style={{
      minHeight: isMobile ? '100dvh' : '100vh',
      background: themeStyles.bgPage,
      fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif',
      display: 'flex',
      flexDirection: 'row',
      position: 'relative',
    }}>
      {isMobile && leftSidebarOpen && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1001,
            backgroundColor: 'rgba(0,0,0,0.4)',
          }}
          onClick={() => setLeftSidebarOpen(false)}
        />
      )}
      {isMobile && rightSidebarOpen && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1001,
            backgroundColor: 'rgba(0,0,0,0.4)',
          }}
          onClick={() => setRightSidebarOpen(false)}
        />
      )}

      <aside style={{
        ...(isMobile
          ? {
              position: 'fixed' as const,
              left: 0,
              top: 0,
              bottom: 0,
              width: '280px',
              maxWidth: '85vw',
              zIndex: 1002,
              transform: leftSidebarOpen ? 'translateX(0)' : 'translateX(-100%)',
              transition: 'transform 0.2s ease',
              boxShadow: leftSidebarOpen ? (theme === 'dark' ? '4px 0 16px rgba(0,0,0,0.4)' : '4px 0 16px rgba(0,0,0,0.1)') : 'none',
              paddingTop: 'env(safe-area-inset-top, 0px)',
            }
          : {
              position: 'absolute' as const,
              left: 0,
              top: 0,
              bottom: 0,
              width: leftSidebarOpen ? sidebarWidth : collapsedWidth,
              transition: 'width 0.25s ease',
            }),
        display: 'flex',
        flexDirection: 'row',
        background: themeStyles.bgSecondary,
        borderRight: `1px solid ${themeStyles.border}`,
        overflow: 'hidden',
      }}>
        {leftSidebarOpen ? (
          <>
            <div style={{
              flex: 1,
              padding: isMobile ? '12px 16px 20px' : '20px 16px',
              overflowY: 'auto',
              minWidth: 0,
              WebkitOverflowScrolling: 'touch',
            } as React.CSSProperties}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '12px',
                paddingBottom: '8px',
                borderBottom: `1px solid ${themeStyles.border}`,
              }}>
                <span style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: themeStyles.textSecondary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>
                  {i18n('Completed cards')}
                </span>
                <button
                  type="button"
                  onClick={() => setLeftSidebarOpen(false)}
                  style={{
                    padding: isMobile ? '8px 12px' : '4px 8px',
                    minHeight: isMobile ? '44px' : undefined,
                    fontSize: '12px',
                    background: 'transparent',
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '6px',
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  {isMobile ? i18n('Close') : '×'}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {completedCardsToday.length === 0 ? (
                  <div style={{ fontSize: '13px', color: themeStyles.textTertiary, fontStyle: 'italic' }}>
                    {i18n('No completed cards')}
                  </div>
                ) : (
                  completedCardsToday.map((c) => (
                    <button
                      key={c.cardId}
                      type="button"
                      onClick={() => {
                        if (c.resultId) {
                          window.open(`/d/${domainId}/learn/lesson/result/${c.resultId}`, '_blank', 'noopener,noreferrer');
                        }
                      }}
                      style={{
                        padding: isMobile ? '14px 12px' : '10px 12px',
                        minHeight: isMobile ? '48px' : undefined,
                        fontSize: '14px',
                        color: themeStyles.textSecondary,
                        borderRadius: '8px',
                        background: themeStyles.bgPrimary,
                        border: `1px solid ${themeStyles.border}`,
                        cursor: c.resultId ? 'pointer' : 'default',
                        textAlign: 'left',
                        width: '100%',
                        transition: 'background 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        if (c.resultId) e.currentTarget.style.background = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = themeStyles.bgPrimary;
                      }}
                      title={c.resultId ? i18n('View result') : undefined}
                    >
                      <div style={{ fontWeight: 500, color: themeStyles.textPrimary }}>
                        {c.cardTitle || i18n('Unnamed Card')}
                      </div>
                      <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginTop: '4px' }}>
                        {c.nodeTitle ? `${c.nodeTitle} · ` : ''}
                        {c.completedAt
                          ? (() => {
                              const d = typeof c.completedAt === 'string' ? new Date(c.completedAt) : c.completedAt;
                              const pad = (n: number) => String(n).padStart(2, '0');
                              return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
                            })()
                          : ''}{' '}
                        ✓
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </>
        ) : !isMobile ? (
          <button
            type="button"
            onClick={() => setLeftSidebarOpen(true)}
            title={i18n('Completed cards')}
            style={{
              width: '100%',
              padding: '16px 0',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '18px',
              color: themeStyles.textSecondary,
              opacity: 0.7,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'opacity 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
          >
            →
          </button>
        ) : null}
      </aside>

      <main style={{
        flex: 1,
        minWidth: 0,
        padding: isMobile
          ? `24px max(12px, env(safe-area-inset-right, 0px)) max(32px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px))`
          : '32px 24px 48px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}>
      <div style={{
        maxWidth: viewMode === 'contributions' ? 720 : 520,
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
      }}>
        {(
          <div style={{
            padding: '12px 14px',
            borderRadius: '12px',
            border: `1px solid ${themeStyles.border}`,
            background: themeStyles.bgCard,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            flexWrap: 'wrap',
          }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginBottom: '2px' }}>
                {i18n('Current knowledge base (Learn)')}
              </div>
              <div style={{ fontSize: '14px', color: themeStyles.textPrimary, fontWeight: 600, wordBreak: 'break-word' }}>
                {selectedLearnBase
                  ? `${selectedLearnBase.title || String(selectedLearnBase.docId)} · ${learnBranchUi}`
                  : i18n('Pending selection')}
              </div>
            </div>
            <a
              href={`/d/${domainId}/learn/base/select?redirect=${encodeURIComponent(`/d/${domainId}/learn`)}`}
              style={{
                padding: '8px 12px',
                borderRadius: '8px',
                border: `1px solid ${themeStyles.border}`,
                color: themeStyles.textPrimary,
                textDecoration: 'none',
                background: themeStyles.bgSecondary,
                fontSize: '13px',
                whiteSpace: 'nowrap',
              }}
            >
              {i18n('Edit')}
            </a>
          </div>
        )}

        <div style={{
          display: 'flex',
          gap: '4px',
          padding: '4px',
          background: themeStyles.bgSecondary,
          borderRadius: '12px',
          border: `1px solid ${themeStyles.border}`,
        }}>
          <button
            type="button"
            onClick={() => setViewMode('progress')}
            style={{
              flex: 1,
              padding: isMobile ? '10px 8px' : '10px 12px',
              minHeight: isMobile ? '48px' : undefined,
              fontSize: isMobile ? '12px' : '14px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              background: viewMode === 'progress' ? themeStyles.bgCard : 'transparent',
              color: viewMode === 'progress' ? themeStyles.textPrimary : themeStyles.textSecondary,
              boxShadow: viewMode === 'progress' ? (theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.3)' : '0 2px 6px rgba(0,0,0,0.08)') : 'none',
              transition: 'all 0.2s',
            }}
          >
            {i18n('Learning Progress')}
          </button>
          <button
            type="button"
            onClick={() => setViewMode('path')}
            style={{
              flex: 1,
              padding: isMobile ? '10px 8px' : '10px 12px',
              minHeight: isMobile ? '48px' : undefined,
              fontSize: isMobile ? '12px' : '14px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              background: viewMode === 'path' ? themeStyles.bgCard : 'transparent',
              color: viewMode === 'path' ? themeStyles.textPrimary : themeStyles.textSecondary,
              boxShadow: viewMode === 'path' ? (theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.3)' : '0 2px 6px rgba(0,0,0,0.08)') : 'none',
              transition: 'all 0.2s',
            }}
          >
            {i18n('Learning Path')}
          </button>
          <button
            type="button"
            onClick={() => setViewMode('contributions')}
            style={{
              flex: 1,
              padding: isMobile ? '10px 8px' : '10px 12px',
              minHeight: isMobile ? '48px' : undefined,
              fontSize: isMobile ? '12px' : '14px',
              fontWeight: 600,
              border: 'none',
              borderRadius: '8px',
              cursor: 'pointer',
              background: viewMode === 'contributions' ? themeStyles.bgCard : 'transparent',
              color: viewMode === 'contributions' ? themeStyles.textPrimary : themeStyles.textSecondary,
              boxShadow: viewMode === 'contributions' ? (theme === 'dark' ? '0 2px 8px rgba(0,0,0,0.3)' : '0 2px 6px rgba(0,0,0,0.08)') : 'none',
              transition: 'all 0.2s',
            }}
          >
            {i18n('Learn tab learn wall')}
          </button>
        </div>

        {requireBaseSelection && viewMode !== 'contributions' ? (
          <div style={{
            padding: isMobile ? '20px 16px' : '24px',
            background: themeStyles.bgCard,
            borderRadius: '16px',
            border: `1px solid ${themeStyles.border}`,
            boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.06)',
          }}>
            <div style={{ fontSize: '16px', fontWeight: 600, color: themeStyles.textPrimary, marginBottom: '8px' }}>
              {i18n('Select a knowledge base before learning')}
            </div>
            <div style={{ fontSize: '13px', color: themeStyles.textSecondary, marginBottom: '16px' }}>
              {i18n('Choose a base and branch, then save to continue learning.')}
            </div>
            <a
              href={`/d/${domainId}/learn/base/select?redirect=${encodeURIComponent(`/d/${domainId}/learn`)}`}
              style={{
                display: 'inline-block',
                padding: '10px 16px',
                borderRadius: '10px',
                border: 'none',
                background: themeStyles.primary,
                color: '#fff',
                textDecoration: 'none',
              }}
            >
              {i18n('Select learn base')}
            </a>
          </div>
        ) : !requireBaseSelection && viewMode === 'progress' ? (
        <>
        <div style={{
          padding: isMobile ? '20px 16px' : '28px',
          background: themeStyles.bgCard,
          borderRadius: '20px',
          border: `1px solid ${themeStyles.border}`,
          boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.06)',
        }}>
          <div style={{ marginBottom: '24px' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '10px',
            }}>
              <span style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                {i18n('Total progress')}
              </span>
              <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.textPrimary }}>
                {currentProgress} / {totalProgress}
              </span>
            </div>
            <div style={{
              height: '12px',
              background: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
              borderRadius: '6px',
              overflow: 'hidden',
            }}>
              <div style={{
                width: `${progressPercentage}%`,
                height: '100%',
                background: `linear-gradient(90deg, ${themeStyles.primary} 0%, ${theme === 'dark' ? '#2dd47a' : '#22c55e'} 100%)`,
                borderRadius: '6px',
                transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                boxShadow: `0 0 12px ${themeStyles.primaryGlow}`,
              }} />
            </div>
            <div style={{ marginTop: '18px' }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '10px',
              }}>
                <span style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                  {i18n('Today progress')}
                </span>
                <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.textPrimary }}>
                  {todayCompletedCount} / {goal}
                </span>
              </div>
              <div style={{
                height: '12px',
                background: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
                borderRadius: '6px',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${goal > 0 ? Math.min(100, Math.round((todayCompletedCount / goal) * 100)) : 0}%`,
                  height: '100%',
                  background: `linear-gradient(90deg, ${themeStyles.accent} 0%, ${theme === 'dark' ? '#7dd3fc' : '#38bdf8'} 100%)`,
                  borderRadius: '6px',
                  transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
                  boxShadow: `0 0 12px ${themeStyles.accentGlow}`,
                }} />
              </div>
            </div>
          </div>

            {learnPrefsOpen && (
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="learn-prefs-modal-title"
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 10000,
                  background: 'rgba(0,0,0,0.45)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '16px',
                }}
                onClick={() => !savingLearnPrefs && setLearnPrefsOpen(false)}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: '100%',
                    maxWidth: '420px',
                    maxHeight: 'min(90vh, 640px)',
                    overflow: 'auto',
                    background: themeStyles.bgCard,
                    borderRadius: '16px',
                    border: `1px solid ${themeStyles.border}`,
                    boxShadow: theme === 'dark' ? '0 12px 48px rgba(0,0,0,0.55)' : '0 8px 32px rgba(0,0,0,0.12)',
                    padding: '20px',
                  }}
                >
                  <div
                    id="learn-prefs-modal-title"
                    style={{ fontSize: '16px', fontWeight: 600, color: themeStyles.textPrimary, marginBottom: '16px' }}
                  >
                    {learnSubModeStrings.sessionPreferences || i18n('Learn session preferences')}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label htmlFor="learn-prefs-daily-goal" style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                        {i18n('Daily Goal')}
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <input
                          id="learn-prefs-daily-goal"
                          type="number"
                          min={0}
                          value={draftDailyGoal}
                          disabled={savingLearnPrefs}
                          onChange={(e) => setDraftDailyGoal(Math.max(0, parseInt(e.target.value, 10) || 0))}
                          style={{
                            width: '72px',
                            padding: '8px 10px',
                            fontSize: '13px',
                            background: themeStyles.bgPrimary,
                            border: `1px solid ${themeStyles.border}`,
                            borderRadius: '8px',
                            color: themeStyles.textPrimary,
                          }}
                        />
                        <span style={{ fontSize: '13px', color: themeStyles.textSecondary }}>{i18n('cards')}</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label htmlFor="learn-prefs-session-mode" style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                        {i18n('Learn session mode')}
                      </label>
                      <select
                        id="learn-prefs-session-mode"
                        value={draftSessionMode}
                        disabled={savingLearnPrefs}
                        onChange={(e) => setDraftSessionMode(e.target.value as LearnSessionModeUi)}
                        style={{
                          padding: '8px 10px',
                          fontSize: '13px',
                          background: themeStyles.bgPrimary,
                          border: `1px solid ${themeStyles.border}`,
                          borderRadius: '8px',
                          color: themeStyles.textPrimary,
                          width: '100%',
                        }}
                      >
                        <option value="deep">{i18n('Deep learning mode')}</option>
                        <option value="breadth">{i18n('Breadth learning mode')}</option>
                        <option value="random">{i18n('Random learning mode')}</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label htmlFor="learn-prefs-card-filter" style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                        {i18n('Learn session card filter')}
                      </label>
                      <select
                        id="learn-prefs-card-filter"
                        value={draftCardFilter}
                        disabled={savingLearnPrefs}
                        onChange={(e) => setDraftCardFilter(normalizeLearnSessionCardFilterFromUi(e.target.value))}
                        style={{
                          padding: '8px 10px',
                          fontSize: '13px',
                          background: themeStyles.bgPrimary,
                          border: `1px solid ${themeStyles.border}`,
                          borderRadius: '8px',
                          color: themeStyles.textPrimary,
                          width: '100%',
                        }}
                      >
                        <option value="all">{i18n('Learn session card filter all')}</option>
                        <option value="with_problems">{i18n('Learn session card filter with problems')}</option>
                        <option value="without_problems">{i18n('Learn session card filter without problems')}</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label htmlFor="learn-prefs-problem-tag-mode" style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                        {i18n('Learn session problem tag filter')}
                      </label>
                      <select
                        id="learn-prefs-problem-tag-mode"
                        value={draftTagMode}
                        disabled={savingLearnPrefs}
                        onChange={(e) => setDraftTagMode(normalizeLearnSessionProblemTagModeFromUi(e.target.value))}
                        style={{
                          padding: '8px 10px',
                          fontSize: '13px',
                          background: themeStyles.bgPrimary,
                          border: `1px solid ${themeStyles.border}`,
                          borderRadius: '8px',
                          color: themeStyles.textPrimary,
                          width: '100%',
                        }}
                      >
                        <option value="off">{i18n('Learn session problem tag filter off')}</option>
                        <option value="include">{i18n('Learn session problem tag filter include')}</option>
                        <option value="exclude">{i18n('Learn session problem tag filter exclude')}</option>
                      </select>
                    </div>
                    {draftTagMode !== 'off' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <span style={{ fontSize: '12px', color: themeStyles.textTertiary }}>
                          {i18n('Learn session problem tag filter max hint', LEARN_PROBLEM_SESSION_TAG_LIMIT)}
                        </span>
                        <span style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                          {i18n('Learn session problem tag filter tags label')}
                        </span>
                        {tagOptionsForPicker.length === 0 ? (
                          <div style={{ fontSize: '12px', color: themeStyles.textTertiary, lineHeight: 1.45 }}>
                            {i18n('Learn session problem tag filter no tags in base')}
                          </div>
                        ) : (
                          <div
                            role="group"
                            aria-label={i18n('Learn session problem tag filter tags label')}
                            style={{
                              maxHeight: 'min(200px, 40vh)',
                              overflow: 'auto',
                              padding: '8px 10px',
                              border: `1px solid ${themeStyles.border}`,
                              borderRadius: '8px',
                              background: themeStyles.bgPrimary,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: '8px',
                            }}
                          >
                            {tagOptionsForPicker.map((tag) => (
                              <label
                                key={tag}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '10px',
                                  fontSize: '13px',
                                  color: themeStyles.textPrimary,
                                  cursor: savingLearnPrefs ? 'not-allowed' : 'pointer',
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={draftTags.includes(tag)}
                                  disabled={savingLearnPrefs
                                    || (!draftTags.includes(tag) && draftTags.length >= LEARN_PROBLEM_SESSION_TAG_LIMIT)}
                                  onChange={() => toggleDraftProblemTag(tag)}
                                />
                                <span>{tag}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label htmlFor="learn-prefs-ratio" style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                        {learnSubModeStrings.label || i18n('Learn ratio section label')}
                      </label>
                      <select
                        id="learn-prefs-ratio"
                        value={String(draftRatio)}
                        disabled={savingLearnPrefs}
                        onChange={(e) => setDraftRatio(normalizeLearnNewReviewRatioFromUi(e.target.value))}
                        aria-label={learnSubModeStrings.ratioAria || i18n('Learn new review ratio')}
                        style={{
                          padding: '8px 10px',
                          fontSize: '13px',
                          background: themeStyles.bgPrimary,
                          border: `1px solid ${themeStyles.border}`,
                          borderRadius: '8px',
                          color: themeStyles.textPrimary,
                          width: '100%',
                        }}
                      >
                        {LEARN_NEW_REVIEW_RATIO_UI_VALUES.map((n, i) => (
                          <option key={n} value={String(n)}>
                            {(learnSubModeStrings.ratioOptionLabels && learnSubModeStrings.ratioOptionLabels[i])
                              || (n === 0 ? i18n('New vs review ratio label new only')
                                : n === -1 ? i18n('New vs review ratio label review only')
                                  : i18n('New vs review ratio label', n))}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <label htmlFor="learn-prefs-order" style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                        {learnSubModeStrings.orderLabel || i18n('Learn new review order label')}
                      </label>
                      <select
                        id="learn-prefs-order"
                        value={draftOrder}
                        disabled={savingLearnPrefs}
                        onChange={(e) => setDraftOrder(normalizeLearnNewReviewOrderFromUi(e.target.value))}
                        aria-label={learnSubModeStrings.orderAria || i18n('Learn new review order aria')}
                        style={{
                          padding: '8px 10px',
                          fontSize: '13px',
                          background: themeStyles.bgPrimary,
                          border: `1px solid ${themeStyles.border}`,
                          borderRadius: '8px',
                          color: themeStyles.textPrimary,
                          width: '100%',
                        }}
                      >
                        <option value="new_first">
                          {learnSubModeStrings.orderOptionNewFirst || i18n('Learn new review order new first')}
                        </option>
                        <option value="old_first">
                          {learnSubModeStrings.orderOptionOldFirst || i18n('Learn new review order old first')}
                        </option>
                        <option value="shuffle">
                          {learnSubModeStrings.orderOptionShuffle || i18n('Learn new review order shuffle')}
                        </option>
                      </select>
                    </div>
                  </div>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: '10px',
                    marginTop: '20px',
                  }}>
                    <button
                      type="button"
                      disabled={savingLearnPrefs}
                      onClick={() => setLearnPrefsOpen(false)}
                      style={{
                        padding: '8px 14px',
                        fontSize: '13px',
                        background: 'transparent',
                        border: `1px solid ${themeStyles.border}`,
                        borderRadius: '8px',
                        color: themeStyles.textPrimary,
                        cursor: savingLearnPrefs ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {i18n('Cancel')}
                    </button>
                    <button
                      type="button"
                      disabled={savingLearnPrefs}
                      onClick={() => { void saveLearnPrefsModal(); }}
                      style={{
                        padding: '8px 14px',
                        fontSize: '13px',
                        background: themeStyles.primary,
                        border: 'none',
                        borderRadius: '8px',
                        color: '#fff',
                        cursor: savingLearnPrefs ? 'not-allowed' : 'pointer',
                        opacity: savingLearnPrefs ? 0.8 : 1,
                      }}
                    >
                      {savingLearnPrefs ? i18n('Saving...') : i18n('Save')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div style={{
            marginTop: '24px',
            paddingTop: '20px',
            borderTop: `1px solid ${themeStyles.border}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}>
            <div style={{
              position: 'relative',
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}>
              <div style={{
                position: 'relative',
                width: '56px',
                height: '56px',
                borderRadius: '50%',
                background: theme === 'dark' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(14, 165, 233, 0.12)',
                border: `2px solid ${theme === 'dark' ? 'rgba(56, 189, 248, 0.4)' : 'rgba(14, 165, 233, 0.3)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <span style={{ fontSize: '24px', fontWeight: 700, color: themeStyles.accent, lineHeight: 1 }}>
                  {totalCheckinDays}
                </span>
                <button
                  ref={consecutiveBubbleRef}
                  type="button"
                  onClick={handleConsecutiveBubbleClick}
                  style={{
                    position: 'absolute',
                    top: '-4px',
                    right: '-4px',
                    minWidth: '22px',
                    height: '22px',
                    padding: '0 6px',
                    borderRadius: '11px',
                    background: themeStyles.accent,
                    color: '#fff',
                    fontSize: '12px',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `2px solid ${themeStyles.bgCard}`,
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                  }}
                >
                  {consecutiveDays}
                  {showConsecutiveTip && (
                    <span
                      style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        marginBottom: '6px',
                        padding: '6px 10px',
                        fontSize: '12px',
                        color: themeStyles.textPrimary,
                        background: themeStyles.bgPrimary,
                        border: `1px solid ${themeStyles.border}`,
                        borderRadius: '8px',
                        whiteSpace: 'nowrap',
                        boxShadow: theme === 'dark' ? '0 4px 12px rgba(0,0,0,0.5)' : '0 2px 8px rgba(0,0,0,0.15)',
                        zIndex: 20,
                      }}
                    >
                      {i18n('Consecutive check-in days')}
                    </span>
                  )}
                </button>
              </div>
              <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginTop: '8px', fontWeight: 500 }}>
                {i18n('Total check-in days')}
              </div>
            </div>
          </div>
        </div>

        {hasTodayLessonResume && (
          <div
            style={{
              marginBottom: '12px',
              padding: '10px 14px',
              borderRadius: '12px',
              background: theme === 'dark' ? 'rgba(56, 189, 248, 0.12)' : 'rgba(14, 165, 233, 0.08)',
              border: `1px solid ${theme === 'dark' ? 'rgba(56, 189, 248, 0.25)' : 'rgba(14, 165, 233, 0.2)'}`,
              fontSize: '13px',
              color: themeStyles.textPrimary,
              lineHeight: 1.45,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '4px' }}>{i18n('Today daily lesson in progress')}</div>
            <div style={{ color: themeStyles.textSecondary, fontSize: '12px' }}>
              {todayLessonCardProgressText
                ? `${i18n('Progress')}: ${todayLessonCardProgressText}`
                : i18n('Tap below to resume')}
            </div>
          </div>
        )}

        <button
          onClick={handleStart}
          type="button"
          style={{
            padding: isMobile ? '16px 24px' : '18px 28px',
            minHeight: isMobile ? '52px' : undefined,
            fontSize: '16px',
            fontWeight: 600,
            background: themeStyles.primary,
            color: '#fff',
            border: 'none',
            borderRadius: '14px',
            cursor: 'pointer',
            width: '100%',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
            boxShadow: `0 4px 14px ${themeStyles.primaryGlow}`,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'translateY(-2px)';
            e.currentTarget.style.boxShadow = `0 6px 20px ${themeStyles.primaryGlow}`;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = `0 4px 14px ${themeStyles.primaryGlow}`;
          }}
        >
          {hasTodayLessonResume ? i18n('Continue Learning') : i18n('Start Learning')}
        </button>

        <a
          href={`/d/${domainId}/learn/section/edit?uid=${(window as any).UserContext?._id ?? ''}`}
          style={{
            display: 'block',
            textAlign: 'center',
            marginTop: '12px',
            fontSize: '14px',
            color: themeStyles.accent,
            textDecoration: 'none',
            opacity: 0.9,
            transition: 'opacity 0.2s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
          onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.9'; }}
        >
          {learnSubModeStrings.sectionOrderLink || i18n('Section Order')}
        </a>
        <button
          type="button"
          onClick={openLearnPrefsModal}
          disabled={savingLearnPrefs}
          style={{
            display: 'block',
            textAlign: 'center',
            marginTop: '8px',
            fontSize: '14px',
            color: themeStyles.accent,
            textDecoration: 'none',
            opacity: savingLearnPrefs ? 0.5 : 0.9,
            transition: 'opacity 0.2s',
            background: 'none',
            border: 'none',
            width: '100%',
            cursor: savingLearnPrefs ? 'not-allowed' : 'pointer',
            padding: 0,
            fontFamily: 'inherit',
          }}
          onMouseEnter={(e) => {
            if (!savingLearnPrefs) e.currentTarget.style.opacity = '1';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = savingLearnPrefs ? '0.5' : '0.9';
          }}
        >
          {learnSubModeStrings.sessionPreferences || i18n('Learn session preferences')}
        </button>
      </>
        ) : null}

        {viewMode === 'path' && pathListLen > 0 && (
          <div style={{
            padding: '8px 0',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {pathSectionsView.map((section, sectionIndex) => {
                const sectionCards = collectCardsUnder(section._id, pathSectionsView, pathFullDagView, new Set());
                // 节序里可复制同一合并根 id，必须用槽位下标区分「当前」；不能单靠 pathCurrentSectionId/_id。
                const hasValidCurrentIndex =
                  typeof currentSectionIndex === 'number'
                  && Number.isFinite(currentSectionIndex)
                  && currentSectionIndex >= 0
                  && currentSectionIndex < pathListLen;
                const isCurrentSection = hasValidCurrentIndex
                  ? sectionIndex === currentSectionIndex
                  : useTrainingPath && pathCurrentSectionId
                    ? section._id === pathCurrentSectionId
                      && sectionIndex === pathSectionsView.findIndex((s) => s._id === pathCurrentSectionId)
                    : typeof currentSectionIndex === 'number' && sectionIndex === currentSectionIndex;
                const startCardAnchorsThisSection =
                  !!pathCurrentLearnStartCardId
                  && isCurrentSection
                  && sectionCards.some((c) => String(c.cardId) === pathCurrentLearnStartCardId);
                const highlightSectionChrome = isCurrentSection && !startCardAnchorsThisSection;
                const isExpanded = expandedPathSectionSlots.has(sectionIndex);
                const toggleSection = () => {
                  setExpandedPathSectionSlots((prev) => {
                    const next = new Set(prev);
                    if (next.has(sectionIndex)) next.delete(sectionIndex);
                    else next.add(sectionIndex);
                    return next;
                  });
                };
                return (
                  <div
                    key={`learn-path-${sectionIndex}-${section._id}`}
                    style={{
                      background: themeStyles.bgCard,
                      borderRadius: '14px',
                      border: `1px solid ${highlightSectionChrome ? themeStyles.primary : themeStyles.border}`,
                      overflow: 'hidden',
                      boxShadow: theme === 'dark' ? '0 2px 12px rgba(0,0,0,0.3)' : '0 2px 8px rgba(0,0,0,0.06)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={toggleSection}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: isMobile ? '16px 14px' : '14px 18px',
                        minHeight: isMobile ? '52px' : undefined,
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        textAlign: 'left',
                        color: themeStyles.textPrimary,
                        fontSize: '15px',
                        fontWeight: 600,
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{
                          width: '28px',
                          height: '28px',
                          borderRadius: '50%',
                          background: highlightSectionChrome ? themeStyles.primary : themeStyles.bgSecondary,
                          color: highlightSectionChrome ? '#fff' : themeStyles.textSecondary,
                          fontSize: '13px',
                          fontWeight: 700,
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}>
                          {sectionIndex + 1}
                        </span>
                        {section.title || i18n('Unnamed Section')}
                        {highlightSectionChrome && (
                          <span style={{ fontSize: '12px', color: themeStyles.primary, fontWeight: 500 }}>
                            ({i18n('Current')})
                          </span>
                        )}
                      </span>
                      <span style={{ color: themeStyles.textSecondary, fontSize: '14px' }}>
                        {isExpanded ? '▼' : '▶'}
                      </span>
                    </button>
                    {isExpanded && sectionCards.length > 0 && (
                      <div style={{
                        padding: '0 18px 14px',
                        borderTop: `1px solid ${themeStyles.border}`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        marginTop: '4px',
                        paddingTop: '12px',
                      }}>
                        {sectionCards.map((card) => {
                          const cardIdStr = String(card.cardId);
                          const pathPlacementKey = `${sectionIndex}:${cardIdStr}`;
                          const pathCardLoopCountRaw = learnPathCardPractiseCounts[pathPlacementKey];
                          const pathCardLoopCount =
                            typeof pathCardLoopCountRaw === 'number' && Number.isFinite(pathCardLoopCountRaw)
                              ? pathCardLoopCountRaw
                              : 0;
                          const pathCardPassed = passedCardKeysSet.has(pathPlacementKey)
                            || passedLegacyCardIdsSet.has(cardIdStr);
                          const isLearnStartCard = isCurrentSection && !!pathCurrentLearnStartCardId
                            && cardIdStr === pathCurrentLearnStartCardId;
                          const problemCount = card.problemCount ?? (card.problems?.length ?? 0);
                          const problems = card.problems ?? [];
                          const isCardExpanded = expandedPathCardIds.has(pathPlacementKey);
                          const cardAriaBase = card.title || i18n('Unnamed Card');
                          const cardAria = [
                            cardAriaBase,
                            pathCardPassed ? i18n('Done') : '',
                            isLearnStartCard ? i18n('Current') : '',
                          ].filter(Boolean).join(', ');
                          return (
                            <div key={pathPlacementKey} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <button
                                type="button"
                                title={
                                  pathCardPassed
                                    ? i18n('Done')
                                    : isLearnStartCard
                                      ? i18n('Current')
                                      : undefined
                                }
                                aria-label={cardAria}
                                onClick={(e) => { e.stopPropagation(); togglePathCardExpand(pathPlacementKey); }}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '8px',
                                  padding: isMobile ? '12px 14px' : '8px 12px',
                                  minHeight: isMobile ? '48px' : undefined,
                                  fontSize: '13px',
                                  fontWeight: 500,
                                  color: themeStyles.textPrimary,
                                  background: themeStyles.bgSecondary,
                                  border: isLearnStartCard
                                    ? `2px solid ${themeStyles.primary}`
                                    : `1px solid ${pathCardPassed ? themeStyles.primary : themeStyles.border}`,
                                  borderLeft: isLearnStartCard
                                    ? `4px solid ${themeStyles.primary}`
                                    : pathCardPassed
                                      ? `4px solid ${themeStyles.primary}`
                                      : undefined,
                                  borderRadius: '10px',
                                  opacity: pathCardPassed && !isLearnStartCard ? 0.88 : 1,
                                  cursor: 'pointer',
                                  textAlign: 'left',
                                  width: '100%',
                                  transition: 'all 0.2s',
                                }}
                                onMouseEnter={(e) => {
                                  e.currentTarget.style.background = themeStyles.bgHover;
                                }}
                                onMouseLeave={(e) => {
                                  e.currentTarget.style.background = themeStyles.bgSecondary;
                                }}
                              >
                                <span style={{ flex: 1, display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                                  {card.title || i18n('Unnamed Card')}
                                  {isLearnStartCard && (
                                    <span style={{ fontSize: '12px', color: themeStyles.primary, fontWeight: 600 }}>
                                      ({i18n('Current')})
                                    </span>
                                  )}
                                </span>
                                {pathCardPassed && (
                                  <span
                                    style={{
                                      fontSize: '11px',
                                      fontWeight: 700,
                                      color: themeStyles.primary,
                                      flexShrink: 0,
                                    }}
                                    aria-hidden
                                  >
                                    ✓
                                  </span>
                                )}
                                <span
                                  title={learnSubModeStrings.pathCardLoopCountTitle || i18n('Learn path card loop count title')}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    minWidth: '22px',
                                    height: '22px',
                                    padding: '0 8px',
                                    fontSize: '11px',
                                    fontWeight: 600,
                                    color: themeStyles.textSecondary,
                                    backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                                    border: `1px solid ${themeStyles.border}`,
                                    borderRadius: '11px',
                                    flexShrink: 0,
                                  }}
                                >
                                  {(learnSubModeStrings.pathCardLoopCountFmt ?? '×{0}').replace(
                                    /\{0\}/g,
                                    String(pathCardLoopCount),
                                  )}
                                </span>
                                {problemCount > 0 && (
                                  <span style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    minWidth: '22px',
                                    height: '22px',
                                    padding: '0 8px',
                                    fontSize: '12px',
                                    fontWeight: 600,
                                    color: themeStyles.accent,
                                    backgroundColor: theme === 'dark' ? 'rgba(56, 189, 248, 0.2)' : 'rgba(14, 165, 233, 0.15)',
                                    border: `1px solid ${themeStyles.accent}`,
                                    borderRadius: '11px',
                                  }}>
                                    {problemCount}
                                  </span>
                                )}
                                <span style={{ color: themeStyles.textSecondary, fontSize: '12px' }}>
                                  {isCardExpanded ? '▼' : '▶'}
                                </span>
                              </button>
                              {isCardExpanded && problems.length > 0 && (
                                <div style={{
                                  marginLeft: '12px',
                                  paddingLeft: '12px',
                                  borderLeft: `2px solid ${themeStyles.border}`,
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '6px',
                                }}>
                                  {problems.map((p, idx) => (
                                    <div
                                      key={idx}
                                      style={{
                                        padding: '8px 10px',
                                        fontSize: '12px',
                                        color: themeStyles.textSecondary,
                                        background: themeStyles.bgPrimary,
                                        borderRadius: '6px',
                                        lineHeight: 1.5,
                                      }}
                                    >
                                      <span style={{ color: themeStyles.textTertiary, marginRight: '6px' }}>{idx + 1}.</span>
                                      {p.stem || i18n('Unnamed question')}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {viewMode === 'contributions' && (
          <div style={{
            padding: isMobile ? '16px 14px' : '20px 18px',
            background: themeStyles.bgCard,
            borderRadius: 16,
            border: `1px solid ${themeStyles.border}`,
            boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.35)' : '0 2px 12px rgba(0,0,0,0.06)',
          }}
          >
            <h2 style={{
              fontSize: 15,
              fontWeight: 600,
              color: themeStyles.textPrimary,
              margin: '0 0 10px',
            }}
            >
              {i18n('Learn domain learn wall')}
            </h2>
            <ContributionWall
              contributions={learnWallContributions}
              theme={theme}
              contributionDetails={learnWallContributionDetails as Record<string, ContributionDetail[]>}
              onDateClick={(d) => setSelectedLearnWallDate(d)}
              pastYearCaption={i18n('Learn domain learn wall caption')}
              compact
            />
            {selectedLearnWallDate && learnWallContributionDetails[selectedLearnWallDate]?.[0] ? (
              <div style={{
                marginTop: 18,
                padding: 16,
                background: themeStyles.bgSecondary,
                borderRadius: 10,
                border: `1px solid ${themeStyles.border}`,
              }}
              >
                <h3 style={{ fontSize: 14, fontWeight: 700, color: themeStyles.textPrimary, margin: '0 0 12px' }}>
                  {i18n('Contributions on {0}', moment(selectedLearnWallDate).format('YYYY-MM-DD'))}
                </h3>
                {(() => {
                  const row = learnWallContributionDetails[selectedLearnWallDate]![0]!;
                  const hasCounts = row.nodes > 0 || row.cards > 0 || row.problems > 0;
                  return (
                    <>
                      {row.checkedIn ? (
                        <div style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: themeStyles.primary,
                          marginBottom: 10,
                        }}
                        >
                          {i18n('Learn wall checked in')}
                        </div>
                      ) : null}
                      <div style={{
                        display: 'flex',
                        gap: 16,
                        flexWrap: 'wrap',
                        fontSize: 13,
                        color: themeStyles.textSecondary,
                        marginBottom: 12,
                      }}
                      >
                        {row.nodes > 0 ? (
                          <span>
                            <span style={{ color: themeStyles.statNode, fontWeight: 700 }}>{row.nodes}</span>
                            {' '}
                            {i18n('nodes')}
                          </span>
                        ) : null}
                        {row.cards > 0 ? (
                          <span>
                            <span style={{ color: themeStyles.statCard, fontWeight: 700 }}>{row.cards}</span>
                            {' '}
                            {i18n('cards')}
                          </span>
                        ) : null}
                        {row.problems > 0 ? (
                          <span>
                            <span style={{ color: themeStyles.statProblem, fontWeight: 700 }}>{row.problems}</span>
                            {' '}
                            {i18n('problems')}
                          </span>
                        ) : null}
                        {!hasCounts && !row.checkedIn ? (
                          <span style={{ color: themeStyles.textTertiary }}>{i18n('No contributions')}</span>
                        ) : null}
                        {!hasCounts && row.checkedIn ? (
                          <span style={{ color: themeStyles.textTertiary }}>{i18n('Learn wall checkin only saves')}</span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: themeStyles.textPrimary, marginBottom: 8 }}>
                        {i18n('Learn wall sessions')}
                      </div>
                      {(row.sessions && row.sessions.length > 0) ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {(row.sessions || []).map((se) => (
                            <div
                              key={se.sessionId}
                              style={{
                                padding: '10px 12px',
                                borderRadius: 8,
                                border: `1px solid ${themeStyles.border}`,
                                background: themeStyles.bgCard,
                              }}
                            >
                              <a
                                href={se.sessionHistoryUrl}
                                style={{
                                  fontWeight: 600,
                                  color: themeStyles.accent,
                                  textDecoration: 'none',
                                  fontSize: 13,
                                  display: 'inline-block',
                                }}
                              >
                                {selectedLearnWallDate
                                  ? (se.timeUtc
                                      ? `${moment(selectedLearnWallDate).format('YYYY-MM-DD')} ${se.timeUtc} UTC`
                                      : `${moment(selectedLearnWallDate).format('YYYY-MM-DD')} UTC`)
                                  : (se.timeUtc ? `${se.timeUtc} UTC` : '')}
                              </a>
                              <div style={{
                                marginTop: 6,
                                fontSize: 12,
                                color: themeStyles.textSecondary,
                                lineHeight: 1.45,
                              }}
                              >
                                {se.statusLabel}
                                {se.progressText ? ` · ${se.progressText}` : ''}
                              </div>
                              <div style={{
                                marginTop: 4,
                                fontSize: 12,
                                color: themeStyles.textTertiary,
                              }}
                              >
                                {i18n('Learn wall session record count', se.recordCount)}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: themeStyles.textTertiary }}>{i18n('Learn wall no sessions')}</div>
                      )}
                    </>
                  );
                })()}
                <button
                  type="button"
                  onClick={() => setSelectedLearnWallDate(null)}
                  style={{
                    marginTop: 14,
                    padding: '6px 12px',
                    fontSize: 12,
                    borderRadius: 8,
                    border: `1px solid ${themeStyles.border}`,
                    background: themeStyles.bgCard,
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  {i18n('Close')}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      </main>

      <aside style={{
        ...(isMobile
          ? {
              position: 'fixed' as const,
              right: 0,
              top: 0,
              bottom: 0,
              width: '280px',
              maxWidth: '85vw',
              zIndex: 1002,
              transform: rightSidebarOpen ? 'translateX(0)' : 'translateX(100%)',
              transition: 'transform 0.2s ease',
              boxShadow: rightSidebarOpen ? (theme === 'dark' ? '-4px 0 16px rgba(0,0,0,0.4)' : '-4px 0 16px rgba(0,0,0,0.1)') : 'none',
              paddingTop: 'env(safe-area-inset-top, 0px)',
            }
          : {
              position: 'absolute' as const,
              right: 0,
              top: 0,
              bottom: 0,
              width: rightSidebarOpen ? sidebarWidth : collapsedWidth,
              transition: 'width 0.25s ease',
              zIndex: 10,
            }),
        display: 'flex',
        flexDirection: 'row',
        background: themeStyles.bgCard,
        borderLeft: `1px solid ${themeStyles.border}`,
        overflow: 'hidden',
      }}>
        {rightSidebarOpen ? (
          <>
            <div style={{
              flex: 1,
              padding: isMobile ? '12px 16px 20px' : '20px 16px',
              overflowY: 'auto',
              minWidth: 0,
              WebkitOverflowScrolling: 'touch',
            } as React.CSSProperties}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '12px',
                paddingBottom: '8px',
                borderBottom: `1px solid ${themeStyles.border}`,
              }}>
                <span style={{
                  fontSize: '12px',
                  fontWeight: 600,
                  color: themeStyles.textSecondary,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>
                  {i18n('Pending sections')}
                </span>
                <button
                  type="button"
                  onClick={() => setRightSidebarOpen(false)}
                  style={{
                    padding: isMobile ? '8px 12px' : '4px 8px',
                    minHeight: isMobile ? '44px' : undefined,
                    fontSize: '12px',
                    background: 'transparent',
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '6px',
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  {isMobile ? i18n('Close') : '×'}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {pendingNodeList.length === 0 ? (
                  <div style={{ fontSize: '13px', color: themeStyles.textTertiary, fontStyle: 'italic' }}>
                    {i18n('No pending sections')}
                  </div>
                ) : (
                  pendingNodeList.map((node) => {
                    const nodeKey = `${String(node._id)}-${node.orderIndex}`;
                    const isNodeExpanded = expandedNodeIds.has(nodeKey);
                    return (
                      <div
                        key={nodeKey}
                        style={{
                          borderRadius: '8px',
                          background: themeStyles.bgPrimary,
                          border: `1px solid ${themeStyles.border}`,
                          overflow: 'hidden',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => toggleNodeExpand(nodeKey)}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: isMobile ? '14px 12px' : '10px 12px',
                            minHeight: isMobile ? '48px' : undefined,
                            fontSize: '14px',
                            fontWeight: 500,
                            color: themeStyles.textPrimary,
                            background: 'transparent',
                            border: 'none',
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          <span style={{ flexShrink: 0, color: themeStyles.textSecondary, fontSize: '12px' }}>
                            {node.orderIndex}.
                          </span>
                          <span style={{ flex: 1 }}>{node.title}</span>
                          <span style={{ fontSize: '12px', color: themeStyles.textTertiary }}>
                            {isNodeExpanded ? '▼' : '▶'}
                          </span>
                        </button>
                        {isNodeExpanded && node.cards && node.cards.length > 0 && (
                          <div style={{ padding: '0 12px 8px', borderTop: `1px solid ${themeStyles.border}` }}>
                            {node.cards.map((card, cardIndex) => {
                              const cardNumber = `${node.orderIndex}.${cardIndex + 1}`;
                              const cardKey = `${nodeKey}-${String(card.cardId)}`;
                              const isCardExpanded = expandedCardIds.has(cardKey);
                              const problems = card.problems || [];
                              return (
                                <div
                                  key={cardKey}
                                  style={{
                                    marginTop: '6px',
                                    padding: '6px 8px',
                                    background: themeStyles.bgSecondary,
                                    borderRadius: '6px',
                                  }}
                                >
                                  <button
                                    type="button"
                                    onClick={() => toggleCardStems(cardKey)}
                                    style={{
                                      width: '100%',
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '6px',
                                      padding: 0,
                                      fontSize: '13px',
                                      color: themeStyles.textPrimary,
                                      background: 'transparent',
                                      border: 'none',
                                      cursor: 'pointer',
                                      textAlign: 'left',
                                    }}
                                  >
                                    <span style={{ flexShrink: 0, color: themeStyles.textSecondary, fontSize: '12px' }}>
                                      {cardNumber}.
                                    </span>
                                    <span style={{ flex: 1 }}>{card.title}</span>
                                    {problems.length > 0 && (
                                      <span style={{ color: themeStyles.textTertiary, fontSize: '11px' }}>
                                        {isCardExpanded ? '▼' : '▶'}
                                      </span>
                                    )}
                                  </button>
                                  {isCardExpanded && problems.length > 0 && (
                                    <div style={{ marginTop: '6px', fontSize: '12px', color: themeStyles.textSecondary, whiteSpace: 'pre-wrap' }}>
                                      {problems.map((p, idx) => {
                                        const problemNumber = `${cardNumber}.${idx + 1}`;
                                        return (
                                          <div key={idx} style={{ marginBottom: '4px' }}>
                                            <span style={{ color: themeStyles.textTertiary, marginRight: '6px' }}>{problemNumber}.</span>
                                            {p.stem || ''}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        ) : !isMobile ? (
          <button
            type="button"
            onClick={() => setRightSidebarOpen(true)}
            title={i18n('Pending sections')}
            style={{
              width: '100%',
              padding: '16px 0',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: '18px',
              color: themeStyles.textSecondary,
              opacity: 0.7,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'opacity 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.7'; }}
          >
            ←
          </button>
        ) : null}
      </aside>
    </div>
  );
}

const page = new NamedPage('learnPage', async () => {
  try {
    const container = document.getElementById('learn-container');
    if (!container) {
      return;
    }
    ReactDOM.render(<LearnPage />, container);
  } catch (error: any) {
    console.error('Failed to render learn page:', error);
  }
});

export default page;
