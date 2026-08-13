import type { ReactNode } from 'react';
import { Link } from './link';

export interface TagProps {
  /** Route name to resolve via the route map (renders a Link). */
  to?: string;
  /** Params for route resolution when `to` is given. */
  params?: Record<string, string>;
  /** Pre-built href (renders an anchor). */
  href?: string;
  className?: string;
  children?: ReactNode;
}

/** Small chip. Renders a Link, an anchor, or a plain span. */
export function Tag({ to, params, href, className = '', children }: TagProps) {
  const cls = ['uix-tag', className].filter(Boolean).join(' ');
  if (to) {
    return <Link to={to} params={params} className={cls}>{children}</Link>;
  }
  if (href) {
    return <a className={cls} href={href}>{children}</a>;
  }
  return <span className={cls}>{children}</span>;
}
