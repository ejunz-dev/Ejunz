import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './autocomplete.css';

export interface AutoCompleteItem {
  /** Stable unique key for the item. */
  key: string;
  /** Primary label shown in the list and as a chip. */
  label: string;
  /** Optional secondary text shown after the label. */
  hint?: string;
}

export interface AutoCompleteProps {
  /** Currently selected item keys. */
  selected: string[];
  /** Called when an item is picked from the list. */
  onSelect: (key: string) => void;
  /** Called when a selected chip is removed. */
  onRemove: (key: string) => void;
  /** Async search; return items matching the query. */
  query: (q: string) => Promise<AutoCompleteItem[]>;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Lightweight multi-select autocomplete.
 *
 * Queries `query` as the user types (debounced), shows a dropdown of matches,
 * and renders selected items as removable chips. Keyboard navigation
 * (arrows/enter/escape) is supported. This is a self-contained replacement for
 * the ui-default AutoComplete so ui-next plugins do not depend on ui-default.
 */
export function AutoComplete({
  selected, onSelect, onRemove, query, placeholder = 'Search...', disabled = false,
}: AutoCompleteProps) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<AutoCompleteItem[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [listPos, setListPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const boxRef = useRef<HTMLDivElement>(null);

  const updateListPos = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setListPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
  }, []);

  const openList = useCallback(() => {
    updateListPos();
    setOpen(true);
  }, [updateListPos]);

  const runQuery = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    try {
      const items = await query(q.trim());
      setResults(Array.isArray(items) ? items : []);
      setHighlight(0);
    } catch {
      setResults([]);
    }
  }, [query]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { void runQuery(text); }, 250);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [text, runQuery]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const pick = useCallback((key: string) => {
    onSelect(key);
    setText('');
    setResults([]);
    setOpen(false);
  }, [onSelect]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[highlight]) pick(results[highlight].key);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="uix-autocomplete" ref={boxRef}>
      <div className="uix-autocomplete__chips">
        {selected.map((key) => (
          <span key={key} className="uix-autocomplete__chip">
            {key}
            <button type="button" onClick={() => onRemove(key)} aria-label={`Remove ${key}`}>×</button>
          </span>
        ))}
        <input
          type="text"
          className="uix-autocomplete__input"
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => { setText(e.target.value); openList(); }}
          onFocus={openList}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && results.length > 0 && listPos ? createPortal(
        <ul
          className="uix-autocomplete__list"
          style={{ position: 'fixed', top: listPos.top, left: listPos.left, width: listPos.width }}
        >
          {results.map((item, idx) => {
            const isSelected = selected.includes(item.key);
            return (
              <li
                key={item.key}
                className={`uix-autocomplete__item${idx === highlight ? ' is-highlight' : ''}${isSelected ? ' is-selected' : ''}`}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => { if (!isSelected) pick(item.key); }}
              >
                <span className="uix-autocomplete__label">{item.label}</span>
                {item.hint ? <span className="uix-autocomplete__hint">{item.hint}</span> : null}
                {isSelected ? <span className="uix-autocomplete__check">✓</span> : null}
              </li>
            );
          })}
        </ul>,
        document.body,
      ) : null}
    </div>
  );
}
