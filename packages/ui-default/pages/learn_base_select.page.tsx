import React, { useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { NamedPage } from 'vj/misc/Page';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';

interface LearnTrainingItem {
  docId: string;
  name?: string;
  baseDocId?: number;
}

function LearnBaseSelectPage() {
  const domainId = (window as any).UiContext?.domainId as string;
  const trainings = ((window as any).UiContext?.trainings || []) as LearnTrainingItem[];
  const selectedTrainingDocId = String((window as any).UiContext?.selectedTrainingDocId || '').trim() || null;
  const redirect = ((window as any).UiContext?.redirect as string) || `/d/${domainId}/learn`;
  const [current, setCurrent] = useState<string | null>(selectedTrainingDocId ?? (trainings[0]?.docId ?? null));
  const [saving, setSaving] = useState(false);

  const empty = useMemo(() => !trainings || trainings.length === 0, [trainings]);

  const handleSubmit = async () => {
    if (!current || saving) return;
    setSaving(true);
    try {
      await request.post(`/d/${domainId}/learn/base`, { trainingDocId: current });
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
      <div
        style={{
          maxWidth: 760,
          margin: '0 auto',
          padding: '0 12px',
        }}
      >
        <div
          style={{
            background: theme.card,
            border: `1px solid ${theme.border}`,
            borderRadius: 16,
            padding: '20px 18px',
            boxShadow: isDark ? '0 8px 24px rgba(0,0,0,0.35)' : '0 8px 24px rgba(15,23,42,0.08)',
          }}
        >
          <h1 style={{ margin: 0, marginBottom: 8, color: theme.textPrimary }}>{i18n('Select Learn Training')}</h1>
          <div style={{ marginBottom: 16, color: theme.textSecondary, fontSize: 13 }}>
            {i18n('Select one training plan as your learning source, then continue to learn.')}
          </div>
          {empty ? (
            <div>
              <div className="note" style={{ marginBottom: 12 }}>{i18n('No training available in this domain.')}</div>
              <a className="button" href={`/d/${domainId}/training`}>{i18n('Go To Training List')}</a>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {trainings.map((training) => {
                const selected = String(current) === String(training.docId);
                return (
                  <label
                    key={training.docId}
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
                      name="trainingDocId"
                      value={training.docId}
                      checked={selected}
                      onChange={() => setCurrent(training.docId)}
                    />
                    <span style={{ fontWeight: selected ? 600 : 500 }}>
                      {training.name || i18n('Untitled training')}
                    </span>
                  </label>
                );
              })}
              <div style={{ marginTop: 8, display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={saving || !current}
                  style={{
                    border: 0,
                    borderRadius: 10,
                    padding: '10px 16px',
                    color: '#fff',
                    background: saving || !current ? '#9ca3af' : theme.primary,
                    cursor: saving || !current ? 'not-allowed' : 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!saving && current) e.currentTarget.style.background = theme.primaryHover;
                  }}
                  onMouseLeave={(e) => {
                    if (!saving && current) e.currentTarget.style.background = theme.primary;
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

