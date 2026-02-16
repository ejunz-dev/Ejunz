import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import { request } from 'vj/utils';
import Notification from 'vj/components/notification';

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

interface MapCardProblem {
  stem?: string;
}

interface MapCard {
  cardId: string;
  title: string;
  order?: number;
  problemCount?: number;
  problems?: MapCardProblem[];
}

interface MapDAGNode {
  _id: string;
  title: string;
  requireNids?: string[];
  cards?: MapCard[];
  order?: number;
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
  const currentSectionIndex = (window as any).UiContext?.currentSectionIndex as number | undefined;
  const passedCardIdsSet = new Set<string>((window as any).UiContext?.passedCardIds || []);

  const [goal, setGoal] = useState(dailyGoal);
  const [isEditingGoal, setIsEditingGoal] = useState(false);
  const [isSavingGoal, setIsSavingGoal] = useState(false);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [showConsecutiveTip, setShowConsecutiveTip] = useState(false);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(new Set());
  const [expandedCardIds, setExpandedCardIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<'progress' | 'path'>('progress');
  const [expandedMapSectionIds, setExpandedMapSectionIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    sections.forEach((sec) => s.add(sec._id));
    return s;
  });
  const [expandedPathCardIds, setExpandedPathCardIds] = useState<Set<string>>(new Set());
  const consecutiveBubbleRef = useRef<HTMLButtonElement>(null);

