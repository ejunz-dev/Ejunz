import type { ReactNode } from 'react';
import { Link } from './link';

export type ButtonVariant = 'default' | 'primary' | 'ghost';

export interface ButtonProps {
  /** Route name to resolve via the route map (renders a Link). */
  to?: string;
  /** Params for route resolution when `to` is given. */
  params?: Record<string, string>;
  /** Pre-built href (renders an anchor). */
  href?: string;
  /** Visual variant. */
  variant?: ButtonVariant;
  className?: string;
  children?: ReactNode;
  onClick?: () => void;
}

/** Button-styled control. Renders a Link, an anchor, or a <button>. */
export function Button({
  to, params, href, variant = 'default', className = '', children, onClick,
}: ButtonProps) {
  const cls = ['uix-button', variant !== 'default' ? `uix-button--${variant}` : '', className]
    .filter(Boolean)
    .join(' ');
  if (to) {
    return <Link to={to} params={params} className={cls}>{children}</Link>;
  }
  if (href) {
    return <a className={cls} href={href} onClick={onClick}>{children}</a>;
  }
  return <button className={cls} onClick={onClick}>{children}</button>;
}
