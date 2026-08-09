import React from 'react';

export interface AppShellProps {
  eyebrow?: string;
  title?: React.ReactNode;
  metaLeft?: React.ReactNode;
  metaRight?: React.ReactNode;
  minimal?: boolean;
  bottomNav?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export function AppShell({
  eyebrow = 'EJUNZ UI',
  title = '组件库',
  metaLeft,
  metaRight,
  minimal = false,
  bottomNav = false,
  children,
  className = '',
}: AppShellProps) {
  const shellClass = [
    'ej-shell',
    bottomNav ? 'ej-shell--bottom-nav' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      {!minimal && (
        <>
          <div className="ej-shell__topbar">
            <div>
              <span className="ej-shell__eyebrow">{eyebrow}</span>
              <span className="ej-shell__title">{title}</span>
            </div>
            <span className="ej-shell__dot" aria-hidden />
          </div>
          {(metaLeft || metaRight) && (
            <div className="ej-shell__meta">
              <span>{metaLeft}</span>
              <span>{metaRight}</span>
            </div>
          )}
        </>
      )}
      {children}
    </div>
  );
}

export default AppShell;
