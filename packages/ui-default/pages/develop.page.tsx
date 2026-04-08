import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n } from 'vj/utils';
import { request } from 'vj/utils';
import Notification from 'vj/components/notification';

type LearnBaseOption = { docId: number; title?: string; branches?: string[] };

type PoolEntry = {
  baseDocId: number;
  branch: string;
  dailyNodeGoal: number;
  dailyCardGoal: number;
  dailyProblemGoal: number;
};

type DisplayRow = PoolEntry & {
  baseTitle?: string;
  todayNodes: number;
  todayCards: number;
  todayProblems: number;
};

function statRatio(cur: number, goal: number): { pct: number; done: boolean } {
  if (goal > 0) {
    const pct = Math.min(100, Math.round((cur / goal) * 100));
    return { pct, done: cur >= goal };
  }
  if (cur > 0) return { pct: 100, done: false };
  return { pct: 0, done: false };
}

function MiniProgress({
  label,
  cur,
  goal,
  theme,
  themeStyles,
}: {
  label: string;
  cur: number;
  goal: number;
  theme: 'light' | 'dark';
  themeStyles: { border: string; textSecondary: string; textPrimary: string; primary: string; accent: string };
}) {
  const { pct, done } = statRatio(cur, goal);
  const track = theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const fill = done && goal > 0 ? themeStyles.primary : themeStyles.accent;
  const caption = goal > 0 ? `${cur} / ${goal}` : `${cur} / ${i18n('Develop goal unset')}`;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: themeStyles.textPrimary }}>{label}</span>
        <span style={{ fontSize: 11, color: themeStyles.textSecondary }}>{caption}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: track, overflow: 'hidden', border: `1px solid ${themeStyles.border}` }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: fill,
            borderRadius: 3,
            transition: 'width 0.25s ease',
            opacity: pct <= 0 ? 0.35 : 1,
          }}
        />
      </div>
    </div>
  );
}

