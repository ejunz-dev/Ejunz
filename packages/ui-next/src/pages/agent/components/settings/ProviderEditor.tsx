import { useEffect, useMemo, useState } from 'react';
import { apiKeyFailure } from './apiKey';
import { DeepSeekModelsEditor, modelDrafts, validateDeepSeekModels, type ModelDraft } from './DeepSeekModelsEditor';
import { EditorFooter } from './EditorFooter';
import { ModelListEditor } from './ModelListEditor';
import type { LocaleKey } from './locales';
import { deriveKeyRef, getPath, protocolChoices, type CredentialView, type SettingsNamespaceView, type SettingsRpc } from './modelsStore';
import css from './ModelsSection.module.css';

export interface ProviderEditorProps {
    rpc: SettingsRpc;
    provider: string;
    displayName: string;
    namespace: SettingsNamespaceView;
    settingsPath: readonly string[];
    readOnly: boolean;
    declared?: boolean;
    hideTitle?: boolean;
    onClose: (changed: boolean) => void;
    t: (key: LocaleKey) => string;
}

function objectAt(value: unknown, path: readonly string[]): Record<string, unknown> {
    const found = getPath(value, path);
    return found && typeof found === 'object' && !Array.isArray(found) ? { ...(found as Record<string, unknown>) } : {};
}

function pathOps(base: readonly string[], before: unknown, after: Record<string, unknown>) {
    const previous = before && typeof before === 'object' && !Array.isArray(before) ? before as Record<string, unknown> : {};
    const ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[] = [];
    Object.entries(after).forEach(([key, value]) => {
        if (JSON.stringify(previous[key]) !== JSON.stringify(value)) ops.push({ op: 'set', path: [...base, key], value });
    });
    Object.keys(previous).forEach((key) => {
        if (!(key in after)) ops.push({ op: 'unset', path: [...base, key] });
    });
    return ops;
}

function stringAt(value: unknown, key: string): string | undefined {
    const found = getPath(value, [key]);
    return typeof found === 'string' && found.trim() ? found : undefined;
}

