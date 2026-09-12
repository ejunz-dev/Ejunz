import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Problem } from 'ejun/src/interface';
import { getProblemAuthorNoteList, getProblemTagList, problemKind } from 'ejun/src/model/problem';
import { usePageData } from '../../context/page-data';
import { useNavigate } from '../../context/router';
import { i18n } from '../../i18n';
import { useBuildUrl } from '../../hooks/use-build-url';
import Notification from '../notification';
import { renderMarkdown } from '../base-detail/markdown';
import { requestJson } from '../base-detail/base-detail-api';
import { useNavigationActions } from '../navigation/context';
import { fetchLessonSnapshot, navigateLessonCard, passLessonCard, readLessonSnapshot } from './lesson-api';
import { LessonProblem, type LessonGrading } from './LessonProblem';
import { LessonNotesPanel } from './LessonNotesPanel';
import { LessonTagPanel } from './LessonTagPanel';
import type { LessonAnswerRecord, LessonCard, LessonSnapshot } from './types';
import './lesson.css';

interface QueueItem {
  pid: string;
  problem: Problem;
}

interface SessionProblem extends QueueItem {
  cardId: string;
  orderIndex: number;
}

interface SessionGroup {
  cardId: string;
  title: string;
  index: number;
  isCurrent: boolean;
  isDone: boolean;
  inReview: boolean;
  timeText: string;
  problems: SessionProblem[];
}

function isLessonPageUrl(url: string): boolean {
  if (!url.includes('/learn/lesson')) return false;
  return !url.includes('/learn/lesson/result') && !url.includes('/learn/lesson/node-result');
}

function withOverrides(problem: Problem, overrides: Record<string, Problem>): Problem {
  return overrides[String(problem.pid || '')] || problem;
}

function lessonCardKey(snapshot: LessonSnapshot | null): string {
  return String(snapshot?.card?.docId || '');
}

function problemKindLabel(problem: Problem): string {
  switch (problemKind(problem)) {
    case 'multi': return i18n('Problem kind multi');
    case 'true_false': return i18n('Problem kind true false');
    case 'flip': return i18n('Problem kind flip');
    case 'fill_blank': return i18n('Problem kind fill blank');
    case 'matching': return i18n('Problem kind matching');
    case 'super_flip': return i18n('Problem kind super flip');
    case 'chain': return i18n('Problem kind chain');
    case 'ai_eval': return i18n('Problem kind ai eval');
    default: return i18n('Problem kind single');
  }
}

