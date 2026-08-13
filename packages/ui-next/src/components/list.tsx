import type { ReactNode } from 'react';
import { Link } from './link';

export interface ListProps {
  children?: ReactNode;
}

/** Unordered list of rows. */
export function List({ children }: ListProps) {
  return <ul className="uix-list">{children}</ul>;
}

export interface ListItemProps {
  /** Route name to resolve via the route map. */
  to?: string;
  /** Params for route resolution when `to` is given. */
  params?: Record<string, string>;
  /** Pre-built href. Use this or `to`, not both. */
  href?: string;
  /** Primary title text (rendered as a link when `to`/`href` is given). */
  title: string;
  /** Right-aligned auxiliary content (time, counts, author…). */
  meta?: ReactNode;
}

/** Title row with optional right-aligned meta. */
export function ListItem({ to, params, href, title, meta }: ListItemProps) {
  const content = to
    ? <Link to={to} params={params} className="uix-list__title">{title}</Link>
    : href
      ? <a className="uix-list__title" href={href}>{title}</a>
      : <span className="uix-list__title">{title}</span>;
  return (
    <li className="uix-list__item">
      {content}
      {meta != null ? <span className="uix-muted">{meta}</span> : null}
    </li>
  );
}
