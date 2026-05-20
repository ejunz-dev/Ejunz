import React, { useCallback, useEffect, useState } from 'react';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';
import type { ProblemAuthorNote } from 'ejun/src/interface';

export type LearnerNoteWire = {
  id: string;
  uid: number;
  uname: string;
  content: string;
  createdAt: string;
};

type Theme = {
  bgPrimary: string;
  bgSecondary: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentMutedBg: string;
};

/** Fetch + list notes on a problem (from card + learner); add new learner note. */
export function LearnProblemNotesPanelBody(props: {
  domainId: string;
  cardId: string;
  pid: string;
  authorNotes: ProblemAuthorNote[];
  theme: Theme;
  onAfterAdd?: () => void;
}) {
  const { domainId, cardId, pid, authorNotes, theme, onAfterAdd } = props;
  const [learnerNotes, setLearnerNotes] = useState<LearnerNoteWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await request.get(`/d/${domainId}/learn/problem-notes`, { cardId, pid });
      const list = Array.isArray(res?.learnerNotes) ? res.learnerNotes : [];
      setLearnerNotes(
        list.map((x: any) => ({
          id: String(x.id || ''),
          uid: Number(x.uid) || 0,
          uname: String(x.uname || ''),
          content: String(x.content || ''),
          createdAt: String(x.createdAt || ''),
        })),
      );
    } catch (e) {
      console.error(e);
      Notification.error(i18n('Lesson problem notes load failed'));
      setLearnerNotes([]);
    } finally {
      setLoading(false);
    }
  }, [domainId, cardId, pid]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    try {
      const res: any = await request.post(`/d/${domainId}/learn/problem-notes`, {
        cardId,
        pid,
        content: text,
      });
      const n = res?.note;
      if (n && typeof n === 'object') {
        setLearnerNotes((prev) => [{
          id: String(n.id || ''),
          uid: Number(n.uid) || 0,
          uname: String(n.uname || ''),
          content: String(n.content || ''),
          createdAt: String(n.createdAt || ''),
        }, ...prev]);
        setDraft('');
        Notification.success(i18n('Lesson problem notes saved'));
        onAfterAdd?.();
      }
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        ?? (err as Error)?.message
        ?? i18n('Lesson problem notes save failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setSubmitting(false);
    }
  };

  const fld: React.CSSProperties = {
    width: '100%',
    minHeight: 88,
    padding: '10px 12px',
    borderRadius: 8,
    border: `1px solid ${theme.border}`,
    backgroundColor: theme.bgPrimary,
    color: theme.textPrimary,
    fontSize: 14,
    lineHeight: 1.5,
    boxSizing: 'border-box',
    resize: 'vertical' as const,
  };

  const btn: React.CSSProperties = {
    marginTop: 10,
    padding: '10px 18px',
    borderRadius: 8,
    border: 'none',
    backgroundColor: theme.accent,
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: submitting ? 'not-allowed' : 'pointer',
    opacity: submitting ? 0.7 : 1,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {authorNotes.map((n) => (
          <div
            key={n.id}
            style={{
              padding: '10px 12px',
              borderRadius: 8,
              border: `1px solid ${theme.border}`,
              backgroundColor: theme.bgSecondary,
              fontSize: 14,
              color: theme.textPrimary,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}
          >
            {n.text}
          </div>
        ))}
        {loading ? (
          <div style={{ fontSize: 13, color: theme.textTertiary }}>{i18n('Loading...')}</div>
        ) : null}
        {!loading
          ? learnerNotes.map((n) => (
              <div
                key={n.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: `1px solid ${theme.border}`,
                  backgroundColor: theme.bgPrimary,
                  fontSize: 14,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700, color: theme.textPrimary, marginBottom: 4 }}>{n.uname}</div>
                <div style={{ color: theme.textSecondary, whiteSpace: 'pre-wrap' }}>{n.content}</div>
              </div>
            ))
          : null}
        {!loading && authorNotes.length === 0 && learnerNotes.length === 0 ? (
          <div style={{ fontSize: 13, color: theme.textTertiary, marginBottom: 8 }}>
            {i18n('Lesson problem notes empty list')}
          </div>
        ) : null}
      </div>

      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: theme.textSecondary, marginBottom: 8 }}>
          {i18n('Lesson problem notes add')}
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={i18n('Lesson problem notes placeholder')}
          style={fld}
          disabled={submitting}
        />
        <button type="button" style={btn} disabled={submitting || !draft.trim()} onClick={() => { void submit(); }}>
          {submitting ? i18n('Lesson problem notes submitting') : i18n('Lesson problem notes submit')}
        </button>
      </div>
    </div>
  );
}
