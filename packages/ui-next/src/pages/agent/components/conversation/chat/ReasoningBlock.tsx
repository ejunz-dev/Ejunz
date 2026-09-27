import { useMemo, useState } from 'react';
import { DisclosureRow } from '../../primitives/DisclosureRow';
import css from './ReasoningRow.module.css';

function summaryText(text: string, running?: boolean): string {
    const value = running ? text.trimEnd() : text.trimStart();
    const lines = value.split('\n').filter(Boolean);
    return running ? lines[lines.length - 1] ?? 'Thinking…' : lines[0] ?? 'Think';
}

export function ReasoningBlock({ text, running }: { text: string; running?: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const summary = useMemo(() => summaryText(text, running), [running, text]);
    return <div className={css.root} data-state={running ? 'running' : 'ok'}>
        <DisclosureRow
            rowClassName={css.row}
            leadingClassName={css.leading}
            titleClassName={css.title}
            chevronClassName={css.chevron}
            icon="◈"
            title="Think"
            open={expanded}
            expandable
            expandOnRowClick
            onToggle={() => setExpanded((value) => !value)}
            collapsedContent={<><span className={css.separator} aria-hidden /><span className={css.summary}>{summary}</span></>}
        >
            <div className={css.thinkBody}>{text}</div>
        </DisclosureRow>
    </div>;
}
