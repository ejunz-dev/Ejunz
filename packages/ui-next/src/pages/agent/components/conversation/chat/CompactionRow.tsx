import { useState } from 'react';
import { MarkdownText } from '../../primitives/markdown/MarkdownText';
import css from './MessageItem.module.css';

export function CompactionRow({ summary, items, tokens }: { summary?: string; items?: number; tokens?: number }) {
    const [open, setOpen] = useState(false);
    const text = items !== undefined && tokens !== undefined ? `已压缩 ${items} 条消息 · ${tokens} tokens` : summary ? '展开查看压缩摘要' : '压缩摘要不可用';
    return <div className={css.compactionRow}>
        <button type="button" className={css.compactionButton} disabled={!summary} aria-expanded={summary ? open : undefined} onClick={() => setOpen((value) => !value)}>
            <span className={css.compactionLeading} aria-hidden>◈</span><span className={css.compactionTitle}>上下文压缩</span><span className={css.compactionSep} aria-hidden /><span className={css.compactionSummary}>{text}</span>
        </button>
        {open && summary && <div className={css.compactionBody}><MarkdownText text={summary} /></div>}
    </div>;
}
