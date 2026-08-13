import type { ChangeEvent, InputHTMLAttributes } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  name?: string;
  /** Controlled value; omit for an uncontrolled input read via the form. */
  value?: string;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}

/** Labeled text input. */
export function Field({ label, name, value, onChange, ...rest }: FieldProps) {
  return (
    <label className="uix-field">
      <span className="uix-field__label">{label}</span>
      <input className="uix-field__input" name={name} value={value} onChange={onChange} {...rest} />
    </label>
  );
}
