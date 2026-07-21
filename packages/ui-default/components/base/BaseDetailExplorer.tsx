import React, { useCallback, useEffect, useState } from 'react';
import { i18n } from 'vj/utils';
import {
  emptyBaseDetailFilter,
  isBaseDetailFilterActive,
  type BaseDetailFilter,
  writeBaseDetailFilterToLocation,
} from './detail_tree_filter';

function FilterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.75" />
      <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/** Render tags as inline row boxes (parent | child1 | child2) with toggle logic. */
function TagChipGroup({
  tags,
  selectedSet,
  onToggle,
  highlightColor,
}: {
  tags: string[];
  selectedSet: Set<string>;
  onToggle: (tag: string, isParent: boolean, parentTag?: string) => void;
  highlightColor: string;
}) {
  // Build hierarchy
  const parents: string[] = [];
  const childMap: Record<string, string[]> = {};
  for (const t of tags) {
    const sl = t.indexOf('/');
    if (sl > 0) {
      const p = t.slice(0, sl);
      const c = t.slice(sl + 1);
      if (!childMap[p]) childMap[p] = [];
      childMap[p].push(c);
    } else {
      parents.push(t);
    }
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {parents.map((p) => {
        const chs = childMap[p] || [];
        const pSel = selectedSet.has(p);
        const groupSel = pSel || chs.some((c) => selectedSet.has(p + '/' + c));
        return (
          <span key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 0, border: `1px solid ${groupSel ? highlightColor : 'var(--roadmap-border, #ddd)'}`, borderRadius: 4, overflow: 'hidden', fontSize: 11, lineHeight: '1.5' }}>
            <span style={{ padding: '2px 7px', cursor: 'pointer', background: pSel ? 'var(--roadmap-tag-bg, rgba(65,53,214,0.1))' : 'var(--roadmap-bg-input, #f0f0f0)', color: pSel ? highlightColor : 'var(--roadmap-text-secondary, #888)', fontWeight: 600 }}
              onClick={() => onToggle(p, true, undefined)}>
              {p}
            </span>
            {chs.map((c) => {
              const fullTag = p + '/' + c;
              const cSel = selectedSet.has(fullTag);
              return (
                <span key={fullTag} style={{ padding: '2px 6px', cursor: 'pointer', borderLeft: '1px solid var(--roadmap-border, #ddd)', background: cSel ? 'var(--roadmap-tag-bg, rgba(65,53,214,0.1))' : 'transparent', color: cSel ? highlightColor : 'var(--roadmap-text-secondary, #888)', fontWeight: cSel ? 600 : 400 }}
                  onClick={() => onToggle(fullTag, false, p)}>
                  {c}
                </span>
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

export function BaseDetailExplorer({
  searchQuery,
  filters,
  matchedCount,
  onSearchQueryChange,
  onApplyFilters,
  onClearFilters,
  availableCardTags,
  availableProblemTags,
}: {
  searchQuery: string;
  filters: BaseDetailFilter;
  matchedCount: number;
  onSearchQueryChange: (query: string) => void;
  onApplyFilters: (filters: BaseDetailFilter) => void;
  onClearFilters: () => void;
  availableCardTags?: string[];
  availableProblemTags?: string[];
}) {
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState<BaseDetailFilter>(filters);
  const filtersActive = isBaseDetailFilterActive(filters);
  const searchActive = !!searchQuery.trim();

  useEffect(() => {
    if (!filterDialogOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFilterDialogOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filterDialogOpen]);

  const openFilterDialog = useCallback(() => {
    setFilterDraft(filters);
    setFilterDialogOpen(true);
  }, [filters]);

  const applyFilters = useCallback(() => {
    writeBaseDetailFilterToLocation(filterDraft);
    onApplyFilters(filterDraft);
    setFilterDialogOpen(false);
  }, [filterDraft, onApplyFilters]);

  const clearFilters = useCallback(() => {
    const empty = emptyBaseDetailFilter();
    setFilterDraft(empty);
    writeBaseDetailFilterToLocation(empty);
    onClearFilters();
    setFilterDialogOpen(false);
  }, [onClearFilters]);

  const makeToggleHandler = (field: 'filterCardTag' | 'filterProblemTag') => (tag: string) => {
    setFilterDraft((draft) => {
      const current = draft[field].split(',').map((t) => t.trim()).filter(Boolean);
      const set = new Set(current);
      if (set.has(tag)) set.delete(tag);
      else set.add(tag);
      // Also remove children when parent is toggled off
      if (field === 'filterCardTag') {
        // no special handling needed — child tags are independent tags in the set
      }
      return { ...draft, [field]: [...set].join(', ') };
    });
  };

  const parseActiveTags = (field: string): Set<string> =>
    new Set(field.split(',').map((t) => t.trim()).filter(Boolean));

  return (
    <>
      <div className="roadmap-detail-explorer">
        <button
          type="button"
          className={`roadmap-detail-explorer__filter${filtersActive ? ' is-active' : ''}`}
          onClick={openFilterDialog}
          aria-haspopup="dialog"
          aria-expanded={filterDialogOpen}
          title={String(i18n('Roadmap detail filter aria'))}
        >
          <FilterIcon />
          <span>{i18n('Roadmap detail filter open')}</span>
        </button>

        <div className="roadmap-detail-explorer__search">
          <SearchIcon />
          <input
            type="search"
            className="roadmap-detail-explorer__search-input"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.currentTarget.value)}
            placeholder={i18n('Base detail tree search placeholder')}
            aria-label={i18n('Base detail tree search aria')}
            autoComplete="off"
          />
        </div>

        {filtersActive || searchActive ? (
          <span className="roadmap-detail-explorer__summary">
            {i18n('Roadmap detail filter match count', matchedCount)}
          </span>
        ) : null}
      </div>

      {filterDialogOpen ? (
        <>
          <div
            className="roadmap-detail-explorer__backdrop"
            onClick={() => setFilterDialogOpen(false)}
            aria-hidden
          />
          <div
            className="roadmap-detail-explorer__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="base-detail-filter-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="base-detail-filter-title" className="roadmap-detail-explorer__dialog-title">
              {i18n('Roadmap detail filter dialog title')}
            </h2>
            <p className="roadmap-detail-explorer__dialog-hint">
              {i18n('Base detail content filter dialog hint')}
            </p>
            <div className="roadmap-detail-explorer__dialog-fields">
              <label className="roadmap-detail-explorer__field">
                <span>{i18n('Roadmap detail filter node label')}</span>
                <input
                  type="text"
                  value={filterDraft.filterNode}
                  onChange={(e) => setFilterDraft((draft) => ({ ...draft, filterNode: e.target.value }))}
                  placeholder={i18n('Roadmap detail filter node placeholder')}
                  autoComplete="off"
                />
              </label>
              <label className="roadmap-detail-explorer__field">
                <span>{i18n('Roadmap detail filter content label')}</span>
                <input
                  type="text"
                  value={filterDraft.filterCard}
                  onChange={(e) => setFilterDraft((draft) => ({ ...draft, filterCard: e.target.value }))}
                  placeholder={i18n('Roadmap detail filter content placeholder')}
                  autoComplete="off"
                />
              </label>
              <label className="roadmap-detail-explorer__field">
                <span>{i18n('Roadmap detail filter problem label')}</span>
                <input
                  type="text"
                  value={filterDraft.filterProblem}
                  onChange={(e) => setFilterDraft((draft) => ({ ...draft, filterProblem: e.target.value }))}
                  placeholder={i18n('Roadmap detail filter problem placeholder')}
                  autoComplete="off"
                />
              </label>

              {/* Card tags filter */}
              <label className="roadmap-detail-explorer__field">
                <span>{i18n('Card tags filter')}</span>
                <input
                  type="text"
                  value={filterDraft.filterCardTag}
                  onChange={(e) => setFilterDraft((draft) => ({ ...draft, filterCardTag: e.target.value }))}
                  placeholder={i18n('Card tags filter placeholder')}
                  autoComplete="off"
                  style={{ marginBottom: 6 }}
                />
                {availableCardTags && availableCardTags.length > 0 && (
                  <TagChipGroup
                    tags={availableCardTags}
                    selectedSet={parseActiveTags(filterDraft.filterCardTag)}
                    onToggle={makeToggleHandler('filterCardTag')}
                    highlightColor="var(--roadmap-tag-color, #4135d6)"
                  />
                )}
              </label>

              {/* Problem tags filter */}
              <label className="roadmap-detail-explorer__field">
                <span>{i18n('Problem tags filter')}</span>
                <input
                  type="text"
                  value={filterDraft.filterProblemTag}
                  onChange={(e) => setFilterDraft((draft) => ({ ...draft, filterProblemTag: e.target.value }))}
                  placeholder={i18n('Problem tags filter placeholder')}
                  autoComplete="off"
                  style={{ marginBottom: 6 }}
                />
                {availableProblemTags && availableProblemTags.length > 0 && (
                  <TagChipGroup
                    tags={availableProblemTags}
                    selectedSet={parseActiveTags(filterDraft.filterProblemTag)}
                    onToggle={makeToggleHandler('filterProblemTag')}
                    highlightColor="#e65100"
                  />
                )}
              </label>
            </div>
            <div className="roadmap-detail-explorer__dialog-actions">
              <button type="button" className="roadmap-detail-explorer__dialog-btn" onClick={clearFilters}>
                {i18n('Roadmap detail filter clear')}
              </button>
              <button type="button" className="roadmap-detail-explorer__dialog-btn" onClick={() => setFilterDialogOpen(false)}>
                {i18n('Roadmap detail filter cancel')}
              </button>
              <button
                type="button"
                className="roadmap-detail-explorer__dialog-btn roadmap-detail-explorer__dialog-btn--primary"
                onClick={applyFilters}
              >
                {i18n('Roadmap detail filter apply')}
              </button>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}