function DevelopPage() {
  const domainId = (window as any).UiContext?.domainId as string;
  const learnBases = ((window as any).UiContext?.learnBases || []) as LearnBaseOption[];
  const developDateUtc = String((window as any).UiContext?.developDateUtc || '').trim();
  const developTotalCheckinDays = Number((window as any).UiContext?.developTotalCheckinDays) || 0;
  const developConsecutiveDays = Number((window as any).UiContext?.developConsecutiveDays) || 0;
  const developCheckedInToday = !!(window as any).UiContext?.developCheckedInToday;
  const developAllGoalsMet = !!(window as any).UiContext?.developAllGoalsMet;

  const initialRows = ((window as any).UiContext?.developPool || []) as Array<PoolEntry & {
    baseTitle?: string;
    todayNodes?: number;
    todayCards?: number;
    todayProblems?: number;
  }>;

  const [displayPool] = useState<DisplayRow[]>(() =>
    initialRows.map((r) => ({
      baseDocId: Number(r.baseDocId),
      branch: r.branch || 'main',
      dailyNodeGoal: Number(r.dailyNodeGoal) || 0,
      dailyCardGoal: Number(r.dailyCardGoal) || 0,
      dailyProblemGoal: Number(r.dailyProblemGoal) || 0,
      baseTitle: typeof (r as any).baseTitle === 'string' ? (r as any).baseTitle : undefined,
      todayNodes: Number(r.todayNodes) || 0,
      todayCards: Number(r.todayCards) || 0,
      todayProblems: Number(r.todayProblems) || 0,
    })),
  );

  const [editDraft, setEditDraft] = useState<PoolEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [startModalOpen, setStartModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [showConsecutiveTip, setShowConsecutiveTip] = useState(false);
  const [checkinSubmitting, setCheckinSubmitting] = useState(false);
  const consecutiveBubbleRef = useRef<HTMLButtonElement>(null);

  const getTheme = () => {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) return (window as any).Ejunz.utils.getTheme();
      if ((window as any).UserContext?.theme === 'dark') return 'dark';
    } catch { /* */ }
    return 'light';
  };
  const [theme] = useState<'light' | 'dark'>(() => (getTheme() === 'dark' ? 'dark' : 'light'));

  const themeStyles = useMemo(() => ({
    bgPage: theme === 'dark' ? 'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(76, 175, 80, 0.06) 0%, transparent 50%), #0f0f0f' : '#fafbfc',
    bgCard: theme === 'dark' ? 'rgba(38, 39, 41, 0.92)' : '#fff',
    bgPrimary: theme === 'dark' ? '#0f0f0f' : '#fff',
    textPrimary: theme === 'dark' ? '#f0f0f0' : '#1a1a1a',
    textSecondary: theme === 'dark' ? '#9ca3af' : '#6b7280',
    border: theme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    primary: theme === 'dark' ? '#22c55e' : '#16a34a',
    primaryGlow: theme === 'dark' ? 'rgba(34, 197, 94, 0.35)' : 'rgba(22, 163, 74, 0.25)',
    accent: theme === 'dark' ? '#38bdf8' : '#0ea5e9',
  }), [theme]);

  const poolCount = displayPool.length;

  const baseMeta = useMemo(() => {
    const byId = new Map<number, LearnBaseOption>();
    for (const b of learnBases) byId.set(Number(b.docId), b);
    return byId;
  }, [learnBases]);

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

  const openEditModal = useCallback(() => {
    setEditDraft(displayPool.map((r) => ({
      baseDocId: r.baseDocId,
      branch: r.branch,
      dailyNodeGoal: r.dailyNodeGoal,
      dailyCardGoal: r.dailyCardGoal,
      dailyProblemGoal: r.dailyProblemGoal,
    })));
    setEditModalOpen(true);
  }, [displayPool]);

  const closeEditModal = useCallback(() => {
    setEditModalOpen(false);
  }, []);

  const addEditRow = useCallback(() => {
    const first = learnBases[0];
    if (!first) return;
    setEditDraft((d) => [...d, {
      baseDocId: Number(first.docId),
      branch: (first.branches && first.branches[0]) || 'main',
      dailyNodeGoal: 0,
      dailyCardGoal: 0,
      dailyProblemGoal: 0,
    }]);
  }, [learnBases]);

  const removeEditRow = useCallback((idx: number) => {
    setEditDraft((d) => d.filter((_, i) => i !== idx));
  }, []);

  const updateEditRow = useCallback((idx: number, patch: Partial<PoolEntry>) => {
    setEditDraft((d) => d.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
  }, []);

  const savePoolFromEdit = useCallback(async () => {
    if (!domainId || saving) return;
    setSaving(true);
    try {
      await request.post(`/d/${domainId}/develop/pool`, { pool: editDraft });
      window.location.reload();
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? i18n('Develop save failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setSaving(false);
    }
  }, [domainId, editDraft, saving]);

  const hasAnyGoal = useMemo(
    () => displayPool.some((r) => r.dailyNodeGoal > 0 || r.dailyCardGoal > 0 || r.dailyProblemGoal > 0),
    [displayPool],
  );

  const checkinDisabled = developCheckedInToday
    || poolCount === 0
    || !hasAnyGoal
    || !developAllGoalsMet;

  let checkinButtonLabel = i18n('Develop check-in');
  if (developCheckedInToday) {
    checkinButtonLabel = i18n('Develop check-in done');
  } else if (poolCount === 0) {
    checkinButtonLabel = i18n('Develop check-in need pool');
  } else if (!hasAnyGoal) {
    checkinButtonLabel = i18n('Develop check-in need goals set');
  } else if (!developAllGoalsMet) {
    checkinButtonLabel = i18n('Develop check-in blocked');
  }

  const submitCheckin = useCallback(async () => {
    if (!domainId || checkinSubmitting || checkinDisabled) return;
    setCheckinSubmitting(true);
    try {
      await request.post(`/d/${domainId}/develop/checkin`, {});
      window.location.reload();
    } catch (e: any) {
      const msg = e?.response?.data?.message ?? e?.message ?? i18n('Develop check-in failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setCheckinSubmitting(false);
    }
  }, [domainId, checkinSubmitting, checkinDisabled]);

  const modalRows = useMemo(() => displayPool.map((e, idx) => {
    const b = baseMeta.get(e.baseDocId);
    const title = (e.baseTitle || (b?.title || '').trim() || String(e.baseDocId));
    const encBr = encodeURIComponent(e.branch || 'main');
    const editorUrl = `/d/${domainId}/base/${e.baseDocId}/branch/${encBr}/editor`;
    return {
      key: `pick-${idx}-${e.baseDocId}-${e.branch}`,
      title,
      branch: e.branch || 'main',
      editorUrl,
      nodes: e.todayNodes,
      cards: e.todayCards,
      problems: e.todayProblems,
      dailyNodeGoal: e.dailyNodeGoal,
      dailyCardGoal: e.dailyCardGoal,
      dailyProblemGoal: e.dailyProblemGoal,
    };
  }), [displayPool, baseMeta, domainId]);

  const hasBases = learnBases.length > 0;

  const btnRowStyle = {
    display: 'flex',
    gap: 10,
    flexWrap: 'wrap' as const,
    marginBottom: 20,
  };

  const outlineBtn = {
    flex: '1 1 160px',
    padding: '14px 18px',
    fontSize: 15,
    fontWeight: 600,
    background: 'transparent',
    color: themeStyles.textPrimary,
    border: `2px solid ${themeStyles.border}`,
    borderRadius: 14,
    cursor: 'pointer' as const,
  };

  const primaryBtn = {
    flex: '1 1 160px',
    padding: '14px 18px',
    fontSize: 15,
    fontWeight: 600,
    background: poolCount ? themeStyles.primary : themeStyles.textSecondary,
    color: '#fff',
    border: 'none',
    borderRadius: 14,
    cursor: poolCount ? 'pointer' : 'not-allowed',
    boxShadow: poolCount ? `0 4px 14px ${themeStyles.primaryGlow}` : 'none',
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: themeStyles.bgPage,
      fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      padding: '24px 16px 48px',
    }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div style={{
          background: themeStyles.bgCard,
          border: `1px solid ${themeStyles.border}`,
          borderRadius: 16,
          padding: 24,
          boxShadow: theme === 'dark' ? '0 8px 32px rgba(0,0,0,0.35)' : '0 4px 24px rgba(0,0,0,0.06)',
        }}>
          <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700, color: themeStyles.textPrimary }}>
            {i18n('Develop')}
          </h1>
          {developDateUtc ? (
            <div style={{ fontSize: 12, color: themeStyles.textSecondary, marginBottom: 12 }}>
              {i18n('Develop utc day')}: {developDateUtc}
            </div>
          ) : null}

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 20,
            paddingTop: 8,
            paddingBottom: 20,
            borderBottom: `1px solid ${themeStyles.border}`,
          }}>
            <div style={{
              position: 'relative',
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'center',
            }}
            >
              <div style={{
                position: 'relative',
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: theme === 'dark' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(14, 165, 233, 0.12)',
                border: `2px solid ${theme === 'dark' ? 'rgba(56, 189, 248, 0.4)' : 'rgba(14, 165, 233, 0.3)'}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              >
                <span style={{ fontSize: 24, fontWeight: 700, color: themeStyles.accent, lineHeight: 1 }}>
                  {developTotalCheckinDays}
                </span>
                <button
                  ref={consecutiveBubbleRef}
                  type="button"
                  onClick={handleConsecutiveBubbleClick}
                  style={{
                    position: 'absolute',
                    top: -4,
                    right: -4,
                    minWidth: 22,
                    height: 22,
                    padding: '0 6px',
                    borderRadius: 11,
                    background: themeStyles.accent,
                    color: '#fff',
                    fontSize: 12,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `2px solid ${themeStyles.bgCard}`,
                    boxSizing: 'border-box',
                    cursor: 'pointer',
                  }}
                >
                  {developConsecutiveDays}
                  {showConsecutiveTip && (
                    <span
                      style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: '50%',
                        transform: 'translateX(-50%)',
                        marginBottom: 6,
                        padding: '6px 10px',
                        fontSize: 12,
                        color: themeStyles.textPrimary,
                        background: themeStyles.bgPrimary,
                        border: `1px solid ${themeStyles.border}`,
                        borderRadius: 8,
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
              <div style={{ fontSize: 11, color: themeStyles.textSecondary, marginTop: 8, fontWeight: 500 }}>
                {i18n('Total check-in days')}
              </div>
            </div>
          </div>

          <div style={btnRowStyle}>
            <button
              type="button"
              disabled={!hasBases}
              onClick={openEditModal}
              style={{
                ...outlineBtn,
                opacity: hasBases ? 1 : 0.5,
                cursor: hasBases ? 'pointer' : 'not-allowed',
              }}
            >
              {i18n('Edit')}
            </button>
            <button
              type="button"
              disabled={!poolCount}
              onClick={() => setStartModalOpen(true)}
              style={primaryBtn}
            >
              {i18n('Develop start')}
            </button>
          </div>

          <button
            type="button"
            disabled={checkinDisabled || checkinSubmitting}
            onClick={() => { void submitCheckin(); }}
            style={{
              padding: '16px 24px',
              minHeight: 52,
              fontSize: 16,
              fontWeight: 600,
              background: !checkinDisabled && !checkinSubmitting ? themeStyles.primary : themeStyles.textSecondary,
              color: '#fff',
              border: 'none',
              borderRadius: 14,
              cursor: checkinDisabled || checkinSubmitting ? 'not-allowed' : 'pointer',
              width: '100%',
              marginBottom: 20,
              boxShadow: !checkinDisabled && !checkinSubmitting ? `0 4px 14px ${themeStyles.primaryGlow}` : 'none',
              opacity: checkinSubmitting ? 0.85 : 1,
            }}
          >
            {checkinSubmitting ? i18n('Saving...') : checkinButtonLabel}
          </button>

          <h2 style={{ fontSize: 15, fontWeight: 600, color: themeStyles.textPrimary, margin: '8px 0 14px' }}>
            {i18n('Develop progress overview')}
          </h2>

          {!hasBases ? (
            <p style={{ color: themeStyles.textSecondary, fontSize: 14 }}>{i18n('Develop no bases')}</p>
          ) : poolCount === 0 ? (
            <div style={{
              padding: 28,
              borderRadius: 14,
              border: `1px dashed ${themeStyles.border}`,
              textAlign: 'center',
              color: themeStyles.textSecondary,
              fontSize: 14,
              lineHeight: 1.55,
            }}>
              {i18n('Develop no pool hint')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {displayPool.map((row, idx) => {
                const b = baseMeta.get(row.baseDocId);
                const title = (row.baseTitle || (b?.title || '').trim() || String(row.baseDocId));

                return (
                  <div
                    key={`viz-${idx}-${row.baseDocId}-${row.branch}`}
                    style={{
                      padding: 16,
                      borderRadius: 14,
                      border: `1px solid ${themeStyles.border}`,
                      background: theme === 'dark' ? 'rgba(0,0,0,0.22)' : '#f9fafb',
                    }}
                  >
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: themeStyles.textPrimary }}>
                        {title}
                      </div>
                      <div style={{ fontSize: 12, color: themeStyles.textSecondary, marginTop: 2 }}>
                        {i18n('Develop branch')}: <span style={{ color: themeStyles.accent, fontWeight: 600 }}>{row.branch}</span>
                      </div>
                    </div>
                    <MiniProgress
                      label={i18n('Develop today nodes')}
                      cur={row.todayNodes}
                      goal={row.dailyNodeGoal}
                      theme={theme}
                      themeStyles={themeStyles}
                    />
                    <MiniProgress
                      label={i18n('Develop today cards')}
                      cur={row.todayCards}
                      goal={row.dailyCardGoal}
                      theme={theme}
                      themeStyles={themeStyles}
                    />
                    <MiniProgress
                      label={i18n('Develop today problems')}
                      cur={row.todayProblems}
                      goal={row.dailyProblemGoal}
                      theme={theme}
                      themeStyles={themeStyles}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {editModalOpen && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2100,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={closeEditModal}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={i18n('Develop edit pool')}
            style={{
              background: themeStyles.bgCard,
              borderRadius: 16,
              maxWidth: 640,
              width: '100%',
              maxHeight: '90vh',
              overflow: 'auto',
              border: `1px solid ${themeStyles.border}`,
              boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 20, borderBottom: `1px solid ${themeStyles.border}` }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: themeStyles.textPrimary }}>
                {i18n('Develop edit pool')}
              </div>
              <div style={{ fontSize: 12, color: themeStyles.textSecondary, marginTop: 6 }}>
                {i18n('Develop edit pool hint')}
              </div>
            </div>
            <div style={{ padding: 16 }}>
              {!learnBases.length ? (
                <p style={{ color: themeStyles.textSecondary }}>{i18n('Develop no bases')}</p>
              ) : (
                <>
                  {editDraft.map((row, idx) => {
                    const b = baseMeta.get(row.baseDocId);
                    const branches = b?.branches?.length ? b.branches : ['main'];
                    return (
                      <div
                        key={`edit-${idx}-${row.baseDocId}`}
                        style={{
                          marginBottom: 12,
                          padding: 12,
                          borderRadius: 10,
                          border: `1px solid ${themeStyles.border}`,
                          background: theme === 'dark' ? 'rgba(0,0,0,0.2)' : '#f9fafb',
                        }}
                      >
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                          <select
                            value={row.baseDocId}
                            onChange={(ev) => {
                              const docId = parseInt(ev.target.value, 10);
                              const nb = baseMeta.get(docId);
                              const brs = nb?.branches?.length ? nb.branches : ['main'];
                              updateEditRow(idx, { baseDocId: docId, branch: brs[0] || 'main' });
                            }}
                            style={{
                              flex: '1 1 200px',
                              padding: 6,
                              borderRadius: 8,
                              border: `1px solid ${themeStyles.border}`,
                              background: themeStyles.bgCard,
                              color: themeStyles.textPrimary,
                            }}
                          >
                            {learnBases.map((lb) => (
                              <option key={lb.docId} value={lb.docId}>{(lb.title || '').trim() || lb.docId}</option>
                            ))}
                          </select>
                          <select
                            value={row.branch}
                            onChange={(ev) => updateEditRow(idx, { branch: ev.target.value })}
                            style={{
                              flex: '0 1 140px',
                              padding: 6,
                              borderRadius: 8,
                              border: `1px solid ${themeStyles.border}`,
                              background: themeStyles.bgCard,
                              color: themeStyles.textPrimary,
                            }}
                          >
                            {branches.map((br) => (
                              <option key={br} value={br}>{br}</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                          {(['dailyNodeGoal', 'dailyCardGoal', 'dailyProblemGoal'] as const).map((field) => (
                            <label
                              key={field}
                              style={{ display: 'flex', flexDirection: 'column', fontSize: 11, color: themeStyles.textSecondary, gap: 4 }}
                            >
                              {field === 'dailyNodeGoal' ? i18n('Develop goal nodes') : field === 'dailyCardGoal' ? i18n('Develop goal cards') : i18n('Develop goal problems')}
                              <input
                                type="number"
                                min={0}
                                value={row[field]}
                                onChange={(ev) => {
                                  const v = Math.max(0, parseInt(ev.target.value, 10) || 0);
                                  updateEditRow(idx, { [field]: v });
                                }}
                                style={{
                                  width: 88,
                                  padding: 6,
                                  borderRadius: 8,
                                  border: `1px solid ${themeStyles.border}`,
                                  background: themeStyles.bgCard,
                                  color: themeStyles.textPrimary,
                                }}
                              />
                            </label>
                          ))}
                          <button
                            type="button"
                            onClick={() => removeEditRow(idx)}
                            style={{
                              marginLeft: 'auto',
                              padding: '6px 10px',
                              borderRadius: 8,
                              border: `1px solid ${themeStyles.border}`,
                              background: 'transparent',
                              color: themeStyles.textSecondary,
                              cursor: 'pointer',
                            }}
                          >
                            {i18n('Remove')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    onClick={addEditRow}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 10,
                      border: `1px solid ${themeStyles.border}`,
                      background: themeStyles.bgCard,
                      color: themeStyles.textPrimary,
                      cursor: 'pointer',
                      marginBottom: 12,
                    }}
                  >
                    {i18n('Develop add row')}
                  </button>
                </>
              )}
            </div>
            <div style={{ padding: 12, borderTop: `1px solid ${themeStyles.border}`, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                disabled={saving}
                onClick={closeEditModal}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 10,
                  border: `1px solid ${themeStyles.border}`,
                  background: 'transparent',
                  color: themeStyles.textPrimary,
                  cursor: saving ? 'wait' : 'pointer',
                }}
              >
                {i18n('Cancel')}
              </button>
              <button
                type="button"
                disabled={saving || !learnBases.length}
                onClick={() => { void savePoolFromEdit(); }}
                style={{
                  flex: 1,
                  padding: 10,
                  borderRadius: 10,
                  border: 'none',
                  background: themeStyles.primary,
                  color: '#fff',
                  cursor: saving || !learnBases.length ? 'not-allowed' : 'pointer',
                  opacity: !learnBases.length ? 0.6 : 1,
                }}
              >
                {saving ? i18n('Saving...') : i18n('Develop save pool')}
              </button>
            </div>
          </div>
        </div>
      )}

      {startModalOpen && (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setStartModalOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              background: themeStyles.bgCard,
              borderRadius: 16,
              maxWidth: 560,
              width: '100%',
              maxHeight: '85vh',
              overflow: 'auto',
              border: `1px solid ${themeStyles.border}`,
              boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 20, borderBottom: `1px solid ${themeStyles.border}` }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: themeStyles.textPrimary }}>
                {i18n('Develop pick branch')}
              </div>
              <div style={{ fontSize: 12, color: themeStyles.textSecondary, marginTop: 6 }}>
                {i18n('Develop today progress')}
              </div>
            </div>
            <div style={{ padding: 12 }}>
              {modalRows.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => { window.location.href = r.editorUrl; }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: 14,
                    marginBottom: 8,
                    borderRadius: 12,
                    border: `1px solid ${themeStyles.border}`,
                    background: theme === 'dark' ? 'rgba(0,0,0,0.2)' : '#f9fafb',
                    color: themeStyles.textPrimary,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>{r.title} · {r.branch}</div>
                  <div style={{ fontSize: 12, color: themeStyles.textSecondary, lineHeight: 1.5 }}>
                    {i18n('Develop today nodes')}: {r.nodes}/{r.dailyNodeGoal} · {i18n('Develop today cards')}: {r.cards}/{r.dailyCardGoal} · {i18n('Develop today problems')}: {r.problems}/{r.dailyProblemGoal}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ padding: 12, borderTop: `1px solid ${themeStyles.border}` }}>
              <button
                type="button"
                onClick={() => setStartModalOpen(false)}
                style={{
                  width: '100%',
                  padding: 10,
                  borderRadius: 10,
                  border: `1px solid ${themeStyles.border}`,
                  background: 'transparent',
                  color: themeStyles.textPrimary,
                  cursor: 'pointer',
                }}
              >
                {i18n('Cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const page = new NamedPage('developPage', async () => {
  try {
    const container = document.getElementById('develop-container');
    if (!container) return;
    ReactDOM.render(<DevelopPage />, container);
  } catch (err) {
    console.error('develop page render failed', err);
  }
});

export default page;
