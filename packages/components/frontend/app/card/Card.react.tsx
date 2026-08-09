import React from 'react';

export interface CardProps {
  title?: string;
  children?: React.ReactNode;
  className?: string;
}

export function Card({ title, children, className = '' }: CardProps) {
  return (
    <article className={['ej-card', className].filter(Boolean).join(' ')}>
      {title ? <h3 className="ej-card__title">{title}</h3> : null}
      <div className="ej-card__body">{children}</div>
    </article>
  );
}

export default Card;
