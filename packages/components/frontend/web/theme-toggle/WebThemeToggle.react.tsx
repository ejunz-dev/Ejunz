import React from 'react';

export interface WebThemeToggleProps {
  mode?: 'light' | 'dark';
  onChange?: (mode: 'light' | 'dark') => void;
  className?: string;
}

/** Docs footer theme toggle (sun / moon) with sliding thumb. */
export function WebThemeToggle({
  mode = 'dark',
  onChange,
  className = '',
}: WebThemeToggleProps) {
  return (
    <div
      className={['ej-web-theme', `ej-web-theme--${mode}`, className].filter(Boolean).join(' ')}
      role="group"
      aria-label="Theme"
    >
      <span className="ej-web-theme__thumb" aria-hidden />
      <button
        type="button"
        className={['ej-web-theme__btn', mode === 'light' ? 'is-active' : ''].filter(Boolean).join(' ')}
        aria-pressed={mode === 'light'}
        onClick={() => onChange?.('light')}
        title="Light"
      >
        ☀
      </button>
      <button
        type="button"
        className={['ej-web-theme__btn', mode === 'dark' ? 'is-active' : ''].filter(Boolean).join(' ')}
        aria-pressed={mode === 'dark'}
        onClick={() => onChange?.('dark')}
        title="Dark"
      >
        ☾
      </button>
    </div>
  );
}

export default WebThemeToggle;
