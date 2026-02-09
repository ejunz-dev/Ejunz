import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import { request } from 'vj/utils';

interface SectionProgress {
  _id: string;
  title: string;
  passed: number;
  total: number;
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
  const pendingSections = ((window as any).UiContext?.pendingSections || []) as SectionProgress[];
  const completedSections = ((window as any).UiContext?.completedSections || []) as SectionProgress[];
  const nextCard = (window as any).UiContext?.nextCard as { nodeId: string; cardId: string } | null;

  const [goal, setGoal] = useState(dailyGoal);
  const [isEditingGoal, setIsEditingGoal] = useState(false);
  const [isSavingGoal, setIsSavingGoal] = useState(false);
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(false);
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
    if (nextCard) {
      window.location.href = `/d/${domainId}/learn/lesson?cardId=${nextCard.cardId}`;
    } else {
      window.location.href = `/d/${domainId}/learn/lesson`;
    }
  }, [domainId, nextCard]);

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
      alert(i18n('Failed to save daily goal'));
    } finally {
      setIsSavingGoal(false);
    }
  }, [domainId, goal, isSavingGoal]);

  const progressPercentage = totalProgress > 0 ? Math.round((currentProgress / totalProgress) * 100) : 0;

  const sidebarWidth = 220;
  const collapsedWidth = 36;

  return (
    <div style={{
      minHeight: '100vh',
      background: themeStyles.bgPage,
      fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", sans-serif',
      display: 'flex',
      flexDirection: 'row',
      position: 'relative',
    }}>
      {/* 左侧边栏：绝对定位，覆盖展开 */}
      <aside style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: leftSidebarOpen ? sidebarWidth : collapsedWidth,
        display: 'flex',
        flexDirection: 'row',
        background: themeStyles.bgSecondary,
        borderRight: `1px solid ${themeStyles.border}`,
        transition: 'width 0.25s ease',
        overflow: 'hidden',
        zIndex: 10,
      }}>
        {leftSidebarOpen ? (
          <>
            <div style={{
              flex: 1,
              padding: '20px 16px',
              overflowY: 'auto',
              minWidth: 0,
            }}>
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
                    padding: '4px 8px',
                    fontSize: '12px',
                    background: 'transparent',
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '6px',
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {pendingSections.length === 0 ? (
                  <div style={{ fontSize: '13px', color: themeStyles.textTertiary, fontStyle: 'italic' }}>
                    {i18n('No pending sections')}
                  </div>
                ) : (
                  pendingSections.map((s) => (
                    <a
                      key={s._id}
                      href={`/d/${domainId}/learn?sectionId=${s._id}`}
                      style={{
                        display: 'block',
                        padding: '10px 12px',
                        fontSize: '14px',
                        color: themeStyles.textPrimary,
                        textDecoration: 'none',
                        borderRadius: '8px',
                        background: themeStyles.bgPrimary,
                        border: `1px solid ${themeStyles.border}`,
                        transition: 'background 0.15s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = themeStyles.bgHover;
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = themeStyles.bgPrimary;
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{s.title}</div>
                      <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginTop: '4px' }}>
                        {s.passed}/{s.total}
                      </div>
                    </a>
                  ))
                )}
              </div>
            </div>
          </>
        ) : (
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
        )}
      </aside>

      {/* 主内容 */}
      <main style={{
        flex: 1,
        minWidth: 0,
        padding: '32px 24px 48px',
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
        <h1 style={{
          fontSize: '28px',
          fontWeight: 600,
          color: themeStyles.textPrimary,
          margin: '0 0 4px',
          letterSpacing: '-0.03em',
        }}>
          {i18n('Learning Progress')}
        </h1>

        {/* 进度：总进度 + 今日进度 */}
        <div style={{
          padding: '28px',
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
            padding: '18px 28px',
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
      </div>
      </main>

      {/* 右侧边栏：绝对定位，覆盖展开 */}
      <aside style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: rightSidebarOpen ? sidebarWidth : collapsedWidth,
        display: 'flex',
        flexDirection: 'row',
        background: themeStyles.bgCard,
        borderLeft: `1px solid ${themeStyles.border}`,
        transition: 'width 0.25s ease',
        overflow: 'hidden',
        zIndex: 10,
      }}>
        {rightSidebarOpen ? (
          <>
            <div style={{
              flex: 1,
              padding: '20px 16px',
              overflowY: 'auto',
              minWidth: 0,
            }}>
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
                  {i18n('Completed sections')}
                </span>
                <button
                  type="button"
                  onClick={() => setRightSidebarOpen(false)}
                  style={{
                    padding: '4px 8px',
                    fontSize: '12px',
                    background: 'transparent',
                    border: `1px solid ${themeStyles.border}`,
                    borderRadius: '6px',
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {completedSections.length === 0 ? (
                  <div style={{ fontSize: '13px', color: themeStyles.textTertiary, fontStyle: 'italic' }}>
                    {i18n('No completed sections')}
                  </div>
                ) : (
                  completedSections.map((s) => (
                    <div
                      key={s._id}
                      style={{
                        padding: '10px 12px',
                        fontSize: '14px',
                        color: themeStyles.textSecondary,
                        borderRadius: '8px',
                        background: themeStyles.bgPrimary,
                        border: `1px solid ${themeStyles.border}`,
                      }}
                    >
                      <div style={{ fontWeight: 500, color: themeStyles.textPrimary }}>{s.title}</div>
                      <div style={{ fontSize: '12px', color: themeStyles.textTertiary, marginTop: '4px' }}>
                        {s.passed}/{s.total} ✓
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setRightSidebarOpen(true)}
            title={i18n('Completed sections')}
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
        )}
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
