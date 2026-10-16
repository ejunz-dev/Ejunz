import { i18n } from '@/i18n';
import type { ChatMessage } from '../../types';
import css from './MessageItem.module.css';

export function RetryRow({ message }: { message: ChatMessage }) {
    const active = message.retryState === 'scheduled';
    const label = message.retryState === 'cancelled' ? i18n('Cancelled') : message.retryState === 'started' ? i18n('Started') : active ? i18n('Waiting to retry') : i18n('Scheduled');
    const seconds = Math.max(1, Math.ceil((message.retryDelayMs ?? 0) / 1000));
    return <details className={css.retryRow} data-active={active || undefined}>
        <summary className={css.retrySummary}><span className={css.retryText}>{i18n('{0} · attempt {1} · {2}s', label, message.retry ?? 1, seconds)}</span></summary>
        {message.text && <div className={css.retryDetails}><div><span className={css.retryDetailLabel}>{i18n('Reason')}</span> {message.text}</div></div>}
    </details>;
}
