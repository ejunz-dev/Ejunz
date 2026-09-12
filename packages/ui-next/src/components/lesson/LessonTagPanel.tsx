import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Problem } from 'ejun/src/interface';
import { getProblemTagList, normalizeProblemTagInput } from 'ejun/src/model/problem';
import { i18n } from '../../i18n';
import Notification from '../notification';
import { BaseDetailProblemTagPicker } from '../base-detail/BaseDetailProblemTagPicker';
import { deleteProblemTag, registerProblemTag, saveCardProblems } from './lesson-api';

interface Props {
  open: boolean;
  problem: Problem | null;
  cardId: string;
  cardProblems: Problem[];
  domainId: string;
  baseDocId: number;
  registry: string[];
  canEdit: boolean;
  onClose: () => void;
  onRegistryChange: (next: string[]) => void;
  onProblemsChange: (next: Problem[]) => void;
}

function tagGroups(tags: string[]) {
  const parents: string[] = [];
  const children = new Map<string, string[]>();
  for (const tag of tags) {
    const slash = tag.indexOf('/');
    if (slash > 0) {
      const parent = tag.slice(0, slash);
      const child = tag.slice(slash + 1);
      children.set(parent, [...(children.get(parent) || []), child]);
    } else if (!parents.includes(tag)) {
      parents.push(tag);
    }
  }
  for (const parent of children.keys()) if (!parents.includes(parent)) parents.push(parent);
  return { parents, children };
}

