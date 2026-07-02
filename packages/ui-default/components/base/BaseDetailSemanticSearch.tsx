import React, { useCallback, useEffect, useRef, useState } from 'react';
import { domainApiPath, i18n, request } from 'vj/utils';

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M16 16l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function NodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 8h4M8 6v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function CardIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 6.5h6M5 9h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export type SemanticSearchItem = {
  nodeId: string;
  kind: 'node' | 'card';
  cardDocId?: string;
  cardTitle?: string;
  text: string;
  score: number;
};

export type BaseDetailSemanticSearchProps = {
  domainId: string;
  docId: string;
  branch: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectResult?: (result: SemanticSearchItem) => void;
};

export function BaseDetailSemanticSearch({
  domainId,
  docId,
  branch,
  open,
  onOpenChange,
  onSelectResult,
}: BaseDetailSemanticSearchProps) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SemanticSearchItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
    if (!open) {
      setQuery('');
      setResults([]);
      setHasSearched(false);
    }
  }, [open]);

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setHasSearched(true);
    try {
      const res: any = await request.post(
        domainApiPath('/base/semantic-search', domainId),
        { docId: Number(docId), branch, query: q, limit: 20 },
      );
      setResults((res?.results || []) as SemanticSearchItem[]);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, domainId, docId, branch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSearch();
    }
  }, [doSearch]);

  const handleResultClick = useCallback((item: SemanticSearchItem) => {
    onSelectResult?.(item);
    onOpenChange(false);
  }, [onSelectResult, onOpenChange]);

  const scorePercent = useCallback((score: number) => Math.round(score * 100), []);

  const resultSubtitle = useCallback((item: SemanticSearchItem): string => {
    if (item.kind === 'card') {
      return item.cardTitle || i18n('Card');
    }
    return i18n('Node');
  }, []);

  return (
    <>
      {open ? (
        <>
          <div
            className="roadmap-semantic-search-backdrop"
            onClick={() => onOpenChange(false)}
            aria-hidden
          />
          <div
            className="roadmap-semantic-search-modal"
            role="dialog"
            aria-modal="true"
            aria-label={i18n('Semantic Search')}
          >
            <div className="roadmap-semantic-search-modal__header">
              <div className="roadmap-semantic-search-modal__title">
                <SearchIcon />
                {i18n('Semantic Search')}
              </div>
              <button
                type="button"
                className="roadmap-semantic-search-modal__close"
                onClick={() => onOpenChange(false)}
                aria-label={i18n('Close')}
              >
                <CloseIcon />
              </button>
            </div>

            <div className="roadmap-semantic-search-modal__body">
              <div className="roadmap-semantic-search-input-wrap">
                <input
                  ref={inputRef}
                  type="text"
                  className="roadmap-semantic-search-input"
                  placeholder={String(i18n('Search knowledge base by meaning...'))}
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={handleKeyDown}
                />
                <button
                  type="button"
                  className="roadmap-semantic-search-submit"
                  disabled={loading || !query.trim()}
                  onClick={doSearch}
                >
                  {loading ? String(i18n('Searching...')) : String(i18n('Search'))}
                </button>
              </div>

              {loading ? (
                <div className="roadmap-semantic-search-status">
                  {i18n('Searching...')}
                </div>
              ) : null}

              {!loading && hasSearched && results.length === 0 ? (
                <div className="roadmap-semantic-search-status roadmap-semantic-search-status--empty">
                  {i18n('No results found')}
                </div>
              ) : null}

              {results.length > 0 ? (
                <ul className="roadmap-semantic-search-results">
                  {results.map((r, i) => (
                    <li key={`${r.kind}-${r.cardDocId || r.nodeId}-${i}`}>
                      <button
                        type="button"
                        className="roadmap-semantic-search-result-item"
                        onClick={() => handleResultClick(r)}
                      >
                        <div className="roadmap-semantic-search-result-item__icon">
                          {r.kind === 'card' ? <CardIcon /> : <NodeIcon />}
                        </div>
                        <div className="roadmap-semantic-search-result-item__body">
                          <div className="roadmap-semantic-search-result-item__text">
                            {r.text.length > 120 ? r.text.slice(0, 120) + '…' : r.text}
                          </div>
                          <div className="roadmap-semantic-search-result-item__meta-row">
                            <span className="roadmap-semantic-search-result-item__kind">
                              {resultSubtitle(r)}
                            </span>
                            <span className="roadmap-semantic-search-result-item__score">
                              {i18n('Match: {0}%', String(scorePercent(r.score)))}
                            </span>
                          </div>
                        </div>
                        <div className="roadmap-semantic-search-result-item__arrow" aria-hidden>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

export default BaseDetailSemanticSearch;
