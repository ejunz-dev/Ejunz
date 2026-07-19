import React, { useCallback, useEffect, useRef, useState } from 'react';
import Notification from 'vj/components/notification';
import { domainApiPath, i18n, request } from 'vj/utils';

type ThemeStyles = Record<string, string>;

export function BaseEditorCardTagsPanel({
  docId,
  getBaseUrl,
  themeStyles,
  onTagsChanged,
}: {
  docId: string;
  getBaseUrl: (path: string, docId?: string) => string;
  themeStyles: Record<string, string>;
  onTagsChanged?: () => void;
}) {
  const [tags, setTags] = useState<string[]>(() => {
    const init: string[] = (window as any).UiContext?.base?.cardTags || [];
    return Array.isArray(init) ? init : [];
  });
  const [newTagInput, setNewTagInput] = useState('');
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  const domainId = (window as any).UiContext?.domainId || 'system';
  const apiUrl = domainApiPath('/base/card-tag', domainId);

  const handleAdd = useCallback(async () => {
    const tag = newTagInput.trim();
    if (!tag) return;
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'add', tag });
      if (res?.success) {
        setTags(res.cardTags || []);
        setNewTagInput('');
        (window as any).UiContext?.base && ((window as any).UiContext.base.cardTags = res.cardTags || []);
        onTagsChanged?.();
        Notification.success(i18n('Saved'));
      } else Notification.error(i18n('Save failed'));
    } catch { Notification.error(i18n('Save failed')); }
  }, [apiUrl, docId, newTagInput, onTagsChanged]);

  const handleDelete = useCallback(async (tag: string) => {
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'delete', tag });
      if (res?.success) {
        setTags(res.cardTags || []);
        (window as any).UiContext?.base && ((window as any).UiContext.base.cardTags = res.cardTags || []);
        onTagsChanged?.();
        Notification.success(i18n('Deleted'));
      } else Notification.error(i18n('Save failed'));
    } catch { Notification.error(i18n('Save failed')); }
  }, [apiUrl, docId, onTagsChanged]);

  const handleRename = useCallback(async (oldTag: string) => {
    const newTag = renameInput.trim();
    if (!newTag || newTag === oldTag) { setRenamingTag(null); return; }
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'rename', oldTag, newTag });
      if (res?.success) {
        setTags(res.cardTags || []);
        (window as any).UiContext?.base && ((window as any).UiContext.base.cardTags = res.cardTags || []);
        onTagsChanged?.();
        setRenamingTag(null);
        Notification.success(i18n('Saved'));
      } else Notification.error(i18n('Save failed'));
    } catch { Notification.error(i18n('Save failed')); }
  }, [apiUrl, docId, renameInput]);

  useEffect(() => {
    if (renamingTag && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renamingTag]);

  return (
    <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600, color: themeStyles.textSecondary, padding: '0 8px' }}>
        {i18n('Card tags')}
      </div>

      {/* Add new tag */}
      <div style={{ display: 'flex', gap: 4, padding: '0 8px' }}>
        <input
          type="text"
          value={newTagInput}
          onChange={(e) => setNewTagInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
          placeholder={i18n('Add tag...')}
          style={{
            flex: 1, padding: '5px 8px', borderRadius: 4,
            border: `1px solid ${themeStyles.borderSecondary}`,
            background: themeStyles.bgPrimary, color: themeStyles.textPrimary,
            fontSize: 12, outline: 'none',
          }}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={handleAdd}
          style={{
            padding: '5px 10px', borderRadius: 4, border: 'none',
            background: '#ffd24a', color: '#111', fontSize: 12, fontWeight: 600,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          {i18n('Add')}
        </button>
      </div>

      {/* Tag list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 4px', overflowY: 'auto', maxHeight: 'calc(100vh - 200px)' }}>
        {tags.length === 0 ? (
          <span style={{ color: themeStyles.textSecondary, fontStyle: 'italic', padding: '8px' }}>
            {i18n('No tags available')}
          </span>
        ) : tags.map((tag) => (
          <div
            key={tag}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '6px 8px', borderRadius: 4,
              background: renamingTag === tag ? themeStyles.bgSecondary : 'transparent',
            }}
          >
            {renamingTag === tag ? (
              <>
                <input
                  ref={renameRef}
                  type="text"
                  value={renameInput}
                  onChange={(e) => setRenameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(tag);
                    else if (e.key === 'Escape') setRenamingTag(null);
                  }}
                  style={{
                    flex: 1, padding: '3px 6px', borderRadius: 3,
                    border: `1px solid ${themeStyles.accent || '#4135d6'}`,
                    background: themeStyles.bgPrimary, color: themeStyles.textPrimary,
                    fontSize: 12, outline: 'none',
                  }}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => handleRename(tag)}
                  style={{
                    padding: '3px 6px', borderRadius: 3, border: 'none',
                    background: '#ffd24a', color: '#111', fontSize: 11, fontWeight: 600,
                    cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  {i18n('Save')}
                </button>
                <button
                  type="button"
                  onClick={() => setRenamingTag(null)}
                  style={{
                    padding: '3px 6px', borderRadius: 3, border: 'none',
                    background: 'transparent', color: themeStyles.textSecondary,
                    fontSize: 11, cursor: 'pointer', flexShrink: 0,
                  }}
                >
                  {i18n('Cancel')}
                </button>
              </>
            ) : (
              <>
                <span style={{
                  flex: 1, padding: '2px 6px', borderRadius: 3,
                  background: 'var(--roadmap-tag-bg, rgba(65, 53, 214, 0.1))',
                  color: 'var(--roadmap-tag-color, var(--roadmap-accent, #4135d6))',
                  fontSize: 12, fontWeight: 500,
                }}>
                  {tag}
                </span>
                <button
                  type="button"
                  onClick={() => { setRenamingTag(tag); setRenameInput(tag); }}
                  style={{
                    padding: '2px 5px', borderRadius: 3, border: 'none',
                    background: 'transparent', color: themeStyles.textSecondary,
                    fontSize: 11, cursor: 'pointer', flexShrink: 0,
                  }}
                  title={i18n('Rename')}
                >
                  ✏️
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(tag)}
                  style={{
                    padding: '2px 5px', borderRadius: 3, border: 'none',
                    background: 'transparent', color: '#c00',
                    fontSize: 12, cursor: 'pointer', flexShrink: 0, fontWeight: 700,
                  }}
                  title={i18n('Delete')}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