export function LessonTagPanel({
  open,
  problem,
  cardId,
  cardProblems,
  domainId,
  baseDocId,
  registry,
  canEdit,
  onClose,
  onRegistryChange,
  onProblemsChange,
}: Props) {
  const pid = String(problem?.pid || '');
  const [tab, setTab] = useState<'assign' | 'manage'>('assign');
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftRegistry, setDraftRegistry] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab('assign');
    setDraftTags(getProblemTagList(problem));
    setDraftRegistry([...registry]);
    setNewTag('');
    setRenaming(null);
    setRenameInput('');
  }, [open, problem, pid, registry]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const initialTags = useMemo(() => getProblemTagList(problem), [problem]);
  const tagsDirty = useMemo(
    () => JSON.stringify([...initialTags].sort()) !== JSON.stringify([...draftTags].sort()),
    [initialTags, draftTags],
  );
  const registryDirty = useMemo(
    () => JSON.stringify([...registry].sort()) !== JSON.stringify([...draftRegistry].sort()),
    [registry, draftRegistry],
  );
  const dirty = tagsDirty || registryDirty;
  const currentGroups = useMemo(() => tagGroups(draftTags), [draftTags]);
  const manageGroups = useMemo(() => tagGroups(draftRegistry), [draftRegistry]);

  const handleSave = useCallback(async () => {
    if (!canEdit || saving || !dirty || !pid || !cardId) return;
    setSaving(true);
    try {
      if (tagsDirty) {
        const nextProblems = cardProblems.map((item) => {
          if (String(item.pid || '') !== pid) return item;
          const copy = { ...item } as Problem & { tags?: string[] };
          if (draftTags.length) copy.tags = draftTags;
          else delete copy.tags;
          return copy;
        });
        await saveCardProblems(domainId, cardId, nextProblems);
        onProblemsChange(nextProblems);
      }
      const removed = registry.filter((tag) => !draftRegistry.includes(tag));
      const added = draftRegistry.filter((tag) => !registry.includes(tag));
      for (const tag of removed) {
        try {
          await deleteProblemTag(domainId, baseDocId, tag);
        } catch { /* one stale registry entry must not block the rest */ }
      }
      for (const tag of added) {
        try {
          await registerProblemTag(domainId, baseDocId, tag);
        } catch { /* one rejected tag must not block the rest */ }
      }
      onRegistryChange([...draftRegistry]);
      Notification.success(i18n('Saved successfully'));
    } catch (error: any) {
      Notification.error(typeof error?.message === 'string' ? error.message : i18n('Lesson problem tag save failed'));
    } finally {
      setSaving(false);
    }
  }, [canEdit, saving, dirty, pid, cardId, tagsDirty, cardProblems, draftTags, domainId, registry, draftRegistry, baseDocId, onProblemsChange, onRegistryChange]);

  if (!open || !problem) return null;

  return (
    <div className="lesson-panel" role="dialog" aria-modal="true" aria-label={i18n('Lesson problem tag panel title')}>
      <button type="button" className="lesson-panel__scrim" aria-label={i18n('Close')} onClick={onClose} />
      <div className="lesson-panel__body">
        <div className="lesson-panel__head">
          <h2 className="lesson-panel__title">{i18n('Lesson problem tag panel title')}</h2>
          <button type="button" className="lesson-panel__close" onClick={onClose}>{i18n('Close')}</button>
        </div>

        <div className="lesson-panel__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'assign'}
            className={`lesson-panel__tab${tab === 'assign' ? ' is-active' : ''}`}
            onClick={() => setTab('assign')}
          >
            {i18n('Lesson problem tag panel assign')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'manage'}
            className={`lesson-panel__tab${tab === 'manage' ? ' is-active' : ''}`}
            disabled={!canEdit}
            onClick={() => setTab('manage')}
          >
            {i18n('Manage tags')}
          </button>
          <button
            type="button"
            className="lesson-panel__save"
            disabled={!canEdit || saving || !dirty}
            onClick={() => void handleSave()}
          >
            {saving ? i18n('Saving...') : i18n('Save')}
          </button>
        </div>

        {tab === 'assign' ? (
          <div className="lesson-panel__section">
            <div className="lesson-panel__label">{i18n('Lesson problem tag panel current')}</div>
            {draftTags.length ? (
              <div className="lesson-tag-row">
                {currentGroups.parents.map((parent) => {
                  const children = currentGroups.children.get(parent) || [];
                  return (
                    <span className="lesson-tag-group" key={parent}>
                      <button
                        type="button"
                        className="lesson-tag is-selected"
                        disabled={!canEdit}
                        onClick={() => setDraftTags((prev) => prev.filter((tag) => tag !== parent && !tag.startsWith(`${parent}/`)))}
                      >
                        {parent}
                      </button>
                      {children.map((child) => {
                        const full = `${parent}/${child}`;
                        return (
                          <button
                            type="button"
                            className="lesson-tag lesson-tag--child is-selected"
                            key={full}
                            disabled={!canEdit}
                            onClick={() => setDraftTags((prev) => prev.filter((tag) => tag !== full))}
                          >
                            {child}
                          </button>
                        );
                      })}
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="lesson-panel__empty">{i18n('Lesson problem tag panel empty')}</p>
            )}

            <div className="lesson-panel__label">{i18n('Available tags')}</div>
            {draftRegistry.length ? (
              <BaseDetailProblemTagPicker
                value={draftTags}
                availableTags={draftRegistry}
                onChange={setDraftTags}
                disabled={!canEdit}
              />
            ) : (
              <p className="lesson-panel__empty">{i18n('No tags available')}</p>
            )}
          </div>
        ) : (
          <div className="lesson-panel__section">
            <div className="lesson-panel__label">{i18n('Manage tags')}</div>
            <div className="lesson-panel__add">
              <input
                type="text"
                value={newTag}
                placeholder={i18n('Problem tags')}
                onChange={(event) => setNewTag(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={!normalizeProblemTagInput(newTag)}
                onClick={() => {
                  const tag = normalizeProblemTagInput(newTag);
                  if (!tag) return;
                  setDraftRegistry((prev) => [...new Set([...prev, tag])].sort((a, b) => a.localeCompare(b)));
                  setNewTag('');
                }}
              >
                {i18n('Add')}
              </button>
            </div>
            {manageGroups.parents.map((parent) => {
              const children = manageGroups.children.get(parent) || [];
              return (
                <div className="lesson-panel__manage-group" key={parent}>
                  <div className="lesson-panel__manage-row">
                    {renaming === parent ? (
                      <input
                        type="text"
                        value={renameInput}
                        autoFocus
                        onChange={(event) => setRenameInput(event.currentTarget.value)}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          const next = normalizeProblemTagInput(renameInput);
                          if (next && !next.includes('/') && next !== parent) {
                            setDraftRegistry((prev) => [...new Set(prev.map((tag) => (tag === parent ? next : tag.startsWith(`${parent}/`) ? `${next}/${tag.slice(parent.length + 1)}` : tag)))].sort((a, b) => a.localeCompare(b)));
                          }
                          setRenaming(null);
                        }}
                      />
                    ) : (
                      <span className="lesson-panel__manage-name">{parent}</span>
                    )}
                    <button type="button" onClick={() => { setRenaming(parent); setRenameInput(parent); }}>{i18n('Rename')}</button>
                    <button
                      type="button"
                      onClick={() => setDraftRegistry((prev) => prev.filter((tag) => tag !== parent && !tag.startsWith(`${parent}/`)))}
                    >
                      {i18n('Delete')}
                    </button>
                  </div>
                  {children.map((child) => {
                    const full = `${parent}/${child}`;
                    return (
                      <div className="lesson-panel__manage-row is-child" key={full}>
                        <span className="lesson-panel__manage-name">{child}</span>
                        <button type="button" onClick={() => setDraftRegistry((prev) => prev.filter((tag) => tag !== full))}>{i18n('Delete')}</button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {!manageGroups.parents.length ? <p className="lesson-panel__empty">{i18n('No tags available')}</p> : null}
          </div>
        )}
      </div>
    </div>
  );
}
