import React, { useEffect, useRef } from 'react';
import { i18n } from 'vj/utils';

/** Floating status dot that stays fixed; label slides in/out by animating container width. */
export function StatusIndicator({ dirty }: { dirty: boolean }) {
  const elRef = useRef<HTMLDivElement>(null);
  const fullWRef = useRef(0);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    // Measure full width once
    const savedW = el.style.width;
    el.style.width = 'auto';
    fullWRef.current = Math.max(el.offsetWidth, 60);
    el.style.width = dirty ? `${fullWRef.current}px` : '28px';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = elRef.current;
    if (!el || !fullWRef.current) return;

    const fullW = fullWRef.current;
    if (dirty) {
      el.style.transition = 'none';
      el.style.width = '28px';
      void el.offsetWidth;
      el.style.transition = 'width 0.28s ease-out';
      el.style.width = `${fullW}px`;
    } else {
      const curW = el.offsetWidth;
      el.style.transition = 'none';
      el.style.width = `${curW}px`;
      void el.offsetWidth;
      el.style.transition = 'width 0.25s ease-in';
      el.style.width = '28px';
    }
  }, [dirty]);

  return (
    <div className="base-detail-status-indicator-wrap">
      <div
        ref={elRef}
        className={`base-detail-status-indicator${dirty ? ' is-dirty' : ' is-clean'}`}
        title={dirty
          ? i18n('Expand state has unsaved changes, press Ctrl+S to save')
          : i18n('Expand state is saved')}
      >
        <span className="base-detail-status-indicator__dot" />
        <span className="base-detail-status-indicator__label">{i18n('Unsaved')}</span>
      </div>
    </div>
  );
}
