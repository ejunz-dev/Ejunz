import React, { useMemo, useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';

interface LearnBaseItem {
  docId: number;
  title?: string;
  branches?: string[];
}

function LearnBaseSelectPage() {
  const domainId = (window as any).UiContext?.domainId as string;
  const learnBases = ((window as any).UiContext?.learnBases || []) as LearnBaseItem[];
  const selectedLearnBaseDocIdRaw = (window as any).UiContext?.selectedLearnBaseDocId;
  const selectedLearnBaseDocId =
    selectedLearnBaseDocIdRaw != null && selectedLearnBaseDocIdRaw !== ''
      ? Number(selectedLearnBaseDocIdRaw)
      : null;
  const initialBranch = String((window as any).UiContext?.learnBranch || 'main').trim() || 'main';
  const redirect = ((window as any).UiContext?.redirect as string) || `/d/${domainId}/learn`;

  const [baseDocId, setBaseDocId] = useState<number | null>(() => {
    if (selectedLearnBaseDocId != null && Number.isFinite(selectedLearnBaseDocId) && selectedLearnBaseDocId > 0) {
      return selectedLearnBaseDocId;
    }
    const first = learnBases[0];
    return first ? Number(first.docId) : null;
  });
  const selectedBase = useMemo(
    () => (baseDocId != null ? learnBases.find((b) => Number(b.docId) === baseDocId) || null : null),
    [learnBases, baseDocId],
  );
  const branchChoices = useMemo(() => {
    const raw = selectedBase?.branches;
    if (Array.isArray(raw) && raw.length > 0) return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
    return ['main'];
  }, [selectedBase]);
  const [branch, setBranch] = useState(initialBranch);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!branchChoices.includes(branch)) {
      setBranch(branchChoices[0] || 'main');
    }
  }, [branchChoices, branch]);

  const empty = useMemo(() => !learnBases || learnBases.length === 0, [learnBases]);

  const handleSubmit = async () => {
    if (baseDocId == null || saving) return;
    setSaving(true);
    try {
      await request.post(`/d/${domainId}/learn/base`, { baseDocId, branch: branch || 'main' });
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
            {i18n('Select learn base and branch')}
          </h1>
          <div style={{ marginBottom: 16, color: theme.textSecondary, fontSize: 13 }}>
            {i18n('Choose which knowledge base and branch to use for Learn.')}
          </div>
          {empty ? (
            <div>
              <div className="note" style={{ marginBottom: 12 }}>
                {i18n('No knowledge base in this domain.')}
              </div>
              <a className="button" href={`/d/${domainId}/`}>
                {i18n('Back')}
              </a>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <div style={{ fontSize: 12, color: theme.textSecondary, marginBottom: 8 }}>{i18n('Knowledge base')}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {learnBases.map((b) => {
                    const id = Number(b.docId);
                    const selected = baseDocId === id;
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
                          name="learnBaseDocId"
                          value={id}
                          checked={selected}
                          onChange={() => setBaseDocId(id)}
                        />
                        <span style={{ fontWeight: selected ? 600 : 500 }}>{b.title || String(id)}</span>
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
                  disabled={!selectedBase}
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
                  disabled={saving || baseDocId == null}
                  style={{
                    border: 0,
                    borderRadius: 10,
                    padding: '10px 16px',
                    color: '#fff',
                    background: saving || baseDocId == null ? '#9ca3af' : theme.primary,
                    cursor: saving || baseDocId == null ? 'not-allowed' : 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!saving && baseDocId != null) e.currentTarget.style.background = theme.primaryHover;
                  }}
                  onMouseLeave={(e) => {
                    if (!saving && baseDocId != null) e.currentTarget.style.background = theme.primary;
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

const page = new NamedPage(['learn_training_select', 'learn_base_select'], async () => {
  const container = document.getElementById('learn-training-select-container');
  if (!container) return;
  ReactDOM.render(<LearnBaseSelectPage />, container);
});

export default page;
