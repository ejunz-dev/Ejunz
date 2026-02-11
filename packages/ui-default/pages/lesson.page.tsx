import React, { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';

// 与 base outline 相同的缓存 key 和图片 Cache 名，便于复用 base 的缓存
const BASE_OUTLINE_CARD_CACHE_PREFIX = 'base-outline-card-';
const BASE_OUTLINE_IMAGES_CACHE_NAME = 'base-outline-images-v1';

interface Problem {
  pid: string;
  type: 'single';
  stem: string;
  options: string[];
  answer: number;
  analysis?: string;
}

interface Card {
  docId: string;
  title: string;
  content: string;
  problems?: Problem[];
  updateAt?: string;
}

interface Node {
  id: string;
  text: string;
}

function LessonPage() {
  const card = (window.UiContext?.card || {}) as Card;
  const node = (window.UiContext?.node || {}) as Node;
  const cards = (window.UiContext?.cards || []) as Card[];
  const currentIndex = (window.UiContext?.currentIndex || 0) as number;
  const domainId = (window.UiContext?.domainId || '') as string;
  const baseDocId = (window.UiContext?.baseDocId || '') as string;
  const isAlonePractice = (window.UiContext?.isAlonePractice || false) as boolean;
  const isSingleNodeMode = (window.UiContext?.isSingleNodeMode || false) as boolean;
  const isTodayMode = (window.UiContext?.isTodayMode || false) as boolean;
  const hasProblems = (window.UiContext?.hasProblems ?? false) as boolean;
  const rootNodeId = (window.UiContext?.rootNodeId || '') as string;
  const rootNodeTitle = (window.UiContext?.rootNodeTitle || '') as string;
  const flatCards = ((window.UiContext?.flatCards || []) as Array<{ nodeId: string; cardId: string; nodeTitle: string; cardTitle: string }>);
  const nodeTree = ((window.UiContext?.nodeTree || []) as Array<{
    type: 'node';
    id: string;
    title: string;
    children: Array<{ type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }>;
  }>);
  const currentCardIndex = (window.UiContext?.currentCardIndex ?? 0) as number;
  const lessonReviewCardIds = ((window.UiContext?.lessonReviewCardIds || []) as string[]);

  const cardIdToFlatIndex = useMemo(() => {
    const m: Record<string, number> = {};
    flatCards.forEach((item, idx) => {
      m[String(item.cardId)] = idx;
    });
    return m;
  }, [flatCards]);

  const [renderedContent, setRenderedContent] = useState<string>('');
  const imageCacheRef = useRef<Cache | null>(null);

  // 与 base outline 共用图片 Cache API
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

  // 使用 base 的缓存：有缓存则用，无缓存则请求并写入缓存（与 base outline 一致）
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

    // 无缓存：请求 /markdown 后写入缓存（与 base 一致）
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

  const allProblems = useMemo(() => {
    return (card.problems || []).map(p => ({ ...p, cardId: card.docId }));
  }, [card]);

  const [problemQueue, setProblemQueue] = useState<Array<Problem & { cardId: string }>>(allProblems);
  const [currentProblemIndex, setCurrentProblemIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [isPassed, setIsPassed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);
  const hasCalledPassRef = useRef(false);
  const [answerHistory, setAnswerHistory] = useState<Array<{ problem: Problem & { cardId: string }; selected: number; correct: boolean; timeSpent: number; attempts: number }>>([]);
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

  useEffect(() => {
    if (allProblems.length > 0 && problemQueue.length === 0 && answerHistory.length === 0) {
      setProblemQueue(allProblems);
      setCurrentProblemIndex(0);
      setSelectedAnswer(null);
      setIsAnswered(false);
      setShowAnalysis(false);
    }
  }, [allProblems, problemQueue.length, answerHistory.length]);

  const isNodeOrToday = isSingleNodeMode || isTodayMode;
  const cardTimesStorageKey = domainId && rootNodeId ? `lesson-card-times-${domainId}-${rootNodeId}` : '';

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
      // 优先用条目数不少于服务端的一方，避免刚提交的那张卡时间未及时从服务端返回时显示为 —
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

  const renderNodeTreeItem = (item: { type: 'card'; id: string; title: string } | { type: 'node'; id: string; title: string; children: unknown[] }, depth: number): React.ReactNode => {
    if (item.type === 'card') {
      const idx = cardIdToFlatIndex[item.id];
      const inReview = lessonReviewCardIds.includes(item.id);
      const isDone = typeof idx === 'number' && idx < currentCardIndex && !inReview;
      const isCurrent = typeof idx === 'number' && idx === currentCardIndex;
      let timeText = '—';
      if (typeof idx === 'number') {
        if (isCurrent) timeText = `${(currentCardCumulativeMs / 1000).toFixed(1)}s`;
        else if (idx < cardTimesMs.length) timeText = `${(cardTimesMs[idx] / 1000).toFixed(1)}s`;
      }
      return (
        <div
          key={`card-${item.id}`}
          style={{
            padding: '6px 10px',
            marginLeft: `${depth * 12}px`,
            marginBottom: '2px',
            fontSize: '13px',
            borderRadius: '6px',
            backgroundColor: isCurrent ? '#e3f2fd' : isDone ? '#e8f5e9' : 'transparent',
            color: isCurrent ? '#1976d2' : isDone ? '#2e7d32' : '#666',
            fontWeight: isCurrent ? 600 : 400,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>
            {isDone && <span style={{ marginRight: '6px' }}>✓</span>}
            {item.title || i18n('Unnamed Card')}
          </span>
          <span style={{ fontSize: '12px', color: '#999', flexShrink: 0 }}>{timeText}</span>
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
          color: '#333',
        }}>
          {nodeItem.title || i18n('Unnamed Node')}
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
        console.error('预览图片失败:', err);
        Notification.error(i18n('Image preview failed'));
      }
    };
    document.addEventListener('click', handleImageClick, true);
    return () => document.removeEventListener('click', handleImageClick, true);
  }, []);

  const currentProblem = problemQueue[currentProblemIndex];
  const displayOrder = currentProblem?.options && optionOrder.length === currentProblem.options.length
    ? optionOrder
    : (currentProblem?.options?.map((_, i) => i) ?? []);
  const isCorrect = currentProblem && selectedAnswer !== null && displayOrder[selectedAnswer] === currentProblem.answer;
  const allCorrect = problemQueue.length === 0 && answerHistory.length > 0;

  useLayoutEffect(() => {
    if (currentProblem?.options?.length) {
      setSelectedAnswer(null);
      setIsAnswered(false);
      setShowAnalysis(false);
      setProblemStartTime(Date.now());
      const indices = currentProblem.options.map((_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      setOptionOrder(indices);
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
          nextTimes = Array.isArray(arr) ? [...arr, totalTimeMs] : [totalTimeMs];
          sessionStorage.setItem(cardTimesStorageKey, JSON.stringify(nextTimes));
        } catch (_) {}
      }
      const result = await request.post(`/d/${domainId}/learn/lesson/pass`, {
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
        cardIndex: (isSingleNodeMode || isTodayMode) ? currentCardIndex : undefined,
      });
      setIsPassed(true);
      if (nextTimes) setCardTimesMs(nextTimes);
      const redirect = result?.redirect ?? result?.body?.redirect;
      if (redirect && (!isAlonePractice || isSingleNodeMode)) {
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
          nextTimes = Array.isArray(arr) ? [...arr, totalTimeMs] : [totalTimeMs];
          sessionStorage.setItem(cardTimesStorageKey, JSON.stringify(nextTimes));
        } catch (_) {}
      }
      const result = await request.post(`/d/${domainId}/learn/lesson/pass`, {
        answerHistory: [],
        totalTime: totalTimeMs,
        isAlonePractice: false,
        cardId: card.docId,
        singleNodeMode: isSingleNodeMode || undefined,
        todayMode: isTodayMode || undefined,
        nodeId: isSingleNodeMode ? rootNodeId : undefined,
        cardIndex: (isSingleNodeMode || isTodayMode) ? currentCardIndex : undefined,
        noImpression: isSingleNodeMode ? noImpression : undefined,
      });
      if (nextTimes) setCardTimesMs(nextTimes);
      const redirect = result?.redirect ?? result?.body?.redirect;
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

  const handleAnswerSelect = (displayedIndex: number) => {
    if (isAnswered || !currentProblem?.options) return;
    const order = displayOrder.length === currentProblem.options.length ? displayOrder : currentProblem.options.map((_, i) => i);
    const originalIndex = order[displayedIndex] ?? displayedIndex;
    const correct = originalIndex === currentProblem.answer;
    const timeSpent = Date.now() - problemStartTime;
    const problemId = currentProblem.pid;
    const currentAttempts = (problemAttempts[problemId] || 0) + 1;

    setSelectedAnswer(displayedIndex);
    setIsAnswered(true);
    setShowAnalysis(true);
    setProblemAttempts(prev => ({ ...prev, [problemId]: currentAttempts }));

    if (correct) {
      setAnswerHistory(prev => {
        const existingIndex = prev.findIndex(h => h.problem.pid === problemId && h.correct);
        if (existingIndex >= 0) {
          const updated = [...prev];
          updated[existingIndex] = {
            problem: currentProblem,
            selected: originalIndex,
            correct: true,
            timeSpent: updated[existingIndex].timeSpent + timeSpent,
            attempts: currentAttempts,
          };
          return updated;
        }
        return [...prev, {
          problem: currentProblem,
          selected: originalIndex,
          correct: true,
          timeSpent,
          attempts: currentAttempts,
        }];
      });
      const need = correctNeeded[problemId] || 0;
      if (need > 0) {
        setCorrectNeeded(prev => ({ ...prev, [problemId]: need - 1 }));
        setTimeout(() => handleCorrectButNeedMore(), 1500);
      } else {
        setTimeout(() => handleNextProblem(), 1500);
      }
    } else {
      setPeekCount(prev => ({ ...prev, [problemId]: (prev[problemId] || 0) + 1 }));
      setCorrectNeeded(prev => ({ ...prev, [problemId]: (prev[problemId] || 0) + 1 }));
      setTimeout(() => handleWrongAnswer(), 2000);
    }
  };

  const handleNextProblem = () => {
    setSelectedAnswer(null);
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
      }}>
        <div style={{
          padding: '40px',
          color: '#999',
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
      }}>
        <div style={{
          marginBottom: '20px',
          padding: '16px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
        }}>
          <div style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
            {node.text || i18n('Unnamed Node')}
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
            {card.title || i18n('Unnamed Card')}
          </h1>
        </div>

        {card.content && (
          <div style={{
            marginBottom: '30px',
            padding: '20px',
            backgroundColor: '#fff',
            borderRadius: '8px',
            border: '1px solid #e0e0e0',
          }}>
            <h2 style={{ fontSize: '18px', marginBottom: '12px', color: '#333' }}>
              {i18n('Content')}
            </h2>
            <div
              className="lesson-markdown-body"
              style={{
                fontSize: '16px',
                lineHeight: '1.6',
                color: '#555',
              }}
              dangerouslySetInnerHTML={{ __html: renderedContent || card.content }}
            />
          </div>
        )}

        <div style={{
          marginBottom: '30px',
          padding: '30px',
          backgroundColor: '#fff',
          borderRadius: '8px',
          border: '1px solid #e0e0e0',
        }}>
          <h2 style={{ fontSize: '20px', marginBottom: '20px', color: '#333' }}>
            {i18n('Practice Results')}
          </h2>
          <div style={{
            display: 'flex',
            justifyContent: 'space-around',
            marginBottom: '30px',
            padding: '20px',
            backgroundColor: '#f5f5f5',
            borderRadius: '8px',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#4caf50', marginBottom: '8px' }}>
                {correctCount}/{totalCount}
              </div>
              <div style={{ fontSize: '14px', color: '#666' }}>{i18n('Correct')}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#2196f3', marginBottom: '8px' }}>
                {accuracy}%
              </div>
              <div style={{ fontSize: '14px', color: '#666' }}>{i18n('Accuracy')}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#ff9800', marginBottom: '8px' }}>
                {(totalTimeMs / 1000).toFixed(1)}s
              </div>
              <div style={{ fontSize: '14px', color: '#666' }}>{i18n('Total Time')}</div>
            </div>
          </div>

          <div style={{ marginTop: '20px' }}>
            <h3 style={{ fontSize: '16px', marginBottom: '16px', color: '#333' }}>
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
                    backgroundColor: history.correct ? '#e8f5e9' : '#ffebee',
                    border: `1px solid ${history.correct ? '#4caf50' : '#f44336'}`,
                  }}
                >
                  <div style={{ fontSize: '14px', fontWeight: '500', marginBottom: '8px' }}>
                    {i18n('Question')} {idx + 1}: {history.problem.stem}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                    {i18n('Time Spent')}: {(history.timeSpent / 1000).toFixed(1)}s
                    {idx > 0 && (
                      <> ({i18n('Cumulative')}: {(cumulativeTime / 1000).toFixed(1)}s)</>
                    )}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                    {i18n('Attempts')}: {history.attempts}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>
                    {i18n('Your Answer')}: {history.problem?.options?.[history.selected] || i18n('N/A')} 
                    {history.correct ? (
                      <span style={{ color: '#4caf50', marginLeft: '8px' }}>✓</span>
                    ) : (
                      <span style={{ color: '#f44336', marginLeft: '8px' }}>✗</span>
                    )}
                  </div>
                  {!history.correct && (
                    <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                      {i18n('Correct Answer')}: {history.problem?.options?.[history.problem?.answer] || i18n('N/A')}
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
              backgroundColor: '#e8f5e9',
              borderRadius: '12px',
              border: '2px solid #4caf50',
              marginBottom: '20px',
            }}>
              <div style={{ fontSize: '48px', marginBottom: '20px' }}>✓</div>
              <h2 style={{ fontSize: '28px', color: '#2e7d32', marginBottom: '16px' }}>
                {i18n('Lesson Passed')}
              </h2>
              <p style={{ fontSize: '16px', color: '#555', marginBottom: '30px' }}>
                {i18n('Congratulations! You have completed all practice questions correctly.')}
              </p>
            </div>
          )}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            {!isAlonePractice && (
              <button
                onClick={() => {
                  window.location.href = `/d/${domainId}/learn/lesson`;
                }}
                style={{
                  padding: '12px 32px',
                  border: 'none',
                  borderRadius: '6px',
                  backgroundColor: '#2196f3',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '16px',
                  fontWeight: 'bold',
                }}
              >
                {i18n('Next Card')}
              </button>
            )}
            <button
              onClick={() => {
                window.location.href = `/d/${domainId}/learn`;
              }}
              style={{
                padding: '12px 32px',
                border: 'none',
                borderRadius: '6px',
                backgroundColor: '#4caf50',
                color: '#fff',
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

  // 仅当「无题目」时使用卡片 view（Know it / No impression）；有题目的走下方题目刷题模式。与刷题模式共用侧边栏布局。
  const useCardViewMode = (isSingleNodeMode || isTodayMode) && !hasProblems && allProblems.length === 0;
  let cardViewContent: React.ReactNode = null;
  if (useCardViewMode) {
    cardViewContent = (
      <div style={{
        maxWidth: '900px',
        width: '100%',
        margin: '0 auto',
        padding: '20px',
      }}>
        <div style={{
          marginBottom: '20px',
          padding: '16px',
          backgroundColor: '#f5f5f5',
          borderRadius: '8px',
        }}>
          <div style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
            {node.text || i18n('Unnamed Node')}
          </div>
          <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
            {card.title || i18n('Unnamed Card')}
          </h1>
          <div style={{ fontSize: '14px', color: '#2196f3', marginTop: '8px', fontWeight: 600 }}>
            {i18n('This card')}: {(currentCardCumulativeMs / 1000).toFixed(1)}s
          </div>
        </div>

        {!browseFlipped ? (
          <div style={{
            marginBottom: '30px',
            padding: '30px',
            backgroundColor: '#fff',
            borderRadius: '8px',
            border: '1px solid #e0e0e0',
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
                backgroundColor: '#4caf50',
                color: '#fff',
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
                backgroundColor: '#ff9800',
                color: '#fff',
                cursor: 'pointer',
                fontSize: '16px',
                fontWeight: 'bold',
              }}
            >
              {i18n('No impression')}
            </button>
          </div>
        ) : (
          <>
            {card.content && (
              <div style={{
                marginBottom: '24px',
                padding: '20px',
                backgroundColor: '#fff',
                borderRadius: '8px',
                border: '1px solid #e0e0e0',
              }}>
                <h2 style={{ fontSize: '18px', marginBottom: '12px', color: '#333' }}>
                  {i18n('Content')}
                </h2>
                <div
                  className="lesson-markdown-body"
                  style={{ fontSize: '16px', lineHeight: '1.6', color: '#555' }}
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
                  backgroundColor: '#2196f3',
                  color: '#fff',
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

  // 卡片 view 与刷题模式共用侧边栏：有侧边栏时用同一布局
  if (cardViewContent) {
    const showSidebarHere = (isSingleNodeMode || isTodayMode) && nodeTree.length > 0;
    if (showSidebarHere) {
      return (
        <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#fafafa' }}>
          <aside style={{
            width: '240px',
            flexShrink: 0,
            padding: '16px',
            backgroundColor: '#fff',
            borderRight: '1px solid #e0e0e0',
            overflowY: 'auto',
          }}>
            <div style={{ fontSize: '12px', color: '#999', marginBottom: '8px', textTransform: 'uppercase' }}>
              {i18n('Progress')}
            </div>
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: '#333' }}>
              {rootNodeTitle || i18n('Unnamed Node')}
            </div>
            <div style={{ fontSize: '12px', color: '#666', marginBottom: '12px' }}>
              {currentCardIndex + 1} / {flatCards.length} {i18n('cards')}
            </div>
            <div style={{ fontSize: '12px', color: '#333', marginBottom: '12px', fontWeight: 600 }}>
              {i18n('Cumulative')}: {(cumulativeMs / 1000).toFixed(1)}s
            </div>
            {nodeTree.map((root, i) => renderNodeTreeItem(root, 0))}
          </aside>
          <main style={{ flex: 1, overflowY: 'auto' }}>
            {cardViewContent}
          </main>
        </div>
      );
    }
    return <>{cardViewContent}</>;
  }

  if (!currentProblem && !allCorrect && answerHistory.length === 0) {
    return (
      <div style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        textAlign: 'center',
      }}>
        <div style={{
          padding: '40px',
          color: '#999',
        }}>
          {i18n('No content or practice questions available.')}
        </div>
      </div>
    );
  }

  if (!currentProblem || !currentProblem.options) {
    if (allCorrect) {
      return null;
    }
    return (
      <div style={{
        maxWidth: '900px',
        margin: '0 auto',
        padding: '20px',
        textAlign: 'center',
      }}>
        <div style={{
          padding: '40px',
          color: '#999',
        }}>
          {i18n('Loading...')}
        </div>
      </div>
    );
  }

  const mainContent = (
    <div style={{
      maxWidth: '900px',
      width: '100%',
      margin: '0 auto',
      padding: '20px',
    }}>
      <div style={{
        marginBottom: '20px',
        padding: '16px',
        backgroundColor: '#f5f5f5',
        borderRadius: '8px',
      }}>
        <div style={{ fontSize: '14px', color: '#666', marginBottom: '8px' }}>
          {node.text || i18n('Unnamed Node')}
        </div>
        <h1 style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
          {card.title || i18n('Unnamed Card')}
        </h1>
        <div style={{ fontSize: '12px', color: '#999', marginTop: '8px' }}>
          {i18n('Question')} {allProblems.length - problemQueue.length + 1} / {allProblems.length}
          {problemQueue.length > 0 && ` (${i18n('Remaining')}: ${problemQueue.length})`}
        </div>
        {(isSingleNodeMode || isTodayMode) && (
          <div style={{ fontSize: '14px', color: '#2196f3', marginTop: '8px', fontWeight: 600 }}>
            {i18n('This card')}: {(elapsedMs / 1000).toFixed(1)}s
          </div>
        )}
      </div>


      <div style={{
        marginBottom: '30px',
        padding: '30px',
        backgroundColor: '#fff',
        borderRadius: '8px',
        border: '1px solid #e0e0e0',
      }}>
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
          <span style={{
            display: 'inline-block',
            padding: '4px 8px',
            backgroundColor: '#2196f3',
            color: '#fff',
            borderRadius: '4px',
            fontSize: '12px',
            marginRight: '8px',
          }}>
            {i18n('Question')}
          </span>
          {!isAnswered && (
            <button
              type="button"
              onClick={handlePeek}
              style={{
                padding: '6px 14px',
                border: '1px solid #ff9800',
                borderRadius: '6px',
                backgroundColor: '#fff3e0',
                color: '#e65100',
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
              backgroundColor: '#ff9800',
              color: '#fff',
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
              backgroundColor: isCorrect ? '#4caf50' : '#f44336',
              color: '#fff',
              borderRadius: '4px',
              fontSize: '12px',
            }}>
              {isCorrect ? i18n('Correct') : i18n('Incorrect')}
            </span>
          )}
        </div>

        <div style={{
          fontSize: '18px',
          fontWeight: '500',
          marginBottom: '24px',
          color: '#333',
          lineHeight: '1.6',
        }}>
          {currentProblem?.stem || i18n('No stem')}
        </div>

        <div style={{ marginBottom: '20px' }} key={`options-${currentProblem?.pid}-${currentProblemIndex}-${shuffleTrigger}`}>
          {(currentProblem?.options && Array.isArray(currentProblem.options) ? displayOrder : []).map((originalIdx, displayIdx) => {
            const option = currentProblem.options[originalIdx];
            const isSelected = selectedAnswer === displayIdx;
            const isAnswer = originalIdx === currentProblem.answer;
            const baseStyle: React.CSSProperties = {
              padding: '14px',
              marginBottom: '12px',
              borderRadius: '6px',
              cursor: isAnswered ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
            };
            let optionStyle: React.CSSProperties;
            if (showAnalysis) {
              if (isAnswer) {
                optionStyle = { ...baseStyle, border: '2px solid #4caf50', backgroundColor: '#e8f5e9' };
              } else if (isSelected) {
                optionStyle = { ...baseStyle, border: '2px solid #f44336', backgroundColor: '#ffebee' };
              } else {
                optionStyle = { ...baseStyle, border: '2px solid #e0e0e0', backgroundColor: '#fff', opacity: 0.6 };
              }
            } else if (isSelected) {
              optionStyle = { ...baseStyle, border: '2px solid #2196f3', backgroundColor: '#e3f2fd' };
            } else {
              optionStyle = { ...baseStyle, border: '2px solid #e0e0e0', backgroundColor: '#fff' };
            }

            return (
              <div
                key={`${currentProblem.pid || currentProblemIndex}-${displayIdx}`}
                onClick={() => !isAnswered && handleAnswerSelect(displayIdx)}
                style={optionStyle}
              >
                <span style={{ marginRight: '10px', fontWeight: 'bold', fontSize: '16px' }}>
                  {String.fromCharCode(65 + displayIdx)}.
                </span>
                <span style={{ fontSize: '16px' }}>{option}</span>
              </div>
            );
          })}
        </div>

        {showAnalysis && currentProblem.analysis && (
          <div style={{
            marginTop: '20px',
            padding: '16px',
            backgroundColor: '#f5f5f5',
            borderRadius: '6px',
            fontSize: '15px',
            color: '#666',
            lineHeight: '1.6',
          }}>
            <strong style={{ color: '#333' }}>{i18n('Analysis')}:</strong> {currentProblem.analysis}
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
              backgroundColor: 'rgba(0,0,0,0.5)',
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
                backgroundColor: '#fff',
                borderRadius: '12px',
                padding: '24px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 style={{ margin: '0 0 16px', fontSize: '18px', color: '#333' }}>
                {i18n('Source card')}: {card.title || i18n('Unnamed Card')}
              </h3>
              <div
                style={{
                  fontSize: '15px',
                  lineHeight: '1.6',
                  color: '#555',
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
                    backgroundColor: '#ff9800',
                    color: '#fff',
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

  const showSidebar = (isSingleNodeMode || isTodayMode) && nodeTree.length > 0;
  if (showSidebar) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#fafafa' }}>
        <aside style={{
          width: '240px',
          flexShrink: 0,
          padding: '16px',
          backgroundColor: '#fff',
          borderRight: '1px solid #e0e0e0',
          overflowY: 'auto',
        }}>
          <div style={{ fontSize: '12px', color: '#999', marginBottom: '8px', textTransform: 'uppercase' }}>
            {i18n('Progress')}
          </div>
          <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '12px', color: '#333' }}>
            {rootNodeTitle || i18n('Unnamed Node')}
          </div>
          <div style={{ fontSize: '12px', color: '#666', marginBottom: '12px' }}>
            {currentCardIndex + 1} / {flatCards.length} {i18n('cards')}
          </div>
          <div style={{ fontSize: '12px', color: '#333', marginBottom: '12px', fontWeight: 600 }}>
            {i18n('Cumulative')}: {(cumulativeMs / 1000).toFixed(1)}s
          </div>
          {nodeTree.map((root, i) => renderNodeTreeItem(root, 0))}
        </aside>
        <main style={{ flex: 1, overflowY: 'auto' }}>
          {mainContent}
        </main>
      </div>
    );
  }

  return mainContent;
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
