import { useCallback, useEffect, useRef, useState } from 'react';
import type { Problem } from 'ejun/src/interface';
import { getProblemAuthorNoteList } from 'ejun/src/model/problem';
import { i18n } from '../../i18n';
import Notification from '../notification';
import { requestJson } from '../base-detail/base-detail-api';

export interface LearnerNote {
  id: string;
  uid: number;
  uname: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
}

interface Props {
  open: boolean;
  problem: Problem | null;
  cardId: string;
  domainId: string;
  onCountChange: (pid: string, count: number) => void;
  onClose: () => void;
}

function mapNote(raw: unknown): LearnerNote {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const note: LearnerNote = {
    id: String(value.id || ''),
    uid: Number(value.uid) || 0,
    uname: String(value.uname || ''),
    content: String(value.content || ''),
    createdAt: String(value.createdAt || ''),
  };
  if (typeof value.updatedAt === 'string' && value.updatedAt) note.updatedAt = value.updatedAt;
  return note;
}

function noteTime(note: LearnerNote, edited: boolean): string {
  const raw = edited && note.updatedAt ? note.updatedAt : note.createdAt;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
}

export function LessonNotesPanel({ open, problem, cardId, domainId, onCountChange, onClose }: Props) {
  const pid = String(problem?.pid || '');
  const authorNotes = problem ? getProblemAuthorNoteList(problem) : [];
  const [notes, setNotes] = useState<LearnerNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const countChangeRef = useRef(onCountChange);
  countChangeRef.current = onCountChange;

  useEffect(() => {
    if (!open || !pid || !cardId) return undefined;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const response = await requestJson<{ learnerNotes?: unknown[] }>(
          `/learn/problem-notes?cardId=${encodeURIComponent(cardId)}&pid=${encodeURIComponent(pid)}`,
          { domainId, acceptJson: true },
        );
        if (cancelled) return;
        const list = Array.isArray(response?.learnerNotes) ? response.learnerNotes.map(mapNote) : [];
        setNotes(list);
        countChangeRef.current(pid, list.length);
      } catch {
        if (cancelled) return;
        Notification.error(i18n('Lesson problem notes load failed'));
        setNotes([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, pid, cardId, domainId]);

  useEffect(() => {
    if (!open) {
      setDraft('');
      setEditingId(null);
      setEditDraft('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || submitting || !pid || !cardId) return;
    setSubmitting(true);
    try {
      const response = await requestJson<{ note?: unknown }>('/learn/problem-notes', {
        domainId,
        acceptJson: true,
        body: { cardId, pid, content: text },
      });
      const note = response?.note ? mapNote(response.note) : null;
      if (note) {
        setNotes((prev) => {
          const next = [note, ...prev];
          countChangeRef.current(pid, next.length);
          return next;
        });
        setDraft('');
        Notification.success(i18n('Lesson problem notes saved'));
      }
    } catch (error: any) {
      Notification.error(typeof error?.message === 'string' ? error.message : i18n('Lesson problem notes save failed'));
    } finally {
      setSubmitting(false);
    }
  }, [draft, submitting, pid, cardId, domainId]);

  const submitEdit = useCallback(async (noteId: string) => {
    const text = editDraft.trim();
    if (!text || savingEditId || !pid || !cardId) return;
    setSavingEditId(noteId);
    try {
      const response = await requestJson<{ note?: unknown }>('/learn/problem-notes', {
        domainId,
        acceptJson: true,
        body: { noteId, cardId, pid, content: text },
      });
      const note = response?.note ? mapNote(response.note) : null;
      if (note) {
        setNotes((prev) => prev.map((row) => (row.id === noteId ? note : row)));
        setEditingId(null);
        setEditDraft('');
        Notification.success(i18n('Lesson problem notes updated'));
      }
    } catch (error: any) {
      Notification.error(typeof error?.message === 'string' ? error.message : i18n('Lesson problem notes save failed'));
    } finally {
      setSavingEditId(null);
    }
  }, [editDraft, savingEditId, pid, cardId, domainId]);

  const submitDelete = useCallback(async (noteId: string) => {
    if (!window.confirm(String(i18n('Lesson problem notes delete confirm')))) return;
    if (deletingId || !pid || !cardId) return;
    setDeletingId(noteId);
    try {
      const response = await requestJson<{ success?: boolean }>('/learn/problem-notes', {
        domainId,
        acceptJson: true,
        body: { noteId, cardId, pid, noteDelete: true },
      });
      if (response?.success) {
        setNotes((prev) => {
          const next = prev.filter((row) => row.id !== noteId);
          countChangeRef.current(pid, next.length);
          return next;
        });
        if (editingId === noteId) setEditingId(null);
        Notification.success(i18n('Lesson problem notes deleted'));
      }
    } catch (error: any) {
      Notification.error(typeof error?.message === 'string' ? error.message : i18n('Lesson problem notes delete failed'));
    } finally {
      setDeletingId(null);
    }
  }, [deletingId, pid, cardId, domainId, editingId]);

  if (!open || !problem) return null;

  return (
    <div className="lesson-panel" role="dialog" aria-modal="true" aria-label={i18n('Lesson problem notes panel title')}>
      <button type="button" className="lesson-panel__scrim" aria-label={i18n('Close')} onClick={onClose} />
      <div className="lesson-panel__body">
        <div className="lesson-panel__head">
          <h2 className="lesson-panel__title">{i18n('Lesson problem notes panel title')}</h2>
          <button type="button" className="lesson-panel__close" onClick={onClose}>{i18n('Close')}</button>
        </div>

        <div className="lesson-panel__section">
          {authorNotes.map((note) => (
            <p className="lesson-note lesson-note--author" key={note.id}>{note.text}</p>
          ))}
          {loading ? <p className="lesson-panel__empty">{i18n('Loading...')}</p> : null}
          {!loading ? notes.map((note) => (
            <div className="lesson-note" key={note.id}>
              {editingId === note.id ? (
                <>
                  <textarea
                    rows={3}
                    value={editDraft}
                    onChange={(event) => {
                      const typed = event.currentTarget.value;
                      setEditDraft(typed);
                    }}
                  />
                  <div className="lesson-note__actions">
                    <button type="button" disabled={savingEditId === note.id} onClick={() => void submitEdit(note.id)}>
                      {savingEditId === note.id ? i18n('Lesson problem notes submitting') : i18n('Lesson problem notes save edit')}
                    </button>
                    <button type="button" onClick={() => { setEditingId(null); setEditDraft(''); }}>
                      {i18n('Lesson problem notes cancel edit')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="lesson-note__content">{note.content}</p>
                  <div className="lesson-note__meta">
                    <span>{noteTime(note, false)}</span>
                    {note.updatedAt ? <span>{i18n('Lesson problem notes edited at', noteTime(note, true))}</span> : null}
                  </div>
                  <div className="lesson-note__actions">
                    <button type="button" onClick={() => { setEditingId(note.id); setEditDraft(note.content); }}>
                      {i18n('Lesson problem notes edit')}
                    </button>
                    <button type="button" disabled={deletingId === note.id} onClick={() => void submitDelete(note.id)}>
                      {deletingId === note.id ? i18n('Lesson problem notes deleting') : i18n('Lesson problem notes delete')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )) : null}
          {!loading && !authorNotes.length && !notes.length ? (
            <p className="lesson-panel__empty">{i18n('Lesson problem notes empty list')}</p>
          ) : null}
        </div>

        <div className="lesson-panel__section">
          <div className="lesson-panel__label">{i18n('Lesson problem notes add')}</div>
          <textarea
            className="lesson-note__draft"
            rows={3}
            value={draft}
            placeholder={i18n('Lesson problem notes placeholder')}
            disabled={submitting}
            onChange={(event) => {
              const typed = event.currentTarget.value;
              setDraft(typed);
            }}
          />
          <div className="lesson-note__actions">
            <button type="button" className="lesson-btn is-primary" disabled={submitting || !draft.trim()} onClick={() => void submit()}>
              {submitting ? i18n('Lesson problem notes submitting') : i18n('Lesson problem notes submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
