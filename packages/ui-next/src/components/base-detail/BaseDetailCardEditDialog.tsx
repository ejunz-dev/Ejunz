import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { i18n } from '../../i18n';
import type { BaseDetailCard } from './types';
import './base-detail.css';

interface Props {
  card: BaseDetailCard;
  availableTags?: string[];
  onSave: (updated: BaseDetailCard) => Promise<void>;
  onClose: () => void;
}

function tagGroups(tags: string[]) {
  const parents: string[] = [];
  const children = new Map<string, string[]>();
  for (const tag of tags) {
    const slash = tag.indexOf('/');
    if (slash > 0) {
      const parent = tag.slice(0, slash);
      const child = tag.slice(slash + 1);
      const group = children.get(parent) || [];
      group.push(child);
      children.set(parent, group);
    } else {
      parents.push(tag);
    }
  }
  for (const parent of children.keys()) if (!parents.includes(parent)) parents.push(parent);
  return { parents, children };
}

export function BaseDetailCardEditDialog({ card, availableTags = [], onSave, onClose }: Props) {
  const [title, setTitle] = useState(card.title || '');
  const [content, setContent] = useState(card.content || '');
  const [tags, setTags] = useState<string[]>(card.tags || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const titleRef = useRef(title);
  const contentRef = useRef(content);
  const tagsRef = useRef(tags);
  const savingRef = useRef(saving);
  titleRef.current = title;
  contentRef.current = content;
  tagsRef.current = tags;
  savingRef.current = saving;

  const allTags = useMemo(() => {
    const values = new Set([...availableTags, ...(card.tags || [])]);
    return [...values].filter(Boolean).sort();
  }, [availableTags, card.tags]);
  const groups = useMemo(() => tagGroups(allTags), [allTags]);

  async function save() {
    if (savingRef.current) return;
    setSaving(true);
    setError('');
    try {
      await onSave({
        ...card,
        title: titleRef.current,
        content: contentRef.current,
        tags: tagsRef.current,
        updateAt: new Date().toISOString(),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : i18n('Save failed'));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) onClose();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const toggleParent = (parent: string) => {
    setTags((current) => current.includes(parent)
      ? current.filter((tag) => tag !== parent && !tag.startsWith(`${parent}/`))
      : [...current, parent]);
  };
  const toggleChild = (parent: string, child: string) => {
    const tag = `${parent}/${child}`;
    setTags((current) => current.includes(tag)
      ? current.filter((item) => item !== tag)
      : current.includes(parent) ? [...current, tag] : [...current, parent, tag]);
  };

  return createPortal(
    <div className="bd-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="bd-edit-dialog bd-edit-dialog--card" role="dialog" aria-modal="true" aria-labelledby="bd-card-edit-title">
        <header className="bd-edit-dialog__header">
          <h2 id="bd-card-edit-title">{i18n('Edit')}</h2>
          <div className="bd-edit-dialog__actions">
            {saving ? <span className="bd-edit-dialog__status">{i18n('Saving...')}</span> : null}
            <button type="button" className="bd-edit-button bd-edit-button--primary" disabled={saving} onClick={() => void save()}>{i18n('Save')}</button>
            <button type="button" className="bd-edit-button" disabled={saving} onClick={onClose}>{i18n('Cancel')}</button>
          </div>
        </header>
        <div className="bd-edit-dialog__body">
          {error ? <p className="bd-edit-dialog__error" role="alert">{error}</p> : null}
          <label className="bd-edit-field">
            <span>{i18n('Title')}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </label>
          <label className="bd-edit-field bd-edit-field--content">
            <span>{i18n('Content')}</span>
            <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={i18n('Write card content in markdown...')} />
          </label>
          <div className="bd-edit-field">
            <span>{i18n('Card tags')}</span>
            {allTags.length ? (
              <div className="bd-edit-tags">
                {groups.parents.map((parent) => (
                  <span className="bd-edit-tag-group" key={parent}>
                    <button type="button" className={`bd-edit-tag${tags.includes(parent) ? ' is-selected' : ''}`} onClick={() => toggleParent(parent)}>{parent}</button>
                    {(groups.children.get(parent) || []).map((child) => {
                      const tag = `${parent}/${child}`;
                      return <button type="button" className={`bd-edit-tag bd-edit-tag--child${tags.includes(tag) ? ' is-selected' : ''}`} key={tag} onClick={() => toggleChild(parent, child)}>{child}</button>;
                    })}
                  </span>
                ))}
                {tags.filter((tag) => !allTags.includes(tag)).map((tag) => <button type="button" className="bd-edit-tag is-selected" key={tag} onClick={() => setTags((current) => current.filter((item) => item !== tag))}>{tag} ×</button>)}
              </div>
            ) : <span className="bd-edit-dialog__muted">{i18n('No tags available')}</span>}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
