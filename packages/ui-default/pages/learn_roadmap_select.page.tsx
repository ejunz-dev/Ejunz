import React, { useMemo, useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';

interface LearnRoadmapItem {
  docId: number;
  title?: string;
  branches?: string[];
}

function LearnRoadmapSelectPage() {
  const domainId = (window as any).UiContext?.domainId as string;
  const learnRoadmaps = ((window as any).UiContext?.learnRoadmaps || []) as LearnRoadmapItem[];
  const selectedLearnRoadmapDocIdRaw = (window as any).UiContext?.selectedLearnRoadmapDocId;
  const selectedLearnRoadmapDocId =
    selectedLearnRoadmapDocIdRaw != null && selectedLearnRoadmapDocIdRaw !== ''
      ? Number(selectedLearnRoadmapDocIdRaw)
      : null;
  const initialBranch = String((window as any).UiContext?.learnBranch || 'main').trim() || 'main';
  const redirect = ((window as any).UiContext?.redirect as string) || `/d/${domainId}/learn`;

  const [roadmapDocId, setRoadmapDocId] = useState<number | null>(() => {
    if (selectedLearnRoadmapDocId != null && Number.isFinite(selectedLearnRoadmapDocId) && selectedLearnRoadmapDocId > 0) {
      return selectedLearnRoadmapDocId;
    }
    const first = learnRoadmaps[0];
    return first ? Number(first.docId) : null;
  });
  const selectedRoadmap = useMemo(
    () => (roadmapDocId != null ? learnRoadmaps.find((r) => Number(r.docId) === roadmapDocId) || null : null),
    [learnRoadmaps, roadmapDocId],
  );
  const branchChoices = useMemo(() => {
    const raw = selectedRoadmap?.branches;
    if (Array.isArray(raw) && raw.length > 0) return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
    return ['main'];
  }, [selectedRoadmap]);
  const [branch, setBranch] = useState(initialBranch);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!branchChoices.includes(branch)) {
      setBranch(branchChoices[0] || 'main');
    }
  }, [branchChoices, branch]);

  const empty = useMemo(() => !learnRoadmaps || learnRoadmaps.length === 0, [learnRoadmaps]);

  const handleSubmit = async () => {
    if (roadmapDocId == null || saving) return;
    setSaving(true);
    try {
      await request.post(`/d/${domainId}/learn/roadmap`, { roadmapDocId, branch: branch || 'main' });
      window.location.href = redirect;
    } catch (error: any) {
      const msg = error?.response?.data?.message ?? error?.response?.data?.error ?? error?.message ?? i18n('Failed to save');
      Notification.error(typeof msg === 'string' ? msg : i18n('Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('theme--dark');
  const theme = {
    bgPage: isDark ? '#0f0f0f' : '#f6f8fb',
    card: isDark ? '#1b1d20' : '#ffffff',
    textPrimary: isDark ? '#e8eaed' : '#111827',
    textSecondary: isDark ? '#9ca3af' : '#6b7280',
    border: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    primary: '#2563eb',
    primaryHover: '#1d4ed8',
    optionBg: isDark ? '#111317' : '#fafafa',
    optionSelectedBg: isDark ? 'rgba(37,99,235,0.16)' : 'rgba(37,99,235,0.08)',
  };

  return (
    <div style={{ minHeight: '70vh', padding: '16px 0 24px', background: theme.bgPage }}>
      <div style={{ maxWidth: 760, margin: '0 auto', padding: '0 12px' }}>
        <div
          style={{
            background: theme.card,
            border: `1px solid ${theme.border}`,
            borderRadius: 16,
            padding: '20px 18px',
            boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.35)' : '0 8px 24px rgba(15,23,42,0.08)',
          }}
        >
          <h1 style={{ margin: 0, marginBottom: 8, color: theme.textPrimary }}>
            {i18n('Select learn roadmap and branch')}
          </h1>
          <div style={{ marginBottom: 16, color: theme.textSecondary, fontSize: 13 }}>
            {i18n('Choose which roadmap and branch to use for Learn.')}
          </div>
          {empty ? (
            <div>
              <div className="note" style={{ marginBottom: 12 }}>
                {i18n('No roadmap in this domain.')}
              </div>
              <a className="button" href={`/d/${domainId}/`}>
                {i18n('Back')}
              </a>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>{i18n('Roadmap')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {learnRoadmaps.map((r) => {
                    const id = Number(r.docId);
                    const selected = roadmapDocId === id;
                    return (
                      <label
                        key={id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          border: `1px solid ${selected ? theme.primary : theme.border}`,
                          background: selected ? theme.optionSelectedBg : theme.optionBg,
                          borderRadius: 10,
                          padding: '10px 12px',
                          cursor: 'pointer',
                          color: theme.textPrimary,
                        }}
                      >
                        <input
                          type="radio"
                          name="learnRoadmapDocId"
                          value={id}
                          checked={selected}
                          onChange={() => setRoadmapDocId(id)}
                        />
                        <span style={{ fontWeight: selected ? 600 : 500 }}>{r.title || String(id)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>{i18n('Branch')}</div>
                <select
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  disabled={!selectedRoadmap}
                  style={{
                    width: '100%',
                    maxWidth: 420,
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: `1px solid ${theme.border}`,
                    background: theme.optionBg,
                    color: theme.textPrimary,
                  }}
                >
                  {branchChoices.map((br) => (
                    <option key={br} value={br}>
                      {br}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={saving || roadmapDocId == null}
                  style={{
                    border: 0,
                    borderRadius: 10,
                    padding: '10px 16px',
                    color: '#fff',
                    background: saving || roadmapDocId == null ? '#9ca3af' : theme.primary,
                    cursor: saving || roadmapDocId == null ? 'not-allowed' : 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!saving && roadmapDocId != null) e.currentTarget.style.background = theme.primaryHover;
                  }}
                  onMouseLeave={(e) => {
                    if (!saving && roadmapDocId != null) e.currentTarget.style.background = theme.primary;
                  }}
                >
                  {saving ? i18n('Saving...') : i18n('Save')}
                </button>
                <a
                  href={redirect}
                  style={{
                    borderRadius: 10,
                    padding: '10px 16px',
                    border: `1px solid ${theme.border}`,
                    color: theme.textPrimary,
                    textDecoration: 'none',
                    background: theme.optionBg,
                  }}
                >
                  {i18n('Cancel')}
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const page = new NamedPage('learn_roadmap_select', async () => {
  const container = document.getElementById('learn-roadmap-select-container');
  if (!container) return;
  ReactDOM.render(<LearnRoadmapSelectPage />, container);
});

export default page;
