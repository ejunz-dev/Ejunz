import { useEffect, useRef, useState } from 'react';
import { IconChevronDownOutline14 } from '../../icons';
import css from './RowMenu.module.css';

export interface RowMenuItem {
    id: string;
    label: string;
}

export interface RowMenuProps {
    items: RowMenuItem[];
    selectedId: string;
    disabled?: boolean;
    onSelect: (id: string) => void;
}

export function RowMenu({ items, selectedId, disabled, onSelect }: RowMenuProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const activeLabel = items.find((item) => item.id === selectedId)?.label ?? selectedId;

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    return <div className={css.anchor} ref={rootRef}>
        <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => { setOpen((value) => !value); }}
        >
            {activeLabel}
            <IconChevronDownOutline14 className={css.chevron} />
        </button>
        {open && <div className={css.card} role="menu">
            <div className={css.viewport}>
                {items.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={item.id === selectedId}
                        className={item.id === selectedId ? `${css.row} ${css.rowActive}` : css.row}
                        onClick={() => { setOpen(false); onSelect(item.id); }}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
        </div>}
    </div>;
}
