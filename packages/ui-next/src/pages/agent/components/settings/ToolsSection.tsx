import { useEffect, useId, useMemo, useState } from 'react';
import { i18n } from '@/i18n';
import { IconChevronDownOutline14, IconSearchOutline16 } from '../../icons';
import type { SettingsRpc } from './cardForm';
import css from './PluginInventoryTab.module.css';

interface ToolEntry {
    name: string;
    description: string;
}

interface ToolInventorySnapshot {
    tools: readonly ToolEntry[];
}

export function ToolsSection({ rpc, sessionId, refreshKey }: { rpc: SettingsRpc; sessionId?: string; refreshKey?: string }) {
    const listId = useId();
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    const [tools, setTools] = useState<readonly ToolEntry[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [request, setRequest] = useState(0);

    useEffect(() => {
        let current = true;
        setTools(null);
        setError(null);
        setExpanded(null);
        const method = sessionId === undefined ? 'pluginInventory/list' : 'pluginInventory/sessionList';
        const payload = sessionId === undefined ? { args: {} } : { args: { agentId: sessionId } };
        void rpc<ToolInventorySnapshot>(method, payload).then((value) => {
            if (!current) return;
            if (!Array.isArray(value.tools)) throw new Error(i18n('Tool list response is missing its tools field.'));
            setTools(value.tools);
            setError(null);
        }).catch((caught: unknown) => {
            if (!current) return;
            setTools(null);
            setError(caught instanceof Error ? caught.message : String(caught));
        });
        return () => { current = false; };
    }, [refreshKey, request, rpc, sessionId]);

    const normalized = query.trim().toLocaleLowerCase();
    const filtered = useMemo(() => (tools ?? []).filter((tool) => normalized.length === 0 || `${tool.name} ${tool.description}`.toLocaleLowerCase().includes(normalized)), [normalized, tools]);

    return <div className={css.section} aria-busy={tools === null && error === null}>
        <h2 className={css.title}>{i18n('Tools')}</h2>
        <p className={css.intro}>{i18n('Tools registered by the current Agent host and available to the model.')}</p>
        {error ? <div className={css.failure}><p role="alert">{i18n('Unable to load tools list: {0}', error)}</p><button type="button" onClick={() => { setTools(null); setError(null); setRequest((value) => value + 1); }}>{i18n('Retry')}</button></div> : null}
        {tools === null && error === null ? <p className={css.status}>{i18n('Loading tools...')}</p> : null}
        {tools !== null ? <div className={css.catalog}>
            <label className={css.search}>
                <IconSearchOutline16 aria-hidden="true" />
                <span className={css.visuallyHidden}>{i18n('Search tools')}</span>
                <input type="search" value={query} placeholder={i18n('Search tools')} aria-label={i18n('Search tools')} onChange={(event) => { setQuery(event.currentTarget.value); }} />
            </label>
            <div className={css.catalogHeading}><h3>{i18n('Tool list')}</h3><span>{filtered.length}</span></div>
            {filtered.length === 0 ? <p className={css.status}>{tools.length === 0 ? i18n('No tools available.') : i18n('No tools match your search.')}</p> : <ul className={css.cards}>
                {filtered.map((tool) => {
                    const open = expanded === tool.name;
                    const detailId = `${listId}-${encodeURIComponent(tool.name)}`;
                    return <li className={css.card} key={tool.name} data-open={open ? 'true' : undefined}>
                        <button className={css.cardContent} type="button" aria-expanded={open} aria-controls={detailId} onClick={() => { setExpanded((current) => current === tool.name ? null : tool.name); }}>
                            <strong className={css.cardTitle} title={tool.name}>{tool.name}</strong>
                            <span className={css.cardTrailing}><span className={css.configTag}>{i18n('Tool')}</span><IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" /></span>
                        </button>
                        {open ? <div className={css.cardDetails} id={detailId}><p>{tool.description || i18n('No description available.')}</p></div> : null}
                    </li>;
                })}
            </ul>}
        </div> : null}
    </div>;
}
