import React, { useState, useCallback, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';

interface DomainTask {
  domainId: string;
  domainName: string;
  domainAvatar: string;
  dailyGoal: number;
  todayCompleted: number;
}

interface DomainForGoal {
  domainId: string;
  domainName: string;
  dailyGoal: number;
}

interface Summary {
  totalDomains: number;
  totalDailyGoal: number;
  totalTodayCompleted: number;
}

const SIDEBAR_WIDTH = 220;
const SIDEBAR_COLLAPSED = 36;

function UserLearnPage() {
  const domainTasks: DomainTask[] = (window as any).UiContext?.domainTasks || [];
  const allDomainsForGoal: DomainForGoal[] = (window as any).UiContext?.allDomainsForGoal || [];
  const summary: Summary = (window as any).UiContext?.summary || {
    totalDomains: 0,
    totalDailyGoal: 0,
    totalTodayCompleted: 0,
  };
  const completedAllDomainsToday = (window as any).UiContext?.completedAllDomainsToday || false;
  const totalCheckinDays = (window as any).UiContext?.totalCheckinDays ?? 0;
  const consecutiveDays = (window as any).UiContext?.consecutiveDays ?? 0;
  const domainId = (window as any).UiContext?.domainId as string;
  const uid = (window as any).UserContext?._id;

  const pendingDomains = domainTasks.filter((t) => t.todayCompleted < t.dailyGoal);
  const completedDomains = domainTasks.filter((t) => t.todayCompleted >= t.dailyGoal);

  const getTheme = useCallback(() => {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) return (window as any).Ejunz.utils.getTheme();
      if ((window as any).UserContext?.theme) return (window as any).UserContext.theme === 'dark' ? 'dark' : 'light';
    } catch (e) {
      console.warn('Failed to get theme:', e);
    }
    return 'light';
  }, []);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => getTheme());
  const MOBILE_BREAKPOINT = 768;
  const initialDesktop = typeof window !== 'undefined' && window.innerWidth > MOBILE_BREAKPOINT;
  const [leftSidebarOpen, setLeftSidebarOpen] = useState(initialDesktop);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(initialDesktop);
  const [goalModalOpen, setGoalModalOpen] = useState(false);
  const [goalInputs, setGoalInputs] = useState<Record<string, number>>(() => {
    const o: Record<string, number> = {};
    allDomainsForGoal.forEach((d) => { o[d.domainId] = d.dailyGoal; });
    return o;
  });
  const [goalSaving, setGoalSaving] = useState(false);

  useEffect(() => {
    const checkTheme = () => {
      const newTheme = getTheme();
      if (newTheme !== theme) setTheme(newTheme);
    };
    checkTheme();
    const interval = setInterval(checkTheme, 500);
    return () => clearInterval(interval);
  }, [theme, getTheme]);

  useEffect(() => {
    if (goalModalOpen) {
      const o: Record<string, number> = {};
      allDomainsForGoal.forEach((d) => { o[d.domainId] = d.dailyGoal; });
      setGoalInputs(o);
    }
  }, [goalModalOpen, allDomainsForGoal]);

  const themeStyles = {
    bgPrimary: theme === 'dark' ? '#121212' : '#fff',
    bgSecondary: theme === 'dark' ? '#323334' : '#f6f8fa',
    bgCard: theme === 'dark' ? '#1e1e1e' : '#fafafa',
    bgPage: theme === 'dark' ? '#0d0d0d' : '#f3f4f6',
    textPrimary: theme === 'dark' ? '#eee' : '#24292e',
    textSecondary: theme === 'dark' ? '#bdbdbd' : '#586069',
    textTertiary: theme === 'dark' ? '#888' : '#9ca3af',
    border: theme === 'dark' ? '#424242' : '#e1e4e8',
    primary: theme === 'dark' ? '#4caf50' : '#16a34a',
    primaryGlow: theme === 'dark' ? 'rgba(76, 175, 80, 0.35)' : 'rgba(22, 163, 74, 0.25)',
    accent: theme === 'dark' ? '#64b5f6' : '#0ea5e9',
    accentGlow: theme === 'dark' ? 'rgba(56, 189, 248, 0.25)' : 'rgba(14, 165, 233, 0.2)',
    success: theme === 'dark' ? '#81c784' : '#4CAF50',
  };

  const entryDomainId = domainId || (domainTasks[0]?.domainId ?? '');
  const startLearnUrl = entryDomainId ? `/d/${entryDomainId}/learn/lesson?allDomains=1` : '#';
  const taskPageUrl = uid != null && entryDomainId ? `/d/${entryDomainId}/user/${uid}/task` : '#';

  const progressPct = summary.totalDailyGoal > 0
    ? Math.min(100, Math.round((summary.totalTodayCompleted / summary.totalDailyGoal) * 100))
    : 0;

  const handleSaveGoals = useCallback(async () => {
    if (goalSaving) return;
    const toSave = allDomainsForGoal.filter((d) => {
      const val = Math.max(0, goalInputs[d.domainId] ?? 0);
      return val !== d.dailyGoal;
    });
    if (toSave.length === 0) {
      setGoalModalOpen(false);
      return;
    }
    setGoalSaving(true);
    let lastSavedDomainId: string | undefined;
    try {
      for (const d of toSave) {
        lastSavedDomainId = d.domainId;
        const val = Math.max(0, goalInputs[d.domainId] ?? 0);
        await request.post(`/d/${d.domainId}/learn/daily-goal`, { dailyGoal: val });
      }
      window.location.reload();
    } catch (e: any) {
      console.error(e);
      if (lastSavedDomainId != null) {
        setGoalInputs((prev) => ({ ...prev, [lastSavedDomainId!]: 0 }));
      }
      const msg = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message ?? (i18n('Failed to save') || '保存失败');
      Notification.error(typeof msg === 'string' ? msg : (Array.isArray(msg) ? msg.join(' ') : (i18n('Failed to save') || '保存失败')));
    } finally {
      setGoalSaving(false);
    }
  }, [allDomainsForGoal, goalInputs, goalSaving]);

  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT);
  useEffect(() => {
    const onResize = () => {
      const nowMobile = window.innerWidth <= MOBILE_BREAKPOINT;
      setIsMobile(nowMobile);
      if (nowMobile) {
        setLeftSidebarOpen(false);
        setRightSidebarOpen(false);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div style={{
      minHeight: isMobile ? '100dvh' : '100vh',
      background: themeStyles.bgPage,
      fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
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
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ☰ {i18n('Pending') || '待完成'}
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
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {i18n('Completed') || '已完成'} ☰
          </button>
        </div>
      )}

      {isMobile && leftSidebarOpen && (
        <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: 'rgba(0,0,0,0.4)' }} onClick={() => setLeftSidebarOpen(false)} />
      )}
      {isMobile && rightSidebarOpen && (
        <div role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 1001, backgroundColor: 'rgba(0,0,0,0.4)' }} onClick={() => setRightSidebarOpen(false)} />
      )}

      {/* 左侧边栏：待完成；移动端抽屉带安全区、iOS 弹性滚动 */}
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
              boxShadow: leftSidebarOpen ? '4px 0 16px rgba(0,0,0,0.15)' : 'none',
              paddingTop: 'env(safe-area-inset-top, 0px)',
            }
          : {
              position: 'absolute' as const,
              left: 0,
              top: 0,
              bottom: 0,
              width: leftSidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED,
              transition: 'width 0.25s ease',
            }),
        display: 'flex',
        flexDirection: 'row',
        background: themeStyles.bgSecondary,
        borderRight: `1px solid ${themeStyles.border}`,
        overflow: 'hidden',
      }}>
        {leftSidebarOpen ? (
          <div style={{
            flex: 1,
            padding: isMobile ? '12px 16px 20px' : '20px 16px',
            overflowY: 'auto',
            minWidth: 0,
            WebkitOverflowScrolling: 'touch',
          } as React.CSSProperties}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', paddingBottom: '8px', borderBottom: `1px solid ${themeStyles.border}` }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: themeStyles.textSecondary, textTransform: 'uppercase' }}>
                {i18n('Pending') || '待完成'}
              </span>
              {!isMobile && (
                <button type="button" onClick={() => setLeftSidebarOpen(false)} style={{ padding: '4px 8px', fontSize: '12px', background: 'transparent', border: `1px solid ${themeStyles.border}`, borderRadius: '6px', color: themeStyles.textSecondary, cursor: 'pointer' }}>×</button>
              )}
            </div>
            {pendingDomains.length === 0 ? (
              <div style={{ fontSize: '13px', color: themeStyles.textTertiary, fontStyle: 'italic' }}>
                {i18n('No pending') || '暂无待完成'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {pendingDomains.map((t) => {
                  const pct = t.dailyGoal > 0 ? Math.min(100, (t.todayCompleted / t.dailyGoal) * 100) : 0;
                  return (
                    <div
                      key={t.domainId}
                      style={{
                        padding: '12px',
                        background: themeStyles.bgPrimary,
                        borderRadius: '10px',
                        border: `1px solid ${themeStyles.border}`,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                        <img src={t.domainAvatar} alt="" style={{ width: '28px', height: '28px', borderRadius: '6px' }} />
                        <span style={{ fontSize: '14px', fontWeight: 600, color: themeStyles.textPrimary }}>{t.domainName}</span>
                      </div>
                      <div style={{ fontSize: '12px', color: themeStyles.textSecondary, marginBottom: '4px' }}>
                        {t.todayCompleted} / {t.dailyGoal}
                      </div>
                      <div style={{ height: '6px', background: themeStyles.bgSecondary, borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: themeStyles.accent, borderRadius: '3px' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : !isMobile ? (
          <button type="button" onClick={() => setLeftSidebarOpen(true)} title={i18n('Pending') || '待完成'} style={{ width: '100%', padding: '16px 0', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', color: themeStyles.textSecondary, opacity: 0.7 }}>←</button>
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
        <div style={{ maxWidth: '520px', width: '100%', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <h1 style={{ fontSize: isMobile ? '22px' : '26px', fontWeight: 'bold', color: themeStyles.textPrimary, marginBottom: '4px' }}>
            {i18n('All Domains Learn') || '全域学习'}
          </h1>

          <div style={{
            padding: isMobile ? '20px 16px' : '28px',
            background: themeStyles.bgCard,
            borderRadius: '20px',
            border: `1px solid ${themeStyles.border}`,
            boxShadow: theme === 'dark' ? '0 4px 24px rgba(0,0,0,0.4)' : '0 2px 12px rgba(0,0,0,0.06)',
          }}>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <span style={{ fontSize: '13px', color: themeStyles.textSecondary, fontWeight: 500 }}>{i18n('Today progress') || '今日进度'}</span>
                <span style={{ fontSize: '15px', fontWeight: 600, color: themeStyles.textPrimary }}>{summary.totalTodayCompleted} / {summary.totalDailyGoal}</span>
              </div>
              <div style={{ height: '12px', background: theme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', borderRadius: '6px', overflow: 'hidden' }}>
                <div style={{ width: `${progressPct}%`, height: '100%', background: `linear-gradient(90deg, ${themeStyles.primary} 0%, ${theme === 'dark' ? '#2dd47a' : '#22c55e'} 100%)`, borderRadius: '6px', transition: 'width 0.4s ease', boxShadow: `0 0 12px ${themeStyles.primaryGlow}` }} />
              </div>
            </div>

            <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: `1px solid ${themeStyles.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ position: 'relative', display: 'inline-flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: theme === 'dark' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(14, 165, 233, 0.12)', border: `2px solid ${theme === 'dark' ? 'rgba(56, 189, 248, 0.4)' : 'rgba(14, 165, 233, 0.3)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: '24px', fontWeight: 700, color: themeStyles.accent }}>{totalCheckinDays}</span>
                </div>
                <div style={{ position: 'absolute', top: '-4px', right: '-4px', minWidth: '22px', height: '22px', padding: '0 6px', borderRadius: '11px', background: themeStyles.accent, color: '#fff', fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${themeStyles.bgCard}` }}>
                  {consecutiveDays}
                </div>
                <div style={{ fontSize: '11px', color: themeStyles.textSecondary, marginTop: '8px', fontWeight: 500 }}>{i18n('All-domains check-in') || '全域打卡'}</div>
              </div>
            </div>
          </div>

          {completedAllDomainsToday ? (
            <div style={{ padding: '20px', background: theme === 'dark' ? 'rgba(76, 175, 80, 0.15)' : 'rgba(76, 175, 80, 0.1)', borderRadius: '14px', border: `1px solid ${themeStyles.success}`, textAlign: 'center', fontSize: '16px', fontWeight: 600, color: themeStyles.success }}>
              {i18n('All domains completed today') || '今日全域任务已完成'}
            </div>
          ) : (
            <a
              href={startLearnUrl}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: isMobile ? '16px 24px' : '18px 28px',
                minHeight: isMobile ? '48px' : undefined,
                fontSize: '16px',
                fontWeight: 600,
                background: themeStyles.primary,
                color: '#fff',
                border: 'none',
                borderRadius: '14px',
                cursor: 'pointer',
                textDecoration: 'none',
                boxShadow: `0 4px 14px ${themeStyles.primaryGlow}`,
                boxSizing: 'border-box',
              }}
            >
              {i18n('Start Learning') || '开始学习'}
            </a>
          )}

          <button
            type="button"
            onClick={() => setGoalModalOpen(true)}
            style={{
              padding: '12px 20px',
              minHeight: isMobile ? '48px' : undefined,
              fontSize: '14px',
              fontWeight: 500,
              background: 'transparent',
              border: `1px solid ${themeStyles.border}`,
              borderRadius: '10px',
              color: themeStyles.accent,
              cursor: 'pointer',
            }}
          >
            {i18n('Set daily goal per domain') || '设置各域每日任务'}
          </button>

          <a href={taskPageUrl} style={{ fontSize: '14px', color: themeStyles.accent, textDecoration: 'none', textAlign: 'center' }}>
            {i18n('My Tasks') || '我的任务'} →
          </a>
        </div>
      </main>

      {/* 右侧边栏：已完成；移动端抽屉带安全区、iOS 弹性滚动 */}
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
              boxShadow: rightSidebarOpen ? '-4px 0 16px rgba(0,0,0,0.15)' : 'none',
              paddingTop: 'env(safe-area-inset-top, 0px)',
            }
          : {
              position: 'absolute' as const,
              right: 0,
              top: 0,
              bottom: 0,
              width: rightSidebarOpen ? SIDEBAR_WIDTH : SIDEBAR_COLLAPSED,
              transition: 'width 0.25s ease',
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', paddingBottom: '8px', borderBottom: `1px solid ${themeStyles.border}` }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: themeStyles.textSecondary, textTransform: 'uppercase' }}>
                {i18n('Completed') || '已完成'}
              </span>
              {!isMobile && (
                <button type="button" onClick={() => setRightSidebarOpen(false)} style={{ padding: '4px 8px', fontSize: '12px', background: 'transparent', border: `1px solid ${themeStyles.border}`, borderRadius: '6px', color: themeStyles.textSecondary, cursor: 'pointer' }}>×</button>
              )}
            </div>
            {completedDomains.length === 0 ? (
              <div style={{ fontSize: '13px', color: themeStyles.textTertiary, fontStyle: 'italic' }}>
                {i18n('No completed') || '暂无已完成'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {completedDomains.map((t) => (
                  <div
                    key={t.domainId}
                    style={{
                      padding: '12px',
                      background: themeStyles.bgPrimary,
                      borderRadius: '10px',
                      border: `1px solid ${themeStyles.border}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <img src={t.domainAvatar} alt="" style={{ width: '28px', height: '28px', borderRadius: '6px' }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: themeStyles.textPrimary }}>{t.domainName}</div>
                      <div style={{ fontSize: '12px', color: themeStyles.success }}>{t.todayCompleted} / {t.dailyGoal} ✓</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : !isMobile ? (
          <button type="button" onClick={() => setRightSidebarOpen(true)} title={i18n('Completed') || '已完成'} style={{ width: '100%', padding: '16px 0', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', color: themeStyles.textSecondary, opacity: 0.7 }}>→</button>
        ) : null}
      </aside>

      {/* 弹窗：设置各域每日任务 */}
      {goalModalOpen && (
        <>
          <div
            role="presentation"
            style={{ position: 'fixed', inset: 0, zIndex: 2000, backgroundColor: 'rgba(0,0,0,0.5)' }}
            onClick={() => setGoalModalOpen(false)}
          />
          <div
            style={{
              position: 'fixed',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%, -50%)',
              zIndex: 2001,
              width: isMobile ? 'calc(100vw - 24px)' : '90vw',
              maxWidth: '420px',
              maxHeight: isMobile ? 'calc(100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 48px)' : '80vh',
              overflow: 'auto',
              WebkitOverflowScrolling: 'touch',
              background: themeStyles.bgPrimary,
              borderRadius: '16px',
              border: `1px solid ${themeStyles.border}`,
              boxShadow: theme === 'dark' ? '0 8px 32px rgba(0,0,0,0.5)' : '0 8px 32px rgba(0,0,0,0.15)',
              padding: isMobile ? '20px 16px calc(20px + env(safe-area-inset-bottom, 0px))' : '24px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: '18px', fontWeight: 600, color: themeStyles.textPrimary, marginBottom: '16px' }}>
              {i18n('Set daily goal per domain') || '设置各域每日任务'}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '20px' }}>
              {allDomainsForGoal.map((d) => (
                <div key={d.domainId} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{ flex: 1, fontSize: '14px', color: themeStyles.textPrimary }}>{d.domainName}</span>
                  <input
                    type="number"
                    min={0}
                    value={goalInputs[d.domainId] ?? 0}
                    onChange={(e) => setGoalInputs((prev) => ({ ...prev, [d.domainId]: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                    style={{
                      width: '72px',
                      padding: '8px 10px',
                      fontSize: '14px',
                      background: themeStyles.bgSecondary,
                      border: `1px solid ${themeStyles.border}`,
                      borderRadius: '8px',
                      color: themeStyles.textPrimary,
                    }}
                  />
                  <span style={{ fontSize: '12px', color: themeStyles.textSecondary }}>{i18n('cards') || '张'}</span>
                </div>
              ))}
            </div>
            {allDomainsForGoal.length === 0 && (
              <div style={{ fontSize: '14px', color: themeStyles.textTertiary, marginBottom: '16px' }}>
                {i18n('No domains joined') || '暂无已加入的域'}
              </div>
            )}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={() => setGoalModalOpen(false)}
                style={{ padding: '10px 18px', fontSize: '14px', fontWeight: 500, background: 'transparent', border: `1px solid ${themeStyles.border}`, borderRadius: '8px', color: themeStyles.textPrimary, cursor: 'pointer' }}
              >
                {i18n('Cancel') || '取消'}
              </button>
              <button
                type="button"
                onClick={handleSaveGoals}
                disabled={goalSaving}
                style={{ padding: '10px 18px', fontSize: '14px', fontWeight: 500, background: themeStyles.primary, border: 'none', borderRadius: '8px', color: '#fff', cursor: goalSaving ? 'not-allowed' : 'pointer', opacity: goalSaving ? 0.7 : 1 }}
              >
                {goalSaving ? (i18n('Saving...') || '保存中...') : (i18n('Save') || '保存')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const page = new NamedPage('userLearnPage', async () => {
  const container = document.getElementById('user-learn-container');
  if (!container) return;
  ReactDOM.render(<UserLearnPage />, container);
});

export default page;
