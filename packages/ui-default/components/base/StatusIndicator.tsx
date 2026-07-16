import React, { useEffect, useRef } from 'react';
import { i18n } from 'vj/utils';

/** Floating status dot that stays fixed; label slides out to the right. */
export function StatusIndicator({ dirty }: { dirty: boolean }) {
  const elRef = useRef<HTMLDivElement>(null);
  const fullWRef = useRef(0);

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    if (fullWRef.current === 0) {
      el.style.width = 'auto';
      fullWRef.current = Math.max(el.offsetWidth, 60);
    }

    // Set width directly — CSS transition handles the animation
    // framer-motion animate can interfere with absolute positioning
    el.style.transition = 'width 0.3s ease-out';
    el.style.width = dirty ? `${fullWRef.current}px` : '28px';
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
