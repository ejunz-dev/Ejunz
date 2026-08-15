import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { i18n } from '../../i18n';
import { requestJson } from './base-detail-api';

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

export type EmbeddingStatusView = {
  status: 'never' | 'queued' | 'indexing' | 'ready' | 'error';
  indexedCount?: number;
  lastError?: string | null;
  mode?: string | null;
} | null;

interface Props {
  domainId: string;
  docId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectResult?: (result: SemanticSearchItem) => void;
  embeddingStatus?: EmbeddingStatusView;
}

function embeddingStatusLabel(status: EmbeddingStatusView | undefined): string | null {
  if (!status?.status) return null;
  if (status.status === 'never') return i18n('Not indexed');
  if (status.status === 'queued') return i18n('Index queued');
  if (status.status === 'indexing') return i18n('Indexing…');
  if (status.status === 'error') return i18n('Index failed');
  const count = status.indexedCount;
  return typeof count === 'number' && count > 0
    ? i18n('Indexed ({0})', count)
    : i18n('Indexed');
}

export function BaseDetailSemanticSearch({
  domainId,
  docId,
  open,
  onOpenChange,
  onSelectResult,
  embeddingStatus,
}: Props) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SemanticSearchItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const embeddingLabel = embeddingStatusLabel(embeddingStatus);

  useEffect(() => {
    if (open && inputRef.current) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 100);
      return () => window.clearTimeout(timer);
    }
    if (!open) {
      setQuery('');
      setResults([]);
      setHasSearched(false);
    }
    return undefined;
  }, [open]);

  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setHasSearched(true);
    try {
      const res = await requestJson<{ results?: SemanticSearchItem[] }>('/base/semantic-search', {
        domainId,
        body: { docId: Number(docId), query: q, limit: 20 },
      });
      setResults(res?.results || []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, [query, domainId, docId]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void doSearch();
    }
  }, [doSearch]);

  const handleResultClick = useCallback((item: SemanticSearchItem) => {
    onSelectResult?.(item);
    onOpenChange(false);
  }, [onSelectResult, onOpenChange]);

  const scorePercent = useCallback((score: number) => Math.round(score * 100), []);

  const resultSubtitle = useCallback((item: SemanticSearchItem): string => (
    item.kind === 'card' ? item.cardTitle || i18n('Card') : i18n('Node')
  ), []);

  if (!open) return null;

  return (
    <>
      <div
        className="bd-semantic-search-backdrop"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      <div className="bd-semantic-search-shell">
        {embeddingLabel ? (
          <div
            className={`bd-semantic-search-index-status is-${embeddingStatus?.status || 'never'}`}
            title={embeddingStatus?.lastError || embeddingLabel}
          >
            <span className="bd-semantic-search-index-status__dot" aria-hidden />
            {embeddingLabel}
          </div>
        ) : null}
        <div
          className="bd-semantic-search-modal"
          role="dialog"
          aria-modal="true"
          aria-label={i18n('Semantic Search')}
        >
          <div className="bd-semantic-search-modal__header">
            <div className="bd-semantic-search-modal__title">
              <SearchIcon />
              {i18n('Semantic Search')}
            </div>
            <button
              type="button"
              className="bd-semantic-search-modal__close"
              onClick={() => onOpenChange(false)}
              aria-label={i18n('Close')}
            >
              <CloseIcon />
            </button>
          </div>

          <div className="bd-semantic-search-modal__body">
            <div className="bd-semantic-search-input-wrap">
              <input
                ref={inputRef}
                type="text"
                className="bd-semantic-search-input"
                placeholder={String(i18n('Search knowledge base by meaning...'))}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={handleKeyDown}
              />
              <button
                type="button"
                className="bd-semantic-search-submit"
                disabled={loading || !query.trim()}
                onClick={() => void doSearch()}
              >
                {loading ? String(i18n('Searching...')) : String(i18n('Search'))}
              </button>
            </div>

            {loading ? (
              <div className="bd-semantic-search-status">
                {i18n('Searching...')}
              </div>
            ) : null}

            {!loading && hasSearched && results.length === 0 ? (
              <div className="bd-semantic-search-status bd-semantic-search-status--empty">
                {i18n('No results found')}
              </div>
            ) : null}

            {results.length > 0 ? (
              <ul className="bd-semantic-search-results">
                {results.map((item, index) => (
                  <li key={`${item.kind}-${item.cardDocId || item.nodeId}-${index}`}>
                    <button
                      type="button"
                      className="bd-semantic-search-result-item"
                      onClick={() => handleResultClick(item)}
                    >
                      <span className="bd-semantic-search-result-item__icon">
                        {item.kind === 'card' ? <CardIcon /> : <NodeIcon />}
                      </span>
                      <span className="bd-semantic-search-result-item__body">
                        <span className="bd-semantic-search-result-item__text">
                          {item.text.length > 120 ? `${item.text.slice(0, 120)}…` : item.text}
                        </span>
                        <span className="bd-semantic-search-result-item__meta-row">
                          <span className="bd-semantic-search-result-item__kind">
                            {resultSubtitle(item)}
                          </span>
                          <span className="bd-semantic-search-result-item__score">
                            {i18n('Match: {0}%', String(scorePercent(item.score)))}
                          </span>
                        </span>
                      </span>
                      <span className="bd-semantic-search-result-item__arrow" aria-hidden>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

export default BaseDetailSemanticSearch;
