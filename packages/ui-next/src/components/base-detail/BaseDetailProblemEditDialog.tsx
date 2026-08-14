import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Problem } from 'ejun/src/interface';
import { i18n } from '../../i18n';
import { BaseDetailProblemForm } from './BaseDetailProblemForm';
import type { BaseDetailCard, BaseDetailProblem } from './types';
import './base-detail.css';

interface Props {
  card: BaseDetailCard;
  problem: BaseDetailProblem;
  problemIndex: number;
  domainId: string;
  baseDocId: string;
  availableTags?: string[];
  onSave: (updatedCard: BaseDetailCard) => Promise<void>;
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

export function BaseDetailProblemEditDialog({ card, problem, problemIndex, domainId, baseDocId, availableTags = [], onSave, onClose }: Props) {
  const initialProblem = problem as unknown as Problem;
  const [updatedProblem, setUpdatedProblem] = useState<Problem>(initialProblem);
  const [problemTags, setProblemTags] = useState<string[]>(problem.tags || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(saving);
  const updatedProblemRef = useRef(updatedProblem);
  const problemTagsRef = useRef(problemTags);
  savingRef.current = saving;
  updatedProblemRef.current = updatedProblem;
  problemTagsRef.current = problemTags;

  const allTags = useMemo(() => {
    const values = new Set([...availableTags, ...(problem.tags || [])]);
    return [...values].filter(Boolean).sort();
  }, [availableTags, problem.tags]);
  const groups = useMemo(() => tagGroups(allTags), [allTags]);

  async function save() {
    if (savingRef.current) return;
    setSaving(true);
    setError('');
    try {
      const problems = [...(card.problems || [])];
      problems[problemIndex] = { ...updatedProblemRef.current, tags: problemTagsRef.current } as BaseDetailProblem;
      await onSave({ ...card, problems, updateAt: new Date().toISOString() });
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
    setProblemTags((current) => current.includes(parent)
      ? current.filter((tag) => tag !== parent && !tag.startsWith(`${parent}/`))
      : [...current, parent]);
  };
  const toggleChild = (parent: string, child: string) => {
    const tag = `${parent}/${child}`;
    setProblemTags((current) => current.includes(tag)
      ? current.filter((item) => item !== tag)
      : current.includes(parent) ? [...current, tag] : [...current, parent, tag]);
  };

  return createPortal(
    <div className="bd-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="bd-edit-dialog bd-edit-dialog--problem" role="dialog" aria-modal="true" aria-labelledby="bd-problem-edit-title">
        <header className="bd-edit-dialog__header">
          <h2 id="bd-problem-edit-title">{i18n('Edit Problem')} #{problemIndex + 1}</h2>
          <div className="bd-edit-dialog__actions">
            {saving ? <span className="bd-edit-dialog__status">{i18n('Saving...')}</span> : null}
            <button type="button" className="bd-edit-button bd-edit-button--primary" disabled={saving} onClick={() => void save()}>{i18n('Save')}</button>
            <button type="button" className="bd-edit-button" disabled={saving} onClick={onClose}>{i18n('Cancel')}</button>
          </div>
        </header>
        <div className="bd-edit-dialog__body">
          {error ? <p className="bd-edit-dialog__error" role="alert">{error}</p> : null}
          <BaseDetailProblemForm
            problem={updatedProblem}
            index={problemIndex}
            cardId={card.docId}
            borderColor="var(--bd-line)"
            borderStyle="solid"
            isNew={false}
            isEdited={false}
            onUpdate={setUpdatedProblem}
            onDelete={() => undefined}
            docId={baseDocId}
            getBaseUrl={(path) => `${domainId !== 'system' ? `/d/${encodeURIComponent(domainId)}` : ''}${path}`}
            themeStyles={{
              borderPrimary: 'var(--bd-line)',
              bgPrimary: 'var(--bd-surface)',
              bgSecondary: 'var(--bd-bg)',
              textPrimary: 'var(--bd-ink)',
              textSecondary: 'var(--bd-muted)',
              success: 'var(--web-positive)',
              warning: 'var(--web-negative)',
            }}
          />
          <div className="bd-edit-field bd-edit-field--problem-tags">
            <span>{i18n('Problem tags')}</span>
            {allTags.length ? (
              <div className="bd-edit-tags">
                {groups.parents.map((parent) => (
                  <span className="bd-edit-tag-group" key={parent}>
                    <button type="button" className={`bd-edit-tag bd-edit-tag--problem${problemTags.includes(parent) ? ' is-selected' : ''}`} onClick={() => toggleParent(parent)}>{parent}</button>
                    {(groups.children.get(parent) || []).map((child) => {
                      const tag = `${parent}/${child}`;
                      return <button type="button" className={`bd-edit-tag bd-edit-tag--child bd-edit-tag--problem${problemTags.includes(tag) ? ' is-selected' : ''}`} key={tag} onClick={() => toggleChild(parent, child)}>{child}</button>;
                    })}
                  </span>
                ))}
              </div>
            ) : <span className="bd-edit-dialog__muted">{i18n('No tags available')}</span>}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
