import { useState } from 'react';
import { ContextBody } from './ContextBody';
import { DisclosureRow } from '../../primitives/DisclosureRow';
import css from './ContextInjectionRow.module.css';

interface ContextInjectionRowProps {
    label: string;
    source?: string;
    summary?: string;
    text: string;
    contextSource?: unknown;
    contextForm?: string;
}

export function ContextInjectionRow({ label, source, summary, text, contextSource, contextForm }: ContextInjectionRowProps) {
    const [open, setOpen] = useState(false);
    return <DisclosureRow
        className={css.root}
        rowClassName={css.root}
        chevronClassName={css.chevron}
        icon="◌"
        title={label}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={<>{source && <><span className={css.sep} aria-hidden /><span className={css.source}>{source}</span></>}{summary && <><span className={css.sep} aria-hidden /><span className={css.summary}>{summary}</span></>}</>}
    >
        <div className={css.body}><ContextBody text={text} source={contextSource} form={contextForm} /></div>
    </DisclosureRow>;
}
