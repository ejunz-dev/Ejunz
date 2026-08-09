import React from 'react';

export type WebButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost';

export interface WebButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: WebButtonVariant;
  children?: React.ReactNode;
}

/** Ejunz Web button */
export function WebButton({
  variant = 'primary',
  className = '',
  children,
  type = 'button',
  ...rest
}: WebButtonProps) {
  const classes = ['ej-web-button', `ej-web-button--${variant}`, className].filter(Boolean).join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}

export default WebButton;
