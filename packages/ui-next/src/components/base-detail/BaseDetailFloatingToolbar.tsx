import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { i18n } from '../../i18n';

function ArrowIcon({ direction }: { direction: 'up' | 'down' }) {
  return <span aria-hidden>{direction === 'up' ? '↑' : '↓'}</span>;
}

interface Props {
  open: boolean;
  posX: number;
  posY: number;
  onOpenChange: (open: boolean) => void;
  onPosChange: (x: number, y: number) => void;
  onTreeOpen?: () => void;
  onSearchOpen?: () => void;
}

export function BaseDetailFloatingToolbar({ open, posX, posY, onOpenChange, onPosChange, onTreeOpen, onSearchOpen }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    if (!wrapRef.current) return;
    wrapRef.current.style.left = `calc(100% - ${posX}px)`;
    wrapRef.current.style.top = `${posY}px`;
  }, [posX, posY]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    movedRef.current = false;
    dragRef.current = { startX: event.clientX, startY: event.clientY, startPosX: posX, startPosY: posY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [posX, posY]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) movedRef.current = true;
    if (!movedRef.current || !wrapRef.current) return;
    const nextX = Math.max(10, drag.startPosX - dx);
    const nextY = Math.max(5, drag.startPosY + dy);
    wrapRef.current.style.left = `calc(100% - ${nextX}px)`;
    wrapRef.current.style.top = `${nextY}px`;
  }, []);

  const onPointerUp = useCallback(() => {
    const moved = movedRef.current;
    movedRef.current = false;
    dragRef.current = null;
    if (!moved) {
      onOpenChange(!open);
      return;
    }
    if (!wrapRef.current) return;
    const x = parseInt(wrapRef.current.style.left.replace('calc(100% - ', '').replace('px)', ''), 10) || posX;
    const y = parseInt(wrapRef.current.style.top, 10) || posY;
    onPosChange(Math.max(10, x), Math.max(5, y));
  }, [onOpenChange, onPosChange, open, posX, posY]);

  const scrollTop = () => {
    document.documentElement.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const scrollBottom = () => {
    const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    document.documentElement.scrollTo({ top: height, behavior: 'smooth' });
    document.body.scrollTo({ top: height, behavior: 'smooth' });
  };

  return (
    <div className="bd-toolbar-wrap" ref={wrapRef}>
      <div className={`bd-toolbar-menu bd-toolbar-menu--top${open ? ' is-visible' : ''}`}>
        <button type="button" className="bd-toolbar-item" onClick={scrollTop} title={i18n('Scroll to top')} aria-label={i18n('Scroll to top')}><ArrowIcon direction="up" /></button>
      </div>
      <div className="bd-toolbar-row">
        <div className={`bd-toolbar-side bd-toolbar-side--left${open ? ' is-visible' : ''}`}>
          <button type="button" className="bd-toolbar-item" onClick={onTreeOpen} title={i18n('Document Structure')} aria-label={i18n('Document Structure')}>☷</button>
        </div>
        <div className={`bd-toolbar-trigger${open ? ' is-open' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} role="button" tabIndex={0} aria-label={i18n('Show toolbar')}>
          <span className="bd-toolbar-trigger__dot" />
        </div>
        <div className={`bd-toolbar-side bd-toolbar-side--right${open ? ' is-visible' : ''}`}>
          <button type="button" className="bd-toolbar-item" onClick={onSearchOpen} title={i18n('Filter current tree')} aria-label={i18n('Filter current tree')}>⌕</button>
        </div>
      </div>
      <div className={`bd-toolbar-menu bd-toolbar-menu--bottom${open ? ' is-visible' : ''}`}>
        <button type="button" className="bd-toolbar-item" onClick={scrollBottom} title={i18n('Scroll to bottom')} aria-label={i18n('Scroll to bottom')}><ArrowIcon direction="down" /></button>
      </div>
    </div>
  );
}
