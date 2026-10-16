import { useState, type ReactNode } from 'react';
import { i18n } from '@/i18n';
import { IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconGlobeOutline14, IconSearchOutline16 } from '../../../icons';
import type { AgentAddonView, ChatMessage } from '../../types';
import { DisclosureRow } from '../../primitives/DisclosureRow';
import { StateDot } from '../../primitives/StateDot';
import { toolRowModel } from '../../tool/tool-call-model';
import { ToolViewCard } from '../../tool/toolviews/ToolViewCard';
import css from './ToolRow.module.css';

function leadingFor(state: 'running' | 'ok' | 'error', icon: ReactNode): ReactNode {
    return state === 'error' ? <StateDot state="error" /> : icon;
}

export function ToolRow({ message, addons, onOpenFile, onOpenDetails }: { message: ChatMessage; addons: readonly AgentAddonView[]; onOpenFile?: (path: string) => void; onOpenDetails?: (message: ChatMessage) => void }) {
    const [expanded, setExpanded] = useState(false);
    const name = message.toolName ?? 'tool';
    const model = toolRowModel(message);
    const addon = addons.find((item) => item.toolPrefixes?.some((prefix) => prefix.length > 0 && name.startsWith(prefix)));
    const title = addon ? `${model.title} · ${addon.displayName} · ${name}` : model.title;
    const summary = addon && model.summary.startsWith(`${name} · `)
        ? model.summary.slice(name.length + 3)
        : model.summary;
    const icon = model.variant === 'bash'
        ? <IconApiOutline14 size={14} />
        : model.variant === 'read'
            ? <IconBrowseOutline16 size={14} />
            : model.variant === 'search'
                ? <IconSearchOutline16 size={14} />
                : model.variant === 'web'
                    ? <>{name === 'web_fetch' ? <IconBrowseOutline16 size={14} /> : <IconGlobeOutline14 size={14} />}</>
                    : model.variant === 'write' || model.variant === 'edit'
                        ? <IconEditOutline16 size={14} />
                        : model.variant === 'code' ? <IconCodeOutline16 size={14} /> : '◈';
    const expandable = Boolean(model.input || model.output);
    return <div className={css.root} data-variant={model.variant} data-state={model.state}>
        {model.state !== 'ok' && <span className={css.visuallyHidden}>{model.state === 'error' ? i18n('Failure') : i18n('Running')}</span>}
        <DisclosureRow
            rowClassName={css.row}
            leadingClassName={css.leading}
            titleClassName={css.title}
            chevronClassName={css.chevron}
            icon={leadingFor(model.state, icon)}
            title={title}
            open={expanded}
            expandable={expandable}
            expandOnRowClick
            onToggle={() => setExpanded((value) => !value)}
            collapsedContent={<><span className={css.sep} aria-hidden />{model.filePath && onOpenFile && model.errorSummary === undefined ? <button type="button" className={css.fileLink} onClick={(event) => { event.stopPropagation(); onOpenFile(model.filePath!); }}>{summary}</button> : <span className={`${css.summary}${model.errorSummary !== undefined ? ` ${css.errorSummary}` : ''}`}>{summary}</span>}</>}
        >
            <div className={css.bodyWrap}><ToolViewCard variant={model.variant} input={model.input} output={model.output} meta={model.meta} error={model.state === 'error'} /><button type="button" className={css.inspectButton} onClick={(event) => { event.stopPropagation(); onOpenDetails?.(message); }}>{i18n('View details')}</button>{message.children?.length ? <div className="eza-toolChildren">{message.children.map((child) => <ToolRow key={child.key} message={child} addons={addons} onOpenFile={onOpenFile} onOpenDetails={onOpenDetails} />)}</div> : null}</div>
        </DisclosureRow>
    </div>;
}
