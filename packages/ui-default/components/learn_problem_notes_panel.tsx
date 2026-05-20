import React, { useCallback, useEffect, useState } from 'react';
import moment from 'moment';
import 'moment/locale/zh-cn';
import { i18n, request } from 'vj/utils';
import Notification from 'vj/components/notification';
import type { ProblemAuthorNote } from 'ejun/src/interface';

export type LearnerNoteWire = {
  id: string;
  uid: number;
  uname: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
};

function mapProblemNoteWire(x: unknown): LearnerNoteWire {
  const o = x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
  const u: LearnerNoteWire = {
    id: String(o.id || ''),
    uid: Number(o.uid) || 0,
    uname: String(o.uname || ''),
    content: String(o.content || ''),
    createdAt: String(o.createdAt || ''),
  };
  if (typeof o.updatedAt === 'string' && o.updatedAt) u.updatedAt = o.updatedAt;
  return u;
}

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
  /** Optional: sync badge count after user deletes own note. */
  onAfterRemove?: () => void;
}) {
  const { domainId, cardId, pid, authorNotes, theme, onAfterAdd, onAfterRemove } = props;
  const [learnerNotes, setLearnerNotes] = useState<LearnerNoteWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const lang = String(
      (typeof window !== 'undefined' && (window as any).UserContext?.viewLang)
        || (typeof document !== 'undefined' ? document.documentElement.lang : '')
        || 'en',
    ).toLowerCase();
    moment.locale(lang.startsWith('zh') ? 'zh-cn' : 'en');
  }, []);

  const currentUid = typeof window !== 'undefined' ? Number((window as any).UserContext?._id) || 0 : 0;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res: any = await request.get(`/d/${domainId}/learn/problem-notes`, { cardId, pid });
      const list = Array.isArray(res?.learnerNotes) ? res.learnerNotes : [];
      setLearnerNotes(list.map((x: unknown) => mapProblemNoteWire(x)));
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
        setLearnerNotes((prev) => [mapProblemNoteWire(n), ...prev]);
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

  const submitEdit = async (noteId: string) => {
    const text = editDraft.trim();
    if (!text || savingEditId || deletingId) return;
    setSavingEditId(noteId);
    try {
      const res: any = await request.post(`/d/${domainId}/learn/problem-notes`, {
        noteId,
        cardId,
        pid,
        content: text,
      });
      const n = res?.note;
      if (n && typeof n === 'object') {
        const wired = mapProblemNoteWire(n);
        setLearnerNotes((prev) => prev.map((row) => (row.id === noteId ? wired : row)));
        setEditingId(null);
        setEditDraft('');
        Notification.success(i18n('Lesson problem notes updated'));
        onAfterAdd?.();
      }
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        ?? (err as Error)?.message
        ?? i18n('Lesson problem notes save failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setSavingEditId(null);
    }
  };

  const submitDelete = async (noteId: string) => {
    if (!window.confirm(String(i18n('Lesson problem notes delete confirm')))) return;
    if (deletingId) return;
    setDeletingId(noteId);
    if (editingId === noteId) {
      setEditingId(null);
      setEditDraft('');
    }
    try {
      const res: any = await request.post(`/d/${domainId}/learn/problem-notes`, {
        noteId,
        cardId,
        pid,
        noteDelete: true,
      });
      if (res?.success) {
        setLearnerNotes((prev) => prev.filter((row) => row.id !== noteId));
        Notification.success(i18n('Lesson problem notes deleted'));
        onAfterRemove?.();
      }
    } catch (err: unknown) {
      console.error(err);
      const msg = (err as { response?: { data?: { message?: string } }; message?: string })?.response?.data?.message
        ?? (err as Error)?.message
        ?? i18n('Lesson problem notes delete failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setDeletingId(null);
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
          ? learnerNotes.map((n) => {
              const isMine = currentUid > 0 && n.uid === currentUid;
              const postedAgo = n.createdAt ? moment(n.createdAt).fromNow() : '';
              const showEdited = Boolean(n.updatedAt);
              const editing = editingId === n.id;
              return (
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
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ fontWeight: 700, color: theme.textPrimary }}>{n.uname}</span>
                    {postedAgo ? (
                      <span style={{ fontSize: 12, color: theme.textTertiary }}>{postedAgo}</span>
                    ) : null}
                    {isMine && !editing ? (
                      <div
                        style={{
                          marginLeft: 'auto',
                          display: 'flex',
                          gap: 8,
                          flexShrink: 0,
                          alignItems: 'center',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (deletingId) return;
                            setEditingId(n.id);
                            setEditDraft(n.content);
                          }}
                          disabled={!!deletingId}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: `1px solid ${theme.border}`,
                            backgroundColor: theme.bgSecondary,
                            color: theme.accent,
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: deletingId ? 'not-allowed' : 'pointer',
                            opacity: deletingId ? 0.5 : 1,
                          }}
                        >
                          {i18n('Lesson problem notes edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { void submitDelete(n.id); }}
                          disabled={!!deletingId}
                          style={{
                            padding: '4px 10px',
                            borderRadius: 6,
                            border: '1px solid rgba(198,40,40,0.4)',
                            backgroundColor: theme.bgSecondary,
                            color: '#c62828',
                            fontSize: 12,
                            fontWeight: 600,
                            cursor: deletingId ? 'not-allowed' : 'pointer',
                            opacity: deletingId ? 0.5 : 1,
                          }}
                        >
                          {deletingId === n.id
                            ? i18n('Lesson problem notes deleting')
                            : i18n('Lesson problem notes delete')}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {showEdited && n.updatedAt ? (
                    <div style={{ fontSize: 12, color: theme.textTertiary, marginBottom: 8 }}>
                      {i18n('Lesson problem notes edited at', [moment(n.updatedAt).fromNow()])}
                    </div>
                  ) : null}
                  {editing ? (
                    <>
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        style={{ ...fld, minHeight: 72, marginTop: 0 }}
                        disabled={!!savingEditId || !!deletingId}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <button
                          type="button"
                          onClick={() => { void submitEdit(n.id); }}
                          disabled={
                            !!savingEditId
                            || !!deletingId
                            || !editDraft.trim()
                            || editDraft.trim() === n.content.trim()
                          }
                          style={{
                            padding: '8px 14px',
                            borderRadius: 8,
                            border: 'none',
                            backgroundColor: theme.accent,
                            color: '#fff',
                            fontSize: 13,
                            fontWeight: 600,
                            cursor:
                              savingEditId || deletingId || !editDraft.trim() || editDraft.trim() === n.content.trim()
                                ? 'not-allowed'
                                : 'pointer',
                            opacity:
                              savingEditId || deletingId || !editDraft.trim() || editDraft.trim() === n.content.trim()
                                ? 0.55
                                : 1,
                          }}
                        >
                          {savingEditId === n.id
                            ? i18n('Lesson problem notes submitting')
                            : i18n('Lesson problem notes save edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(null);
                            setEditDraft('');
                          }}
                          disabled={!!savingEditId || !!deletingId}
                          style={{
                            padding: '8px 14px',
                            borderRadius: 8,
                            border: `1px solid ${theme.border}`,
                            backgroundColor: theme.bgSecondary,
                            color: theme.textPrimary,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: savingEditId || deletingId ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {i18n('Lesson problem notes cancel edit')}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={{ color: theme.textSecondary, whiteSpace: 'pre-wrap' }}>{n.content}</div>
                  )}
                </div>
              );
            })
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
