import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';

type SessionDrawerView = 'chat' | 'trajectory' | 'model' | 'context' | 'host';

interface SessionDrawerProps {
    loading: boolean;
    loadingLabel?: string;
    drawerWidth: number;
    view: SessionDrawerView;
    onViewChange: (view: SessionDrawerView) => void;
    onResize: (delta: number) => void;
    onClose: () => void;
    children: ReactNode;
    overlay?: ReactNode;
}

interface SwipeState {
    pointerId: number;
    startX: number;
    startY: number;
    horizontal: boolean;
}

const SWIPE_CLOSE_DISTANCE = 80;
const SWIPE_AXIS_RATIO = 1.2;
const CLOSE_ANIMATION_MS = 120;

function ResizeHandle({ onResize }: { onResize: (delta: number) => void }) {
    const [dragging, setDragging] = useState(false);
    const origin = useRef(0);
    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = event.clientX;
        setDragging(true);
    };
    const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onResize(origin.current - event.clientX);
        origin.current = event.clientX;
    };
    const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
    };
    return <div className="eja-sessionDrawerResize" data-dragging={dragging || undefined} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />;
}

export function SessionDrawer({ loading, loadingLabel = '加载中…', drawerWidth, view, onViewChange, onResize, onClose, children, overlay }: SessionDrawerProps) {
    const [closing, setClosing] = useState(false);
    const closingRef = useRef(false);
    const closeTimerRef = useRef<number | null>(null);
    const swipeRef = useRef<SwipeState | null>(null);
    useEffect(() => () => {
        if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    }, []);
    const requestClose = () => {
        if (closingRef.current) return;
        closingRef.current = true;
        setClosing(true);
        closeTimerRef.current = window.setTimeout(onClose, CLOSE_ANIMATION_MS);
    };
    const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'mouse') return;
        swipeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, horizontal: false };
    };
    const handlePointerMove = (event: PointerEvent<HTMLElement>) => {
        const swipe = swipeRef.current;
        if (!swipe || swipe.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - swipe.startX;
        const deltaY = event.clientY - swipe.startY;
        if (!swipe.horizontal) {
            if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 8) {
                swipeRef.current = null;
                return;
            }
            if (deltaX <= 8 || deltaX <= Math.abs(deltaY)) return;
            swipe.horizontal = true;
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
    };
    const handlePointerEnd = (event: PointerEvent<HTMLElement>) => {
        const swipe = swipeRef.current;
        if (!swipe || swipe.pointerId !== event.pointerId) return;
        const deltaX = event.clientX - swipe.startX;
        const deltaY = event.clientY - swipe.startY;
        swipeRef.current = null;
        if (swipe.horizontal && deltaX >= SWIPE_CLOSE_DISTANCE && deltaX >= Math.abs(deltaY) * SWIPE_AXIS_RATIO) requestClose();
    };
    const handlePointerCancel = () => {
        swipeRef.current = null;
    };
    return <>
        <button type="button" className="bd-backdrop bd-card-backdrop eja-sessionDrawerBackdrop" data-closing={closing || undefined} onClick={requestClose} aria-label="关闭会话历史" />
        <aside className="bd-drawer bd-card-drawer eja-sessionDrawer" data-closing={closing || undefined} style={{ '--eja-session-drawer-width': `${drawerWidth}px` } as CSSProperties} role="dialog" aria-modal="true" aria-label="会话历史" onWheel={(event) => event.stopPropagation()} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerEnd} onPointerCancel={handlePointerCancel}>
            <ResizeHandle onResize={onResize} />
            <header className="bd-drawer__header">
                <div className="bd-drawer__tabs" role="tablist">
                    <button type="button" role="tab" className={view === 'chat' ? 'is-active' : ''} aria-selected={view === 'chat'} onClick={() => onViewChange('chat')}>对话</button>
                    <button type="button" role="tab" className={view === 'trajectory' ? 'is-active' : ''} aria-selected={view === 'trajectory'} onClick={() => onViewChange('trajectory')}>轨迹</button>
                    <button type="button" role="tab" className={view === 'model' ? 'is-active' : ''} aria-selected={view === 'model'} onClick={() => onViewChange('model')}>模型</button>
                    <button type="button" role="tab" className={view === 'context' ? 'is-active' : ''} aria-selected={view === 'context'} onClick={() => onViewChange('context')}>上下文</button>
                    <button type="button" role="tab" className={view === 'host' ? 'is-active' : ''} aria-selected={view === 'host'} onClick={() => onViewChange('host')}>主机</button>
                </div>
                <div className="bd-drawer__header-actions">
                    <button type="button" className="bd-drawer__close" onClick={requestClose} aria-label="关闭">×</button>
                </div>
            </header>
            <div className="bd-drawer__body eja-sessionDrawerBody">
                {loading ? <div className="eja-sessionDrawerLoading" role="status" aria-label="加载会话历史"><span />{loadingLabel}</div> : children}
            </div>
            {overlay}
        </aside>
    </>;
}
