import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Problem } from 'ejun/src/interface';
import { usePageData } from '../../context/page-data';
import { useNavigate } from '../../context/router';
import { i18n } from '../../i18n';
import { useBuildUrl } from '../../hooks/use-build-url';
import Notification from '../notification';
import { renderMarkdown } from '../base-detail/markdown';
import { fetchLessonSnapshot, passLessonCard, readLessonSnapshot } from './lesson-api';
import { LessonProblem, type LessonGrading } from './LessonProblem';
import type { LessonAnswerRecord, LessonSnapshot } from './types';
import './lesson.css';

interface QueueItem {
  pid: string;
  problem: Problem;
}

/** Lesson URLs that render this page again; result routes end the session instead. */
function isLessonPageUrl(url: string): boolean {
  if (!url.includes('/learn/lesson')) return false;
  return !url.includes('/learn/lesson/result') && !url.includes('/learn/lesson/node-result');
}

function lessonCardKey(snapshot: LessonSnapshot | null): string {
  return String(snapshot?.card?.docId || '');
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
  // Bumped when a problem is presented again, so a requeued problem starts empty
  // while an answered problem keeps its own feedback until the learner advances.
  const [round, setRound] = useState(0);
  const [passing, setPassing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [sessionStats, setSessionStats] = useState({ cards: 0, problems: 0, correct: 0 });
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
  const isLastCard = !lesson?.flatCards?.length || (lesson?.currentCardIndex ?? 0) + 1 >= (lesson?.flatCards?.length ?? 0);
  const cardTotal = lesson?.flatCards?.length ?? 0;
  const cardPosition = (lesson?.currentCardIndex ?? 0) + 1;
  const cardPercent = cardTotal > 0 ? Math.round((cardPosition / cardTotal) * 100) : 0;
  const isReviewCard = Boolean(cardId) && (lesson?.lessonReviewCardIds || []).includes(cardId);
  const backUrl = lesson?.lessonSourceUrl?.trim()
    || buildUrl('base_domain', { domainId: lesson?.domainId || domainId });

  // Client-side navigation to another lesson URL delivers fresh page args.
  useEffect(() => {
    const snapshot = readLessonSnapshot(args);
    if (!snapshot) return;
    setLesson(snapshot);
    setFinished(false);
    setErrorText(null);
  }, [args]);

  // Deep links carry no page args; ask the session API for the current card.
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

  // A new card resets the problem queue, the per-card answer history and the timer.
  useEffect(() => {
    if (!cardId) return;
    queueCardIdRef.current = cardId;
    setQueue(problems.map((problem) => ({ pid: String(problem.pid || ''), problem })));
    setProblemIndex(0);
    setHistory([]);
    setAttempts({});
    setPendingAdvance(null);
    cardStartedAtRef.current = Date.now();
    problemStartedAtRef.current = Date.now();
  }, [cardId, problems]);

  useEffect(() => {
    problemStartedAtRef.current = Date.now();
  }, [current?.pid]);

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
  }, [lesson, passing, domainId, cardId, history, navigate]);

  // Every problem of the card was answered correctly: submit the card.
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
    setQueue((prev) => prev.filter((entry) => entry.pid !== item.pid));
    setProblemIndex((prev) => (prev < queue.length - 1 ? prev : 0));
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
        next.splice(problemIndex, 1);
      }
      return next;
    });
    const nextLength = advance === 'requeue' ? queue.length : queue.length - 1;
    setProblemIndex((prev) => (nextLength <= 0 ? 0 : (prev < nextLength ? prev : 0)));
  }, [pendingAdvance, problemIndex, queue.length]);

  const handleExit = useCallback(() => {
    void navigate(backUrl);
  }, [navigate, backUrl]);

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

  return (
    <div className="lesson-page">
      <header className="lesson-header">
        <div className="lesson-header__topline">
          <a className="lesson-header__back" href={backUrl}>← {i18n('All Bases')}</a>
          <div className="lesson-header__actions">
            <button type="button" className="lesson-btn" onClick={handleExit}>{i18n('Exit')}</button>
          </div>
        </div>
        <h1 className="lesson-header__title">{lesson.rootNodeTitle || lesson.node?.title || card.title || i18n('Unnamed Card')}</h1>
        {lesson.lessonCardProvenanceLabel ? (
          <p className="lesson-header__provenance">{lesson.lessonCardProvenanceLabel}</p>
        ) : null}
        <div
          className="lesson-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={cardPercent}
          aria-label={i18n('Lesson progress session cards')}
        >
          <div className="lesson-progress__bar" style={{ width: `${cardPercent}%` }} />
        </div>
        <div className="lesson-header__meta">
          {lesson.flatCards?.length ? (
            <span className="lesson-chip">
              {i18n('Lesson progress session cards')} {(lesson.currentCardIndex ?? 0) + 1}/{lesson.flatCards.length}
            </span>
          ) : null}
          {isReviewCard ? <span className="lesson-chip is-review">{i18n('Review')}</span> : null}
          {lesson.lessonTodayCardKindLabel ? <span className="lesson-chip">{lesson.lessonTodayCardKindLabel}</span> : null}
          {lesson.lessonSessionQueueNewOldLabel ? <span className="lesson-chip">{lesson.lessonSessionQueueNewOldLabel}</span> : null}
        </div>
      </header>

      <main className="lesson-main">
        <section className="lesson-card">
          <h2 className="lesson-card__title">{card.title || i18n('Unnamed Card')}</h2>
          {card.content?.trim() ? (
            <details className="lesson-card__content">
              <summary>{i18n('Content')}</summary>
              <div className="lesson-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.content) }} />
            </details>
          ) : null}
        </section>

        {current ? (
          <section className="lesson-practice" aria-live="polite">
            <p className="lesson-problem__ordinal">
              {i18n('Problem')} {Math.min(problemIndex + 1, queue.length)} / {queue.length}
            </p>
            <LessonProblem
              key={`${current.pid}-${round}`}
              problem={current.problem}
              domainId={domainId}
              locked={pendingAdvance !== null}
              onGraded={handleGraded}
              onSkip={handleSkipProblem}
            />
            <div className="lesson-practice__footer">
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
            </div>
          </section>
        ) : (
          <section className="lesson-practice lesson-practice--browse">
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
    </div>
  );
}
