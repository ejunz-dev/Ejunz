import React, { useCallback, useEffect, useRef, useState } from 'react';
import Notification from 'vj/components/notification';
import { domainApiPath, i18n, request } from 'vj/utils';

type ThemeStyles = Record<string, string>;

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
  return { parents: [...new Set(parents)], children };
}

export function BaseEditorProblemTagsPanel({
  docId,
  themeStyles,
  onTagsChanged,
}: {
  docId: string;
  themeStyles: Record<string, string>;
  onTagsChanged?: () => void;
}) {
  const domainId = (window as any).UiContext?.domainId || 'system';
  const apiUrl = domainApiPath('/base/problem-tag', domainId);
  const [tags, setTags] = useState<string[]>(() => {
    const init: string[] = (window as any).UiContext?.base?.problemTags || [];
    return Array.isArray(init) ? init : [];
  });
  const tree = buildTagTree(tags);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set(tree.parents));
  const [newTagInput, setNewTagInput] = useState('');
  const [newChildInputs, setNewChildInputs] = useState<Record<string, string>>({});
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  const handleAdd = useCallback(async () => {
    const tag = newTagInput.trim();
    if (!tag) return;
    try {
      (window as any).__baseJustSaved = Date.now();
      const res: any = await request.post(apiUrl, { docId: Number(docId), action: 'add', tag });
      if (res?.success) {
        setTags(res.problemTags || []);
        setNewTagInput('');
        setExpandedParents(prev => new Set(prev).add(tag));
        if ((window as any).UiContext?.base) (window as any).UiContext.base.problemTags = res.problemTags || [];
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
        setTags(res.problemTags || []);
        setNewChildInputs(prev => ({ ...prev, [parentTag]: '' }));
        if ((window as any).UiContext?.base) (window as any).UiContext.base.problemTags = res.problemTags || [];
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
        setTags(res.problemTags || []);
        if ((window as any).UiContext?.base) (window as any).UiContext.base.problemTags = res.problemTags || [];
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
        setTags(res.problemTags || []);
        if ((window as any).UiContext?.base) (window as any).UiContext.base.problemTags = res.problemTags || [];
        onTagsChanged?.();
        setRenamingTag(null);
        Notification.success(i18n('Saved'));
      } else Notification.error(i18n('Save failed'));
    } catch { Notification.error(i18n('Save failed')); }
  }, [apiUrl, docId, renameInput, onTagsChanged]);

  useEffect(() => { if (renamingTag && renameRef.current) { renameRef.current.focus(); renameRef.current.select(); } }, [renamingTag]);

  const toggleExpand = useCallback((p: string) => {
    setExpandedParents(prev => { const n = new Set(prev); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  }, []);

  return (
    <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontWeight: 600, color: themeStyles.textSecondary, padding: '0 8px' }}>{i18n('Problem tags')}</div>
      {/* Add new parent at top */}
      <div style={{ display: 'flex', gap: 4, padding: '0 8px' }}>
        <input type="text" value={newTagInput} onChange={(e) => setNewTagInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
          placeholder={i18n('Add new tag group...')}
          style={{ flex: 1, padding: '5px 8px', borderRadius: 4, border: `1px solid ${themeStyles.borderSecondary}`, background: themeStyles.bgPrimary, color: themeStyles.textPrimary, fontSize: 12, outline: 'none' }}
          autoComplete="off" />
        <button type="button" onClick={handleAdd}
          style={{ padding: '5px 10px', borderRadius: 4, border: 'none', background: '#ffd24a', color: '#111', fontSize: 12, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>{i18n('Add')}</button>
      </div>
      {/* Parent tags */}
      {tree.parents.slice().reverse().map((parent) => {
        const children = tree.children[parent] || [];
        const hasChildren = children.length > 0;
        const isExpanded = expandedParents.has(parent);
        return (
          <div key={parent} style={{ border: `1px solid ${themeStyles.borderSecondary}`, borderRadius: 6, overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', background: 'rgba(255, 152, 0, 0.08)', borderBottom: isExpanded ? `1px solid ${themeStyles.borderSecondary}` : 'none' }}>
              {hasChildren && (
                <button type="button" onClick={() => toggleExpand(parent)}
                  style={{ width: 16, height: 16, border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 10, color: themeStyles.textSecondary, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {isExpanded ? '▼' : '▶'}
                </button>
              )}
              {!hasChildren && <span style={{ width: 16 }} />}
              <span style={{ flex: 1, fontWeight: 600, fontSize: 12, color: '#e65100' }}>{parent}</span>
              {renamingTag === parent ? (
                <>
                  <input ref={renameRef} type="text" value={renameInput} onChange={(e) => setRenameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleRename(parent); else if (e.key === 'Escape') setRenamingTag(null); }}
                    style={{ flex: 1, padding: '2px 6px', borderRadius: 3, border: `1px solid ${themeStyles.accent || '#4135d6'}`, background: themeStyles.bgPrimary, color: themeStyles.textPrimary, fontSize: 12, outline: 'none' }} autoComplete="off" />
                  <button type="button" onClick={() => handleRename(parent)} style={{ padding: '2px 6px', borderRadius: 3, border: 'none', background: '#ffd24a', color: '#111', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>{i18n('Save')}</button>
                  <button type="button" onClick={() => setRenamingTag(null)} style={{ padding: '2px 6px', borderRadius: 3, border: 'none', background: 'transparent', color: themeStyles.textSecondary, fontSize: 11, cursor: 'pointer' }}>{i18n('Cancel')}</button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => { setRenamingTag(parent); setRenameInput(parent); }} style={{ padding: '2px 5px', borderRadius: 3, border: 'none', background: 'transparent', color: themeStyles.textSecondary, fontSize: 11, cursor: 'pointer', flexShrink: 0 }} title={i18n('Rename')}>✏️</button>
                  <button type="button" onClick={() => handleDelete(parent)} style={{ padding: '2px 5px', borderRadius: 3, border: 'none', background: 'transparent', color: '#c00', fontSize: 12, cursor: 'pointer', flexShrink: 0, fontWeight: 700 }} title={i18n('Delete')}>×</button>
                </>
              )}
            </div>
            {isExpanded && (
              <div style={{ padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {children.map((child) => (
                  <div key={child} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px' }}>
                    <span style={{ flex: 1, fontSize: 11, color: themeStyles.textSecondary, paddingLeft: 16 }}>{child}</span>
                    <button type="button" onClick={() => handleDelete(parent + '/' + child)} style={{ padding: '2px 5px', borderRadius: 3, border: 'none', background: 'transparent', color: '#c00', fontSize: 11, cursor: 'pointer', flexShrink: 0, fontWeight: 700 }}>×</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 4, padding: '4px 4px 2px' }}>
                  <input type="text" value={newChildInputs[parent] || ''} onChange={(e) => setNewChildInputs(prev => ({ ...prev, [parent]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddChild(parent); }}
                    placeholder={i18n('Add sub-tag...')}
                    style={{ flex: 1, padding: '3px 6px', borderRadius: 3, border: `1px solid ${themeStyles.borderSecondary}`, background: themeStyles.bgPrimary, color: themeStyles.textPrimary, fontSize: 11, outline: 'none' }} autoComplete="off" />
                  <button type="button" onClick={() => handleAddChild(parent)} style={{ padding: '2px 6px', borderRadius: 3, border: 'none', background: '#ffd24a', color: '#111', fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0 }}>+</button>
                </div>
              </div>
            )}
            {!isExpanded && hasChildren && (
              <div style={{ padding: '4px 8px' }}>
                <button type="button" onClick={() => toggleExpand(parent)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 11, color: themeStyles.textTertiary, padding: '2px 4px' }}>
                  {children.length} {i18n('sub-tags')} ▶
                </button>
              </div>
            )}
          </div>
        );
      })}
      {tags.length === 0 && tree.parents.length === 0 && (
        <span style={{ color: themeStyles.textSecondary, fontStyle: 'italic', padding: '8px' }}>{i18n('No tags available')}</span>
      )}
    </div>
  );
}
