import React from 'react';

export interface StatCardProps {
  label: string;
  value: string | number;
  accent?: string;
  className?: string;
}

export function StatCard({ label, value, accent, className = '' }: StatCardProps) {
  return (
    <div className={['ej-stat', className].filter(Boolean).join(' ')}>
      <div className="ej-stat__label">{label}</div>
      <div className="ej-stat__value" style={accent ? { color: accent } : undefined}>{value}</div>
    </div>
  );
}

export default StatCard;
