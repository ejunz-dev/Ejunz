import type { ReactNode } from 'react';
import type { LocaleKey } from './locales';
import css from './ModelsSection.module.css';

export interface EditorFooterProps {
    t: (key: LocaleKey) => string;
    busy: boolean;
    disabled: boolean;
    onCancel: () => void;
    onSubmit: () => void;
    submitLabel?: LocaleKey;
    busyLabel?: LocaleKey;
}

export function EditorFooter({ t, busy, disabled, onCancel, onSubmit, submitLabel = 'save', busyLabel = 'saving' }: EditorFooterProps): ReactNode {
    return <div className={css.editorActions}>
        <button type="button" className={css.secondaryButton} disabled={busy} onClick={onCancel}>{t('cancel')}</button>
        <button type="button" className={css.primaryButton} disabled={disabled || busy} onClick={onSubmit}>{busy ? t(busyLabel) : t(submitLabel)}</button>
    </div>;
}
