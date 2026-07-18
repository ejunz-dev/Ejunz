import React, { useCallback, useEffect, useRef } from 'react';
import { i18n } from 'vj/utils';

export type WSConnectionStatus = 'connecting' | 'connected' | 'disconnected';

/** Floating status dot for WebSocket connection state. */
export function WSStatusIndicator({
  status,
  viewerCount,
  posX,
  posY,
  onPosChange,
}: {
  status: WSConnectionStatus;
  viewerCount?: number;
  posX: number;
  posY: number;
  onPosChange?: (x: number, y: number) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    startX: number; startY: number;
    startPosX: number; startPosY: number;
  } | null>(null);

  const dotClass = status === 'connected' ? 'is-connected'
    : status === 'connecting' ? 'is-connecting'
    : 'is-disconnected';

  const label = status === 'connected'
    ? i18n('Online: {0}', viewerCount ?? 1)
    : status === 'connecting' ? i18n('Connecting…') : i18n('Disconnected');

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

  return (
    <div className="base-detail-ws-indicator-wrap" ref={wrapRef}>
      <div
        ref={innerRef}
        className={`base-detail-ws-indicator ${dotClass}`}
        style={{ cursor: onPosChange ? 'grab' : undefined }}
        title={label}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="base-detail-ws-indicator__dot" />
        <span className="base-detail-ws-indicator__label">{label}</span>
      </div>
    </div>
  );
}
