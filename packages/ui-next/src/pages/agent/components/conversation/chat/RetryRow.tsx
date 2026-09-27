import type { ChatMessage } from '../../types';
import css from './MessageItem.module.css';

export function RetryRow({ message }: { message: ChatMessage }) {
    const active = message.retryState === 'scheduled';
    const label = message.retryState === 'cancelled' ? '已取消' : message.retryState === 'started' ? '已开始' : active ? '等待重试' : '已安排';
    const seconds = Math.max(1, Math.ceil((message.retryDelayMs ?? 0) / 1000));
    return <details className={css.retryRow} data-active={active || undefined}>
        <summary className={css.retrySummary}><span className={css.retryText}>{label} · 第 {message.retry ?? 1} 次 · {seconds}s</span></summary>
        {message.text && <div className={css.retryDetails}><div><span className={css.retryDetailLabel}>原因</span> {message.text}</div></div>}
    </details>;
}
