import type { ReactNode, KeyboardEvent, MouseEvent } from 'react';
import css from './DisclosureRow.module.css';

interface DisclosureRowProps {
    icon: ReactNode;
    title: string;
    open: boolean;
    expandable: boolean;
    onToggle: () => void;
    expandOnRowClick?: boolean;
    collapsedContent?: ReactNode;
    children?: ReactNode;
    className?: string;
    rowClassName?: string;
    leadingClassName?: string;
    chevronClassName?: string;
    titleClassName?: string;
}

export function DisclosureRow({ icon, title, open, expandable, onToggle, expandOnRowClick = false, collapsedContent, children, className, rowClassName, leadingClassName, chevronClassName, titleClassName }: DisclosureRowProps) {
    const rowExpands = expandable && expandOnRowClick;
    const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!rowExpands || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onToggle();
    };
    const toggle = (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        onToggle();
    };
    const leading = open ? '⌄' : icon;
    return <div className={`${css.root}${className ? ` ${className}` : ''}`} data-open={open || undefined}>
        <div className={`${css.row}${rowClassName ? ` ${rowClassName}` : ''}`} data-disclosure-row data-expandable={rowExpands || undefined} role={rowExpands ? 'button' : undefined} tabIndex={rowExpands ? 0 : undefined} aria-expanded={rowExpands ? open : undefined} onClick={rowExpands ? onToggle : undefined} onKeyDown={keyboard}>
            {expandable && !rowExpands ? <button type="button" className={`${css.leading}${leadingClassName ? ` ${leadingClassName}` : ''}`} aria-expanded={open} onClick={toggle}>{leading}</button> : <span className={`${css.leading}${leadingClassName ? ` ${leadingClassName}` : ''}`}>{leading}</span>}
            <span className={`${css.title}${titleClassName ? ` ${titleClassName}` : ''}`}>{title}</span>
            {!open && collapsedContent}
        </div>
        {open && children}
    </div>;
}
