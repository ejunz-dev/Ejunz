import React, { useEffect, useState } from 'react';

export interface BottomNavItem {
  key: string;
  icon: string;
  label: string;
}

export interface BottomNavProps {
  current: string;
  items: BottomNavItem[];
  onChange?: (key: string) => void;
  className?: string;
}

export function BottomNav({ current, items, onChange, className = '' }: BottomNavProps) {
  const [compact, setCompact] = useState(
    typeof window !== 'undefined' ? window.innerWidth > 0 && window.innerWidth < 640 : false,
  );

  useEffect(() => {
    const onResize = () => setCompact(window.innerWidth > 0 && window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <nav className={['ej-bottom-nav', compact ? 'ej-bottom-nav--compact' : '', className].filter(Boolean).join(' ')}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={['ej-bottom-nav__item', item.key === current ? 'is-active' : ''].filter(Boolean).join(' ')}
          onClick={() => onChange?.(item.key)}
        >
          <span className="ej-bottom-nav__icon">{item.icon}</span>
          {!compact && <span className="ej-bottom-nav__label">{item.label}</span>}
        </button>
      ))}
    </nav>
  );
}

export default BottomNav;
