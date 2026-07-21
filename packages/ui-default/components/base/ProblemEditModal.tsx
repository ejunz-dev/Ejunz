import React, { useCallback, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import Notification from 'vj/components/notification';
import { domainApiPath, domainScopedPath, i18n, request } from 'vj/utils';
import type { Card } from './types';
import type { Problem } from 'ejun/src/interface';
import { EditableProblem } from 'vj/components/editor_workspace/editable_problem';

/**
 * Centered modal for editing a single problem on a card.
 * Edits the problem in-place, then saves the entire card's problem[] array.
 */
export function ProblemEditModal({
  card,
  problem,
  problemIndex,
  domainId,
  baseDocId,
  availableTags,
  onSave,
  onClose,
}: {
  card: Card;
  problem: Problem;
  problemIndex: number;
  domainId?: string;
  baseDocId?: string;
  availableTags?: string[];
  onSave: (updatedCard: Card) => void;
  onClose: () => void;
}) {
  const [updatedProblem, setUpdatedProblem] = useState<Problem>(problem);
  const [problemTags, setProblemTags] = useState<string[]>(problem.tags || []);
  const [saving, setSaving] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  const resolvedDomainId = domainId || (window as any).UiContext?.domainId || 'system';
  const resolvedDocId = baseDocId || String((window as any).UiContext?.base?.docId || '');

  const themeStyles = {
    borderPrimary: 'var(--roadmap-border, #ddd)',
    bgPrimary: 'var(--roadmap-bg-surface, #fff)',
    bgSecondary: 'var(--roadmap-bg-page, #f5f5f7)',
    textPrimary: 'var(--roadmap-text-primary, #222)',
  };

  const getBaseUrl = useCallback((path: string) => {
    return domainScopedPath(path, resolvedDomainId);
  }, [resolvedDomainId]);

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      (window as any).__baseJustSaved = Date.now();
      // Build updated problems array
      const newProblems = [...(card.problems || [])];
      newProblems[problemIndex] = { ...updatedProblem, tags: problemTags };

      const res: any = await request.post(
        domainApiPath(`/base/card/${encodeURIComponent(card.docId)}`, resolvedDomainId),
        { problems: newProblems, operation: 'update' },
      );
      if (res?.success) {
        Notification.success(i18n('Saved'));
        onSave({ ...card, problems: newProblems });
      } else {
        Notification.error(i18n('Save failed'));
      }
    } catch (e: any) {
      const msg = e?.message ?? i18n('Save failed');
      Notification.error(typeof msg === 'string' ? msg : String(msg));
    } finally {
      setSaving(false);
    }
  }, [saving, card, problemIndex, updatedProblem, problemTags, resolvedDomainId, onSave]);

  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  }, [onClose]);

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
          padding: '14px 20px', borderBottom: '1px solid var(--roadmap-border, #e0e0e0)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--roadmap-text-primary, #222)' }}>
            {i18n('Edit Problem')} #{problemIndex + 1}
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
                background: saving ? 'var(--roadmap-bg-disabled, #eee)' : 'var(--roadmap-accent, #ffd24a)',
                color: saving ? 'var(--roadmap-text-muted, #999)' : 'var(--roadmap-text-on-accent, #111)',
                fontSize: 13, fontWeight: 600, cursor: saving ? 'default' : 'pointer',
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

        {/* Body — EditableProblem */}
        <div style={{
          flex: 1, overflow: 'auto', padding: '16px 20px', minHeight: 0,
        }}>
          <EditableProblem
            problem={updatedProblem}
            index={problemIndex}
            cardId={card.docId}
            borderColor="#e1e4e8"
            borderStyle="solid"
            isNew={false}
            isEdited={false}
            onUpdate={(p) => setUpdatedProblem(p)}
            onDelete={() => {}}
            docId={resolvedDocId}
            getBaseUrl={getBaseUrl}
            themeStyles={themeStyles}
          />
        </div>

        {/* Bottom: Problem tags — select from available */}
        <div style={{ flexShrink: 0, padding: '12px 20px', borderTop: '1px solid var(--roadmap-border, #e0e0e0)' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--roadmap-text-secondary, #888)', marginBottom: 6 }}>
            {i18n('Problem tags')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {(() => {
                const tagsForRender: string[] = (Array.isArray(availableTags) && availableTags.length > 0)
                  ? availableTags
                  : (Array.isArray((window as any).UiContext?.base?.problemTags) ? (window as any).UiContext.base.problemTags : []);
                const allNodeCardsMap = (window as any).UiContext?.nodeCardsMap || {};
                const allTags = new Set(tagsForRender);
                Object.values(allNodeCardsMap as Record<string, any[]>).forEach((cards) => {
                  cards.forEach((c: any) => {
                    if (Array.isArray(c.problems)) c.problems.forEach((p: any) => {
                      if (Array.isArray(p.tags)) p.tags.forEach((t: string) => allTags.add(t));
                    });
                  });
                });
                const renderTags = [...allTags];
                const parents: string[] = [];
                const childMap: Record<string, string[]> = {};
                for (const t of renderTags) {
                  const sl = t.indexOf('/');
                  if (sl > 0) { const p2 = t.slice(0, sl); const c2 = t.slice(sl + 1); if (!childMap[p2]) childMap[p2] = []; childMap[p2].push(c2); }
                  else { parents.push(t); }
                }
                const toggleTag = (tag: string) => {
                  if (problemTags.includes(tag)) setProblemTags((prev) => prev.filter((t) => t !== tag && !t.startsWith(tag + "/")));
                  else setProblemTags((prev) => [...prev, tag]);
                };
                const buttons: React.ReactNode[] = [];
                for (const p of parents) {
                  const pSel = problemTags.includes(p);
                  const chs = childMap[p] || [];
                  buttons.push(
                    <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 0, border: `1px solid ${pSel ? 'var(--roadmap-problem-tag-color, #e65100)' : 'var(--roadmap-border, #ddd)'}`, borderRadius: 4, overflow: 'hidden', fontSize: 11, lineHeight: '1.5' }}>
                      <span style={{ padding: '3px 8px', cursor: 'pointer', background: pSel ? 'var(--roadmap-problem-tag-bg, rgba(255,152,0,0.15))' : 'transparent', color: pSel ? 'var(--roadmap-problem-tag-color, #e65100)' : 'var(--roadmap-text-secondary, #888)', fontWeight: 600 }}
                        onClick={() => toggleTag(p)}>
                        {p}
                      </span>
                      {chs.map((c) => {
                        const fullTag = p + '/' + c;
                        const cSel = problemTags.includes(fullTag);
                        return (
                          <span key={fullTag} style={{ padding: '3px 6px', cursor: 'pointer', borderLeft: '1px solid var(--roadmap-border, #ddd)', background: cSel ? 'var(--roadmap-problem-tag-bg, rgba(255,152,0,0.15))' : 'transparent', color: cSel ? 'var(--roadmap-problem-tag-color, #e65100)' : 'var(--roadmap-text-secondary, #888)', fontWeight: cSel ? 600 : 400 }}
                            onClick={() => {
                              if (cSel) setProblemTags((prev) => prev.filter((t) => t !== fullTag));
                              else setProblemTags((prev) => prev.includes(p) ? [...prev, fullTag] : [...prev, p, fullTag]);
                            }}>
                            {c}
                          </span>
                        );
                      })}
                    </span>
                  );
                }
                if (buttons.length > 0) return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{buttons}</div>;
                return <span style={{ fontSize: 11, color: 'var(--roadmap-text-muted, #aaa)', fontStyle: 'italic' }}>{i18n('No tags available')}</span>;                return <span style={{ fontSize: 11, color: 'var(--roadmap-text-muted, #aaa)', fontStyle: 'italic' }}>{i18n('No tags available')}</span>;
              })()}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
