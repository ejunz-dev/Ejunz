import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconCheckOutline16, IconChevronRightOutline14, IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16 } from '../../../icons';
import css from './DirectoryPickerPrimitives.module.css';

export { IconCheckOutline16, IconChevronRightOutline14, IconEditOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16 };

export function Button({ variant = 'primary', icon, className, disabled, onClick, children }: {
    variant?: 'primary' | 'outline';
    icon?: ReactNode;
    className?: string;
    disabled?: boolean;
    onClick?: () => void;
    children: ReactNode;
}) {
    return <button type="button" className={`${css.button} ${variant === 'primary' ? css.primary : css.outline}${className ? ` ${className}` : ''}`} disabled={disabled} onClick={onClick}>
        {icon}
        {children}
    </button>;
}

export function Modal({ open, onClose, title, children, className, headless = false }: {
    open: boolean;
    onClose: () => void;
    title: string;
    children?: ReactNode;
    className?: string;
    headless?: boolean;
}) {
    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onClose, open]);
    if (!open) return null;
    const darkTheme = document.querySelector('.eja-app[data-ds-dark-theme], body[data-ds-dark-theme]') !== null;
    return createPortal(<div className={`${css.root}${darkTheme ? ` ${css.darkRoot}` : ''}`} role="presentation">
        <div className={css.mask} aria-hidden onClick={onClose} />
        <div className={`${css.dialog}${className ? ` ${className}` : ''}`} style={darkTheme ? { background: 'rgb(44 44 46)', color: 'rgb(245 245 247)', borderColor: 'rgb(255 255 255 / 12%)' } : undefined} role="dialog" aria-modal="true" aria-label={title}>
            {headless ? children : <div className={css.body}>{children}</div>}
        </div>
    </div>, document.body);
}
