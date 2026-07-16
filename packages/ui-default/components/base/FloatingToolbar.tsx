import React, { useCallback, useEffect, useRef } from 'react';
import { i18n } from 'vj/utils';

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 19V5M5 12l7 7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function FloatingToolbar({
  open,
  posX,
  posY,
  onOpenChange,
  onPosChange,
}: {
  open: boolean;
  posX: number;
  posY: number;
  onOpenChange: (v: boolean) => void;
  onPosChange: (x: number, y: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.left = `calc(100% - ${posX}px)`;
    wrap.style.top = `${posY}px`;
  }, [posX, posY]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLDivElement;
    movedRef.current = false;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      startPosX: posX, startPosY: posY,
    };
    el.setPointerCapture(e.pointerId);
  }, [posX, posY]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    if (!movedRef.current) return;
    const newX = Math.max(10, drag.startPosX - dx);
    const newY = Math.max(5, drag.startPosY + dy);
    const wrap = wrapRef.current;
    if (wrap) {
      wrap.style.left = `calc(100% - ${newX}px)`;
      wrap.style.top = `${newY}px`;
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    const wasMoved = movedRef.current;
    movedRef.current = false;
    dragRef.current = null;
    if (wasMoved) {
      const wrap = wrapRef.current;
      if (wrap) {
        const x = parseInt(wrap.style.left.replace('calc(100% - ', '').replace('px)', ''), 10) || posX;
        const y = parseInt(wrap.style.top, 10) || posY;
        onPosChange(Math.max(10, x), Math.max(5, y));
      }
    } else {
      onOpenChange(!open);
    }
  }, [onPosChange, onOpenChange, open, posX, posY]);

  const scrollTop = () => {
    document.documentElement.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollBottom = () => {
    const h = document.documentElement.scrollHeight;
    document.documentElement.scrollTo({ top: h, behavior: 'smooth' });
    document.body.scrollTo({ top: h, behavior: 'smooth' });
  };

  return (
    <div className="base-detail-toolbar-wrap" ref={wrapRef}>
      <div className={`base-detail-toolbar-menu${open ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="base-detail-toolbar-item"
          onClick={scrollTop}
          title={i18n('Scroll to top')}
        >
          <span className="base-detail-toolbar-item__icon">
            <ArrowUpIcon />
          </span>
        </button>
      </div>
      <div
        className={`base-detail-toolbar-trigger${open ? ' is-open' : ''}`}
        style={{ cursor: 'grab' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="base-detail-toolbar-trigger__dot" />
      </div>
      <div className={`base-detail-toolbar-menu${open ? ' is-visible' : ''}`}>
        <button
          type="button"
          className="base-detail-toolbar-item"
          onClick={scrollBottom}
          title={i18n('Scroll to bottom')}
        >
          <span className="base-detail-toolbar-item__icon">
            <ArrowDownIcon />
          </span>
        </button>
      </div>
    </div>
  );
}
