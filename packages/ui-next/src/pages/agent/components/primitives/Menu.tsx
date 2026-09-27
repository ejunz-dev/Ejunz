import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePointerGrace } from './pointer-grace';
import css from './Menu.module.css';

export interface MenuItem {
    id: string;
    label: ReactNode;
    disabled?: boolean;
    icon?: ReactNode;
    danger?: boolean;
}

export interface MenuSeparator {
    type: 'separator';
    id: string;
}

export type MenuEntry = MenuItem | MenuSeparator;

function isSeparator(entry: MenuEntry): entry is MenuSeparator {
    return 'type' in entry && entry.type === 'separator';
}

const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 };

export interface MenuProps {
    open: boolean;
    anchor: ReactNode;
    items: readonly MenuEntry[];
    selectedId?: string;
    onSelect: (id: string) => void;
    onClose: () => void;
    align?: 'start' | 'end';
    side?: 'bottom' | 'top' | 'right';
    portal?: boolean;
    closeOnPointerLeave?: boolean;
    dense?: boolean;
    compact?: boolean;
}

export function Menu({ open, anchor, items, selectedId, onSelect, onClose, align = 'start', side = 'bottom', portal = false, closeOnPointerLeave = false, dense = false, compact = false }: MenuProps) {
    const rootRef = useRef<HTMLSpanElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [fixedPos, setFixedPos] = useState<CSSProperties | null>(null);
    const { arm: armClose, cancel: cancelClose } = usePointerGrace(onClose);

    useLayoutEffect(() => {
        if (!open || !portal) {
            setFixedPos(null);
            return undefined;
        }
        const place = () => {
            const rect = rootRef.current?.getBoundingClientRect();
            if (!rect) return;
            const width = listRef.current?.offsetWidth ?? 218;
            const height = listRef.current?.offsetHeight ?? 0;
            const margin = 12;
            let left = side === 'right' ? rect.right + 4 : align === 'end' ? rect.right - width : rect.left;
            let top = side === 'top' ? rect.top - height - 4 : rect.bottom + 4;
            left = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
            top = Math.min(Math.max(top, margin), window.innerHeight - height - margin);
            setFixedPos({ left, top });
        };
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [align, open, portal, side]);

    useEffect(() => {
        if (!open) {
            cancelClose();
            return undefined;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (!(event.target instanceof Node)) return;
            if (rootRef.current?.contains(event.target) || listRef.current?.contains(event.target)) return;
            onClose();
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [cancelClose, onClose, open]);

    const darkTheme = typeof document !== 'undefined' && document.querySelector('.eja-app[data-ds-dark-theme], body[data-ds-dark-theme]') !== null;
    const list = open ? <div ref={listRef} className={`${css.list}${dense ? ` ${css.denseList}` : ''}${compact ? ` ${css.compactList}` : ''}${portal ? ` ${css.portal}` : ''}${portal && darkTheme ? ` ${css.darkPortal}` : ''}${!portal && side === 'top' ? ` ${css.sideTop}` : ''}${!portal && align === 'end' ? ` ${css.alignEnd}` : ''}`} style={portal ? { ...(fixedPos ?? MEASURE_STYLE), position: 'fixed', zIndex: 1100 } : undefined} role="menu" onClick={(event) => { event.stopPropagation(); }}>
        <div className={css.viewport}>
            {items.map((entry) => isSeparator(entry)
                ? <div key={entry.id} className={css.separator} role="separator" />
                : <button key={entry.id} type="button" role="menuitem" className={`${css.item}${entry.id === selectedId ? ` ${css.selected}` : ''}${entry.danger ? ` ${css.danger}` : ''}`} disabled={entry.disabled} onClick={() => { onSelect(entry.id); }}>
                    {entry.icon !== undefined && <span className={css.itemIcon}>{entry.icon}</span>}
                    <span className={css.itemLabel}>{entry.label}</span>
                </button>)}
        </div>
    </div> : null;

    return <span ref={rootRef} className={css.root} onPointerEnter={closeOnPointerLeave ? cancelClose : undefined} onPointerLeave={closeOnPointerLeave ? () => { if (open) armClose(); } : undefined}>
        {anchor}
        {portal ? list && createPortal(list, document.body) : list}
    </span>;
}
