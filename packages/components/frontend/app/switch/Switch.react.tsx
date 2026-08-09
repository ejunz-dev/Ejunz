import React from 'react';

export interface SwitchProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

export function Switch({
  checked = false,
  onChange,
  disabled = false,
  className = '',
  'aria-label': ariaLabel = 'toggle',
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      className={['ej-switch', checked ? 'is-on' : '', className].filter(Boolean).join(' ')}
      onClick={() => onChange?.(!checked)}
    >
      <span className="ej-switch__thumb" />
    </button>
  );
}

export default Switch;
