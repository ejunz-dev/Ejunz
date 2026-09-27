import { useState } from 'react';
import { IconChevronDownOutline14 } from '../../../icons';
import type { BaseView } from '../../../runtime/session';
import { Menu } from '../../primitives/Menu';
import css from './BasePicker.module.css';

export interface BasePickerProps {
    bases: readonly BaseView[];
    selectedId?: number;
    onPick: (baseId: number) => void;
}

export function BasePicker({ bases, selectedId, onPick }: BasePickerProps) {
    const [open, setOpen] = useState(false);
    const current = bases.find((base) => base.docId === selectedId);
    return <Menu
        open={open}
        onClose={() => setOpen(false)}
        items={bases.map((base) => ({ id: String(base.docId), label: base.title }))}
        selectedId={selectedId === undefined ? undefined : String(selectedId)}
        onSelect={(id) => {
            setOpen(false);
            const baseId = Number(id);
            if (Number.isSafeInteger(baseId) && baseId > 0) onPick(baseId);
        }}
        side="bottom"
        portal
        anchor={<button type="button" className={css.trigger} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <span className={css.mark} aria-hidden>◇</span>
            <span className={css.label}>{current?.title ?? '选择知识库'}</span>
            <IconChevronDownOutline14 size={14} className={open ? css.open : undefined} />
        </button>}
    />;
}
