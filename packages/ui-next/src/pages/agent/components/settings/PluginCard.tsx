import { useState, type ReactNode } from 'react';
import { i18n } from '@/i18n';
import { IconChevronDownOutline14 } from '../../icons';
import type { CardShell } from './cardForm';
import css from './PluginCard.module.css';

export interface PluginCardProps {
    title: string;
    description: string;
    state: CardShell;
    onSave: () => void;
    onDiscard: () => void;
    children: ReactNode;
}

export function PluginCard({ title, description, state, onSave, onDiscard, children }: PluginCardProps) {
    const [open, setOpen] = useState(false);
    if (!state.available) return null;
    const blocked = !state.dirty || state.invalid || state.saving;
    return (
        <li className={open ? `${css.card} ${css.cardOpen}` : css.card}>
            <button
                type="button"
                className={css.header}
                aria-expanded={open}
                aria-label={i18n(open ? 'Collapse settings: {0}' : 'Expand settings: {0}', title)}
                onClick={() => { setOpen(!open); }}
            >
                <span className={css.headText}>
                    <span className={css.name}>{title}</span>
                    <span className={css.description}>{description}</span>
                </span>
                {state.dirty ? <span className={css.pending}>{i18n('Unsaved')}</span> : null}
                <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
            </button>
            {open ? (
                <div className={css.body}>
                    {!state.writable ? <p className={css.readOnly} role="status">{i18n('Settings are read-only in this deployment.')}</p> : null}
                    {children}
                    <div className={css.footer}>
                        {state.failed ? <p className={css.failed} role="status">{i18n('This deployment did not accept these values. They are kept so you can edit them.')}</p> : null}
                        <button type="button" className={css.discard} disabled={!state.dirty || state.saving} onClick={onDiscard}>{i18n('Discard changes')}</button>
                        <button type="button" className={css.save} disabled={blocked} onClick={onSave}>{state.saving ? i18n('Saving...') : i18n('Save')}</button>
                    </div>
                </div>
            ) : null}
        </li>
    );
}
