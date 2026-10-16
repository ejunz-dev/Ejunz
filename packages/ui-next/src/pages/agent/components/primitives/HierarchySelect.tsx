import { useEffect, useRef, useState } from 'react';
import { i18n } from '@/i18n';
import css from './HierarchySelect.module.css';

export interface HierarchySelectOption {
    value: string;
    label: string;
    children?: readonly HierarchySelectOption[];
}

interface HierarchySelectProps {
    value: string;
    options: readonly HierarchySelectOption[];
    placeholder: string;
    ariaLabel: string;
    disabled?: boolean;
    onChange: (value: string) => void;
}

function findLabel(options: readonly HierarchySelectOption[], value: string): string | undefined {
    for (const option of options) {
        if (option.value === value) return option.label;
        const childLabel = findLabel(option.children ?? [], value);
        if (childLabel !== undefined) return childLabel;
    }
    return undefined;
}

export function HierarchySelect({ value, options, placeholder, ariaLabel, disabled = false, onChange }: HierarchySelectProps) {
    const rootRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
    const selectedLabel = findLabel(options, value);

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event: PointerEvent) => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    const renderOptions = (items: readonly HierarchySelectOption[], depth = 0) => items.map((option) => {
        const children = option.children ?? [];
        const hasChildren = children.length > 0;
        const isExpanded = expanded.has(option.value);
        const selected = value === option.value;
        return <div className={css.node} role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined} aria-selected={selected} key={option.value}>
            <div className={css.row} style={{ paddingInlineStart: `${depth * 1.1}rem` }}>
                {hasChildren
                    ? <button type="button" className={css.toggle} aria-label={i18n(isExpanded ? 'Collapse {0}' : 'Expand {0}', option.label)} aria-expanded={isExpanded} onClick={() => setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(option.value)) next.delete(option.value); else next.add(option.value);
                        return next;
                    })}><span className={isExpanded ? css.chevronExpanded : css.chevron} aria-hidden="true" /></button>
                    : <span className={css.spacer} aria-hidden="true" />}
                <button type="button" className={`${css.option}${selected ? ` ${css.selected}` : ''}`} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>
            </div>
            {hasChildren && isExpanded && <div className={css.children} role="group">{renderOptions(children, depth + 1)}</div>}
        </div>;
    });

    return <div className={css.root} ref={rootRef}>
        <button type="button" className={css.trigger} aria-haspopup="tree" aria-expanded={open} aria-label={ariaLabel} disabled={disabled || options.length === 0} onClick={() => setOpen((current) => !current)}>
            <span className={selectedLabel ? css.triggerValue : css.placeholder}>{selectedLabel ?? placeholder}</span>
            <span className={open ? css.chevronExpanded : css.chevron} aria-hidden="true" />
        </button>
        {open && <div className={css.menu} role="tree" aria-label={ariaLabel}>
            {options.length > 0 ? renderOptions(options) : <p className={css.empty}>{i18n('No teams available')}</p>}
        </div>}
    </div>;
}
