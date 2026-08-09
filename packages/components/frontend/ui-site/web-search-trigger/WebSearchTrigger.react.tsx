import React from 'react';

export interface WebSearchTriggerProps {
  label?: string;
  shortcut?: string;
  onClick?: () => void;
  className?: string;
}

/** Docs sidebar search trigger. */
export function WebSearchTrigger({
  label = 'Search',
  shortcut = '⌘ K',
  onClick,
  className = '',
}: WebSearchTriggerProps) {
  return (
    <button
      type="button"
      className={['ej-web-search', className].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      <span className="ej-web-search__icon" aria-hidden>⌕</span>
      <span className="ej-web-search__label">{label}</span>
      <kbd className="ej-web-search__kbd">{shortcut}</kbd>
    </button>
  );
}

export default WebSearchTrigger;
