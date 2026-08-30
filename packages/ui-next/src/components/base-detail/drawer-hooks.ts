import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';

export function useDrawerPresence(open: boolean, duration = 240) {
  const [present, setPresent] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setPresent(true);
      setClosing(false);
      return undefined;
    }
    if (!present) return undefined;
    setClosing(true);
    const timer = window.setTimeout(() => setPresent(false), duration);
    return () => window.clearTimeout(timer);
  }, [duration, open, present]);

  return { present, closing };
}

export function useDrawerSwipe(side: 'left' | 'right', onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  const startXRef = useRef<number | null>(null);

  const onPointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, a, input, textarea, select, summary')) return;
    startXRef.current = event.clientX;
    offsetRef.current = 0;
    setOffset(0);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    if (startXRef.current == null) return;
    const delta = event.clientX - startXRef.current;
    const next = side === 'left' ? Math.min(0, delta) : Math.max(0, delta);
    offsetRef.current = next;
    setOffset(next);
  }, [side]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLElement>) => {
    if (startXRef.current == null) return;
    const shouldClose = Math.abs(offsetRef.current) >= 72;
    startXRef.current = null;
    offsetRef.current = 0;
    setOffset(0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (shouldClose) onClose();
  }, [onClose]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLElement>) => {
    if (startXRef.current == null) return;
    startXRef.current = null;
    offsetRef.current = 0;
    setOffset(0);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);

  const style: CSSProperties | undefined = offset ? { transform: `translateX(${offset}px)` } : undefined;
  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, style };
}
