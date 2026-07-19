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

export function BaseDetailExplorer({
  searchQuery,
  filters,
  matchedCount,
  onSearchQueryChange,
  onApplyFilters,
  onClearFilters,
  availableCardTags,
}: {
  searchQuery: string;
  filters: BaseDetailFilter;
  matchedCount: number;
  onSearchQueryChange: (query: string) => void;
  onApplyFilters: (filters: BaseDetailFilter) => void;
  onClearFilters: () => void;
  availableCardTags?: string[];
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
                {availableCardTags && availableCardTags.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                    {availableCardTags.map((tag) => {
                      const activeTags = filterDraft.filterCardTag.split(',').map((t) => t.trim()).filter(Boolean);
                      const selected = activeTags.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => {
                            const current = new Set(activeTags);
                            if (selected) current.delete(tag);
                            else current.add(tag);
                            setFilterDraft((draft) => ({ ...draft, filterCardTag: [...current].join(', ') }));
                          }}
                          style={{
                            padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer',
                            background: selected ? 'var(--roadmap-tag-bg, rgba(65, 53, 214, 0.1))' : 'var(--roadmap-bg-input, #f0f0f0)',
                            color: selected ? 'var(--roadmap-tag-color, var(--roadmap-accent, #4135d6))' : 'var(--roadmap-text-secondary, #888)',
                            fontSize: 11, fontWeight: selected ? 600 : 400, outline: 'none',
                          }}
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
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
