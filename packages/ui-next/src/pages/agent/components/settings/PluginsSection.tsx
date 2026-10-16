import { useId, useRef, useState } from 'react';
import { i18n } from '@/i18n';
import { AgentLoopCard, BashCard, WebSearchCard } from './PluginCards';
import { PluginInventoryTab } from './PluginInventoryTab';
import type { SettingsRpc } from './cardForm';
import css from './PluginsSection.module.css';

interface TabEntry {
    id: string;
    label: string;
}

const TABS: TabEntry[] = [
    { id: 'configurable', label: 'Plugin configuration' },
    { id: 'inventory', label: 'Plugin list' },
];

export interface PluginsSectionProps {
    rpc: SettingsRpc;
}

export function PluginsSection({ rpc }: PluginsSectionProps) {
    const tabsId = useId();
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [activeId, setActiveId] = useState<string>(TABS[0].id);
    const active = TABS.find((tab) => tab.id === activeId)?.id ?? TABS[0].id;

    return (
        <div className={css.section}>
            <h2 className={css.heading}>{i18n('Plugins')}</h2>
            <p className={css.intro}>{i18n('Configure and inspect the plugins installed in this deployment.')}</p>
            <div className={css.tabs} role="tablist" aria-label={i18n('Plugin views')}>
                {TABS.map((tab, index) => {
                    const selected = tab.id === active;
                    return (
                        <button
                            key={tab.id}
                            ref={(element) => { tabRefs.current[index] = element; }}
                            id={`${tabsId}-tab-${tab.id}`}
                            type="button"
                            role="tab"
                            className={css.tab}
                            aria-selected={selected}
                            aria-controls={`${tabsId}-panel-${tab.id}`}
                            data-active={selected ? 'true' : undefined}
                            tabIndex={selected ? 0 : -1}
                            onClick={() => { setActiveId(tab.id); }}
                            onKeyDown={(event) => {
                                let nextIndex: number;
                                switch (event.key) {
                                    case 'ArrowRight': nextIndex = (index + 1) % TABS.length; break;
                                    case 'ArrowLeft': nextIndex = (index - 1 + TABS.length) % TABS.length; break;
                                    case 'Home': nextIndex = 0; break;
                                    case 'End': nextIndex = TABS.length - 1; break;
                                    default: return;
                                }
                                event.preventDefault();
                                const nextTab = TABS[nextIndex];
                                setActiveId(nextTab.id);
                                tabRefs.current[nextIndex]?.focus();
                            }}
                        >
                            {i18n(tab.label)}
                        </button>
                    );
                })}
            </div>
            <div id={`${tabsId}-panel-configurable`} className={css.panel} role="tabpanel" aria-labelledby={`${tabsId}-tab-configurable`} hidden={active !== 'configurable'}>
                <ul className={css.cards}>
                    <BashCard rpc={rpc} />
                    <AgentLoopCard rpc={rpc} />
                    <WebSearchCard rpc={rpc} />
                </ul>
            </div>
            <div id={`${tabsId}-panel-inventory`} className={css.panel} role="tabpanel" aria-labelledby={`${tabsId}-tab-inventory`} hidden={active !== 'inventory'}>
                <PluginInventoryTab rpc={rpc} />
            </div>
        </div>
    );
}