export function ProviderEditor({ rpc, provider, displayName, namespace, settingsPath, readOnly, declared = false, hideTitle = false, onClose, t }: ProviderEditorProps) {
    const initial = useMemo(() => objectAt(namespace.user, settingsPath), [namespace.user, settingsPath]);
    const effective = useMemo(() => objectAt(namespace.value, settingsPath), [namespace.value, settingsPath]);
    const original = useMemo(() => getPath(namespace.user, settingsPath), [namespace.user, settingsPath]);
    const [draft, setDraft] = useState<Record<string, unknown>>(initial);
    const [keyDraft, setKeyDraft] = useState('');
    const [credential, setCredential] = useState<CredentialView | undefined>();
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const layout = namespace.ns === 'llm-deepseek' ? 'deepseek' : namespace.ns === 'llm-pi-ai' ? 'pi-ai' : 'unknown';
    const keyRef = stringAt(initial, 'apiKeyEnv') ?? stringAt(effective, 'apiKeyEnv') ?? deriveKeyRef(provider);
    const keyFailure = apiKeyFailure(keyDraft);
    const modelsOverridden = getPath(draft, ['models']) !== undefined;
    const inheritedModels = modelDrafts(getPath(namespace.base, [...settingsPath, 'models']) ?? getPath(namespace.value, [...settingsPath, 'models']));
    const models = modelDrafts(modelsOverridden ? getPath(draft, ['models']) : inheritedModels);
    const detectedProtocols = layout === 'pi-ai' ? protocolChoices(namespace) : [];
    const protocols = detectedProtocols.length > 0 ? detectedProtocols : ['openai-completions', 'openai-responses', 'anthropic-messages'];

    useEffect(() => {
        let disposed = false;
        void rpc<{ credentials?: Record<string, CredentialView> }>('credentials.describe', { refs: [keyRef] }).then((value) => {
            if (!disposed) setCredential(value.credentials?.[keyRef]);
        }).catch(() => undefined);
        return () => { disposed = true; };
    }, [keyRef, rpc]);

    const setField = (key: string, value: unknown) => {
        setDraft((current) => {
            const next = { ...current };
            if (value === undefined || value === '') delete next[key];
            else next[key] = value;
            return next;
        });
    };
    const save = async () => {
        setBusy(true);
        setFailure(null);
        try {
            if (keyFailure) throw new Error(t('invalidKey'));
            const next = { ...draft };
            if (keyDraft.trim() && stringAt(next, 'apiKeyEnv') === undefined) next.apiKeyEnv = keyRef;
            const validation = validateDeepSeekModels(getPath(next, ['models']));
            if (validation) throw new Error(t(validation.key));
            const ops = pathOps(settingsPath, original, next);
            if (ops.length) await rpc('settings.mutate', { ns: namespace.ns, ops, expectedRevision: namespace.revision });
            if (keyDraft.trim()) await rpc('credentials.set', { ref: keyRef, value: keyDraft.trim() });
            onClose(true);
        } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };
    const disabled = readOnly || busy;
    const baseURL = stringAt(draft, 'baseURL') ?? stringAt(effective, 'baseURL');
    const api = stringAt(draft, 'api') ?? stringAt(effective, 'api');
    const updateModels = (next: ModelDraft[]) => setField('models', next);

    return <div className={hideTitle ? css.addBlock : css.editor}>
        {!hideTitle && <div className={css.editorHeader}><span className={css.editorTitle}>{displayName}</span>{provider !== displayName && <span className={css.editorRoute}>{provider}</span>}</div>}
        {layout === 'unknown' ? <p className={css.advancedHint}>{namespace.ns}</p> : <>
            <div className={css.field}><span className={css.fieldLabel}>{t('apiKey')}</span><input className={css.input} type="password" autoComplete="off" value={keyDraft} placeholder={credential?.configured ? t('apiKeyStored') : t('apiKey')} disabled={disabled || credential?.writable === false} onChange={(event) => setKeyDraft(event.target.value)} />{keyFailure && <p className={css.error}>{t(keyFailure === 'keyBlank' ? 'requiredKey' : 'invalidKey')}</p>}</div>
            <details className={css.customized}><summary className={css.customizedSummary}>{t('advanced')}</summary><div className={css.customizedBody}>
                {declared && <div className={css.field}><span className={css.fieldLabel}>{t('displayName')}</span><input className={css.input} value={stringAt(draft, 'displayName') ?? ''} disabled={disabled} onChange={(event) => setField('displayName', event.target.value)} /></div>}
                <div className={css.field}><span className={css.fieldLabel}>{t('baseUrl')}</span><input className={css.input} value={stringAt(draft, 'baseURL') ?? ''} placeholder={layout === 'deepseek' ? 'https://api.deepseek.com' : ''} disabled={disabled} onChange={(event) => setField('baseURL', event.target.value)} /></div>
                {declared && <div className={css.field}><span className={css.fieldLabel}>{t('protocol')}</span><select className={`${css.input} ${css.selectInput}`} value={api ?? ''} disabled={disabled} onChange={(event) => setField('api', event.target.value)}>{!api && <option value="">{t('protocol')}</option>}{protocols.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></div>}
                {layout === 'deepseek' ? <DeepSeekModelsEditor models={models} overridden={modelsOverridden} defaultContextWindow={typeof getPath(effective, ['defaultContextWindow']) === 'number' ? getPath(effective, ['defaultContextWindow']) as number : undefined} defaultMaxTokens={typeof getPath(effective, ['maxTokens']) === 'number' ? getPath(effective, ['maxTokens']) as number : undefined} t={t} disabled={disabled} onChange={updateModels} onReset={() => setField('models', undefined)} /> : <ModelListEditor rpc={rpc} models={models} overridden={modelsOverridden} onChange={updateModels} onReset={() => setField('models', undefined)} probe={{ settingsNs: namespace.ns, provider, baseURL, api, ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}) }} disabled={disabled} t={t} />}
            </div></details>
        </>}
        {failure && <p className={css.error}>{failure}</p>}
        <EditorFooter t={t} busy={busy} disabled={disabled || keyFailure !== undefined || (layout === 'unknown')} onCancel={() => onClose(false)} onSubmit={() => { void save(); }} />
    </div>;
}
