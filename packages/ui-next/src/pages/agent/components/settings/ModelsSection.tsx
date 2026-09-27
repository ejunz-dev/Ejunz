import { useMemo, useState } from 'react';
import { CustomProviderCard } from './CustomProviderCard';
import { ProviderEditor } from './ProviderEditor';
import { zh } from './locales';
import type { LocaleKey } from './locales';
import { protocolChoices, useModelsStore, type ProviderRow, type SettingsRpc } from './modelsStore';
import css from './ModelsSection.module.css';

export interface ModelsSectionProps {
    rpc: SettingsRpc;
}

function providerLabel(row: ProviderRow): string {
    return row.entry.provider === row.entry.displayName ? row.entry.provider : `${row.entry.displayName} (${row.entry.provider})`;
}

export function ModelsSection({ rpc }: ModelsSectionProps) {
    const { state, load } = useModelsStore(rpc);
    const [editing, setEditing] = useState<string | null>(null);
    const [adding, setAdding] = useState<string | null>(null);
    const [custom, setCustom] = useState(false);
    const [deleting, setDeleting] = useState<ProviderRow | null>(null);
    const [deleteBusy, setDeleteBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const localize = (key: LocaleKey) => zh[key];
    const addable = state.rows.filter((row) => !row.configured && row.entry.settingsNs !== '' && state.namespaces.has(row.entry.settingsNs));
    const piNamespace = state.namespaces.get('llm-pi-ai');
    const protocols = piNamespace ? protocolChoices(piNamespace) : [];
    const customProtocols = protocols.length > 0 ? protocols : ['openai-completions', 'openai-responses', 'anthropic-messages'];
    const addingRow = adding === null ? undefined : addable.find((row) => row.entry.provider === adding);
    const editingRow = editing === null ? undefined : state.rows.find((row) => row.entry.provider === editing);
    const shownRows = useMemo(() => state.rows.filter((row) => row.configured), [state.rows]);

    const closeEditor = (changed: boolean) => {
        setEditing(null);
        setAdding(null);
        setCustom(false);
        if (changed) void load();
    };
    const confirmDelete = async () => {
        if (!deleting) return;
        setDeleteBusy(true);
        setFailure(null);
        try {
            if (deleting.apiKeyEnv && deleting.credential?.writable) await rpc('credentials.unset', { ref: deleting.apiKeyEnv });
            if (deleting.entry.settingsPath.length > 0) {
                await rpc('settings.mutate', { ns: deleting.entry.settingsNs, ops: [{ op: 'unset', path: [...deleting.entry.settingsPath] }] });
            } else {
                const namespace = state.namespaces.get(deleting.entry.settingsNs);
                await rpc('settings.replace', { ns: deleting.entry.settingsNs, section: {}, expectedRevision: namespace?.revision });
            }
            setDeleting(null);
            await load();
        } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error));
        } finally {
            setDeleteBusy(false);
        }
    };

    if (state.status === 'error') return <div className={css.section}><p className={css.error}>{localize('loadFailed')}: {state.error}</p><button type="button" className={css.secondaryButton} onClick={() => { void load(); }}>{localize('retry')}</button></div>;
    if (state.status !== 'ready') return <div className={css.section}><h2 className={css.title}>{localize('title')}</h2><p className={css.intro}>{localize('intro')}</p><p className={css.advancedHint}>加载中…</p></div>;

    return <div className={css.section}>
        <h2 className={css.title}>{localize('title')}</h2>
        <p className={css.intro}>{localize('intro')}</p>
        {!state.writable && <p className={css.notice}>{localize('readOnly')}</p>}
        {failure && <p className={css.error}>{failure}</p>}
        <ul className={css.rows}>
            {shownRows.map((row) => {
                const namespace = state.namespaces.get(row.entry.settingsNs);
                if (!namespace) return null;
                const open = editing === row.entry.provider;
                const missing = row.apiKeyEnv !== undefined && row.credential?.configured === false;
                return <li key={row.entry.provider} className={css.rowCard}>
                    <div className={css.rowHead}><span className={css.rowIdentity}><span className={css.rowName}>{row.entry.displayName}</span>{row.entry.declared && <span className={css.rowTag}>自定义</span>}{row.credential?.configured && <span className={`${css.credentialDot} ${css.credentialDotConfigured}`} title={localize('apiKey')} />}{missing && <span className={`${css.credentialDot} ${css.credentialDotMissing}`} title={localize('apiKeyMissing')} />}</span><span className={css.rowActions}><button type="button" className={css.secondaryButton} onClick={() => { setAdding(null); setCustom(false); setEditing(open ? null : row.entry.provider); }}>{localize('edit')}</button>{row.removable && <button type="button" className={css.dangerButton} disabled={!state.writable} onClick={() => setDeleting(row)}>{localize('remove')}</button>}</span></div>
                    {open && <ProviderEditor rpc={rpc} provider={row.entry.provider} displayName={row.entry.displayName} namespace={namespace} settingsPath={row.entry.settingsPath} declared={row.entry.declared} readOnly={!state.writable} t={localize} onClose={closeEditor} />}
                </li>;
            })}
        </ul>
        {addingRow && state.namespaces.get(addingRow.entry.settingsNs) && <div className={css.addCard}><div className={css.field}><span className={css.fieldLabel}>{localize('provider')}</span><select className={`${css.input} ${css.selectInput}`} value={addingRow.entry.provider} onChange={(event) => setAdding(event.target.value)}>{addable.map((row) => <option key={row.entry.provider} value={row.entry.provider}>{row.entry.displayName}</option>)}</select></div><ProviderEditor rpc={rpc} provider={addingRow.entry.provider} displayName={addingRow.entry.displayName} namespace={state.namespaces.get(addingRow.entry.settingsNs)!} settingsPath={addingRow.entry.settingsPath} declared={addingRow.entry.declared} hideTitle readOnly={!state.writable} t={localize} onClose={closeEditor} /></div>}
        {custom && <div className={css.addCard}><CustomProviderCard rpc={rpc} taken={state.rows.map((row) => row.entry.provider)} protocols={customProtocols} revision={piNamespace?.revision ?? 0} readOnly={!state.writable} t={localize} onClose={closeEditor} /></div>}
        {!addingRow && !custom && <div className={css.addActions}><button type="button" className={css.addButton} disabled={!state.writable || addable.length === 0} onClick={() => { setEditing(null); setCustom(false); setAdding(addable[0].entry.provider); }}>{localize('add')}</button><button type="button" className={css.addButton} disabled={!state.writable || !piNamespace} onClick={() => { setEditing(null); setAdding(null); setCustom(true); }}>{localize('customAdd')}</button></div>}
        {deleting && <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => { if (!deleteBusy) setDeleting(null); }} /><div className={css.confirmation} role="dialog" aria-modal="true"><div className={css.confirmTitle}>{localize('deleteTitle')}</div><p className={css.advancedHint}>{localize('deleteDescription')} {providerLabel(deleting)}</p><div className={css.footer}><button type="button" className={`${css.action} ${css.actionOutline}`} disabled={deleteBusy} onClick={() => setDeleting(null)}>{localize('cancel')}</button><button type="button" className={`${css.action} ${css.actionPrimary}`} disabled={deleteBusy} onClick={() => { void confirmDelete(); }}>{deleteBusy ? localize('deleting') : localize('confirmDelete')}</button></div></div></div>}
    </div>;
}
