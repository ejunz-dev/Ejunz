import React, { useCallback, useEffect, useRef, useState } from 'react';
import Notification from 'vj/components/notification';
import { domainApiPath, domainScopedPath, i18n, request } from 'vj/utils';
import type { Card } from './types';
import 'md-editor-rt/lib/style.css';

/**
 * Lightweight single-card editor — SSR-ready, loads card data from UiContext.
 * No full file tree, no roadmap canvas, no develop pool tracking.
 */
export function CardEditorMode({
  initialCard,
  base,
  sessionId,
  nodeId,
  domainId,
}: {
  initialCard: Card;
  base: { domainId?: string; docId?: string; title?: string; bid?: number; currentBranch?: string };
  sessionId: string;
  nodeId: string;
  domainId: string;
}) {
  const [title, setTitle] = useState(initialCard.title || '');
  const [content, setContent] = useState(initialCard.content || '');
  const [cardFace, setCardFace] = useState(initialCard.cardFace || '');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mdEditorLoaded, setMdEditorLoaded] = useState(false);
  const contentInitialRef = useRef(initialCard.content || '');
  const titleInitialRef = useRef(initialCard.title || '');
  const cardFaceInitialRef = useRef(initialCard.cardFace || '');

  const resolvedDomainId = domainId || base.domainId || 'system';
  const detailUrl = domainScopedPath(`/base/${base.docId || ''}`, resolvedDomainId);

  // Check dirty state
  useEffect(() => {
    const tDirty = title !== titleInitialRef.current;
    const cDirty = content !== contentInitialRef.current;
    const fDirty = cardFace !== cardFaceInitialRef.current;
    setDirty(tDirty || cDirty || fDirty);
  }, [title, content, cardFace]);

  // Dynamically import MdEditor
  const MdEditorRef = useRef<any>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('../editor/mdeditor');
        if (!cancelled) MdEditorRef.current = mod.MdEditor;
        if (!cancelled) setMdEditorLoaded(true);
      } catch {
        if (!cancelled) setMdEditorLoaded(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const cardId = initialCard.docId;
      const res: any = await request.post(
        domainApiPath(`/base/card/${encodeURIComponent(cardId)}`, resolvedDomainId),
        { title, content, cardFace },
      );
      if (res?.success) {
        contentInitialRef.current = content;
        titleInitialRef.current = title;
        cardFaceInitialRef.current = cardFace;
        setDirty(false);
        Notification.success(i18n('Saved'));
      } else {
        Notification.error(i18n('Save failed'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Save failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setSaving(false);
    }
  }, [saving, title, content, cardFace, initialCard.docId, resolvedDomainId]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (dirty) handleSave();
    }
  }, [dirty, handleSave]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const navUrl = detailUrl;
  const showFaceField = !!initialCard.cardFace || cardFace.trim().length > 0;

  function getTheme(): 'light' | 'dark' {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) return (window as any).Ejunz.utils.getTheme();
      return (window as any).UserContext?.theme === 'dark' ? 'dark' : 'light';
    } catch { return 'light'; }
  }

  const MarkdownEditor = MdEditorRef.current;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--roadmap-bg-page, #f5f5f7)',
    }}>
      {/* Header bar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 20px',
        borderBottom: '1px solid var(--roadmap-border, #e0e0e0)',
        background: 'var(--roadmap-bg-surface, #fff)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <a
            href={navUrl}
            style={{ color: 'var(--roadmap-accent, #555)', fontSize: 14, textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            ← {base.title || i18n('Knowledge Base')}
          </a>
          <span style={{ color: 'var(--roadmap-text-secondary, #999)' }}>/</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--roadmap-text-primary, #222)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {initialCard.title || i18n('Editing Card')}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {dirty ? (
            <span style={{ fontSize: 12, color: 'var(--roadmap-text-secondary, #999)' }}>
              {i18n('Unsaved changes')}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              border: 'none',
              background: dirty ? '#ffd24a' : 'var(--roadmap-bg-surface, #eee)',
              color: dirty ? '#111' : 'var(--roadmap-text-secondary, #999)',
              fontSize: 13,
              fontWeight: 600,
              cursor: dirty ? 'pointer' : 'default',
              transition: 'all 0.15s ease',
            }}
          >
            {saving ? i18n('Saving...') : i18n('Save')}
          </button>
        </div>
      </div>

      {/* Editor body */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        padding: '20px',
        gap: 16,
        overflow: 'auto',
        minHeight: 0,
      }}>
        {/* Title */}
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--roadmap-text-secondary, #888)', marginBottom: 6 }}>
            {i18n('Title')}
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={String(i18n('Card title'))}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid var(--roadmap-border, #ddd)',
              background: 'var(--roadmap-bg-surface, #fff)',
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--roadmap-text-primary, #222)',
              outline: 'none',
            }}
          />
        </div>

        {/* Card Face (optional) */}
        {showFaceField ? (
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--roadmap-text-secondary, #888)', marginBottom: 6 }}>
              {i18n('Card Face')}
            </label>
            <textarea
              value={cardFace}
              onChange={(e) => setCardFace(e.target.value)}
              placeholder={String(i18n('Short card face text for lesson mode'))}
              rows={2}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '8px 12px',
                borderRadius: 8,
                border: '1px solid var(--roadmap-border, #ddd)',
                background: 'var(--roadmap-bg-surface, #fff)',
                fontSize: 13,
                color: 'var(--roadmap-text-primary, #222)',
                outline: 'none',
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          </div>
        ) : (
          <div>
            <button
              type="button"
              onClick={() => setCardFace(' ')}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--roadmap-accent, #888)',
                fontSize: 12,
                cursor: 'pointer',
                padding: 0,
                textDecoration: 'underline',
              }}
            >
              + {i18n('Add card face')}
            </button>
          </div>
        )}

        {/* Content (Markdown) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 200 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--roadmap-text-secondary, #888)', marginBottom: 6 }}>
            {i18n('Content')}
          </label>
          <div style={{ flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--roadmap-border, #ddd)' }}>
            {MarkdownEditor ? (
              <MarkdownEditor
                key="md-editor"
                className={'textbox' + (getTheme() === 'dark' ? ' md-editor-dark-softer' : '')}
                style={{
                  height: '100%',
                  minHeight: 0,
                  ...(getTheme() === 'dark' ? { backgroundColor: '#323334' } : {}),
                }}
                autoFocus={false}
                codeTheme="github"
                codeStyleReverse={false}
                modelValue={content}
                onChange={(val: string) => setContent(val || '')}
                theme={getTheme()}
                noMermaid
                noPrettier
                autoDetectCode
                toolbarsExclude={[
                  'github',
                  'mermaid',
                  'prettier',
                  'katex',
                  'sub',
                  'sup',
                  'table',
                ]}
              />
            ) : (
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                style={{
                  width: '100%',
                  height: '100%',
                  boxSizing: 'border-box',
                  padding: 14,
                  border: 'none',
                  background: 'var(--roadmap-bg-surface, #fff)',
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: 'var(--roadmap-text-primary, #222)',
                  outline: 'none',
                  resize: 'none',
                  fontFamily: "'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace",
                }}
                placeholder={String(i18n('Write card content in markdown...'))}
              />
            )}
          </div>
        </div>

        {/* Metadata footer */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          fontSize: 12,
          color: 'var(--roadmap-text-secondary, #999)',
          paddingTop: 8,
          borderTop: '1px solid var(--roadmap-border, #eee)',
          flexShrink: 0,
        }}>
          {initialCard.createdAt ? (
            <span>{i18n('Created')}: {new Date(initialCard.createdAt).toLocaleString()}</span>
          ) : null}
          {initialCard.updateAt ? (
            <span>{i18n('Updated')}: {new Date(initialCard.updateAt).toLocaleString()}</span>
          ) : null}
          {(initialCard.files?.length || 0) > 0 ? (
            <span>{initialCard.files?.length} {i18n('files')}</span>
          ) : null}
          {(initialCard.problems?.length || 0) > 0 ? (
            <span>{initialCard.problems?.length} {i18n('problems')}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
