import { useEffect, useId, useMemo, useState } from 'react';
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
            if (!Array.isArray(value.tools)) throw new Error('工具列表响应缺少 tools 字段');
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
        <h2 className={css.title}>工具</h2>
        <p className={css.intro}>当前 Agent host 注册的模型可用工具。</p>
        {error ? <div className={css.failure}><p role="alert">无法加载工具列表：{error}</p><button type="button" onClick={() => { setTools(null); setError(null); setRequest((value) => value + 1); }}>重试</button></div> : null}
        {tools === null && error === null ? <p className={css.status}>正在读取工具…</p> : null}
        {tools !== null ? <div className={css.catalog}>
            <label className={css.search}>
                <IconSearchOutline16 aria-hidden="true" />
                <span className={css.visuallyHidden}>搜索工具</span>
                <input type="search" value={query} placeholder="搜索工具" aria-label="搜索工具" onChange={(event) => { setQuery(event.currentTarget.value); }} />
            </label>
            <div className={css.catalogHeading}><h3>工具列表</h3><span>{filtered.length}</span></div>
            {filtered.length === 0 ? <p className={css.status}>{tools.length === 0 ? '暂无工具。' : '没有匹配的工具。'}</p> : <ul className={css.cards}>
                {filtered.map((tool) => {
                    const open = expanded === tool.name;
                    const detailId = `${listId}-${encodeURIComponent(tool.name)}`;
                    return <li className={css.card} key={tool.name} data-open={open ? 'true' : undefined}>
                        <button className={css.cardContent} type="button" aria-expanded={open} aria-controls={detailId} onClick={() => { setExpanded((current) => current === tool.name ? null : tool.name); }}>
                            <strong className={css.cardTitle} title={tool.name}>{tool.name}</strong>
                            <span className={css.cardTrailing}><span className={css.configTag}>工具</span><IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" /></span>
                        </button>
                        {open ? <div className={css.cardDetails} id={detailId}><p>{tool.description || '暂无描述。'}</p></div> : null}
                    </li>;
                })}
            </ul>}
        </div> : null}
    </div>;
}
