import { useEffect, useState } from 'react';
import { deriveKeyRef, type SettingsNamespaceView } from './modelsStore';
import css from './Onboarding.module.css';

export interface DeepSeekOnboardingProps {
    rpc: <T>(method: string, payload: unknown) => Promise<T>;
}

type ProviderEntry = {
    provider: string;
    settingsNs: string;
    settingsPath: string[];
    active: boolean;
};

type CredentialView = {
    configured: boolean;
    writable: boolean;
};

type ProviderState = {
    entry: ProviderEntry;
    namespace: SettingsNamespaceView;
    keyRef: string;
    credential: CredentialView;
};

function atPath(value: unknown, path: readonly string[]): unknown {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object' || !(key in (current as Record<string, unknown>))) return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

function keyRefOf(namespace: SettingsNamespaceView, entry: ProviderEntry): string {
    const profile = atPath(namespace.value, entry.settingsPath);
    if (profile && typeof profile === 'object' && typeof (profile as Record<string, unknown>).apiKeyEnv === 'string') {
        const value = (profile as Record<string, unknown>).apiKeyEnv as string;
        if (value.trim()) return value;
    }
    return deriveKeyRef(entry.provider);
}

function usable(entry: ProviderEntry, namespace: SettingsNamespaceView | undefined, credentials: Record<string, CredentialView>): boolean {
    if (!entry.active) return false;
    const profile = namespace ? atPath(namespace.value, entry.settingsPath) : undefined;
    const keyRef = profile && typeof profile === 'object' && typeof (profile as Record<string, unknown>).apiKeyEnv === 'string'
        ? (profile as Record<string, unknown>).apiKeyEnv as string
        : undefined;
    return keyRef === undefined || credentials[keyRef]?.configured === true;
}

export function DeepSeekOnboarding({ rpc }: DeepSeekOnboardingProps) {
    const [target, setTarget] = useState<ProviderState | null>(null);
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let disposed = false;
        void (async () => {
            try {
                const [providersValue, settingsValue] = await Promise.all([
                    rpc('llm.providers', {}) as Promise<{ providers?: ProviderEntry[] }>,
                    rpc('settings.describe', {}) as Promise<{ writable?: boolean; namespaces?: SettingsNamespaceView[] }>,
                ]);
                const providers = providersValue.providers ?? [];
                const namespaces = new Map((settingsValue.namespaces ?? []).map((namespace) => [namespace.ns, namespace] as const));
                const entries = providers.map((entry) => ({ ...entry, settingsPath: Array.isArray(entry.settingsPath) ? entry.settingsPath : [] }));
                const refs = entries.flatMap((entry) => {
                    const namespace = namespaces.get(entry.settingsNs);
                    if (!namespace) return [];
                    return [keyRefOf(namespace, entry)];
                });
                const credentialValue = refs.length > 0
                    ? await rpc('credentials.describe', { refs }) as { credentials?: Record<string, CredentialView> }
                    : { credentials: {} };
                const credentials = credentialValue.credentials ?? {};
                if (disposed || entries.some((entry) => usable(entry, namespaces.get(entry.settingsNs), credentials))) return;
                const entry = entries.find((candidate) => candidate.provider === 'deepseek-official' && candidate.settingsNs === 'llm-deepseek' && candidate.settingsPath.length === 0);
                const namespace = entry ? namespaces.get(entry.settingsNs) : undefined;
                if (!entry || !namespace || settingsValue.writable !== true || !entry.active) return;
                const keyRef = keyRefOf(namespace, entry);
                const credential = credentials[keyRef];
                if (!credential || credential.configured || !credential.writable) return;
                setTarget({ entry, namespace, keyRef, credential });
            } catch {
                return;
            }
        })();
        return () => { disposed = true; };
    }, [rpc]);

    if (!target) return null;

    const save = async () => {
        if (!key.trim() || busy) {
            setError('请输入 API 密钥后继续。');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const profile = atPath(target.namespace.value, target.entry.settingsPath);
            const hasKeyRef = profile && typeof profile === 'object' && typeof (profile as Record<string, unknown>).apiKeyEnv === 'string';
            if (!hasKeyRef) await rpc('settings.update', { ns: target.namespace.ns, patch: { apiKeyEnv: target.keyRef } });
            await rpc('credentials.set', { ref: target.keyRef, value: key.trim() });
            setTarget(null);
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return <div className={css.overlay} role="presentation">
        <div className={css.dialog} role="dialog" aria-modal="true" aria-labelledby="eja-deepseek-title">
            <h2 className={css.title} id="eja-deepseek-title">添加一个 API Key 开始使用</h2>
            <div className={css.body}>
                <p className={css.description}>配置 DeepSeek 官方模型，即可开始使用。</p>
                <label className={css.field}><span>API Key</span><input className={css.input} type="password" autoComplete="off" autoFocus value={key} placeholder="输入 API Key" disabled={busy} onChange={(event) => { setKey(event.target.value); setError(null); }} /></label>
                {error ? <p className={css.error} role="alert">{error}</p> : null}
            </div>
            <div className={css.footer}>
                <button type="button" className={css.outline} disabled={busy} onClick={() => { setTarget(null); }}>稍后配置</button>
                <button type="button" className={css.primary} disabled={busy} onClick={() => { void save(); }}>{busy ? '保存中…' : '保存并继续'}</button>
            </div>
        </div>
    </div>;
}
