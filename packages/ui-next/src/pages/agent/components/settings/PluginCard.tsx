import { useState, type ReactNode } from 'react';
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
                aria-label={`${open ? '收起设置' : '展开设置'}: ${title}`}
                onClick={() => { setOpen(!open); }}
            >
                <span className={css.headText}>
                    <span className={css.name}>{title}</span>
                    <span className={css.description}>{description}</span>
                </span>
                {state.dirty ? <span className={css.pending}>未保存</span> : null}
                <IconChevronDownOutline14 className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
            </button>
            {open ? (
                <div className={css.body}>
                    {!state.writable ? <p className={css.readOnly} role="status">本部署的设置为只读。</p> : null}
                    {children}
                    <div className={css.footer}>
                        {state.failed ? <p className={css.failed} role="status">本部署没有接受这些值，已保留供你修改。</p> : null}
                        <button type="button" className={css.discard} disabled={!state.dirty || state.saving} onClick={onDiscard}>放弃修改</button>
                        <button type="button" className={css.save} disabled={blocked} onClick={onSave}>{state.saving ? '保存中…' : '保存'}</button>
                    </div>
                </div>
            ) : null}
        </li>
    );
}
