'use client';

import React, { useEffect, useId, useRef, useState } from 'react';

export type WebRootToggleOption = {
  title: string;
  description?: string;
  url?: string;
  key?: string;
};

export interface WebRootToggleProps {
  options: WebRootToggleOption[];
  value?: string;
  onChange?: (key: string) => void;
  className?: string;
  /** Controlled open state (for demo simulation). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled: open the menu on hover (default true). */
  openOnHover?: boolean;
}

/** Docs sidebar product switcher (Ejunz / IoT / AI / KB). */
export function WebRootToggle({
  options,
  value,
  onChange,
  className = '',
  open: openProp,
  onOpenChange,
  openOnHover = true,
}: WebRootToggleProps) {
  const controlled = openProp !== undefined;
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlled ? openProp : innerOpen;
  const leaveTimer = useRef<number | null>(null);
  const menuId = useId();
  const selected = options.find((o) => (o.key || o.title) === value) || options[0];

  const setOpen = (next: boolean) => {
    if (!controlled) setInnerOpen(next);
    onOpenChange?.(next);
  };

  useEffect(() => () => {
    if (leaveTimer.current != null) window.clearTimeout(leaveTimer.current);
  }, []);

  const clearLeave = () => {
    if (leaveTimer.current != null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };

  const show = () => {
    if (controlled) return;
    clearLeave();
    setOpen(true);
  };

  const hide = () => {
    if (controlled) return;
    clearLeave();
    leaveTimer.current = window.setTimeout(() => setOpen(false), 120);
  };

  return (
    <div
      className={['ej-web-root-toggle', open ? 'is-open' : '', className].filter(Boolean).join(' ')}
      onMouseEnter={!controlled && openOnHover ? show : undefined}
      onMouseLeave={!controlled && openOnHover ? hide : undefined}
    >
      <button
        type="button"
        className="ej-web-root-toggle__trigger"
        aria-expanded={open}
        aria-controls={menuId}
        tabIndex={controlled ? -1 : 0}
        onClick={() => {
          if (controlled) return;
          setOpen(!open);
        }}
      >
        <span className="ej-web-root-toggle__text">
          <span className="ej-web-root-toggle__title">{selected?.title}</span>
          {selected?.description ? (
            <span className="ej-web-root-toggle__desc">{selected.description}</span>
          ) : null}
        </span>
        <span className="ej-web-root-toggle__chev" aria-hidden>▾</span>
      </button>
      <div
        id={menuId}
        className="ej-web-root-toggle__menu"
        role="listbox"
        aria-hidden={!open}
      >
        {options.map((item) => {
          const key = item.key || item.title;
          const active = key === (selected?.key || selected?.title);
          return (
            <button
              key={key}
              type="button"
              role="option"
              aria-selected={active}
              tabIndex={-1}
              className={['ej-web-root-toggle__item', active ? 'is-active' : ''].filter(Boolean).join(' ')}
              onClick={() => {
                if (controlled) return;
                onChange?.(key);
                setOpen(false);
              }}
            >
              <span className="ej-web-root-toggle__title">{item.title}</span>
              {item.description ? (
                <span className="ej-web-root-toggle__desc">{item.description}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default WebRootToggle;
