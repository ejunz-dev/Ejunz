import React from 'react';

export interface EmptyStateProps {
  text?: string;
  className?: string;
}

export function EmptyState({ text = '暂无数据', className = '' }: EmptyStateProps) {
  return (
    <div className={['ej-empty', className].filter(Boolean).join(' ')}>
      <span className="ej-empty__icon">—</span>
      <span>{text}</span>
    </div>
  );
}

export default EmptyState;
