import React from 'react';

export type BadgeTone = 'accent' | 'neutral' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  children?: React.ReactNode;
  className?: string;
}

export function Badge({ tone = 'accent', className = '', children }: BadgeProps) {
  const toneClass = tone === 'accent' ? '' : `ej-badge--${tone}`;
  const classes = ['ej-badge', 'ej-tag', toneClass, className].filter(Boolean).join(' ');
  return <span className={classes}>{children}</span>;
}

export default Badge;
