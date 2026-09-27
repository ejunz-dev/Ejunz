import { useState, type ReactNode } from 'react';
import { IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16, IconGlobeOutline14, IconSearchOutline16 } from '../../../icons';
import type { ChatMessage } from '../../types';
import { DisclosureRow } from '../../primitives/DisclosureRow';
import { StateDot } from '../../primitives/StateDot';
import { toolRowModel } from '../../tool/tool-call-model';
import { ToolViewCard } from '../../tool/toolviews/ToolViewCard';
import css from './ToolRow.module.css';

function leadingFor(state: 'running' | 'ok' | 'error', icon: ReactNode): ReactNode {
    return state === 'error' ? <StateDot state="error" /> : icon;
}

export function ToolRow({ message, onOpenFile, onOpenDetails }: { message: ChatMessage; onOpenFile?: (path: string) => void; onOpenDetails?: (message: ChatMessage) => void }) {
    const [expanded, setExpanded] = useState(false);
    const name = message.toolName ?? 'tool';
    const model = toolRowModel(message);
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
        {model.state !== 'ok' && <span className={css.visuallyHidden}>{model.state === 'error' ? '失败' : '运行中'}</span>}
        <DisclosureRow
            rowClassName={css.row}
            leadingClassName={css.leading}
            titleClassName={css.title}
            chevronClassName={css.chevron}
            icon={leadingFor(model.state, icon)}
            title={model.title}
            open={expanded}
            expandable={expandable}
            expandOnRowClick
            onToggle={() => setExpanded((value) => !value)}
            collapsedContent={<><span className={css.sep} aria-hidden />{model.filePath && onOpenFile && model.errorSummary === undefined ? <button type="button" className={css.fileLink} onClick={(event) => { event.stopPropagation(); onOpenFile(model.filePath!); }}>{model.summary}</button> : <span className={`${css.summary}${model.errorSummary !== undefined ? ` ${css.errorSummary}` : ''}`}>{model.summary}</span>}</>}
        >
            <div className={css.bodyWrap}><ToolViewCard variant={model.variant} input={model.input} output={model.output} meta={model.meta} error={model.state === 'error'} /><button type="button" className={css.inspectButton} onClick={(event) => { event.stopPropagation(); onOpenDetails?.(message); }}>查看详情</button>{message.children?.length ? <div className="eja-toolChildren">{message.children.map((child) => <ToolRow key={child.key} message={child} onOpenFile={onOpenFile} onOpenDetails={onOpenDetails} />)}</div> : null}</div>
        </DisclosureRow>
    </div>;
}
