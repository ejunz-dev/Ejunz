import React from 'react';

export type TagTone = 'accent' | 'neutral' | 'danger';

export interface TagProps {
  tone?: TagTone;
  children?: React.ReactNode;
  className?: string;
}

export function Tag({ tone = 'accent', children, className = '' }: TagProps) {
  const toneClass = tone === 'accent' ? '' : `ej-tag--${tone}`;
  return (
    <span className={['ej-tag', toneClass, className].filter(Boolean).join(' ')}>
      {children}
    </span>
  );
}

export default Tag;
