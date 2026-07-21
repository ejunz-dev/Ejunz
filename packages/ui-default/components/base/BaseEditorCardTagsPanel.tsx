import React, { useCallback, useEffect, useRef, useState } from 'react';
import Notification from 'vj/components/notification';
import { domainApiPath, i18n, request } from 'vj/utils';

type ThemeStyles = Record<string, string>;

/** Split flat tags into parent → children map. Parents are tags without "/". */
function buildTagTree(tags: string[]): { parents: string[]; children: Record<string, string[]> } {
  const parents: string[] = [];
  const children: Record<string, string[]> = {};
  const childSet = new Set<string>();
  for (const t of tags) {
    const slashIdx = t.indexOf('/');
    if (slashIdx > 0) {
      const p = t.slice(0, slashIdx);
      const c = t.slice(slashIdx + 1);
      if (!children[p]) children[p] = [];
      children[p].push(c);
      childSet.add(t);
    }
  }
  for (const t of tags) {
    if (!childSet.has(t) && !t.includes('/')) parents.push(t);
  }
  // Preserve insertion order (newest from reverse iteration), no alphabetical sort
  return { parents: [...new Set(parents)], children };
}

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
  const domainId = (window as any).UiContext?.domainId || 'system';
  const apiUrl = domainApiPath('/base/card-tag', domainId);
  const [tags, setTags] = useState<string[]>(() => {
    const init: string[] = (window as any).UiContext?.base?.cardTags || [];
    return Array.isArray(init) ? init : [];
  });
  const tree = buildTagTree(tags);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set(tree.parents));
  const [newTagInput, setNewTagInput] = useState('');
  const [newChildInputs, setNewChildInputs] = useState<Record<string, string>>({});
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  const refreshTags = useCallback(async () => {
    try {
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'list' });
      if (res?.cardTags) {
        setTags(res.cardTags);
        (window as any).UiContext.base.cardTags = res.cardTags;
        onTagsChanged?.();
      }
    } catch { /* ignore */ }
  }, [apiUrl, docId, onTagsChanged]);

  const handleAdd = useCallback(async () => {
    const tag = newTagInput.trim();
    if (!tag) return;
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'add', tag });
      if (res?.success) {
        setTags(res.cardTags || []);
        setNewTagInput('');
        // Auto-expand the new parent tag so add-child input is visible
        setExpandedParents(prev => new Set(prev).add(tag));
        (window as any).UiContext.base.cardTags = res.cardTags || [];
        onTagsChanged?.();
        Notification.success(i18n('Saved'));
      } else Notification.error(i18n('Save failed'));
    } catch { Notification.error(i18n('Save failed')); }
  }, [apiUrl, docId, newTagInput, onTagsChanged]);

  const handleAddChild = useCallback(async (parentTag: string) => {
    const childTag = (newChildInputs[parentTag] || '').trim();
    if (!childTag) return;
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'add_child', parentTag, childTag });
      if (res?.success) {
        setTags(res.cardTags || []);
        setNewChildInputs(prev => ({ ...prev, [parentTag]: '' }));
        (window as any).UiContext.base.cardTags = res.cardTags || [];
        onTagsChanged?.();
        Notification.success(i18n('Saved'));
      } else Notification.error(i18n('Save failed'));
    } catch { Notification.error(i18n('Save failed')); }
  }, [apiUrl, docId, newChildInputs, onTagsChanged]);

  const handleDelete = useCallback(async (tag: string) => {
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'delete', tag });
      if (res?.success) {
        setTags(res.cardTags || []);
        (window as any).UiContext.base.cardTags = res.cardTags || [];
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
        (window as any).UiContext.base.cardTags = res.cardTags || [];
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

  const toggleExpand = useCallback((parent: string) => {
    setExpandedParents(prev => {
      const next = new Set(prev);
      if (next.has(parent)) next.delete(parent);
      else next.add(parent);
      return next;
    });
  }, []);

  const tagChip = (label: string, onRemove?: () => void) => (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 8px', borderRadius: 4,
      background: 'var(--roadmap-tag-bg, rgba(65, 53, 214, 0.1))',
      color: 'var(--roadmap-tag-color, var(--roadmap-accent, #4135d6))',
      fontSize: 12, fontWeight: 500,
    }}>
      {label}
      {onRemove && (
        <button type="button" onClick={onRemove}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontSize: 14, lineHeight: 1, color: 'inherit', opacity: 0.6 }}
          aria-label={i18n('Remove tag')}>×</button>
      )}
    </span>
  );

  return (
    <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600, color: themeStyles.textSecondary, padding: '0 8px' }}>
        {i18n('Card tags')}
      </div>

      {/* Add new parent tag — at top */}
      <div style={{ display: 'flex', gap: 4, padding: '0 8px' }}>
        <input type="text" value={newTagInput} onChange={(e) => setNewTagInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
          placeholder={i18n('Add new tag group...')}
          style={{ flex: 1, padding: '5px 8px', borderRadius: 4, border: `1px solid ${themeStyles.borderSecondary}`, background: themeStyles.bgPrimary, color: themeStyles.textPrimary, fontSize: 12, outline: 'none' }}
          autoComplete="off" />
        <button type="button" onClick={handleAdd}
          style={{ padding: '5px 10px', borderRadius: 4, border: 'none', background: '#ffd24a', color: '#111', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>
          {i18n('Add')}
        </button>
      </div>

      {/* Parent tags — reverse order so newest is on top */}
      {tree.parents.slice().reverse().map((parent) => {
        const children = tree.children[parent] || [];
        const hasChildren = children.length > 0;
        const isExpanded = expandedParents.has(parent);
        return (
          <div key={parent} style={{
            border: `1px solid ${themeStyles.borderSecondary}`,
            borderRadius: 6, overflow: 'hidden', marginBottom: 4,
          }}>
            {/* Parent row — header bar */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '4px 8px',
              background: 'var(--roadmap-tag-bg, rgba(65, 53, 214, 0.08))',
              borderBottom: isExpanded ? `1px solid ${themeStyles.borderSecondary}` : 'none',
            }}>
              {hasChildren && (
                <button type="button" onClick={() => toggleExpand(parent)}
                  style={{ width: 16, height: 16, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, color: themeStyles.textSecondary, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {isExpanded ? '▼' : '▶'}
                </button>
              )}
              {!hasChildren && <span style={{ width: 16 }} />}
              <span style={{ flex: 1, fontWeight: 600, fontSize: 12, color: 'var(--roadmap-tag-color, var(--roadmap-accent, #4135d6))' }}>
                {parent}
              </span>
              {renamingTag === parent ? (
                <>
                  <input ref={renameRef} type="text" value={renameInput} onChange={(e) => setRenameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRename(parent); else if (e.key === 'Escape') setRenamingTag(null); }}
                    style={{ flex: 1, padding: '2px 6px', borderRadius: 3, border: `1px solid ${themeStyles.accent || '#4135d6'}`, background: themeStyles.bgPrimary, color: themeStyles.textPrimary, fontSize: 12, outline: 'none' }}
                    autoComplete="off" />
                  <button type="button" onClick={() => handleRename(parent)}
                    style={{ padding: '2px 6px', borderRadius: 3, border: 'none', background: '#ffd24a', color: '#111', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{i18n('Save')}</button>
                  <button type="button" onClick={() => setRenamingTag(null)}
                    style={{ padding: '2px 6px', borderRadius: 3, border: 'none', background: 'transparent', color: themeStyles.textSecondary, fontSize: 11, cursor: 'pointer' }}>{i18n('Cancel')}</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => { setRenamingTag(parent); setRenameInput(parent); }}
                    style={{ padding: '2px 5px', borderRadius: 3, border: 'none', background: 'transparent', color: themeStyles.textSecondary, fontSize: 11, cursor: 'pointer', flexShrink: 0 }} title={i18n('Rename')}>✏️</button>
                  <button type="button" onClick={() => handleDelete(parent)}
                    style={{ padding: '2px 5px', borderRadius: 3, border: 'none', background: 'transparent', color: '#c00', fontSize: 12, cursor: 'pointer', flexShrink: 0, fontWeight: 700 }} title={i18n('Delete')}>×</button>
                </>
              )}
            </div>

            {/* Children + add child input */}
            {isExpanded && (
              <div style={{ padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {children.map((child) => (
                  <div key={child} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px' }}>
                    <span style={{ flex: 1, fontSize: 11, color: themeStyles.textSecondary, paddingLeft: 16 }}>
                      {child}
                    </span>
                    <button type="button" onClick={() => handleDelete(parent + '/' + child)}
                      style={{ padding: '2px 5px', borderRadius: 3, border: 'none', background: 'transparent', color: '#c00', fontSize: 11, cursor: 'pointer', flexShrink: 0, fontWeight: 700 }}>×</button>
                  </div>
                ))}
                {/* Add child input */}
                <div style={{ display: 'flex', gap: 4, padding: '4px 4px 2px' }}>
                  <input type="text" value={newChildInputs[parent] || ''}
                    onChange={(e) => setNewChildInputs(prev => ({ ...prev, [parent]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddChild(parent); }}
                    placeholder={i18n('Add sub-tag...')}
                    style={{ flex: 1, padding: '3px 6px', borderRadius: 3, border: `1px solid ${themeStyles.borderSecondary}`, background: themeStyles.bgPrimary, color: themeStyles.textPrimary, fontSize: 11, outline: 'none' }}
                    autoComplete="off" />
                  <button type="button" onClick={() => handleAddChild(parent)}
                    style={{ padding: '2px 6px', borderRadius: 3, border: 'none', background: '#ffd24a', color: '#111', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>+</button>
                </div>
              </div>
            )}

            {/* Collapsed hint */}
            {!isExpanded && hasChildren && (
              <div style={{ padding: '4px 8px' }}>
                <button type="button" onClick={() => toggleExpand(parent)}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: themeStyles.textTertiary, padding: '2px 4px' }}>
                  {children.length} {i18n('sub-tags')} ▶
                </button>
              </div>
            )}
          </div>
        );
      })}

      {tags.length === 0 && tree.parents.length === 0 && (
        <span style={{ color: themeStyles.textSecondary, fontStyle: 'italic', padding: '8px' }}>
          {i18n('No tags available')}
        </span>
      )}
    </div>
  );
}
