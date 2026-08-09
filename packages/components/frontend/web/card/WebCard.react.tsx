import React from 'react';

export interface WebCardProps {
  title: string;
  description?: string;
  href?: string;
  className?: string;
  children?: React.ReactNode;
}

/** Ejunz Web Card */
export function WebCard({
  title, description, href, className = '', children,
}: WebCardProps) {
  const classes = ['ej-web-card', href ? 'ej-web-card--link' : '', className].filter(Boolean).join(' ');
  const body = (
    <>
      <h3 className="ej-web-card__title">{title}</h3>
      {description ? <p className="ej-web-card__desc">{description}</p> : null}
      {children ? <div className="ej-web-card__extra">{children}</div> : null}
    </>
  );
  if (href) {
    return (
      <a className={classes} href={href} data-card="true">
        {body}
      </a>
    );
  }
  return (
    <div className={classes} data-card="true">
      {body}
    </div>
  );
}

export default WebCard;
