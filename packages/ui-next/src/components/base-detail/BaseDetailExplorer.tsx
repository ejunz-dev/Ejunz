import { useEffect, useState } from 'react';
import { i18n } from '../../i18n';
import {
  emptyBaseDetailFilter,
  isBaseDetailFilterActive,
  type BaseDetailFilter,
  writeBaseDetailFilterToLocation,
} from './detail-filter';

interface Props {
  value: string;
  onChange: (value: string) => void;
  filters: BaseDetailFilter;
  matchedCount: number;
  onApplyFilters: (filters: BaseDetailFilter) => void;
  onClearFilters: () => void;
  availableCardTags: string[];
  availableProblemTags: string[];
}

function TagInput({ label, placeholder, value, onChange, tags }: { label: string; placeholder: string; value: string; onChange: (value: string) => void; tags: string[] }) {
  return (
    <label className="bd-explorer__field">
      <span>{label}</span>
      <input type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} autoComplete="off" />
      {tags.length ? <small>{tags.join(' · ')}</small> : null}
    </label>
  );
}

export function BaseDetailExplorer({ value, onChange, filters, matchedCount, onApplyFilters, onClearFilters, availableCardTags, availableProblemTags }: Props) {
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState<BaseDetailFilter>(filters);
  const filtersActive = isBaseDetailFilterActive(filters);

  useEffect(() => {
    if (!filterDialogOpen) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setFilterDialogOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [filterDialogOpen]);

  const openFilters = () => {
    setFilterDraft(filters);
    setFilterDialogOpen(true);
  };
  const applyFilters = () => {
    writeBaseDetailFilterToLocation(filterDraft);
    onApplyFilters(filterDraft);
    setFilterDialogOpen(false);
  };
  const clearFilters = () => {
    const empty = emptyBaseDetailFilter();
    writeBaseDetailFilterToLocation(empty);
    setFilterDraft(empty);
    onClearFilters();
    setFilterDialogOpen(false);
  };

  return (
    <>
      <div className="bd-explorer">
        <button type="button" className={`bd-explorer__filter${filtersActive ? ' is-active' : ''}`} onClick={openFilters} aria-haspopup="dialog" aria-expanded={filterDialogOpen} aria-label={i18n('Roadmap detail filter aria')}>
          ☷ <span>{i18n('Roadmap detail filter open')}</span>
        </button>
        <label className="bd-explorer__search">
          <span aria-hidden>⌕</span>
          <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={i18n('Base detail tree search placeholder')} aria-label={i18n('Base detail tree search aria')} autoComplete="off" />
          {value ? <button type="button" onClick={() => onChange('')} aria-label={i18n('Roadmap detail filter clear')}>×</button> : null}
        </label>
        {filtersActive || value.trim() ? <span className="bd-explorer__summary">{i18n('Roadmap detail filter match count', matchedCount)}</span> : null}
      </div>
      {filterDialogOpen ? (
        <>
          <button type="button" className="bd-explorer__backdrop" onClick={() => setFilterDialogOpen(false)} aria-label={i18n('Close')} />
          <div className="bd-explorer__dialog" role="dialog" aria-modal="true" aria-labelledby="base-detail-filter-title">
            <h2 id="base-detail-filter-title">{i18n('Roadmap detail filter dialog title')}</h2>
            <p>{i18n('Base detail content filter dialog hint')}</p>
            <div className="bd-explorer__fields">
              <TagInput label={i18n('Roadmap detail filter node label')} placeholder={i18n('Roadmap detail filter node placeholder')} value={filterDraft.filterNode} onChange={(filterNode) => setFilterDraft((draft) => ({ ...draft, filterNode }))} tags={[]} />
              <TagInput label={i18n('Roadmap detail filter content label')} placeholder={i18n('Roadmap detail filter content placeholder')} value={filterDraft.filterCard} onChange={(filterCard) => setFilterDraft((draft) => ({ ...draft, filterCard }))} tags={[]} />
              <TagInput label={i18n('Roadmap detail filter problem label')} placeholder={i18n('Roadmap detail filter problem placeholder')} value={filterDraft.filterProblem} onChange={(filterProblem) => setFilterDraft((draft) => ({ ...draft, filterProblem }))} tags={[]} />
              <TagInput label={i18n('Card tags filter')} placeholder={i18n('Card tags filter placeholder')} value={filterDraft.filterCardTag} onChange={(filterCardTag) => setFilterDraft((draft) => ({ ...draft, filterCardTag }))} tags={availableCardTags} />
              <TagInput label={i18n('Problem tags filter')} placeholder={i18n('Problem tags filter placeholder')} value={filterDraft.filterProblemTag} onChange={(filterProblemTag) => setFilterDraft((draft) => ({ ...draft, filterProblemTag }))} tags={availableProblemTags} />
            </div>
            <div className="bd-explorer__actions">
              <button type="button" onClick={clearFilters}>{i18n('Roadmap detail filter clear')}</button>
              <button type="button" onClick={() => setFilterDialogOpen(false)}>{i18n('Roadmap detail filter cancel')}</button>
              <button type="button" className="is-primary" onClick={applyFilters}>{i18n('Roadmap detail filter apply')}</button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
