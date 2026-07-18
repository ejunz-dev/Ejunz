import React, { useCallback, useEffect, useRef } from 'react';
import { i18n } from 'vj/utils';

/** Floating status dot that stays fixed; label slides out to the right. */
export function StatusIndicator({
  dirty,
  posX,
  posY,
  onPosChange,
  onClickSave,
}: {
  dirty: boolean;
  posX: number;
  posY: number;
  onPosChange?: (x: number, y: number) => void;
  onClickSave?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const fullWRef = useRef(0);
  const wasDraggedRef = useRef(false);
  const dragRef = useRef<{
    startX: number; startY: number;
    startPosX: number; startPosY: number;
  } | null>(null);

  // Sync wrap position
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.left = `calc(100% - ${posX}px)`;
    wrap.style.top = `${posY}px`;
  }, [posX, posY]);

  // Measure and animate width
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    if (fullWRef.current === 0) {
      el.style.transition = 'none';
      el.style.width = 'auto';
      fullWRef.current = Math.max(el.offsetWidth, 60);
      el.style.transition = '';
      el.style.width = dirty ? `${fullWRef.current}px` : '28px';
    }

    el.style.transition = 'width 0.3s ease-out';
    el.style.width = dirty ? `${fullWRef.current}px` : '28px';
  }, [dirty]);

  // Drag via pointer capture (no re-render during drag)
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || !onPosChange) return;
    const el = e.currentTarget as HTMLDivElement;
    wasDraggedRef.current = false;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: posX,
      startPosY: posY,
    };
    el.setPointerCapture(e.pointerId);
  }, [posX, posY, onPosChange]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasDraggedRef.current = true;
    const newX = Math.max(10, drag.startPosX - dx);
    const newY = Math.max(5, drag.startPosY + dy);
    const wrap = wrapRef.current;
    if (wrap) {
      wrap.style.left = `calc(100% - ${newX}px)`;
      wrap.style.top = `${newY}px`;
    }
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const wrap = wrapRef.current;
    if (!wrap || !onPosChange) return;
    const leftStr = wrap.style.left;
    const topStr = wrap.style.top;
    const x = leftStr ? parseInt(leftStr.replace('calc(100% - ', '').replace('px)', ''), 10) : posX;
    const y = topStr ? parseInt(topStr, 10) : posY;
    onPosChange(x, y);
    dragRef.current = null;
  }, [onPosChange, posX, posY]);

  // Click on the indicator itself triggers save (only when dirty, not after drag)
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (!dirty || !onClickSave || wasDraggedRef.current) return;
    onClickSave();
  }, [dirty, onClickSave]);

  return (
    <div className="base-detail-status-indicator-wrap" ref={wrapRef}>
      <div
        ref={innerRef}
        className={`base-detail-status-indicator${dirty ? ' is-dirty' : ' is-clean'}`}
        style={{ cursor: onPosChange ? 'grab' : undefined }}
        title={dirty
          ? i18n('Unsaved changes — click to save')
          : i18n('Saved')}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="base-detail-status-indicator__dot" />
        <span className="base-detail-status-indicator__label">{i18n('Unsaved')}</span>
      </div>
    </div>
  );
}
