import type { ReactNode } from 'react';
import { Link } from './link';

export interface CardProps {
  title: string;
  description?: string;
  /** Render the title as a route link when given. */
  to?: string;
  /** Params for route resolution when `to` is given. */
  params?: Record<string, string>;
  /** Render the title as an anchor to this href when given. */
  href?: string;
  children?: ReactNode;
}

/** Section card with title, optional description and body. */
export function Card({ title, description, to, params, href, children }: CardProps) {
  const titleNode = to
    ? <Link to={to} params={params}>{title}</Link>
    : href
      ? <a href={href}>{title}</a>
      : title;
  return (
    <section className="uix-card">
      <div className="uix-card__header">
        <h2 className="uix-card__title">{titleNode}</h2>
        {description ? <p className="uix-card__desc">{description}</p> : null}
      </div>
      {children != null ? <div className="uix-card__body">{children}</div> : null}
    </section>
  );
}
