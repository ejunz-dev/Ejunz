import React from 'react';

export interface ListRowProps {
  title: string;
  description?: string;
  meta?: string;
  avatarText?: string;
  onClick?: () => void;
  className?: string;
}

export function ListRow({
  title,
  description,
  meta,
  avatarText,
  onClick,
  className = '',
}: ListRowProps) {
  return (
    <button
      type="button"
      className={['ej-list-row', className].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      <span className="ej-list-row__avatar">{avatarText || title.charAt(0).toUpperCase()}</span>
      <span className="ej-list-row__main">
        <span className="ej-list-row__title">{title}</span>
        {description ? <span className="ej-list-row__desc">{description}</span> : null}
        {meta ? <span className="ej-list-row__meta">{meta}</span> : null}
      </span>
      <span className="ej-list-row__chevron">›</span>
    </button>
  );
}

export default ListRow;
