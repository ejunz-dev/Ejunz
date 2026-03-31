import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import { request } from 'vj/utils';
import Notification from 'vj/components/notification';

interface CompletedCardToday {
  cardId: string;
  resultId: string;
  cardTitle: string;
  nodeTitle: string;
  completedAt?: Date | string;
}

interface LearnBaseOption {
  docId: number;
  title?: string;
  bid?: string | number;
}

function CollectPage() {
  const domainId = (window as any).UiContext?.domainId as string;
  const totalCheckinDays = (window as any).UiContext?.totalCheckinDays ?? 0;
  const consecutiveDays = (window as any).UiContext?.consecutiveDays || 0;
  const dailyGoal = (window as any).UiContext?.dailyGoal || 0;
  const todayCompletedCount = (window as any).UiContext?.todayCompletedCount ?? 0;
  const completedCardsToday = ((window as any).UiContext?.completedCardsToday || []) as CompletedCardToday[];
  const learnBases = ((window as any).UiContext?.learnBases || []) as LearnBaseOption[];
  const selectedLearnBaseDocId = Number((window as any).UiContext?.selectedLearnBaseDocId || 0) || null;
  const baseDocId = Number((window as any).UiContext?.baseDocId || 0) || null;
  const requireBaseSelection = !!(window as any).UiContext?.requireBaseSelection;
  const effectiveBaseDocId = baseDocId || selectedLearnBaseDocId || null;
  const selectedLearnBase = selectedLearnBaseDocId
    ? (learnBases.find((b) => Number(b.docId) === Number(selectedLearnBaseDocId)) || null)
    : null;

  const [goal, setGoal] = useState(dailyGoal);
  const [isEditingGoal, setIsEditingGoal] = useState(false);
  const [isSavingGoal, setIsSavingGoal] = useState(false);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [showConsecutiveTip, setShowConsecutiveTip] = useState(false);
  const consecutiveBubbleRef = useRef<HTMLButtonElement>(null);

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
    if (!effectiveBaseDocId) {
      window.location.href = `/d/${domainId}/collect/base/select?redirect=${encodeURIComponent(`/d/${domainId}/collect`)}`;
      return;
    }
    window.location.href = `/d/${domainId}/collect/base/${effectiveBaseDocId}/branch/main/editor`;
  }, [domainId, effectiveBaseDocId]);

  const handleSaveGoal = useCallback(async () => {
    if (isSavingGoal) return;
    setIsSavingGoal(true);
    try {
      await request.post(`/d/${domainId}/collect/daily-goal`, {
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
    const onCompleted = () => { setRightSidebarOpen(true); };
    const rightEl = document.getElementById('header-mobile-extra');
    const rightWrap = rightEl ? (() => { const w = document.createElement('div'); rightEl.appendChild(w); return w; })() : null;
    if (rightWrap) {
      ReactDOM.render(
        <button type="button" onClick={onCompleted}>{i18n('Completed cards')} ☰</button>,
        rightWrap,
      );
    }
    return () => {
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
          maxWidth: '520px',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '24px',
        }}>
          {!requireBaseSelection && selectedLearnBase && (
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
                  {i18n('Current base (Collect)')}
                </div>
                <div style={{ fontSize: '14px', color: themeStyles.textPrimary, fontWeight: 600, wordBreak: 'break-word' }}>
                  {selectedLearnBase.bid ? `[${selectedLearnBase.bid}] ` : ''}{selectedLearnBase.title || i18n('Untitled base')}
                </div>
              </div>
              <a
                href={`/d/${domainId}/collect/base/select?redirect=${encodeURIComponent(`/d/${domainId}/collect`)}`}
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
                {i18n('Change')}
              </a>
            </div>
          )}

          {requireBaseSelection ? (
            <div style={{
              padding: isMobile ? '20px 16px' : '24px',
              background: themeStyles.bgCard,
              borderRadius: '16px',
              border: `1px solid ${themeStyles.border}`,
              boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.06)',
            }}>
              <div style={{ fontSize: '16px', fontWeight: 600, color: themeStyles.textPrimary, marginBottom: '8px' }}>
                {i18n('Select a base before learning')}
              </div>
              <div style={{ fontSize: '13px', color: themeStyles.textSecondary, marginBottom: '16px' }}>
                {i18n('Choose one base and save your learning setting first.')}
              </div>
              <a
                href={`/d/${domainId}/collect/base/select?redirect=${encodeURIComponent(`/d/${domainId}/collect`)}`}
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
                {i18n('Select Learn Base')}
              </a>
            </div>
          ) : (
            <>
              <div style={{
                padding: isMobile ? '20px 16px' : '28px',
                background: themeStyles.bgCard,
                borderRadius: '20px',
                border: `1px solid ${themeStyles.border}`,
                boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.06)',
              }}>
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
                {i18n('Collect')}
              </button>
            </>
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
                        window.open(`/d/${domainId}/collect/lesson/result/${c.resultId}`, '_blank', 'noopener,noreferrer');
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

const page = new NamedPage('collectPage', async () => {
  try {
    const container = document.getElementById('collect-container');
    if (!container) {
      return;
    }
    ReactDOM.render(<CollectPage />, container);
  } catch (error: any) {
    console.error('Failed to render collect page:', error);
  }
});

export default page;
