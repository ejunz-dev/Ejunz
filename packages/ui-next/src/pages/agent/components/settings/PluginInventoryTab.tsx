import { useEffect, useId, useMemo, useState } from 'react';
import { IconChevronDownOutline14, IconSearchOutline16 } from '../../icons';
import type { SettingsRpc } from './cardForm';
import css from './PluginInventoryTab.module.css';

type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null;

interface PluginInventoryEntry {
    entryId: string;
    moduleName: string;
    enabled: boolean;
    fiberPhase: PluginFiberPhase;
}

interface PluginInventorySnapshot {
    entries: readonly PluginInventoryEntry[];
}

type ViewState =
    | { readonly status: 'loading' }
    | { readonly status: 'error' }
    | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot };

const PHASE_LABELS: Record<Exclude<PluginFiberPhase, null>, string> = {
    pending: '等待依赖',
    loading: '加载中',
    active: '已挂载',
    failed: '挂载失败',
    unloading: '卸载中',
};

function phaseLabel(phase: PluginFiberPhase): string {
    return phase === null ? '未挂载' : PHASE_LABELS[phase];
}

function moduleShortName(moduleName: string): string {
    const unscoped = moduleName.startsWith('@') ? moduleName.slice(moduleName.indexOf('/') + 1) : moduleName;
    return unscoped.replace(/^cordis:/, '').replace(/^cordis-plugin-/, '').replace(/^(?:host-|client-)/, '');
}

function matches(entry: PluginInventoryEntry, normalizedQuery: string): boolean {
    if (normalizedQuery.length === 0) return true;
    return [entry.moduleName, entry.entryId].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

export function PluginInventoryTab({ rpc }: { rpc: SettingsRpc }) {
    const catalogId = useId();
    const [request, setRequest] = useState(0);
    const [query, setQuery] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    const [state, setState] = useState<ViewState>({ status: 'loading' });

    useEffect(() => {
        let current = true;
        void Promise.resolve()
            .then(() => rpc<PluginInventorySnapshot>('pluginInventory/list', { args: {} }))
            .then(
                (snapshot) => { if (current) setState({ status: 'ready', snapshot }); },
                () => { if (current) setState({ status: 'error' }); },
            );
        return () => { current = false; };
    }, [rpc, request]);

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filteredEntries = useMemo(
        () => state.status === 'ready'
            ? state.snapshot.entries.filter((entry) => matches(entry, normalizedQuery))
            : [],
        [normalizedQuery, state],
    );

    useEffect(() => {
        if (expanded !== null && !filteredEntries.some((entry) => entry.entryId === expanded)) {
            setExpanded(null);
        }
    }, [expanded, filteredEntries]);

    const retry = (): void => {
        setState({ status: 'loading' });
        setRequest((value) => value + 1);
    };

    return (
        <div className={css.section} aria-busy={state.status === 'loading'}>
            {state.status === 'loading' ? <p className={css.status}>正在读取插件…</p> : null}
            {state.status === 'error' ? (
                <div className={css.failure}>
                    <p role="alert">暂时无法读取插件。</p>
                    <button type="button" onClick={retry}>重试</button>
                </div>
            ) : null}
            {state.status === 'ready' ? (
                <div className={css.catalog}>
                    <label className={css.search}>
                        <IconSearchOutline16 aria-hidden="true" />
                        <span className={css.visuallyHidden}>搜索插件</span>
                        <input
                            type="search"
                            value={query}
                            placeholder="搜索插件"
                            aria-label="搜索插件"
                            onChange={(event) => { setQuery(event.currentTarget.value); }}
                        />
                    </label>
                    <div className={css.catalogHeading}>
                        <h3>插件列表</h3>
                        <span data-plugin-count={filteredEntries.length}>{filteredEntries.length}</span>
                    </div>
                    {state.snapshot.entries.length === 0 ? <p className={css.status}>暂无插件。</p> : null}
                    {state.snapshot.entries.length > 0 && filteredEntries.length === 0
                        ? <p className={css.status}>没有匹配的插件。</p>
                        : null}
                    {filteredEntries.length > 0 ? (
                        <ul className={css.cards}>
                            {filteredEntries.map((entry) => {
                                const status = phaseLabel(entry.fiberPhase);
                                const title = moduleShortName(entry.moduleName);
                                const configuration = entry.enabled ? '已启用' : '已停用';
                                const open = expanded === entry.entryId;
                                const detailId = `${catalogId}-details-${encodeURIComponent(entry.entryId)}`;
                                return (
                                    <li
                                        className={css.card}
                                        key={entry.entryId}
                                        data-plugin-entry={entry.entryId}
                                        data-open={open ? 'true' : undefined}
                                    >
                                        <button
                                            className={css.cardContent}
                                            type="button"
                                            aria-expanded={open}
                                            aria-controls={detailId}
                                            aria-label={entry.enabled ? `${title}, ${status}, ${configuration}` : `${title}, ${configuration}`}
                                            onClick={() => {
                                                setExpanded((current) => current === entry.entryId ? null : entry.entryId);
                                            }}
                                        >
                                            <strong className={css.cardTitle} title={entry.moduleName}>{title}</strong>
                                            <span className={css.cardTrailing}>
                                                {entry.enabled ? (
                                                    <span
                                                        className={css.statusDot}
                                                        data-phase={entry.fiberPhase ?? 'unobserved'}
                                                        role="img"
                                                        aria-label={status}
                                                        title={status}
                                                    />
                                                ) : null}
                                                <span className={css.configTag} data-enabled={entry.enabled ? 'true' : 'false'}>
                                                    {configuration}
                                                </span>
                                                <IconChevronDownOutline14 className={css.chevron} size={12} aria-hidden="true" />
                                            </span>
                                        </button>
                                        {open ? (
                                            <div className={css.cardDetails} id={detailId}>
                                                <code className={css.entryValue} data-loader-entry>{entry.entryId}</code>
                                                <dl className={css.details}>
                                                    <div>
                                                        <dt>配置状态</dt>
                                                        <dd>{configuration}</dd>
                                                    </div>
                                                    {entry.enabled ? (
                                                        <div>
                                                            <dt>Cordis 状态</dt>
                                                            <dd>{status}</dd>
                                                        </div>
                                                    ) : null}
                                                </dl>
                                            </div>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
