import { useMemo } from 'react';
import { i18n } from '../../i18n';

interface Props {
  value: string[];
  availableTags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
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

export function BaseDetailProblemTagPicker({ value, availableTags, onChange, disabled = false }: Props) {
  const allTags = useMemo(() => [...new Set([...availableTags, ...value])].filter(Boolean).sort(), [availableTags, value]);
  const groups = useMemo(() => tagGroups(allTags), [allTags]);

  const toggleParent = (parent: string) => {
    onChange(value.includes(parent)
      ? value.filter((tag) => tag !== parent && !tag.startsWith(`${parent}/`))
      : [...value, parent]);
  };
  const toggleChild = (parent: string, child: string) => {
    const tag = `${parent}/${child}`;
    onChange(value.includes(tag)
      ? value.filter((item) => item !== tag)
      : value.includes(parent) ? [...value, tag] : [...value, parent, tag]);
  };

  return (
    <div className="bd-edit-field bd-edit-field--problem-tags">
      <span>{i18n('Problem tags')}</span>
      {allTags.length ? (
        <div className="bd-edit-tags">
          {groups.parents.map((parent) => (
            <span className="bd-edit-tag-group" key={parent}>
              <button type="button" className={`bd-edit-tag bd-edit-tag--problem${value.includes(parent) ? ' is-selected' : ''}`} disabled={disabled} onClick={() => toggleParent(parent)}>{parent}</button>
              {(groups.children.get(parent) || []).map((child) => {
                const tag = `${parent}/${child}`;
                return <button type="button" className={`bd-edit-tag bd-edit-tag--child bd-edit-tag--problem${value.includes(tag) ? ' is-selected' : ''}`} disabled={disabled} key={tag} onClick={() => toggleChild(parent, child)}>{child}</button>;
              })}
            </span>
          ))}
        </div>
      ) : <span className="bd-edit-dialog__muted">{i18n('No tags available')}</span>}
    </div>
  );
}
