import { useState } from 'react';
import css from './MessageIconActions.module.css';

export function MessageActions({ text, time, clock }: { text: string; time?: number; clock: 'start' | 'end' }) {
    const [copied, setCopied] = useState(false);
    const copy = () => {
        if (!navigator.clipboard) return;
        void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1000);
        }).catch(() => {});
    };
    const timeLabel = time === undefined ? null : new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return <div className={css.actions}>
        {clock === 'start' && timeLabel && <span className={css.timeStart}>{timeLabel}</span>}
        <button type="button" className={css.action} aria-label={copied ? '已复制' : '复制'} onClick={copy}>{copied ? '✓' : '⧉'}</button>
        {clock === 'end' && timeLabel && <span className={css.timeEnd}>{timeLabel}</span>}
    </div>;
}