function problemPreview(problem: Problem): string {
  const raw = String(problem.title || '').trim()
    || String((problem as { stem?: string }).stem || (problem as { faceA?: string }).faceA || '').trim();
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/[#*_`>]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '—';
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function ProgressBar({ label, done, total, unit, tone }: {
  label: string;
  done: number;
  total: number;
  unit: string;
  tone: 'session' | 'total' | 'card';
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className={`lesson-bar lesson-bar--${tone}`}>
      <div className="lesson-bar__label">{label}</div>
      <div className="lesson-bar__value">{done} / {total} {unit} · {pct}%</div>
      <div className="lesson-bar__track">
        <div className="lesson-bar__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ProblemRow({ item, isCurrent, isCleared }: { item: SessionProblem; isCurrent: boolean; isCleared: boolean }) {
  return (
    <div className={`lesson-row${isCurrent ? ' is-current' : ''}${isCleared ? ' is-cleared' : ''}`}>
      <div className="lesson-row__head">
        <span className="lesson-row__index">#{item.orderIndex + 1}</span>
        <span className="lesson-row__kind">{problemKindLabel(item.problem)}</span>
        {isCleared ? <span className="lesson-row__check" aria-hidden>✓</span> : null}
      </div>
      <div className="lesson-row__preview">{problemPreview(item.problem)}</div>
    </div>
  );
}

export default function LessonApp() {
  const { args } = usePageData();
  const navigate = useNavigate();
  const buildUrl = useBuildUrl();
  const [lesson, setLesson] = useState<LessonSnapshot | null>(() => readLessonSnapshot(args));
  const [loading, setLoading] = useState(() => !readLessonSnapshot(args));
  const [errorText, setErrorText] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [problemIndex, setProblemIndex] = useState(0);
  const [history, setHistory] = useState<LessonAnswerRecord[]>([]);
  const [attempts, setAttempts] = useState<Record<string, number>>({});
  const [pendingAdvance, setPendingAdvance] = useState<'next' | 'requeue' | null>(null);
  const [round, setRound] = useState(0);
  const [passing, setPassing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [sessionStats, setSessionStats] = useState({ cards: 0, problems: 0, correct: 0 });
  const [clearedPids, setClearedPids] = useState<Record<string, boolean>>({});
  const [cardTimes, setCardTimes] = useState<number[]>([]);
  const [cardNavBusy, setCardNavBusy] = useState(false);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [notesPanelOpen, setNotesPanelOpen] = useState(false);
  const [learnerNoteCounts, setLearnerNoteCounts] = useState<Record<string, number>>({});
  const [tagRegistry, setTagRegistry] = useState<string[]>([]);
  const [problemOverrides, setProblemOverrides] = useState<Record<string, Problem>>({});
  const [departed, setDeparted] = useState<QueueItem[]>([]);
  const [departedGrading, setDepartedGrading] = useState<Record<string, LessonGrading>>({});
  const [reviewOffset, setReviewOffset] = useState(0);
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const cardStartedAtRef = useRef(Date.now());
  const problemStartedAtRef = useRef(Date.now());
  const queueCardIdRef = useRef('');

  const domainId = String(
    lesson?.lessonSessionDomainId
    || lesson?.domainId
    || args?.domainId
    || args?.UiContext?.domainId
    || 'system',
  );
  const cardId = lessonCardKey(lesson);
  const card = lesson?.card || null;
  const problems = useMemo(() => (card?.problems || []) as Problem[], [card]);
  const hasProblems = problems.length > 0;
  const queueReady = Boolean(cardId) && queueCardIdRef.current === cardId;
  const current = queue[problemIndex] || null;
  const flatCards = useMemo(() => lesson?.flatCards || [], [lesson]);
  const currentCardIndex = lesson?.currentCardIndex ?? 0;
  const reviewCardIds = useMemo(() => lesson?.lessonReviewCardIds || [], [lesson]);
  const isLastCard = !flatCards.length || currentCardIndex + 1 >= flatCards.length;
  const isReviewCard = Boolean(cardId) && reviewCardIds.includes(cardId);
  const backUrl = lesson?.lessonSourceUrl?.trim()
    || buildUrl('base_domain', { domainId: lesson?.domainId || domainId });

  useEffect(() => {
    setTagRegistry(lesson?.lessonProblemTagOptions ? [...lesson.lessonProblemTagOptions] : []);
  }, [lesson?.lessonProblemTagOptions]);

  useEffect(() => {
    const snapshot = readLessonSnapshot(args);
    if (!snapshot) return;
    setLesson(snapshot);
    setFinished(false);
    setErrorText(null);
  }, [args]);

  useEffect(() => {
    if (lesson) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    const sessionParam = new URLSearchParams(window.location.search).get('session') || undefined;
    void (async () => {
      try {
        const snapshot = await fetchLessonSnapshot(domainId, sessionParam);
        if (cancelled) return;
        if (!snapshot) {
          setErrorText(i18n('Lesson session not found'));
          return;
        }
        setLesson(snapshot);
      } catch (error: any) {
        if (!cancelled) setErrorText(typeof error?.message === 'string' ? error.message : String(error ?? ''));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [lesson, domainId]);

  useEffect(() => {
    if (!cardId) return;
    queueCardIdRef.current = cardId;
    setQueue(problems.map((problem) => ({ pid: String(problem.pid || ''), problem: withOverrides(problem, problemOverrides) })));
    setProblemIndex(0);
    setHistory([]);
    setAttempts({});
    setPendingAdvance(null);
    setDeparted([]);
    setDepartedGrading({});
    setReviewOffset(0);
    setNotesPanelOpen(false);
    cardStartedAtRef.current = Date.now();
    problemStartedAtRef.current = Date.now();
  }, [cardId, problems, problemOverrides]);

  useEffect(() => {
    problemStartedAtRef.current = Date.now();
  }, [current?.pid]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const cardsById = useMemo(() => {
    const map = new Map<string, LessonCard>();
    for (const item of lesson?.flatQueueCards || []) map.set(String(item.docId), item);
    for (const item of lesson?.cards || []) if (!map.has(String(item.docId))) map.set(String(item.docId), item);
    if (lesson?.card) map.set(String(lesson.card.docId), lesson.card);
    return map;
  }, [lesson]);

  const nowMs = useMemo(() => Date.now(), [clockTick]);

  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const order = flatCards.length
      ? flatCards.map((item) => String(item.cardId))
      : (card ? [String(card.docId)] : []);
    let orderIndex = 0;
    return order.map((id, index) => {
      const doc = cardsById.get(id);
      const items: SessionProblem[] = ((doc?.problems || []) as Problem[]).map((problem) => {
        const resolved = withOverrides(problem, problemOverrides);
        return {
          pid: String(resolved.pid || ''),
          problem: resolved,
          cardId: id,
          orderIndex: orderIndex++,
        };
      });
      const inReview = reviewCardIds.includes(id);
      const isCurrent = index === currentCardIndex;
      const isDone = index < currentCardIndex && !inReview;
      const storedMs = cardTimes[index];
      const elapsed = isCurrent ? nowMs - cardStartedAtRef.current : storedMs;
      return {
        cardId: id,
        title: String(doc?.title || flatCards[index]?.cardTitle || i18n('Unnamed Card')),
        index,
        isCurrent,
        isDone,
        inReview,
        timeText: typeof elapsed === 'number' ? formatSeconds(elapsed) : '—',
        problems: items,
      };
    });
  }, [flatCards, cardsById, card, currentCardIndex, reviewCardIds, cardTimes, nowMs, problemOverrides]);

  const sessionProblems = useMemo(
    () => sessionGroups.flatMap((group) => group.problems),
    [sessionGroups],
  );

  const isProblemDone = useCallback((item: SessionProblem) => {
    if (clearedPids[item.pid]) return true;
    return Boolean(sessionGroups.find((group) => group.cardId === item.cardId)?.isDone);
  }, [clearedPids, sessionGroups]);

  const doneProblems = useMemo(() => sessionProblems.filter(isProblemDone), [sessionProblems, isProblemDone]);
  const doneProblemPids = useMemo(() => new Set(doneProblems.map((item) => item.pid)), [doneProblems]);

  const sessionCardDone = useMemo(
    () => flatCards.filter((item, index) => index < currentCardIndex && !reviewCardIds.includes(String(item.cardId))).length,
    [flatCards, currentCardIndex, reviewCardIds],
  );
  const currentGroup = sessionGroups.find((group) => group.index === currentCardIndex) || null;
  const currentCardProblems = currentGroup?.problems || [];
  const currentCardDone = currentCardProblems.filter((item) => doneProblemPids.has(item.pid)).length;

  const handleNoteCountChange = useCallback((pid: string, count: number) => {
    setLearnerNoteCounts((prev) => (prev[pid] === count ? prev : { ...prev, [pid]: count }));
  }, []);

  const closeDrawers = useCallback(() => {
    setLeftOpen(false);
    setRightOpen(false);
  }, []);

  const passCard = useCallback(async (options: { noImpression?: boolean } = {}) => {
    if (!lesson || passing) return;
    setPassing(true);
    try {
      const response = await passLessonCard({
        domainId,
        sessionId: lesson.lessonSessionId,
        cardId,
        answerHistory: history,
        totalTime: Math.max(0, Date.now() - cardStartedAtRef.current),
        isTodayMode: Boolean(lesson.isTodayMode),
        isSingleNodeMode: Boolean(lesson.isSingleNodeMode),
        nodeId: lesson.rootNodeId,
        noImpression: (lesson.isSingleNodeMode || lesson.isAlonePractice) ? options.noImpression : undefined,
      });
      setSessionStats((prev) => ({
        cards: prev.cards + 1,
        problems: prev.problems + history.length,
        correct: prev.correct + history.filter((entry) => entry.correct).length,
      }));
      const elapsed = Math.max(0, Date.now() - cardStartedAtRef.current);
      setCardTimes((prev) => {
        const next = [...prev];
        next[currentCardIndex] = elapsed;
        return next;
      });
      setClearedPids((prev) => {
        const next = { ...prev };
        for (const item of problems) next[String(item.pid || '')] = true;
        return next;
      });
      const next = readLessonSnapshot(response);
      if (next) {
        setLesson(next);
        return;
      }
      const redirect = String(response?.redirect || '').trim();
      if (redirect && isLessonPageUrl(redirect)) {
        await navigate(redirect);
        return;
      }
      setFinished(true);
    } catch (error: any) {
      Notification.error(typeof error?.message === 'string' ? error.message : i18n('Lesson card navigation failed'));
    } finally {
      setPassing(false);
    }
  }, [lesson, passing, domainId, cardId, history, navigate, currentCardIndex, problems]);

  useEffect(() => {
    if (!lesson || finished || passing || pendingAdvance) return;
    if (!queueReady || !hasProblems || queue.length > 0) return;
    void passCard();
  }, [lesson, finished, passing, pendingAdvance, queueReady, hasProblems, queue.length, passCard]);

  const handleGraded = useCallback((result: LessonGrading) => {
    const item = queue[problemIndex];
    if (!item) return;
    const spent = Math.max(0, Date.now() - problemStartedAtRef.current);
    const nextAttempts = (attempts[item.pid] || 0) + 1;
    setAttempts((prev) => ({ ...prev, [item.pid]: nextAttempts }));
    setPendingAdvance(result.correct ? 'next' : 'requeue');
    if (!result.correct) return;
    setClearedPids((prev) => ({ ...prev, [item.pid]: true }));
    setDepartedGrading((prev) => ({ ...prev, [item.pid]: result }));
    setHistory((prev) => {
      const existing = prev.findIndex((entry) => entry.problemId === item.pid && entry.correct);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = {
          ...updated[existing],
          selected: result.selected,
          timeSpent: updated[existing].timeSpent + spent,
          attempts: nextAttempts,
          ...(result.fillAnswers ? { fillAnswers: result.fillAnswers } : {}),
        };
        return updated;
      }
      return [...prev, {
        problemId: item.pid,
        cardId,
        selected: result.selected,
        correct: true,
        timeSpent: spent,
        attempts: nextAttempts,
        ...(result.fillAnswers ? { fillAnswers: result.fillAnswers } : {}),
      }];
    });
  }, [queue, problemIndex, attempts, cardId]);

  const handleSkipProblem = useCallback(() => {
    const item = queue[problemIndex];
    if (!item) return;
    setPendingAdvance(null);
    setRound((prev) => prev + 1);
    setReviewOffset(0);
    setQueue((prev) => prev.filter((entry) => entry.pid !== item.pid));
    setDeparted((stack) => [...stack, item]);
    setProblemIndex((prev) => (prev < queue.length - 1 ? prev : 0));
  }, [queue, problemIndex]);

  const handlePreviousProblem = useCallback(() => {
    if (departed.length > reviewOffset) {
      setReviewOffset(reviewOffset + 1);
      return;
    }
    if (reviewOffset === 0 && problemIndex > 0) {
      setProblemIndex(problemIndex - 1);
    }
  }, [departed.length, reviewOffset, problemIndex]);

  const handleSkipProblemBrowse = useCallback(() => {
    if (reviewOffset > 0) {
      setReviewOffset(reviewOffset - 1);
      return;
    }
    if (problemIndex + 1 < queue.length) setProblemIndex(problemIndex + 1);
  }, [reviewOffset, problemIndex, queue.length]);

  const handleRedoProblem = useCallback(() => {
    const item = queue[problemIndex];
    if (!item) return;
    setHistory((prev) => prev.filter((entry) => entry.problemId !== item.pid));
    setClearedPids((prev) => {
      const next = { ...prev };
      delete next[item.pid];
      return next;
    });
    setAttempts((prev) => {
      const next = { ...prev };
      delete next[item.pid];
      return next;
    });
    setDeparted((prev) => prev.filter((entry) => entry.pid !== item.pid));
    setDepartedGrading((prev) => {
      const next = { ...prev };
      delete next[item.pid];
      return next;
    });
    setPendingAdvance(null);
    setReviewOffset(0);
    setRound((prev) => prev + 1);
  }, [queue, problemIndex]);

  const handleContinue = useCallback(() => {
    const advance = pendingAdvance;
    if (!advance) return;
    setPendingAdvance(null);
    setRound((prev) => prev + 1);
    setQueue((prev) => {
      const next = [...prev];
      if (advance === 'requeue') {
        const [removed] = next.splice(problemIndex, 1);
        if (removed) next.push(removed);
      } else {
        const [removed] = next.splice(problemIndex, 1);
        if (removed) setDeparted((stack) => [...stack, removed]);
      }
      return next;
    });
    setReviewOffset(0);
    const nextLength = advance === 'requeue' ? queue.length : queue.length - 1;
    setProblemIndex((prev) => (nextLength <= 0 ? 0 : (prev < nextLength ? prev : 0)));
  }, [pendingAdvance, problemIndex, queue.length]);

  const { setMobileNavActions } = useNavigationActions();
  useEffect(() => {
    setMobileNavActions(
      [{ id: 'lesson-completed', label: i18n('Lesson practice sidebar completed'), icon: '✓', onClick: () => { setRightOpen(false); setLeftOpen(true); } }],
      [{ id: 'lesson-queue', label: i18n('Lesson problem queue'), icon: '☰', onClick: () => { setLeftOpen(false); setRightOpen(true); } }],
    );
    return () => setMobileNavActions([], []);
  }, [setMobileNavActions]);

  const handleExit = useCallback(() => {
    void navigate(backUrl);
  }, [navigate, backUrl]);

  const handleCardNav = useCallback(async (action: 'prev' | 'skip') => {
    if (!lesson || cardNavBusy) return;
    setCardNavBusy(true);
    try {
      const response = await navigateLessonCard({
        domainId,
        sessionId: lesson.lessonSessionId,
        action,
        isTodayMode: Boolean(lesson.isTodayMode),
        isSingleNodeMode: Boolean(lesson.isSingleNodeMode),
        nodeId: lesson.rootNodeId,
      });
      const next = readLessonSnapshot(response);
      if (next) {
        setLesson(next);
        return;
      }
      const redirect = String(response?.redirect || '').trim();
      if (redirect && isLessonPageUrl(redirect)) {
        await navigate(redirect);
      }
    } catch (error: any) {
      Notification.error(typeof error?.message === 'string' ? error.message : i18n('Lesson card navigation failed'));
    } finally {
      setCardNavBusy(false);
    }
  }, [lesson, cardNavBusy, domainId, navigate]);

  const modeLabel = useMemo(() => {
    if (lesson?.isTodayMode && lesson?.rootNodeId === 'today') return i18n('Today task');
    if (lesson?.isTodayMode) return i18n('Today session');
    if (lesson?.isSingleNodeMode) return i18n('Single-node session');
    if (lesson?.isAlonePractice) return i18n('Single-card session');
    return i18n('Learn session');
  }, [lesson]);

  const reviewedItemTitleSource = reviewOffset > 0 ? departed[departed.length - reviewOffset] || null : null;
  const shownProblemForTitle = reviewedItemTitleSource ? reviewedItemTitleSource.problem : (current?.problem || null);
  const currentProblemTitle = useMemo(() => {
    if (!shownProblemForTitle) return '';
    const title = String(shownProblemForTitle.title || '').trim();
    if (title) return title;
    const preview = problemPreview(shownProblemForTitle);
    return preview === '—' ? '' : preview;
  }, [shownProblemForTitle]);

  const reviewedItem = reviewOffset > 0 ? departed[departed.length - reviewOffset] || null : null;
  const shownProblem = reviewedItem ? reviewedItem.problem : (current?.problem || null);
  const reviewedGrading = reviewedItem ? (departedGrading[reviewedItem.pid] || null) : null;
  const canGoPrevious = departed.length > reviewOffset || (reviewOffset === 0 && problemIndex > 0);
  const canBrowseNext = reviewOffset > 0 || problemIndex + 1 < queue.length;

  useEffect(() => {
    const pid = shownProblemForTitle ? String(shownProblemForTitle.pid || '') : '';
    if (!pid || !cardId) return undefined;
    if (Object.prototype.hasOwnProperty.call(learnerNoteCounts, pid)) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await requestJson<{ learnerNotes?: unknown[] }>(
          `/learn/problem-notes?cardId=${encodeURIComponent(cardId)}&pid=${encodeURIComponent(pid)}`,
          { domainId, acceptJson: true },
        );
        if (cancelled) return;
        const count = Array.isArray(response?.learnerNotes) ? response.learnerNotes.length : 0;
        setLearnerNoteCounts((prev) => ({ ...prev, [pid]: count }));
      } catch {
        if (!cancelled) setLearnerNoteCounts((prev) => ({ ...prev, [pid]: 0 }));
      }
    })();
    return () => { cancelled = true; };
  }, [shownProblemForTitle, cardId, domainId, learnerNoteCounts]);

  const shownNoteCount = useMemo(() => {
    if (!shownProblem) return 0;
    const pid = String(shownProblem.pid || '');
    return getProblemAuthorNoteList(shownProblem).length + (learnerNoteCounts[pid] ?? 0);
  }, [shownProblem, learnerNoteCounts]);

  const currentProblemTags = useMemo(
    () => (shownProblem ? getProblemTagList(shownProblem) : []),
    [shownProblem],
  );
  const currentTagGroups = useMemo(() => {
    const parents: string[] = [];
    const children = new Map<string, string[]>();
    for (const tag of currentProblemTags) {
      const slash = tag.indexOf('/');
      if (slash > 0) {
        const parent = tag.slice(0, slash);
        children.set(parent, [...(children.get(parent) || []), tag.slice(slash + 1)]);
      } else if (!parents.includes(tag)) {
        parents.push(tag);
      }
    }
    for (const parent of children.keys()) if (!parents.includes(parent)) parents.push(parent);
    return { parents, children };
  }, [currentProblemTags]);

  const showInlineCardNav = Boolean(
    lesson && (lesson.isSingleNodeMode || lesson.isTodayMode)
    && lesson.lessonSessionId && !lesson.reviewCardId && flatCards.length > 0,
  );

  if (loading && !lesson) {
    return <div className="lesson-page"><p className="lesson-page__status">{i18n('Loading...')}</p></div>;
  }

  if (!lesson || !card) {
    return (
      <div className="lesson-page">
        <p className="lesson-page__status">{errorText || i18n('Lesson session not found')}</p>
        <button type="button" className="lesson-btn" onClick={handleExit}>{i18n('Back to Learn')}</button>
      </div>
    );
  }

  if (finished) {
    const accuracy = sessionStats.problems > 0
      ? Math.round((sessionStats.correct / sessionStats.problems) * 100)
      : 0;
    return (
      <div className="lesson-page lesson-page--finished">
        <h1 className="lesson-page__title">{i18n('Lesson Passed')}</h1>
        <p className="lesson-page__status">{i18n('Congratulations! You have completed all practice questions correctly.')}</p>
        <dl className="lesson-finished__stats">
          <div><dt>{i18n('Completed cards')}</dt><dd>{sessionStats.cards}</dd></div>
          <div><dt>{i18n('Lesson progress total problems')}</dt><dd>{sessionStats.problems}</dd></div>
          <div><dt>{i18n('Accuracy')}</dt><dd>{accuracy}%</dd></div>
        </dl>
        <div className="lesson-problem__actions">
          <button type="button" className="lesson-btn lesson-btn--lg is-primary" onClick={handleExit}>{i18n('Back to Learn')}</button>
        </div>
      </div>
    );
  }

  const renderGroup = (group: SessionGroup, items: SessionProblem[], showCleared: boolean) => (
    <div className="lesson-group" key={`group-${group.cardId}`}>
      <div className={`lesson-group__head${group.isCurrent ? ' is-current' : ''}${group.isDone ? ' is-done' : ''}${group.inReview ? ' is-review' : ''}`}>
        <span className="lesson-group__title">
          {group.isDone ? <span aria-hidden>✓ </span> : null}
          {group.inReview ? <em className="lesson-group__review">{i18n('Review')}</em> : null}
          <span>{group.title}</span>
        </span>
        <span className="lesson-group__time">{group.timeText}</span>
      </div>
      <div className="lesson-group__rows">
        {items.map((item) => (
          <ProblemRow
            key={`${group.cardId}-${item.pid}`}
            item={item}
            isCurrent={current?.pid === item.pid}
            isCleared={showCleared && doneProblemPids.has(item.pid)}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="lesson-shell">
      {(leftOpen || rightOpen) ? (
        <button type="button" className="lesson-scrim" aria-label={i18n('Close')} onClick={closeDrawers} />
      ) : null}

      <aside className={`lesson-aside lesson-aside--left${leftOpen ? ' is-open' : ''}`} aria-label={i18n('Lesson practice sidebar completed')}>
        <div className="lesson-aside__head">
          <span className="lesson-aside__title">{i18n('Lesson practice sidebar completed')}</span>
          <span className="lesson-aside__count is-done">{doneProblems.length}</span>
        </div>
        {sessionGroups.map((group) => {
          const items = group.problems.filter((item) => doneProblemPids.has(item.pid));
          if (!items.length) return null;
          return renderGroup(group, items, true);
        })}
      </aside>

      <main className="lesson-main">
        <div className="lesson-bars">
          <div className="lesson-bars__mode">
            <div className="lesson-bars__mode-label">{i18n('Session type')}</div>
            <div className="lesson-bars__mode-line">
              <span className="lesson-bars__mode-name">{modeLabel}</span>
              {lesson.rootNodeTitle ? (
                <>
                  <span className="lesson-bars__dot" aria-hidden>·</span>
                  {lesson.lessonSourceUrl?.trim() ? (
                    <a className="lesson-bars__mode-link" href={lesson.lessonSourceUrl} target="_blank" rel="noreferrer">{lesson.rootNodeTitle}</a>
                  ) : (
                    <span className="lesson-bars__mode-link is-plain">{lesson.rootNodeTitle}</span>
                  )}
                </>
              ) : null}
              {lesson.lessonFilterSummary?.trim() ? (
                <>
                  <span className="lesson-bars__dot" aria-hidden>·</span>
                  <span className="lesson-bars__mode-muted">{lesson.lessonFilterSummary}</span>
                </>
              ) : null}
              {lesson.lessonTodayCardKindLabel ? (
                <>
                  <span className="lesson-bars__dot" aria-hidden>·</span>
                  <span className="lesson-bars__mode-link is-plain">{lesson.lessonTodayCardKindLabel}</span>
                </>
              ) : null}
            </div>
            {lesson.lessonTodayModesConfigLine ? (
              <div className="lesson-bars__mode-hint">{lesson.lessonTodayModesConfigLine}</div>
            ) : null}
          </div>
          {flatCards.length > 0 ? (
            <ProgressBar
              label={i18n('Lesson progress session cards')}
              done={sessionCardDone}
              total={flatCards.length}
              unit={i18n('cards')}
              tone="session"
            />
          ) : null}
          {sessionProblems.length > 0 ? (
            <ProgressBar
              label={i18n('Lesson progress total problems')}
              done={doneProblems.length}
              total={sessionProblems.length}
              unit={i18n('Lesson practice progress unit')}
              tone="total"
            />
          ) : null}
          {currentCardProblems.length > 0 ? (
            <ProgressBar
              label={i18n('Lesson progress current card problems')}
              done={currentCardDone}
              total={currentCardProblems.length}
              unit={i18n('Lesson practice progress unit')}
              tone="card"
            />
          ) : null}
        </div>

        {current ? (
          <section className="lesson-practice" aria-live="polite">
            <div className="lesson-practice__head">
              <span className="lesson-practice__badge">{isReviewCard ? i18n('Review') : i18n('New card')}</span>
              <span className="lesson-practice__provenance" title={lesson.lessonCardProvenanceLabel}>
                {lesson.lessonCardProvenanceLabel || card.title || i18n('Unnamed Card')}
              </span>
              {showInlineCardNav ? (
                <>
                  <button
                    type="button"
                    className="lesson-practice__nav"
                    disabled={cardNavBusy || currentCardIndex <= 0}
                    onClick={() => void handleCardNav('prev')}
                  >
                    {i18n('Previous card')}
                  </button>
                  <button
                    type="button"
                    className="lesson-practice__nav"
                    disabled={cardNavBusy}
                    onClick={() => void handleCardNav('skip')}
                  >
                    {i18n('Skip card')}
                  </button>
                </>
              ) : null}
            </div>
            <div className="lesson-practice__title">
              <span className="lesson-practice__ordinal">{i18n('Problem')} {Math.min(problemIndex + 1, queue.length)} / {queue.length}</span>
              {currentProblemTitle ? <span className="lesson-practice__name">{currentProblemTitle}</span> : null}
              <button type="button" className="lesson-tag-edit" onClick={() => setTagPanelOpen(true)}>
                {i18n('Problem tags edit')}
              </button>
              <button
                type="button"
                className="lesson-notes-open"
                aria-label={i18n('Lesson problem notes panel title')}
                onClick={() => setNotesPanelOpen(true)}
              >
                {i18n('Lesson problem notes count badge', shownNoteCount)}
              </button>
            </div>
            {currentProblemTags.length ? (
              <div className="lesson-tag-row">
                {currentTagGroups.parents.map((parent) => {
                  const children = currentTagGroups.children.get(parent) || [];
                  return (
                    <span className="lesson-tag-group" key={parent}>
                      <span className="lesson-tag">{parent}</span>
                      {children.map((child) => (
                        <span className="lesson-tag lesson-tag--child" key={`${parent}/${child}`}>{child}</span>
                      ))}
                    </span>
                  );
                })}
              </div>
            ) : null}
            {reviewedItem ? (
              <p className="lesson-practice__review">{i18n('Lesson review answered problem')}</p>
            ) : null}
            <LessonProblem
              key={`${shownProblem ? shownProblem.pid : ''}-${round}-${reviewOffset}`}
              problem={(shownProblem || current.problem)}
              domainId={domainId}
              locked={Boolean(reviewedItem) || pendingAdvance !== null}
              preview={reviewedGrading}
              onGraded={handleGraded}
              onSkip={handleSkipProblem}
            />
            <div className="lesson-practice__footer">
              <div className="lesson-practice__actions">
                <button
                  type="button"
                  className="lesson-btn"
                  disabled={!canGoPrevious || passing}
                  onClick={handlePreviousProblem}
                >
                  {i18n('Previous')}
                </button>
                <button
                  type="button"
                  className="lesson-btn"
                  disabled={!canBrowseNext || passing}
                  onClick={handleSkipProblemBrowse}
                >
                  {i18n('Lesson skip problem action')}
                </button>
                <button
                  type="button"
                  className="lesson-btn"
                  disabled={Boolean(reviewedItem) || passing}
                  onClick={handleRedoProblem}
                >
                  {i18n('Lesson practice redo')}
                </button>
              </div>
              {reviewedItem ? (
                <button
                  type="button"
                  className="lesson-btn lesson-btn--lg is-primary"
                  onClick={() => setReviewOffset(0)}
                >
                  {i18n('Lesson review back to current')}
                </button>
              ) : (
                <button
                  type="button"
                  className="lesson-btn lesson-btn--lg is-primary"
                  disabled={pendingAdvance === null || passing}
                  onClick={handleContinue}
                >
                  {pendingAdvance === 'requeue'
                    ? i18n('Continue')
                    : (queue.length <= 1 ? i18n('Next Card') : i18n('Next'))}
                </button>
              )}
            </div>
          </section>
        ) : (
          <section className="lesson-practice lesson-practice--browse">
            <div className="lesson-practice__head">
              <span className="lesson-practice__badge">{isReviewCard ? i18n('Review') : i18n('New card')}</span>
              <span className="lesson-practice__provenance">{lesson.lessonCardProvenanceLabel || card.title || i18n('Unnamed Card')}</span>
            </div>
            <h2 className="lesson-practice__card-title">{card.title || i18n('Unnamed Card')}</h2>
            {card.content?.trim() ? (
              <div className="lesson-markdown lesson-practice__card-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.content) }} />
            ) : null}
            <p className="lesson-page__status">{i18n('Lesson browse card hint')}</p>
            <div className="lesson-problem__actions">
              <button
                type="button"
                className="lesson-btn lesson-btn--lg is-primary"
                disabled={passing}
                onClick={() => void passCard({ noImpression: false })}
              >
                {isLastCard ? i18n('Lesson Passed') : i18n('Know it')}
              </button>
              <button
                type="button"
                className="lesson-btn lesson-btn--lg"
                disabled={passing}
                onClick={() => void passCard({ noImpression: true })}
              >
                {i18n('Not familiar')}
              </button>
            </div>
          </section>
        )}
      </main>

      <aside className={`lesson-aside lesson-aside--right${rightOpen ? ' is-open' : ''}`} aria-label={i18n('Lesson problem queue')}>
        <div className="lesson-aside__head">
          <span className="lesson-aside__title">{i18n('Lesson problem queue')}</span>
          <span className="lesson-aside__count is-pending">{sessionProblems.length - doneProblems.length}/{sessionProblems.length}</span>
        </div>
        {sessionGroups.map((group) => {
          const items = group.problems.filter((item) => !doneProblemPids.has(item.pid));
          if (!items.length) return null;
          return renderGroup(group, items, false);
        })}
        {doneProblems.length === sessionProblems.length ? (
          <p className="lesson-aside__empty">{i18n('No pending sections')}</p>
        ) : null}
      </aside>

      <LessonNotesPanel
        open={notesPanelOpen}
        problem={shownProblem}
        cardId={cardId}
        domainId={domainId}
        onCountChange={handleNoteCountChange}
        onClose={() => setNotesPanelOpen(false)}
      />

      <LessonTagPanel
        open={tagPanelOpen}
        problem={shownProblem}
        cardId={cardId}
        cardProblems={problems}
        domainId={domainId}
        baseDocId={Number(lesson.baseDocId) || 0}
        registry={tagRegistry}
        canEdit={Boolean(lesson.lessonCanEditProblemTags)}
        onClose={() => setTagPanelOpen(false)}
        onRegistryChange={setTagRegistry}
        onProblemsChange={(nextProblems) => {
          setProblemOverrides((prev) => {
            const next = { ...prev };
            for (const item of nextProblems) next[String(item.pid || '')] = item;
            return next;
          });
          setQueue((prev) => prev.map((item) => (
            nextProblems.some((entry) => String(entry.pid || '') === item.pid)
              ? { ...item, problem: nextProblems.find((entry) => String(entry.pid || '') === item.pid) as Problem }
              : item
          )));
        }}
      />
    </div>
  );
}
