import { useState } from 'react';
import { i18n } from '@/i18n';
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
        collapsedContent={<><span className={css.separator} aria-hidden /><span className={css.count}>{enabled ? i18n('{0} tools', tools.length) : i18n('Uninstalled')}</span></>}
    >
        <div className={css.body}>
            {description && <p className={css.description}>{description}</p>}
            {!enabled ? <p className={css.empty}>{i18n('This add-on has been uninstalled from the current session.')}</p> : tools.length > 0 ? <ul className={css.tools}>
                {tools.map((tool) => <li className={css.tool} key={tool.name}>
                    <code className={css.name}>{tool.name}</code>
                    <p className={css.toolDescription}>{tool.description}</p>
                </li>)}
            </ul> : <p className={css.empty}>{i18n('This add-on has no tools available.')}</p>}
        </div>
    </DisclosureRow>;
}
