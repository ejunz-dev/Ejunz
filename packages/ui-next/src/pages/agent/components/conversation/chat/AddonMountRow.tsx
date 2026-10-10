import { useState } from 'react';
import { DisclosureRow } from '../../primitives/DisclosureRow';
import css from './AddonMountRow.module.css';

interface AddonTool {
    name: string;
    description: string;
}

interface AddonMountRowProps {
    label: string;
    description: string;
    enabled: boolean;
    tools: readonly AddonTool[];
}

export function AddonMountRow({ label, description, enabled, tools }: AddonMountRowProps) {
    const [open, setOpen] = useState(false);
    return <DisclosureRow
        className={css.root}
        rowClassName={css.row}
        chevronClassName={css.chevron}
        icon="◌"
        title={label}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        collapsedContent={<><span className={css.separator} aria-hidden /><span className={css.count}>{enabled ? `${tools.length} 个工具` : '已卸载'}</span></>}
    >
        <div className={css.body}>
            {description && <p className={css.description}>{description}</p>}
            {!enabled ? <p className={css.empty}>该 Addon 已从当前会话卸载。</p> : tools.length > 0 ? <ul className={css.tools}>
                {tools.map((tool) => <li className={css.tool} key={tool.name}>
                    <code className={css.name}>{tool.name}</code>
                    <p className={css.toolDescription}>{tool.description}</p>
                </li>)}
            </ul> : <p className={css.empty}>该 Addon 当前没有可用工具。</p>}
        </div>
    </DisclosureRow>;
}
