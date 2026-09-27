import { useCallback, useEffect, useRef, useState } from 'react';

export type SettingsRpc = <T>(method: string, payload: unknown) => Promise<T>;

export interface ConfigurableProviderView {
    provider: string;
    displayName: string;
    settingsNs: string;
    settingsPath: readonly string[];
    active: boolean;
    declared?: boolean;
}

export interface CredentialView {
    configured: boolean;
    source?: string;
    writable: boolean;
}

export interface SettingsNamespaceView {
    ns: string;
    schema: unknown;
    value: unknown;
    base?: unknown;
    user?: unknown;
    revision: number;
}

export interface ProviderRow {
    entry: ConfigurableProviderView;
    configured: boolean;
    removable: boolean;
    apiKeyEnv: string | undefined;
    credential: CredentialView | undefined;
}

export interface ModelsSettingsState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string | null;
    credentialError: string | null;
    writable: boolean;
    rows: readonly ProviderRow[];
    namespaces: ReadonlyMap<string, SettingsNamespaceView>;
}

const PROBE_ROUTE = 'probe';

export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function deriveKeyRef(provider: string): string {
    return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

export function getPath(value: unknown, path: readonly string[]): unknown {
    let current: unknown = value;
    for (const key of path) {
        if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
            current = (current as Record<string, unknown>)[key];
        } else {
            return undefined;
        }
    }
    return current;
}

export function hasPath(value: unknown, path: readonly string[]): boolean {
    return getPath(value, path) !== undefined;
}

export function protocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
    if (namespace === undefined) return [];
    const node = getPath(namespace.schema, ['properties', 'providers', 'properties', PROBE_ROUTE, 'properties', 'api']);
    const list = node as { type?: string; list?: readonly { value?: unknown }[] } | undefined;
    if (list?.type !== 'union' || list.list === undefined) return [];
    return list.list.map((entry) => entry.value).filter((value): value is string => typeof value === 'string');
}

function apiKeyEnvOf(namespace: SettingsNamespaceView | undefined, path: readonly string[]): string | undefined {
    if (namespace === undefined) return undefined;
    const profile = getPath(namespace.value, path);
    if (typeof profile !== 'object' || profile === null) return undefined;
    const ref = (profile as { apiKeyEnv?: unknown }).apiKeyEnv;
    return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
}

export function providerUsable(row: ProviderRow): boolean {
    if (!row.entry.active) return false;
    if (row.apiKeyEnv === undefined) return true;
    return row.credential?.configured === true;
}

const INITIAL: ModelsSettingsState = {
    status: 'idle', error: null, credentialError: null, writable: false, rows: [], namespaces: new Map(),
};

export function useModelsStore(rpc: SettingsRpc) {
    const [state, setState] = useState<ModelsSettingsState>(INITIAL);
    const generationRef = useRef(0);

    const load = useCallback(async () => {
        const generation = ++generationRef.current;
        setState((prev) => ({ ...prev, status: 'loading', error: null }));
        let providers: ConfigurableProviderView[];
        let writable: boolean;
        let views: SettingsNamespaceView[];
        try {
            const [providersValue, settingsValue] = await Promise.all([
                rpc<{ providers: ConfigurableProviderView[] }>('llm.providers', {}),
                rpc<{ writable?: boolean; namespaces?: SettingsNamespaceView[] }>('settings.describe', {}),
            ]);
            if (generation !== generationRef.current) return;
            providers = providersValue.providers ?? [];
            writable = settingsValue.writable === true;
            views = settingsValue.namespaces ?? [];
        } catch (error) {
            if (generation !== generationRef.current) return;
            setState((prev) => ({ ...prev, status: 'error', error: messageOf(error) }));
            return;
        }
        const namespaces = new Map(views.map((view) => [view.ns, view] as const));
        const rows: ProviderRow[] = providers.map((entry) => {
            const namespace = namespaces.get(entry.settingsNs);
            const configured = namespace !== undefined
                && (entry.settingsPath.length === 0
                    ? namespace.user !== undefined
                    : getPath(namespace.value, entry.settingsPath) !== undefined);
            const removable = namespace !== undefined
                && (entry.settingsPath.length === 0
                    ? namespace.user !== undefined
                    : hasPath(namespace.user, entry.settingsPath) && !hasPath(namespace.base, entry.settingsPath));
            return {
                entry,
                configured,
                removable,
                apiKeyEnv: apiKeyEnvOf(namespace, entry.settingsPath),
                credential: undefined,
            };
        });
        const refs = [...new Set(rows.flatMap((row) => row.apiKeyEnv === undefined ? [] : [row.apiKeyEnv]))];
        let credentials: Record<string, CredentialView> = {};
        let credentialError: string | null = null;
        if (refs.length > 0) {
            try {
                const value = await rpc<{ credentials?: Record<string, CredentialView> }>('credentials.describe', { refs });
                if (generation !== generationRef.current) return;
                credentials = value.credentials ?? {};
            } catch (error) {
                if (generation !== generationRef.current) return;
                credentialError = messageOf(error);
            }
        }
        if (generation !== generationRef.current) return;
        setState({
            status: 'ready',
            error: null,
            credentialError,
            writable,
            rows: rows.map((row) => ({
                ...row,
                ...(row.apiKeyEnv !== undefined && credentials[row.apiKeyEnv] !== undefined
                    ? { credential: credentials[row.apiKeyEnv] }
                    : {}),
            })),
            namespaces,
        });
    }, [rpc]);

    useEffect(() => { if (state.status === 'idle') void load(); }, [load, state.status]);

    return { state, load };
}
