import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { i18n } from '../../i18n';
import type { BaseDetailViewerInfo, BaseDetailWsStatus } from './useBaseDetailWebSocket';

interface Props {
  status: BaseDetailWsStatus;
  viewerCount?: number;
  viewers?: BaseDetailViewerInfo[];
  open: boolean;
  posX: number;
  posY: number;
  onPosChange?: (x: number, y: number) => void;
  onToggle?: () => void;
  onRequestViewers?: () => void;
}

export function BaseDetailWSStatusIndicator({ status, viewerCount, viewers = [], open, posX, posY, onPosChange, onToggle, onRequestViewers }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const draggedRef = useRef(false);
  const wasConnectedRef = useRef(false);
  const dotClass = status === 'connected' ? 'is-connected' : status === 'connecting' ? 'is-connecting' : 'is-disconnected';
  const label = status === 'connected' ? i18n('Online: {0}', viewerCount ?? 1) : status === 'connecting' ? i18n('Connecting…') : i18n('Disconnected');

  useEffect(() => {
    if (status === 'connected' && !wasConnectedRef.current) {
      wasConnectedRef.current = true;
      onRequestViewers?.();
    }
    if (status === 'disconnected') wasConnectedRef.current = false;
  }, [onRequestViewers, status]);

  useEffect(() => {
    if (!wrapRef.current) return;
    wrapRef.current.style.left = `calc(100% - ${posX}px)`;
    wrapRef.current.style.top = `${posY}px`;
  }, [posX, posY]);

  useEffect(() => {
    if (!innerRef.current) return;
    innerRef.current.style.transition = 'none';
    innerRef.current.style.width = 'auto';
    const width = Math.max(innerRef.current.offsetWidth, 60);
    innerRef.current.style.transition = 'width .3s ease-out';
    innerRef.current.style.width = `${width}px`;
  }, [label]);

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

  return (
    <div className="bd-ws-indicator-wrap" ref={wrapRef}>
      <div ref={innerRef} className={`bd-ws-indicator ${dotClass}`} title={label} onClick={() => { if (!draggedRef.current) onToggle?.(); }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <span className="bd-ws-indicator__dot" />
        <span className="bd-ws-indicator__label">{label}</span>
      </div>
      {open && status === 'connected' ? (
        <div className="bd-ws-indicator__dropdown">
          {viewers.length ? viewers.map((viewer) => (
            <div className="bd-ws-indicator__viewer" key={viewer.uid}>
              <span>{viewer.pageType === 'detail' ? '📖' : '✏️'}</span>
              <span>{viewer.uname}</span>
              <small>{viewer.pageType === 'detail' ? 'Detail' : 'Editor'}</small>
            </div>
          )) : <div className="bd-ws-indicator__viewer bd-ws-indicator__viewer--empty">{i18n('No other viewers')}</div>}
        </div>
      ) : null}
    </div>
  );
}
