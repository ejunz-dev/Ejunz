import React from 'react';

export interface WebFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Optional label rendered above the input. Omit for a bare input. */
  label?: React.ReactNode;
  className?: string;
}

/** Ejunz Web text field — label + input pair, or a bare input. */
export function WebField({ label, className = '', ...inputProps }: WebFieldProps) {
  const input = <input className="ej-web-field__input" {...inputProps} />;
  if (label == null) return input;
  return (
    <label className={['ej-web-field', className].filter(Boolean).join(' ')}>
      <span className="ej-web-field__label">{label}</span>
      {input}
    </label>
  );
}

export default WebField;
