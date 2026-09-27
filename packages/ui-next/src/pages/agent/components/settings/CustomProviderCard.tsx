import { useState } from 'react';
import { apiKeyFailure } from './apiKey';
import { EditorFooter } from './EditorFooter';
import { ModelListEditor } from './ModelListEditor';
import { validateDeepSeekModels, type ModelDraft } from './DeepSeekModelsEditor';
import type { LocaleKey } from './locales';
import { deriveKeyRef, type SettingsRpc } from './modelsStore';
import css from './ModelsSection.module.css';

const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface CustomProviderCardProps {
    rpc: SettingsRpc;
    taken: readonly string[];
    protocols: readonly string[];
    revision: number;
    readOnly: boolean;
    t: (key: LocaleKey) => string;
    onClose: (changed: boolean) => void;
}

export function CustomProviderCard({ rpc, taken, protocols, revision, readOnly, t, onClose }: CustomProviderCardProps) {
    const [route, setRoute] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [baseURL, setBaseURL] = useState('');
    const [protocol, setProtocol] = useState(protocols[0] ?? '');
    const [keyDraft, setKeyDraft] = useState('');
    const [models, setModels] = useState<readonly ModelDraft[]>([]);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route);
    const routeTaken = route.length > 0 && taken.includes(route);
    const keyFailure = apiKeyFailure(keyDraft);
    const modelFailure = validateDeepSeekModels(models);
    const ready = route.length > 0 && !routeInvalid && !routeTaken && baseURL.trim() !== '' && protocol !== '' && models.length > 0 && modelFailure === undefined && keyFailure === undefined && models.every((model) => typeof model.id === 'string' && model.id.trim() !== '');
    const disabled = readOnly || busy;
    const create = async () => {
        setBusy(true);
        setFailure(null);
        try {
            if (!ready) throw new Error(modelFailure ? t(modelFailure.key) : models.length === 0 ? t('requiredModel') : t('requiredBaseUrl'));
            const key = keyDraft.trim();
            await rpc('settings.mutate', {
                ns: 'llm-pi-ai',
                ops: [{ op: 'set', path: ['providers', route], value: {
                    ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                    ...(key ? { apiKeyEnv: deriveKeyRef(route) } : {}),
                    api: protocol,
                    baseURL: baseURL.trim(),
                    models: models.map((model) => ({ ...model })),
                } }],
                expectedRevision: revision,
            });
            if (key) await rpc('credentials.set', { ref: deriveKeyRef(route), value: key });
            onClose(true);
        } catch (error) {
            setFailure(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    };

    return <div className={css.editor}>
        <div className={css.editorHeader}><span className={css.editorTitle}>{t('customTitle')}</span></div>
        <div className={css.field}><span className={css.fieldLabel}>{t('route')}</span><input className={css.input} value={route} disabled={disabled} onChange={(event) => setRoute(event.target.value)} />{routeInvalid || routeTaken ? <p className={css.error}>{t(routeInvalid ? 'routeInvalid' : 'routeTaken')}</p> : <p className={css.advancedHint}>{t('routeHint')}</p>}</div>
        <div className={css.field}><span className={css.fieldLabel}>{t('displayName')}</span><input className={css.input} value={displayName} disabled={disabled} onChange={(event) => setDisplayName(event.target.value)} /></div>
        <div className={css.field}><span className={css.fieldLabel}>{t('baseUrl')}</span><input className={css.input} value={baseURL} placeholder="https://gateway.example/v1" disabled={disabled} onChange={(event) => setBaseURL(event.target.value)} /></div>
        <div className={css.field}><span className={css.fieldLabel}>{t('protocol')}</span><select className={`${css.input} ${css.selectInput}`} value={protocol} disabled={disabled} onChange={(event) => setProtocol(event.target.value)}>{protocols.map((choice) => <option key={choice} value={choice}>{choice}</option>)}</select></div>
        <div className={css.field}><span className={css.fieldLabel}>{t('apiKey')}</span><input className={css.input} type="password" autoComplete="off" value={keyDraft} disabled={disabled} onChange={(event) => setKeyDraft(event.target.value)} />{keyFailure && <p className={css.error}>{t('invalidKey')}</p>}</div>
        <ModelListEditor rpc={rpc} models={models} onChange={setModels} probe={{ settingsNs: 'llm-pi-ai', baseURL, api: protocol, ...(keyDraft.trim() ? { apiKey: keyDraft.trim() } : {}) }} disabled={disabled} t={t} />
        {failure && <p className={css.error}>{failure}</p>}
        <EditorFooter t={t} busy={busy} disabled={disabled || !ready || protocols.length === 0 || keyFailure !== undefined} submitLabel="create" busyLabel="creating" onCancel={() => onClose(false)} onSubmit={() => { void create(); }} />
    </div>;
}
