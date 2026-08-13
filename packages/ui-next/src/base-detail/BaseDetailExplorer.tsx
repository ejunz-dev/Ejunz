import React, { useEffect, useState } from 'react';

export interface BaseDetailExplorerProps {
  filter: string;
  onFilterChange(filter: string): void;
  labels: {
    filter: string;
    search: string;
    clear: string;
    explore: string;
  };
}

export function BaseDetailExplorer({ filter, onFilterChange, labels }: BaseDetailExplorerProps) {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focused) document.querySelector<HTMLInputElement>('.ej-bd__search')?.focus();
  }, [focused]);
  return (
    <div className="roadmap-detail-explorer ej-bd__toolbar" aria-label={labels.explore}>
      <button
        type="button"
        className={`roadmap-detail-explorer__filter ej-bd__filter-button${filter ? ' is-active' : ''}`}
        onClick={() => setFocused(true)}
      >
        <span aria-hidden>☷</span>{labels.filter}
      </button>
      <label className="roadmap-detail-explorer__search ej-bd__search-wrap">
        <span className="ej-bd__search-icon" aria-hidden>⌕</span>
        <input
          autoFocus={focused}
          type="search"
          className="roadmap-detail-explorer__search-input ej-bd__search"
          placeholder={labels.search}
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
        />
        {filter ? (
          <button type="button" className="ej-bd__clear" onClick={() => onFilterChange('')} aria-label={labels.clear}>×</button>
        ) : null}
      </label>
    </div>
  );
}
