import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from 'reactflow';
import { i18n } from 'vj/utils';
import type { EditorCard } from '../editor_workspace/card_problems_panel';
import {
  computeRoadmapDetailSearchHits,
  emptyRoadmapDetailFilter,
  type RoadmapDetailFilter,
  type RoadmapDetailSearchHit,
  writeRoadmapDetailFilterToLocation,
} from './detail_explorer';

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

export type RoadmapDetailExplorerProps = {
  nodes: Node[];
  nodeCardsMap: Record<string, EditorCard[]>;
  filters: RoadmapDetailFilter;
  filtersActive: boolean;
  matchedCount: number;
  onApplyFilters: (filters: RoadmapDetailFilter) => void;
  onClearFilters: () => void;
  onSelectNode: (nodeId: string) => void;
};

export function RoadmapDetailExplorer({
  nodes,
  nodeCardsMap,
  filters,
  filtersActive,
  matchedCount,
  onApplyFilters,
  onClearFilters,
  onSelectNode,
}: RoadmapDetailExplorerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [filterDialogOpen, setFilterDialogOpen] = useState(false);
  const [filterDraft, setFilterDraft] = useState<RoadmapDetailFilter>(filters);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!searchOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (searchWrapRef.current?.contains(event.target as Element)) return;
      setSearchOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!filterDialogOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFilterDialogOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [filterDialogOpen]);

  const searchHits = useMemo(
    () => computeRoadmapDetailSearchHits(nodes, searchQuery, nodeCardsMap),
    [nodeCardsMap, nodes, searchQuery],
  );

  const openFilterDialog = useCallback(() => {
    setFilterDraft(filters);
    setFilterDialogOpen(true);
  }, [filters]);

  const applyFilters = useCallback(() => {
    writeRoadmapDetailFilterToLocation(filterDraft);
    onApplyFilters(filterDraft);
    setFilterDialogOpen(false);
  }, [filterDraft, onApplyFilters]);

  const clearFilters = useCallback(() => {
    const empty = emptyRoadmapDetailFilter();
    setFilterDraft(empty);
    writeRoadmapDetailFilterToLocation(empty);
    onClearFilters();
    setFilterDialogOpen(false);
  }, [onClearFilters]);

  const navigateHit = useCallback((hit: RoadmapDetailSearchHit) => {
    onSelectNode(hit.nodeId);
    setSearchOpen(false);
  }, [onSelectNode]);

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

        <div ref={searchWrapRef} className="roadmap-detail-explorer__search">
          <SearchIcon />
          <input
            type="search"
            className="roadmap-detail-explorer__search-input"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.currentTarget.value);
              setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            placeholder={i18n('Roadmap detail search placeholder')}
            aria-label={i18n('Roadmap detail search aria')}
            autoComplete="off"
          />
          {searchOpen && searchQuery.trim() ? (
            <div className="roadmap-detail-explorer__search-panel" role="listbox">
              {searchHits.length === 0 ? (
                <div className="roadmap-detail-explorer__search-empty">
                  {i18n('Roadmap detail search no results')}
                </div>
              ) : (
                searchHits.map((hit, index) => (
                  <button
                    key={hit.type === 'node' ? `n-${hit.nodeId}` : `p-${hit.nodeId}-${hit.problemPid || index}`}
                    type="button"
                    className="roadmap-detail-explorer__search-hit"
                    onClick={() => navigateHit(hit)}
                  >
                    <span className="roadmap-detail-explorer__search-hit-kind">
                      {hit.type === 'node'
                        ? i18n('Roadmap detail search kind node')
                        : i18n('Roadmap detail search kind problem')}
                    </span>
                    <span className="roadmap-detail-explorer__search-hit-label">{hit.label}</span>
                    <span className="roadmap-detail-explorer__search-hit-sub">{hit.sublabel}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {filtersActive ? (
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
            aria-labelledby="roadmap-detail-filter-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="roadmap-detail-filter-title" className="roadmap-detail-explorer__dialog-title">
              {i18n('Roadmap detail filter dialog title')}
            </h2>
            <p className="roadmap-detail-explorer__dialog-hint">
              {i18n('Roadmap detail filter dialog hint')}
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
