import { useEffect, useState } from 'react';
import { i18n } from '../../i18n';

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
      <button type="button" className="bd-explorer__filter" aria-label={i18n('Roadmap detail filter aria')}>☷ <span>{i18n('Roadmap detail filter open')}</span></button>
      <label className="bd-explorer__search">
        <span aria-hidden>⌕</span>
        <input type="search" value={value} onChange={(event) => onChange(event.target.value)} onFocus={() => setFocused(true)} placeholder={i18n('Base detail tree search placeholder')} aria-label={i18n('Base detail tree search aria')} />
        {value ? <button type="button" onClick={() => onChange('')} aria-label={i18n('Roadmap detail filter clear')}>×</button> : null}
      </label>
      <span className="bd-explorer__summary">{focused || value ? `${nodeCount} ${i18n('nodes')} · ${cardCount} ${i18n('cards')}` : i18n('Base detail content filter dialog hint')}</span>
    </div>
  );
}