  const togglePathCardExpand = useCallback((cardId: string) => {
    setExpandedPathCardIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (sections.length > 0 && expandedMapSectionIds.size === 0) {
      setExpandedMapSectionIds(new Set(sections.map((sec) => sec._id)));
    }
  }, [sections.length]);

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
  };

  const handleStart = useCallback(() => {
    window.location.href = `/d/${domainId}/learn/lesson?today=1`;
  }, [domainId]);

  const handleSaveGoal = useCallback(async () => {
    if (isSavingGoal) return;
    setIsSavingGoal(true);
    try {
      await request.post(`/d/${domainId}/learn/daily-goal`, {
        dailyGoal: goal,
      });
      setIsEditingGoal(false);
      window.location.reload();
    } catch (error: any) {
      console.error('Failed to save daily goal:', error);
      setGoal(0);
      const msg = error?.response?.data?.message ?? error?.response?.data?.error ?? error?.message ?? i18n('Failed to save daily goal');
      Notification.error(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(' ') : i18n('Failed to save daily goal')));
    } finally {
      setIsSavingGoal(false);
    }
  }, [domainId, goal, isSavingGoal]);

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

  return (
    <div style={{
      minHeight: isMobile ? '100dvh' : '100vh',
      background: themeStyles.bgPage,
      fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif',
      display: 'flex',
      flexDirection: 'row',
      position: 'relative',
    }}>
      {/* 移动端顶栏：安全区 + 44px 触控区 */}
      {isMobile && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            minHeight: '48px',
            paddingTop: 'env(safe-area-inset-top, 0px)',
            paddingLeft: 'max(12px, env(safe-area-inset-left, 0px))',
            paddingRight: 'max(12px, env(safe-area-inset-right, 0px))',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: themeStyles.bgSecondary,
            borderBottom: `1px solid ${themeStyles.border}`,
          }}
        >
          <button
            type="button"
            onClick={() => { setLeftSidebarOpen(true); setRightSidebarOpen(false); }}
            style={{
              padding: '8px 12px',
              minHeight: '44px',
              minWidth: '44px',
              fontSize: '14px',
              fontWeight: 500,
              color: themeStyles.textPrimary,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ☰ {i18n('Pending sections')}
          </button>
          <button
            type="button"
            onClick={() => { setRightSidebarOpen(true); setLeftSidebarOpen(false); }}
            style={{
              padding: '8px 12px',
              minHeight: '44px',
              minWidth: '44px',
              fontSize: '14px',
              fontWeight: 500,
              color: themeStyles.textPrimary,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {i18n('Completed cards')} ☰
          </button>
        </div>
      )}

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

      {/* 左侧边栏：桌面为绝对定位条，移动端为抽屉 */}
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
                  {i18n('Pending sections')}
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
            onClick={() => setLeftSidebarOpen(true)}
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
            →
          </button>
        ) : null}
      </aside>

      {/* 主内容：移动端留出顶栏+安全区、底部安全区 */}
      <main style={{
        flex: 1,
        minWidth: 0,
        padding: isMobile
          ? 'calc(48px + env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) max(32px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px))'
          : '32px 24px 48px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}>
      <div style={{
        maxWidth: '520px',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '24px',
      }}>
        {/* 切换：Learning Progress / Learning Path */}
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
              padding: '10px 16px',
              minHeight: isMobile ? '48px' : undefined,
              fontSize: '14px',
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
              padding: '10px 16px',
              minHeight: isMobile ? '48px' : undefined,
              fontSize: '14px',
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
        </div>

        {/* 进度模式：总进度 + 今日进度 */}
        {viewMode === 'progress' && (
        <>
        <div style={{
          padding: isMobile ? '20px 16px' : '28px',
          background: themeStyles.bgCard,
          borderRadius: '20px',
          border: `1px solid ${themeStyles.border}`,
          boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.06)',
        }}>
          {/* 总进度 */}
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
          </div>

          {/* 今日进度 */}
          <div>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '10px',
              flexWrap: 'wrap',
              gap: '8px',
            }}>
              <span style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>
                {i18n('Today progress')}
              </span>
              <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.textPrimary }}>
                {todayCompletedCount} / {goal}
              </span>
              {!isEditingGoal ? (
                <button
                  onClick={() => setIsEditingGoal(true)}
                  type="button"
                  style={{
                    padding: '5px 12px',
                    fontSize: '12px',
                    background: 'transparent',
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '8px',
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = themeStyles.accent;
                    e.currentTarget.style.color = themeStyles.accent;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = themeStyles.border;
                    e.currentTarget.style.color = themeStyles.textSecondary;
                  }}
                >
                  {i18n('Edit')} {i18n('Daily Goal')}
                </button>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <input
                    type="number"
                    value={goal}
                    onChange={(e) => setGoal(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    min={0}
                    style={{
                      width: '56px',
                      padding: '5px 10px',
                      fontSize: '13px',
                      background: themeStyles.bgPrimary,
                      border: `1px solid ${themeStyles.border}`,
                      borderRadius: '8px',
                      color: themeStyles.textPrimary,
                    }}
                  />
                  <span style={{ fontSize: '12px', color: themeStyles.textSecondary }}>{i18n('cards')}</span>
                  <button
                    onClick={handleSaveGoal}
                    disabled={isSavingGoal}
                    type="button"
                    style={{
                      padding: '5px 12px',
                      fontSize: '12px',
                      background: themeStyles.primary,
                      border: 'none',
                      borderRadius: '8px',
                      color: '#fff',
                      cursor: isSavingGoal ? 'not-allowed' : 'pointer',
                      opacity: isSavingGoal ? 0.7 : 1,
                    }}
                  >
                    {isSavingGoal ? i18n('Saving...') : i18n('Save')}
                  </button>
                  <button
                    onClick={() => { setIsEditingGoal(false); setGoal(dailyGoal); }}
                    type="button"
                    style={{
                      padding: '5px 12px',
                      fontSize: '12px',
                      background: 'transparent',
                      border: `1px solid ${themeStyles.border}`,
                      borderRadius: '8px',
                      color: themeStyles.textPrimary,
                      cursor: 'pointer',
                    }}
                  >
                    {i18n('Cancel')}
                  </button>
                </div>
              )}
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

          {/* 打卡天数：总打卡 + 连续打卡小气泡 */}
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
          {i18n('Start Learning')}
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
          {i18n('Section Order')}
        </a>
      </>
        )}

        {/* Learning Path 模式：sections + 单卡片刷题 */}
        {viewMode === 'path' && sections.length > 0 && (
          <div style={{
            padding: '8px 0',
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {sections.map((section, sectionIndex) => {
                const sectionCards = collectCardsUnder(section._id, sections, fullDag, new Set());
                const isCurrentSection = typeof currentSectionIndex === 'number' && sectionIndex === currentSectionIndex;
                const isExpanded = expandedMapSectionIds.has(section._id);
                const toggleSection = () => {
                  setExpandedMapSectionIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(section._id)) next.delete(section._id);
                    else next.add(section._id);
                    return next;
                  });
                };
                return (
                  <div
                    key={section._id}
                    style={{
                      background: themeStyles.bgCard,
                      borderRadius: '14px',
                      border: `1px solid ${isCurrentSection ? themeStyles.primary : themeStyles.border}`,
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
                          background: isCurrentSection ? themeStyles.primary : themeStyles.bgSecondary,
                          color: isCurrentSection ? '#fff' : themeStyles.textSecondary,
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
                        {isCurrentSection && (
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
                          const problemCount = card.problemCount ?? (card.problems?.length ?? 0);
                          const problems = card.problems ?? [];
                          const isCardExpanded = expandedPathCardIds.has(cardIdStr);
                          return (
                            <div key={card.cardId} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); togglePathCardExpand(cardIdStr); }}
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
                                  border: `1px solid ${themeStyles.border}`,
                                  borderRadius: '10px',
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
                                <span style={{ flex: 1 }}>{card.title || i18n('Unnamed Card')}</span>
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
      </div>
      </main>

      {/* 右侧边栏：桌面绝对定位，移动端为抽屉 */}
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
                  {i18n('Completed cards')}
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
            onClick={() => setRightSidebarOpen(true)}
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
