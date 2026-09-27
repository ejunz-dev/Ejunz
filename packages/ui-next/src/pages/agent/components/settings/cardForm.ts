import { useCallback, useEffect, useRef, useState } from 'react';

export type SettingsRpc = <T>(method: string, payload: unknown) => Promise<T>;

export type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' };

export interface FieldSpec {
    field: string;
    format: (value: unknown) => string;
    parse: (text: string) => FieldWrite | undefined;
}

export function numberField(field: string): FieldSpec {
    return {
        field,
        format: (value) => typeof value === 'number' ? String(value) : '',
        parse: (text) => {
            const trimmed = text.trim();
            if (trimmed === '') return { kind: 'clear' };
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined;
        },
    };
}

export function textField(field: string): FieldSpec {
    return {
        field,
        format: (value) => typeof value === 'string' ? value : '',
        parse: (text) => {
            const trimmed = text.trim();
            return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed };
        },
    };
}

export interface CardFieldState {
    text: string;
    overridden: boolean;
    invalid: boolean;
}

export interface CardShell {
    available: boolean;
    writable: boolean;
    dirty: boolean;
    invalid: boolean;
    saving: boolean;
    failed: boolean;
}

interface NamespaceView {
    ns?: string;
    value?: unknown;
    base?: unknown;
    user?: unknown;
    revision?: number;
}

interface DescribeValue {
    writable?: boolean;
    namespaces?: NamespaceView[];
}

interface StagedEdit {
    text: string;
    clear: boolean;
}

interface SecretConfig {
    field: string;
    ref: (view: NamespaceView | undefined) => string;
}

interface PlannedWrite {
    field: string;
    run: (() => Promise<boolean>) | undefined;
}

export interface CardFormOptions {
    rpc: SettingsRpc;
    ns: string;
    fields: FieldSpec[];
    secret?: SecretConfig;
}

