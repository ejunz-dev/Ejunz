import { useCallback, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import css from './AppFrame.module.css';

interface DragHandleProps {
    side: 'sidebar' | 'details';
    left: number;
    onDrag: (delta: number) => void;
}

function DragHandle({ side, left, onDrag }: DragHandleProps) {
    const [dragging, setDragging] = useState(false);
    const origin = useRef(0);
    const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        origin.current = event.clientX;
        setDragging(true);
    };
    const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onDrag(event.clientX - origin.current);
    }, [onDrag]);
    const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
    };
    return <div className={css.handle} style={{ left }} data-side={side} data-dragging={dragging || undefined} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} />;
}

interface AppFrameProps {
    sidebarWidth: number;
    detailsWidth: number;
    sidebarCollapsed: boolean;
    detailsCollapsed: boolean;
    sidebar: ReactNode;
    conversation: ReactNode;
    details: ReactNode;
    onSidebarResize?: (delta: number) => void;
    onDetailsResize?: (delta: number) => void;
}

export function AppFrame({ sidebarWidth, detailsWidth, sidebarCollapsed, detailsCollapsed, sidebar, conversation, details, onSidebarResize, onDetailsResize }: AppFrameProps) {
    return <div className={css.frame} style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr) ${detailsWidth}px` }} data-sidebar-collapsed={sidebarCollapsed || undefined} data-details-collapsed={detailsCollapsed || undefined}>
        <div className={css.sidebarCol}>{sidebar}</div>
        <div className={css.centerCol}>{conversation}</div>
        <div className={css.detailsCol}>{details}</div>
        {!sidebarCollapsed && onSidebarResize && <DragHandle side="sidebar" left={sidebarWidth} onDrag={onSidebarResize} />}
        {!detailsCollapsed && onDetailsResize && <DragHandle side="details" left={sidebarWidth + detailsWidth} onDrag={(delta) => onDetailsResize(-delta)} />}
    </div>;
}
