import { useState } from 'react';
import { i18n } from '@/i18n';
import { MarkdownText } from '../../primitives/markdown/MarkdownText';
import css from './MessageItem.module.css';

export function CompactionRow({ summary, items, tokens }: { summary?: string; items?: number; tokens?: number }) {
    const [open, setOpen] = useState(false);
    const text = items !== undefined && tokens !== undefined ? i18n('Compacted {0} messages · {1} tokens', items, tokens) : summary ? i18n('Expand to view the compaction summary') : i18n('Compaction summary unavailable');
    return <div className={css.compactionRow}>
        <button type="button" className={css.compactionButton} disabled={!summary} aria-expanded={summary ? open : undefined} onClick={() => setOpen((value) => !value)}>
            <span className={css.compactionLeading} aria-hidden>◈</span><span className={css.compactionTitle}>{i18n('Context compaction')}</span><span className={css.compactionSep} aria-hidden /><span className={css.compactionSummary}>{text}</span>
        </button>
        {open && summary && <div className={css.compactionBody}><MarkdownText text={summary} /></div>}
    </div>;
}
