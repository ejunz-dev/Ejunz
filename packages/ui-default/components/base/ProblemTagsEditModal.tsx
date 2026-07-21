import React, { useCallback, useState } from 'react';
import ReactDOM from 'react-dom';
import { i18n } from 'vj/utils';
import type { Problem } from 'ejun/src/interface';

/**
 * Small modal for editing a single problem's tags.
 * Shows available tags from registry as toggle chips.
 */
export function ProblemTagsEditModal({
  problem,
  availableTags,
  onSave,
  onClose,
}: {
  problem: Problem;
  availableTags?: string[];
  onSave: (updated: Problem) => void;
  onClose: () => void;
}) {
  const [tags, setTags] = useState<string[]>(problem.tags || []);

  // Collect all known tags
  const tagsForRender: string[] = (() => {
    const baseTags: string[] = Array.isArray(availableTags) ? availableTags
      : Array.isArray((window as any).UiContext?.base?.problemTags) ? (window as any).UiContext.base.problemTags : [];
    const allNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
    const allTags = new Set(baseTags);
    Object.values(allNodeCardsMap as Record<string, any[]>).forEach((cards) => {
      cards.forEach((c: any) => {
        if (Array.isArray(c.problems)) c.problems.forEach((p: any) => {
          if (Array.isArray(p.tags)) p.tags.forEach((t: string) => allTags.add(t));
        });
      });
    });
    return [...allTags].sort();
  })();

  const handleSave = useCallback(() => {
    onSave({ ...problem, tags });
    onClose();
  }, [problem, tags, onSave, onClose]);

  return ReactDOM.createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 10050,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.3)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        style={{
          display: 'flex', flexDirection: 'column',
          width: 360, maxHeight: '60vh',
          background: 'var(--roadmap-bg-surface, #fff)',
          borderRadius: 10,
          boxShadow: '0 12px 40px rgba(0,0,0,0.2)',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--roadmap-border, #e0e0e0)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--roadmap-text-primary, #222)' }}>
            {i18n('Problem tags')}
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 18, color: 'var(--roadmap-text-secondary, #999)', padding: '0 4px' }}
          >
            ×
          </button>
        </div>

        {/* Tag chips — hierarchical */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
          {(() => {
            if (tagsForRender.length === 0) return <span style={{ fontSize: 12, color: 'var(--roadmap-text-muted, #aaa)', fontStyle: 'italic' }}>{i18n('No tags available')}</span>;
            const plist: string[] = [];
            const cmap: Record<string, string[]> = {};
            for (const t of tagsForRender) {
              const sl = t.indexOf('/');
              if (sl > 0) { const p2 = t.slice(0, sl); const c2 = t.slice(sl + 1); if (!cmap[p2]) cmap[p2] = []; cmap[p2].push(c2); }
              else { plist.push(t); }
            }
            const toggleTag = (tag: string) => {
              if (tags.includes(tag)) setTags((prev) => prev.filter((t) => t !== tag && !t.startsWith(tag + "/")));
              else setTags((prev) => [...prev, tag]);
            };
            return (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {plist.map((p) => {
                  const pSel = tags.includes(p);
                  const chs = cmap[p] || [];
                  return (
                    <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 0, border: `1px solid ${pSel ? 'var(--roadmap-problem-tag-color, #e65100)' : 'var(--roadmap-border, #ddd)'}`, borderRadius: 4, overflow: 'hidden', fontSize: 12, lineHeight: '1.5' }}>
                      <span style={{ padding: '3px 10px', cursor: 'pointer', background: pSel ? 'var(--roadmap-problem-tag-bg, rgba(255,152,0,0.15))' : 'transparent', color: pSel ? 'var(--roadmap-problem-tag-color, #e65100)' : 'var(--roadmap-text-secondary, #888)', fontWeight: 600 }}
                        onClick={() => toggleTag(p)}>
                        {p}
                      </span>
                      {chs.map((c) => {
                        const fullTag = p + '/' + c;
                        const cSel = tags.includes(fullTag);
                        return (
                          <span key={fullTag} style={{ padding: '3px 8px', cursor: 'pointer', borderLeft: '1px solid var(--roadmap-border, #ddd)', background: cSel ? 'var(--roadmap-problem-tag-bg, rgba(255,152,0,0.15))' : 'transparent', color: cSel ? 'var(--roadmap-problem-tag-color, #e65100)' : 'var(--roadmap-text-secondary, #888)', fontWeight: cSel ? 600 : 400 }}
                            onClick={() => {
                              if (cSel) setTags((prev) => prev.filter((t) => t !== fullTag));
                              else setTags((prev) => prev.includes(p) ? [...prev, fullTag] : [...prev, p, fullTag]);
                            }}>
                            {c}
                          </span>
                        );
                      })}
                    </span>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Actions */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '10px 16px', borderTop: '1px solid var(--roadmap-border, #e0e0e0)',
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid var(--roadmap-border, #ddd)',
              background: 'transparent', color: 'var(--roadmap-text-secondary, #999)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {i18n('Cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none',
              background: 'var(--roadmap-accent, #ffd24a)', color: 'var(--roadmap-text-on-accent, #111)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer',
            }}
          >
            {i18n('Save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
