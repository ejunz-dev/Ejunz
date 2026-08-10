import React from 'react';

export interface WebTagProps {
  /** Render as a link when given. */
  href?: string;
  className?: string;
  children?: React.ReactNode;
}

/** Ejunz Web tag chip. */
export function WebTag({ href, className = '', children }: WebTagProps) {
  const classes = ['ej-web-tag', className].filter(Boolean).join(' ');
  if (href) return <a className={classes} href={href}>{children}</a>;
  return <span className={classes}>{children}</span>;
}

export default WebTag;
