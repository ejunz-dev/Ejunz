import { useMemo } from 'react';

interface Props {
  tags: string[];
  value: string;
  onChange: (value: string) => void;
  variant: 'card' | 'problem';
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
    } else if (!parents.includes(tag)) {
      parents.push(tag);
    }
  }
  for (const parent of children.keys()) if (!parents.includes(parent)) parents.push(parent);
  return { parents, children };
}

function parseTags(value: string): Set<string> {
  return new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean));
}

export function BaseDetailFilterTagGroup({ tags, value, onChange, variant }: Props) {
  const groups = useMemo(() => tagGroups(tags), [tags]);
  const selected = useMemo(() => parseTags(value), [value]);
  const toggle = (tag: string) => {
    const next = new Set(selected);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange([...next].join(', '));
  };

  return (
    <div className={`bd-filter-tags bd-filter-tags--${variant}`}>
      {groups.parents.map((parent) => {
        const children = groups.children.get(parent) || [];
        const parentSelected = selected.has(parent);
        const groupSelected = parentSelected || children.some((child) => selected.has(`${parent}/${child}`));
        return (
          <span className={`bd-filter-tag-group${groupSelected ? ' is-selected' : ''}`} key={parent}>
            <button type="button" className={`bd-filter-tag bd-filter-tag--parent${parentSelected ? ' is-selected' : ''}`} aria-pressed={parentSelected} onClick={() => toggle(parent)}>{parent}</button>
            {children.map((child) => {
              const tag = `${parent}/${child}`;
              const childSelected = selected.has(tag);
              return <button type="button" className={`bd-filter-tag bd-filter-tag--child${childSelected ? ' is-selected' : ''}`} aria-pressed={childSelected} key={tag} onClick={() => toggle(tag)}>{child}</button>;
            })}
          </span>
        );
      })}
    </div>
  );
}
