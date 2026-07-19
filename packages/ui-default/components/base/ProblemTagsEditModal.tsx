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

        {/* Tag chips */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
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
                      padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer',
                      background: selected ? 'rgba(255, 152, 0, 0.15)' : 'var(--roadmap-bg-input, #f0f0f0)',
                      color: selected ? '#e65100' : 'var(--roadmap-text-secondary, #888)',
                      fontSize: 12, fontWeight: selected ? 600 : 400,
                      outline: 'none', transition: 'all 0.1s ease',
                    }}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--roadmap-text-muted, #aaa)', fontStyle: 'italic' }}>
              {i18n('No tags available')}
            </span>
          )}
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
              background: '#ffd24a', color: '#111',
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
