import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import Notification from 'vj/components/notification';
import { domainApiPath, i18n, request } from 'vj/utils';
import type { Card } from './types';

/**
 * Centered modal for editing a card's title and content.
 * After saving, calls onSave(updatedCard) so the parent can update state in-place.
 */
export function CardEditModal({
  card,
  domainId,
  availableTags,
  onSave,
  onClose,
}: {
  card: Card;
  domainId?: string;
  availableTags?: string[];
  onSave: (updated: Card) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(card.title || '');
  const [content, setContent] = useState(card.content || '');
  const [tags, setTags] = useState<string[]>(card.tags || []);
  // Collect available tags: from registry + from all cards in nodeCardsMap
  const baseCardTags: string[] = Array.isArray(availableTags) ? availableTags
    : Array.isArray((window as any).UiContext?.base?.cardTags) ? (window as any).UiContext.base.cardTags : [];
  const allNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
  const allTags = new Set<string>();
  baseCardTags.forEach((t: string) => allTags.add(t));
  Object.values(allNodeCardsMap as Record<string, any[]>).forEach((cards) => {
    cards.forEach((cardItem) => {
      if (Array.isArray(cardItem.tags)) cardItem.tags.forEach((t: string) => allTags.add(t));
    });
  });
  const tagsForRender = [...allTags].sort();
  const [saving, setSaving] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  savingRef.current = saving;
  const titleRef = useRef(title);
  titleRef.current = title;
  const contentRef = useRef(content);
  contentRef.current = content;
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  const cardRef = useRef(card);
  cardRef.current = card;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Keyboard shortcut: Ctrl+S to save, Escape to close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!savingRef.current) doSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function doSave() {
    if (savingRef.current) return;
    const resolvedDomainId = domainId || (window as any).UiContext?.domainId || 'system';
    setSaving(true);
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(
        domainApiPath(`/base/card/${encodeURIComponent(cardRef.current.docId)}`, resolvedDomainId),
        { title: titleRef.current, content: contentRef.current, tags: tagsRef.current, operation: 'update' },
      );
      if (res?.success) {
        Notification.success(i18n('Saved'));
        onSaveRef.current({
          ...cardRef.current,
          title: titleRef.current,
          content: contentRef.current,
          tags: tagsRef.current,
          updateAt: new Date().toISOString(),
        });
      } else {
        Notification.error(i18n('Save failed'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Save failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setSaving(false);
    }
  }

  const handleSave = useCallback(() => { void doSave(); }, []);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

  // Dynamically import MdEditor (same pattern as CardEditor.tsx and editor/index.tsx)
  const MdEditorRef = useRef<any>(null);
  const [mdReady, setMdReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('../editor/mdeditor');
        if (!cancelled) MdEditorRef.current = mod.MdEditor;
        if (!cancelled) setMdReady(true);
      } catch {
        if (!cancelled) setMdReady(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function getTheme(): 'light' | 'dark' {
    try {
      if ((window as any).Ejunz?.utils?.getTheme) return (window as any).Ejunz.utils.getTheme();
      return (window as any).UserContext?.theme === 'dark' ? 'dark' : 'light';
    } catch { return 'light'; }
  }

  const MarkdownEditor = MdEditorRef.current;

  return ReactDOM.createPortal(
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      data-card-edit-overlay="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.4)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        style={{
          display: 'flex', flexDirection: 'column',
          width: 'min(90vw, 800px)', height: 'min(85vh, 700px)',
          background: 'var(--roadmap-bg-surface, #fff)',
          borderRadius: 12,
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid var(--roadmap-border, #e0e0e0)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--roadmap-text-primary, #222)' }}>
            {i18n('Edit')}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {saving ? (
              <span style={{ fontSize: 12, color: 'var(--roadmap-text-secondary, #999)' }}>{i18n('Saving...')}</span>
            ) : null}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={{
                padding: '7px 18px', borderRadius: 8, border: 'none',
                background: saving ? '#eee' : '#ffd24a',
                color: saving ? '#999' : '#111',
                fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {i18n('Save')}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                padding: '7px 14px', borderRadius: 8,
                border: '1px solid var(--roadmap-border, #ddd)',
                background: 'transparent', color: 'var(--roadmap-text-secondary, #999)',
                fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
              }}
            >
              {i18n('Cancel')}
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          padding: '16px 20px', gap: 12, overflow: 'auto', minHeight: 0,
        }}>
          {/* Title */}
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--roadmap-text-secondary, #888)', marginBottom: 4 }}>
              {i18n('Title')}
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={String(i18n('Card title'))}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '9px 14px', borderRadius: 8,
                border: '1px solid var(--roadmap-border, #ddd)', fontSize: 15, fontWeight: 600,
                background: 'var(--roadmap-bg-input, #fafafa)', color: 'var(--roadmap-text-primary, #222)',
                outline: 'none',
              }}
            />
          </div>

          {/* Content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--roadmap-text-secondary, #888)', marginBottom: 4 }}>
              {i18n('Content')}
            </label>
            <div style={{
              flex: 1, minHeight: 0, borderRadius: 8, overflow: 'hidden',
              border: '1px solid var(--roadmap-border, #ddd)',
            }}>
              {MarkdownEditor ? (
                <MarkdownEditor
                  key="md-editor"
                  className={'textbox' + (getTheme() === 'dark' ? ' md-editor-dark-softer' : '')}
                  style={{
                    height: '100%', minHeight: 0,
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
                  toolbarsExclude={['github', 'mermaid', 'prettier', 'katex', 'sub', 'sup', 'table']}
                />
              ) : (
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder={String(i18n('Write card content in markdown...'))}
                  style={{
                    width: '100%', height: '100%', boxSizing: 'border-box', padding: 14,
                    border: 'none', background: 'var(--roadmap-bg-input, #fafafa)',
                    fontSize: 14, lineHeight: 1.7, resize: 'none', outline: 'none',
                    color: 'var(--roadmap-text-primary, #222)',
                    fontFamily: "'SF Mono', Monaco, 'Cascadia Code', Consolas, monospace",
                  }}
                />
              )}
            </div>
          </div>
        </div>

        {/* Bottom: Card Tags — select from available cardTags only */}
        <div style={{ flexShrink: 0, padding: '12px 20px', borderTop: '1px solid var(--roadmap-border, #e0e0e0)' }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--roadmap-text-secondary, #888)', marginBottom: 4 }}>
              {i18n('Card tags')}
            </label>
            {tagsForRender.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tagsForRender.map((tag) => {
                  const selected = tags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => {
                        if (selected) setTags((prev) => prev.filter((t) => t !== tag));
                        else setTags((prev) => [...prev, tag]);
                      }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        padding: '4px 10px', borderRadius: 4, border: 'none',
                        background: selected
                          ? 'var(--roadmap-tag-bg, rgba(65, 53, 214, 0.1))'
                          : 'var(--roadmap-bg-input, #f0f0f0)',
                        color: selected
                          ? 'var(--roadmap-tag-color, var(--roadmap-accent, #4135d6))'
                          : 'var(--roadmap-text-secondary, #888)',
                        fontSize: 12, fontWeight: selected ? 600 : 400,
                        cursor: 'pointer', outline: 'none',
                        transition: 'all 0.1s ease',
                      }}
                    >
                      {tag}
                    </button>
                  );
                })}
                {/* Also show tags already on the card that aren't in tagsForRender */}
                {tags.filter((t) => !tagsForRender.includes(t)).map((tag) => (
                  <span
                    key={tag}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '4px 10px', borderRadius: 4,
                      background: 'var(--roadmap-tag-bg, rgba(65, 53, 214, 0.1))',
                      color: 'var(--roadmap-tag-color, var(--roadmap-accent, #4135d6))',
                      fontSize: 12, fontWeight: 600,
                    }}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                      style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        padding: 0, fontSize: 14, lineHeight: 1, color: 'inherit', opacity: 0.6,
                      }}
                      aria-label={String(i18n('Remove tag'))}
                    >×</button>
                  </span>
                ))}
              </div>
            ) : tags.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      padding: '4px 10px', borderRadius: 4,
                      background: 'var(--roadmap-tag-bg, rgba(65, 53, 214, 0.1))',
                      color: 'var(--roadmap-tag-color, var(--roadmap-accent, #4135d6))',
                      fontSize: 12, fontWeight: 600,
                    }}
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                      style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        padding: 0, fontSize: 14, lineHeight: 1, color: 'inherit', opacity: 0.6,
                      }}
                      aria-label={String(i18n('Remove tag'))}
                    >×</button>
                  </span>
                ))}
              </div>
            ) : (
              <span style={{ fontSize: 12, color: 'var(--roadmap-text-muted, #aaa)', fontStyle: 'italic' }}>
                {i18n('No tags available')}
              </span>
            )}
          </div>
        </div>
    </div>,
    document.body,
  );
}
