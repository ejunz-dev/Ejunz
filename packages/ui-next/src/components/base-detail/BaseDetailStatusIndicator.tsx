import { useCallback, useEffect, useRef, type MouseEvent, type PointerEvent } from 'react';
import { i18n } from '../../i18n';

interface Props {
  dirty: boolean;
  posX: number;
  posY: number;
  onPosChange?: (x: number, y: number) => void;
  onClickSave?: () => void;
}

export function BaseDetailStatusIndicator({ dirty, posX, posY, onPosChange, onClickSave }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const fullWidthRef = useRef(0);
  const draggedRef = useRef(false);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    wrapRef.current.style.left = `calc(100% - ${posX}px)`;
    wrapRef.current.style.top = `${posY}px`;
  }, [posX, posY]);

  useEffect(() => {
    const element = innerRef.current;
    if (!element) return;
    if (!fullWidthRef.current) {
      element.style.transition = 'none';
      element.style.width = 'auto';
      fullWidthRef.current = Math.max(element.offsetWidth, 60);
      element.style.transition = '';
    }
    element.style.transition = 'width .3s ease-out';
    element.style.width = dirty ? `${fullWidthRef.current}px` : '28px';
  }, [dirty]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !onPosChange) return;
    draggedRef.current = false;
    dragRef.current = { startX: event.clientX, startY: event.clientY, startPosX: posX, startPosY: posY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [onPosChange, posX, posY]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true;
    const nextX = Math.max(10, drag.startPosX - dx);
    const nextY = Math.max(5, drag.startPosY + dy);
    if (wrapRef.current) {
      wrapRef.current.style.left = `calc(100% - ${nextX}px)`;
      wrapRef.current.style.top = `${nextY}px`;
    }
  }, []);

  const onPointerUp = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !onPosChange) return;
    const x = parseInt(wrap.style.left.replace('calc(100% - ', '').replace('px)', ''), 10) || posX;
    const y = parseInt(wrap.style.top, 10) || posY;
    onPosChange(x, y);
    dragRef.current = null;
  }, [onPosChange, posX, posY]);

  const onClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (dirty && onClickSave && !draggedRef.current) onClickSave();
    event.stopPropagation();
  }, [dirty, onClickSave]);

  return (
    <div className="bd-status-indicator-wrap" ref={wrapRef}>
      <div
        ref={innerRef}
        className={`bd-status-indicator${dirty ? ' is-dirty' : ' is-clean'}`}
        title={dirty ? i18n('Unsaved changes — click to save') : i18n('Saved')}
        style={{ cursor: onPosChange ? 'grab' : undefined }}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <span className="bd-status-indicator__dot" />
        <span className="bd-status-indicator__label">{i18n('Unsaved')}</span>
      </div>
    </div>
  );
}
