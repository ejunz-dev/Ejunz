import React from 'react';

export interface WebListProps {
  className?: string;
  children?: React.ReactNode;
}

export interface WebListItemProps {
  title: React.ReactNode;
  /** Title link target. */
  href?: string;
  /** Right-aligned auxiliary content (time, counts, author…). */
  meta?: React.ReactNode;
}

/** Ejunz Web list — title rows with optional right-aligned meta. */
export function WebList({ className = '', children }: WebListProps) {
  return <ul className={['ej-web-list', className].filter(Boolean).join(' ')}>{children}</ul>;
}

export function WebListItem({ title, href, meta }: WebListItemProps) {
  return (
    <li className="ej-web-list__item">
      {href
        ? <a className="ej-web-list__title" href={href}>{title}</a>
        : <span className="ej-web-list__title">{title}</span>}
      {meta != null ? <span className="ej-web-list__meta">{meta}</span> : null}
    </li>
  );
}

export default WebList;
