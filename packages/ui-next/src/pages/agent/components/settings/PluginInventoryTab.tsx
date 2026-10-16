import { useEffect, useId, useMemo, useState } from 'react';
import { i18n } from '@/i18n';
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
    pending: 'Waiting for dependencies',
    loading: 'Loading',
    active: 'Mounted',
    failed: 'Mount failed',
    unloading: 'Uninstalling',
};

function phaseLabel(phase: PluginFiberPhase): string {
    return phase === null ? i18n('Not mounted') : i18n(PHASE_LABELS[phase]);
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
            {state.status === 'loading' ? <p className={css.status}>{i18n('Loading plugins...')}</p> : null}
            {state.status === 'error' ? (
                <div className={css.failure}>
                    <p role="alert">{i18n('Unable to load plugins right now.')}</p>
                    <button type="button" onClick={retry}>{i18n('Retry')}</button>
                </div>
            ) : null}
            {state.status === 'ready' ? (
                <div className={css.catalog}>
                    <label className={css.search}>
                        <IconSearchOutline16 aria-hidden="true" />
                        <span className={css.visuallyHidden}>{i18n('Search plugins')}</span>
                        <input
                            type="search"
                            value={query}
                            placeholder={i18n('Search plugins')}
                            aria-label={i18n('Search plugins')}
                            onChange={(event) => { setQuery(event.currentTarget.value); }}
                        />
                    </label>
                    <div className={css.catalogHeading}>
                        <h3>{i18n('Plugin list')}</h3>
                        <span data-plugin-count={filteredEntries.length}>{filteredEntries.length}</span>
                    </div>
                    {state.snapshot.entries.length === 0 ? <p className={css.status}>{i18n('No plugins available.')}</p> : null}
                    {state.snapshot.entries.length > 0 && filteredEntries.length === 0
                        ? <p className={css.status}>{i18n('No plugins match your search.')}</p>
                        : null}
                    {filteredEntries.length > 0 ? (
                        <ul className={css.cards}>
                            {filteredEntries.map((entry) => {
                                const status = phaseLabel(entry.fiberPhase);
                                const title = moduleShortName(entry.moduleName);
                                const configuration = entry.enabled ? i18n('Enabled') : i18n('Disabled');
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
                                                        <dt>{i18n('Configuration status')}</dt>
                                                        <dd>{configuration}</dd>
                                                    </div>
                                                    {entry.enabled ? (
                                                        <div>
                                                            <dt>{i18n('Cordis status')}</dt>
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
