import { useEffect, useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  nodeCount: number;
  cardCount: number;
}

export function BaseDetailExplorer({ value, onChange, nodeCount, cardCount }: Props) {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) return undefined;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setFocused(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [focused]);
  return (
    <div className="bd-explorer">
      <label className="bd-explorer__search">
        <span aria-hidden>⌕</span>
        <input type="search" value={value} onChange={(event) => onChange(event.target.value)} onFocus={() => setFocused(true)} placeholder="Search nodes and cards" aria-label="Search nodes and cards" />
        {value ? <button type="button" onClick={() => onChange('')} aria-label="Clear search">×</button> : null}
      </label>
      <span className="bd-explorer__summary">{focused || value ? `${nodeCount} nodes · ${cardCount} cards` : 'Browse the base structure'}</span>
    </div>
  );
}