export interface CardFormState extends CardShell {
    revision: number;
    secretConfigured: boolean;
    secretWritable: boolean;
    secretText: string;
}

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function useCardForm({ rpc, ns, fields, secret }: CardFormOptions) {
    const specs = useRef(new Map(fields.map((spec) => [spec.field, spec] as const))).current;
    const [staged, setStaged] = useState<Map<string, StagedEdit>>(new Map());
    const [view, setView] = useState<NamespaceView | undefined>(undefined);
    const [writable, setWritable] = useState(false);
    const [saving, setSaving] = useState(false);
    const [failed, setFailed] = useState(false);
    const [secretState, setSecretState] = useState({ text: '', configured: false, writable: true });
    const generationRef = useRef(0);

    const sectionValue = (field: string): unknown => asObject(view?.value)[field];
    const userLayer = (field: string): unknown => asObject(view?.user)[field];

    const load = useCallback(async () => {
        const generation = ++generationRef.current;
        try {
            const value = await rpc<DescribeValue>('settings.describe', {});
            if (generation !== generationRef.current) return;
            const next = (value.namespaces ?? []).find((item) => item.ns === ns);
            setWritable(value.writable === true);
            setView(next);
            if (secret && next) {
                const ref = secret.ref(next);
                try {
                    const described = await rpc<{ credentials?: Record<string, { configured?: boolean; writable?: boolean }> }>('credentials.describe', { refs: [ref] });
                    if (generation !== generationRef.current) return;
                    const entry = described.credentials?.[ref];
                    setSecretState((prev) => ({ ...prev, configured: entry?.configured === true, writable: entry?.writable !== false }));
                } catch { /* keep last known; a write still reaches the host */ }
            }
        } catch {
            if (generation !== generationRef.current) return;
            setView(undefined);
        }
    }, [ns, rpc, secret]);

    useEffect(() => { void load(); }, [load]);

    const edit = useCallback((field: string, text: string) => {
        setStaged((prev) => { const next = new Map(prev); next.set(field, { text, clear: false }); return next; });
        setFailed(false);
    }, []);

    const editSecret = useCallback((text: string) => {
        setSecretState((prev) => ({ ...prev, text }));
        setFailed(false);
    }, []);

    const resetField = useCallback((field: string) => {
        const spec = specs.get(field);
        if (!spec) return;
        const baseValue = asObject(view?.base)[field];
        setStaged((prev) => { const next = new Map(prev); next.set(field, { text: spec.format(baseValue), clear: true }); return next; });
        setFailed(false);
    }, [specs, view]);

    const discard = useCallback(() => {
        setStaged((prev) => { if (prev.size === 0) return prev; return new Map(); });
        setSecretState((prev) => ({ ...prev, text: '' }));
        setFailed(false);
    }, []);

    const plan: () => PlannedWrite[] = useCallback(() => {
        const writes: PlannedWrite[] = [];
        for (const [field, editEntry] of staged) {
            const spec = specs.get(field);
            if (!spec) continue;
            if (editEntry.clear) {
                if (userLayer(field) !== undefined) writes.push({ field, run: () => unsetField(field) });
                continue;
            }
            if (editEntry.text === spec.format(sectionValue(field))) continue;
            const write = spec.parse(editEntry.text);
            if (write === undefined) writes.push({ field, run: undefined });
            else if (write.kind === 'clear') writes.push({ field, run: () => unsetField(field) });
            else writes.push({ field, run: () => setField(field, write.value) });
        }
        return writes;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staged, specs, view]);

    const setField = useCallback(async (field: string, value: unknown): Promise<boolean> => {
        try {
            const result = await rpc<NamespaceView>('settings.mutate', { ns, ops: [{ op: 'set', path: [field], value }], expectedRevision: view?.revision });
            setView(result);
            return asObject(result.user)[field] === value;
        } catch { return false; }
    }, [ns, rpc, view]);

    const unsetField = useCallback(async (field: string): Promise<boolean> => {
        try {
            const result = await rpc<NamespaceView>('settings.mutate', { ns, ops: [{ op: 'unset', path: [field] }], expectedRevision: view?.revision });
            setView(result);
            return asObject(result.user)[field] === undefined;
        } catch { return false; }
    }, [ns, rpc, view]);

    const writeSecret = useCallback(async (): Promise<boolean> => {
        if (!secret || secretState.text.trim() === '') return true;
        const ref = secret.ref(view);
        try {
            await rpc('credentials.set', { ref, value: secretState.text.trim() });
        } catch { return false; }
        try {
            const described = await rpc<{ credentials?: Record<string, { configured?: boolean }> }>('credentials.describe', { refs: [ref] });
            const configured = described.credentials?.[ref]?.configured === true;
            setSecretState((prev) => ({ ...prev, configured, text: '' }));
            return configured;
        } catch { return false; }
    }, [rpc, secret, secretState.text, view]);

    const save = useCallback(async () => {
        const writes = plan();
        if (writes.length === 0 && (!secret || secretState.text.trim() === '')) return;
        if (writes.some((item) => item.run === undefined)) return;
        if (saving) return;
        setSaving(true);
        setFailed(false);
        let landed = true;
        for (const item of writes) { if (item.run) landed = (await item.run()) && landed; }
        if (secret && secretState.text.trim() !== '') landed = (await writeSecret()) && landed;
        if (landed) {
            setStaged(new Map());
            setSecretState((prev) => ({ ...prev, text: '' }));
        }
        setSaving(false);
        setFailed(!landed);
    }, [plan, saving, secret, secretState.text, writeSecret]);

    const fieldState = useCallback((field: string): CardFieldState => {
        const spec = specs.get(field);
        if (!spec) return { text: '', overridden: false, invalid: false };
        const editEntry = staged.get(field);
        if (editEntry === undefined) {
            return { text: spec.format(sectionValue(field)), overridden: userLayer(field) !== undefined, invalid: false };
        }
        const write = editEntry.clear ? { kind: 'clear' as const } : spec.parse(editEntry.text);
        return { text: editEntry.text, overridden: write?.kind === 'set', invalid: write === undefined };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staged, specs, view]);

    const state: CardFormState = {
        available: view !== undefined,
        writable,
        dirty: staged.size > 0 || (secret !== undefined && secretState.text.trim() !== ''),
        invalid: plan().some((item) => item.run === undefined),
        saving,
        failed,
        revision: view?.revision ?? 0,
        secretConfigured: secretState.configured,
        secretWritable: secretState.writable,
        secretText: secretState.text,
    };

    return { state, fieldState, edit, editSecret, resetField, save, discard, reload: load };
}
