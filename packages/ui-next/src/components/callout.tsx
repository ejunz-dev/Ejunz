import type { ReactNode } from 'react';

export type CalloutType = 'info' | 'warn' | 'error';

export interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children?: ReactNode;
}

/** Alert box with an optional title and message. */
export function Callout({ type = 'info', title, children }: CalloutProps) {
  return (
    <div className={`uix-callout uix-callout--${type}`} role="alert">
      {title ? <strong>{title}</strong> : null}
      {children ? <p className="uix-muted">{children}</p> : null}
    </div>
  );
}
