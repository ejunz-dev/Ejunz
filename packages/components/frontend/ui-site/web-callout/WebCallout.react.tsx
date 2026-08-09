import React from 'react';

export type WebCalloutType = 'info' | 'warn' | 'error';

export interface WebCalloutProps {
  type?: WebCalloutType;
  title?: string;
  children?: React.ReactNode;
  className?: string;
}

const icons: Record<WebCalloutType, string> = {
  info: 'ℹ',
  warn: '⚠',
  error: '✕',
};

/** Ejunz Web Callout — info / warn / error. */
export function WebCallout({
  type = 'info', title, children, className = '',
}: WebCalloutProps) {
  return (
    <div className={['ej-web-callout', `ej-web-callout--${type}`, className].filter(Boolean).join(' ')}>
      <span className="ej-web-callout__icon" aria-hidden>{icons[type]}</span>
      <div className="ej-web-callout__body">
        {title ? <p className="ej-web-callout__title">{title}</p> : null}
        <div className="ej-web-callout__content">{children}</div>
      </div>
    </div>
  );
}

export default WebCallout;
