import React, { useCallback, useEffect, useRef } from 'react';
import { i18n } from 'vj/utils';

export type WSConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface ViewerInfo {
  uid: number;
  uname: string;
  pageType: string;
}

/** Floating status dot with toggleable viewer dropdown. */
export function WSStatusIndicator({
  status,
  viewerCount,
  viewers,
  open,
  posX,
  posY,
  onPosChange,
  onToggle,
  onRequestViewers,
}: {
  status: WSConnectionStatus;
  viewerCount?: number;
  viewers?: ViewerInfo[];
  open: boolean;
  posX: number;
  posY: number;
  onPosChange?: (x: number, y: number) => void;
  onToggle?: () => void;
  onRequestViewers?: () => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number; startY: number;
    startPosX: number; startPosY: number;
  } | null>(null);
  const wasDraggedRef = useRef(false);

  const dotClass = status === 'connected' ? 'is-connected'
    : status === 'connecting' ? 'is-connecting'
    : 'is-disconnected';

  const label = status === 'connected'
    ? i18n('Online: {0}', viewerCount ?? 1)
    : status === 'connecting' ? i18n('Connecting…') : i18n('Disconnected');

  // Auto-request viewers once connected
  const wasConnected = useRef(false);
  useEffect(() => {
    if (status === 'connected' && !wasConnected.current) {
      wasConnected.current = true;
      onRequestViewers?.();
    }
    if (status === 'disconnected') wasConnected.current = false;
  }, [status, onRequestViewers]);

  // Sync wrap position
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    wrap.style.left = `calc(100% - ${posX}px)`;
    wrap.style.top = `${posY}px`;
  }, [posX, posY]);

  // Re-measure on every label change to keep width in sync
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.width = 'auto';
    const w = Math.max(el.offsetWidth, 60);
    el.style.transition = 'width 0.3s ease-out';
    el.style.width = `${w}px`;
  }, [label]);

  // Drag via pointer capture
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

  const handlePointerUp = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !onPosChange) return;
    const leftStr = wrap.style.left;
    const topStr = wrap.style.top;
    const x = leftStr ? parseInt(leftStr.replace('calc(100% - ', '').replace('px)', ''), 10) : posX;
    const y = topStr ? parseInt(topStr, 10) : posY;
    onPosChange(x, y);
    dragRef.current = null;
  }, [onPosChange, posX, posY]);

  // Click toggles dropdown (only if not dragged)
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (wasDraggedRef.current) return;
    onToggle?.();
  }, [onToggle]);

  return (
    <div className="base-detail-ws-indicator-wrap" ref={wrapRef}>
      <div
        ref={innerRef}
        className={`base-detail-ws-indicator ${dotClass}`}
        style={{ cursor: onPosChange ? 'grab' : onToggle ? 'pointer' : undefined }}
        title={label}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="base-detail-ws-indicator__dot" />
        <span className="base-detail-ws-indicator__label">{label}</span>
      </div>
      {open && status === 'connected' ? (
        <div className="base-detail-ws-indicator__dropdown">
          {viewers && viewers.length > 0 ? viewers.map((v) => (
            <div key={v.uid} className="base-detail-ws-indicator__dropdown-item">
              <span>{v.pageType === 'detail' ? '📖' : '✏️'}</span>
              <span>{v.uname}</span>
              <span className="base-detail-ws-indicator__dropdown-tag">{v.pageType === 'detail' ? 'Detail' : 'Editor'}</span>
            </div>
          )) : (
            <div className="base-detail-ws-indicator__dropdown-item" style={{ justifyContent: 'center', color: '#999' }}>
              {i18n('No other viewers')}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
