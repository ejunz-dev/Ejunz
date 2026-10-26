import { useEffect } from 'react';
import { i18n } from '@/i18n';
import { HierarchySelect, type HierarchySelectOption } from './HierarchySelect';
import css from './ActionDialog.module.css';

export interface ActionDialogProps {
    open: boolean;
    title: string;
    description?: string;
    inputLabel?: string;
    inputValue?: string;
    inputPlaceholder?: string;
    selectLabel?: string;
    selectValue?: string;
    selectPlaceholder?: string;
    selectTreeOptions?: readonly HierarchySelectOption[];
    confirmLabel: string;
    cancelLabel?: string;
    danger?: boolean;
    busy?: boolean;
    error?: string | null;
    onInputChange?: (value: string) => void;
    onSelectChange?: (value: string) => void;
    onClose: () => void;
    onConfirm: () => void;
}

export function ActionDialog({ open, title, description, inputLabel, inputValue = '', inputPlaceholder, selectLabel, selectValue = '', selectPlaceholder = i18n('Select'), selectTreeOptions = [], confirmLabel, cancelLabel = i18n('Cancel'), danger = false, busy = false, error, onInputChange, onSelectChange, onClose, onConfirm }: ActionDialogProps) {
    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !busy) onClose();
            if (event.key === 'Enter' && inputLabel && !busy) onConfirm();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [busy, inputLabel, onClose, onConfirm, open]);

    if (!open) return null;
    return <div className={css.overlay} role="presentation">
        <button type="button" className={css.mask} aria-label={cancelLabel} onClick={() => { if (!busy) onClose(); }} />
        <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="ea-action-dialog-title">
            <h3 id="ea-action-dialog-title">{title}</h3>
            {description ? <p className={css.description}>{description}</p> : null}
            {selectLabel ? <label className={css.field}><span>{selectLabel}</span><HierarchySelect
                value={selectValue}
                options={selectTreeOptions}
                placeholder={selectPlaceholder}
                ariaLabel={selectLabel}
                disabled={busy}
                onChange={(value) => onSelectChange?.(value)}
            /></label> : null}
            {inputLabel ? <label className={css.field}><span>{inputLabel}</span><input autoFocus={selectLabel === undefined} value={inputValue} placeholder={inputPlaceholder} disabled={busy} onChange={(event) => onInputChange?.(event.target.value)} /></label> : null}
            {error ? <p className={css.error} role="alert">{error}</p> : null}
            <div className={css.footer}>
                <button type="button" className={css.cancel} disabled={busy} onClick={onClose}>{cancelLabel}</button>
                <button type="button" className={danger ? css.danger : css.confirm} disabled={busy || (inputLabel !== undefined && !inputValue.trim()) || (selectLabel !== undefined && !selectValue)} onClick={onConfirm}>{busy ? i18n('Working...') : confirmLabel}</button>
            </div>
        </div>
    </div>;
}
