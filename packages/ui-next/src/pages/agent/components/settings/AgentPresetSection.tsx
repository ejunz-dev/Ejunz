import { useCallback, useEffect, useMemo, useState } from 'react';
import { i18n } from '@/i18n';
import css from './AgentPresetSection.module.css';

export interface AgentPresetSectionProps {
    rpc: <T>(method: string, payload: unknown) => Promise<T>;
    onCreatorDraft?: () => void;
}

type PresetRow = {
    id: string;
    trust: 'system' | 'user';
    isDefault: boolean;
    name?: string;
    description?: string;
    broken?: string;
};

type PresetList = {
    presets?: PresetRow[];
    authorable?: boolean;
    hasDocument?: boolean;
};

type CopyDraft = {
    from: string;
    id: string;
    name: string;
    saving: boolean;
    error: string | null;
};

type PresetView = {
    title: string;
    content: string;
};

const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

const BUILT_IN_TEXT: Record<string, { name: string; description: string }> = {
    standard: {
        name: i18n('Standard mode'),
        description: i18n('A full-featured coding Agent with file editing, shell, file and web search, Skills, plans, goals, subagents, and workflows.'),
    },
    code: {
        name: i18n('PTC mode'),
        description: i18n('Includes all Standard mode capabilities and exposes tools through the Code Mode SDK, so the model can compose multi-step operations in one TypeScript program.'),
    },
    minimal: {
        name: i18n('Minimal mode'),
        description: i18n('A two-tool coding Agent with persistent bash and str_replace_editor only.'),
    },
    cordis: {
        name: i18n('Creator mode'),
        description: i18n('Create a custom Agent preset with Standard mode capabilities, runtime inspection, plugin experiments, and preset-authoring guidance.'),
    },
};

function presetText(row: PresetRow): { name: string; description?: string } {
    const builtIn = row.trust === 'system' ? BUILT_IN_TEXT[row.id] : undefined;
    if (builtIn) return builtIn;
    return { name: row.name ?? row.id, description: row.description };
}

function copyError(draft: CopyDraft, rows: PresetRow[]): string | null {
    if (!draft.id) return i18n('Enter an identifier.');
    if (!PRESET_ID.test(draft.id)) return i18n('Use lowercase letters, numbers, and hyphens; start with a letter or number.');
    if (rows.some((row) => row.id === draft.id)) return i18n('This identifier is already in use.');
    return null;
}

export function AgentPresetSection({ rpc, onCreatorDraft }: AgentPresetSectionProps) {
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [rows, setRows] = useState<PresetRow[]>([]);
    const [authorable, setAuthorable] = useState(false);
    const [hasDocument, setHasDocument] = useState(false);
    const [copy, setCopy] = useState<CopyDraft | null>(null);
    const [view, setView] = useState<PresetView | null>(null);
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [revealedPaths, setRevealedPaths] = useState<Record<string, string>>({});

    const load = useCallback(async () => {
        setStatus('loading');
        setError(null);
        try {
            const value = await rpc('agentPreset.list', {}) as PresetList;
            const presets = Array.isArray(value.presets) ? value.presets : [];
            setRows(presets);
            setAuthorable(value.authorable === true);
            setHasDocument(value.hasDocument === true);
            setRevealedPaths((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => presets.some((preset) => preset.id === id))));
            setStatus(presets.length > 0 ? 'ready' : 'unavailable');
        } catch (caught) {
            setStatus('error');
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [rpc]);

    useEffect(() => { void load(); }, [load]);

    const systemRows = useMemo(() => rows.filter((row) => row.trust === 'system'), [rows]);
    const customRows = useMemo(() => rows.filter((row) => row.trust === 'user'), [rows]);
    const creatorAvailable = onCreatorDraft !== undefined && authorable && rows.some((row) => row.id === 'cordis' && row.broken === undefined);

    const makeDefault = async (id: string) => {
        setError(null);
        try {
            await rpc('settings.update', { ns: 'agent-presets', patch: { default: id } });
            await load();
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const openView = async (id: string) => {
        setError(null);
        try {
            const value = await rpc('agentPreset.read', { agentPreset: id }) as { name?: string; agentPreset?: string; content?: string };
            setView({ title: value.name ?? value.agentPreset ?? id, content: value.content ?? '' });
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const openLocation = async (id: string) => {
        setError(null);
        try {
            const value = await rpc('agentPreset.openDocument', { agentPreset: id }) as { opened?: boolean; path?: string };
            if (value.opened !== true && typeof value.path === 'string') setRevealedPaths((previous) => ({ ...previous, [id]: value.path! }));
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
    };

    const confirmCopy = async () => {
        if (!copy || copy.saving) return;
        const validation = copyError(copy, rows);
        if (validation) {
            setCopy((previous) => previous ? { ...previous, error: validation } : previous);
            return;
        }
        setCopy((previous) => previous ? { ...previous, saving: true, error: null } : previous);
        try {
            await rpc('agentPreset.copy', {
                from: copy.from,
                agentPreset: copy.id,
                ...(copy.name.trim() ? { name: copy.name.trim() } : {}),
            });
            setCopy(null);
            await load();
            await openLocation(copy.id);
        } catch (caught) {
            setCopy((previous) => previous ? { ...previous, saving: false, error: caught instanceof Error ? caught.message : String(caught) } : previous);
        }
    };

    const remove = async () => {
        if (!pendingDelete || deleting) return;
        setDeleting(true);
        setError(null);
        try {
            await rpc('agentPreset.remove', { agentPreset: pendingDelete });
            setPendingDelete(null);
            await load();
        } catch (caught) {
            setPendingDelete(null);
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setDeleting(false);
        }
    };

    const renderCard = (row: PresetRow) => {
        const text = presetText(row);
        return <li key={row.id} className={row.broken ? `${css.card} ${css.cardBroken}` : row.isDefault ? `${css.card} ${css.cardActive}` : css.card}>
            <button
                type="button"
                className={css.cardMain}
                disabled={row.isDefault || Boolean(row.broken)}
                aria-pressed={row.isDefault}
                title={row.broken ?? (row.isDefault ? i18n('Currently in use') : i18n('Set as default'))}
                onClick={() => { void makeDefault(row.id); }}
            >
                <span className={css.cardHead}>
                    <span className={css.cardName}>{text.name}</span>
                    {row.broken ? <span className={css.brokenBadge}>{i18n('Load failed')}</span> : null}
                    <span className={css.badge}>{row.trust === 'user' ? i18n('Custom') : i18n('Built-in')}</span>
                    {row.isDefault ? <span className={css.inUse}>{i18n('Currently in use')}</span> : null}
                </span>
                <span className={css.cardDesc}>{text.description ?? i18n('No description available.')}</span>
                {row.broken ? <span className={css.cardBrokenReason} role="alert">{row.broken}</span> : null}
                <code className={css.cardId}>{row.id}</code>
            </button>
            <div className={css.cardFoot}>
                {row.trust === 'system' && !row.broken ? <button type="button" className={css.textButton} onClick={() => { void openView(row.id); }}>{i18n('View')}</button> : null}
                {row.trust === 'user' ? <button type="button" className={css.textButton} onClick={() => { void openLocation(row.id); }}>{hasDocument ? i18n('Open folder') : i18n('View path')}</button> : null}
                <button type="button" className={css.textButton} disabled={!authorable || Boolean(row.broken)} onClick={() => { setCopy({ from: row.id, id: '', name: '', saving: false, error: null }); }}>{i18n('Copy')}</button>
                {row.trust === 'user' ? <button type="button" className={`${css.textButton} ${css.dangerButton}`} onClick={() => { setPendingDelete(row.id); }}>{i18n('Delete')}</button> : null}
            </div>
            {revealedPaths[row.id] ? <p className={css.revealedPath}><span>{i18n('Preset file:')}</span><code>{revealedPaths[row.id]}</code></p> : null}
        </li>;
    };

    if (status === 'error') return <div className={css.section}><h2 className={css.title}>{i18n('Agent presets')}</h2><p className={css.error}>{i18n('Unable to load Agent presets: {0}', error)}</p><button type="button" className={css.secondaryButton} onClick={() => { void load(); }}>{i18n('Retry')}</button></div>;
    if (status !== 'ready') return <div className={css.section}><h2 className={css.title}>{i18n('Agent presets')}</h2><p className={css.intro}>{i18n('A preset is the plugin assembly an Agent runs for a session.')}</p>{status === 'unavailable' ? <p className={css.advancedHint}>{i18n('This deployment has no Agent presets available.')}</p> : <p className={css.advancedHint}>{i18n('Loading...')}</p>}</div>;

    return <div className={css.section}>
        <h2 className={css.title}>{i18n('Agent presets')}</h2>
        <p className={css.intro}>{i18n('A preset is the plugin assembly an Agent runs for a session: its tools, prompts, and capabilities. Copy an existing preset and make it your own.')}</p>
        {error ? <p className={css.error}>{error}</p> : null}
        {(['system', 'user'] as const).map((trust) => {
            const group = trust === 'system' ? systemRows : customRows;
            if (group.length === 0 && trust === 'system') return null;
            return <section key={trust} className={css.group}>
                <h3 className={css.groupHead}>{trust === 'system' ? i18n('Built-in') : i18n('Custom')}</h3>
                {group.length > 0 ? <ul className={css.cards}>{group.map(renderCard)}</ul> : <p className={css.emptyGroup}>{i18n('No custom presets yet.')}</p>}
                {trust === 'user' && creatorAvailable ? <button type="button" className={css.creatorButton} onClick={onCreatorDraft}>{i18n('Create a custom Agent preset with Creator mode')}</button> : null}
            </section>;
        })}
        {copy ? <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => { if (!copy.saving) setCopy(null); }} /><div className={css.dialog} role="dialog" aria-modal="true"><h3>{i18n('Copy preset')}</h3><p className={css.dialogIntro}>{i18n('The whole preset is copied on this machine. The identifier becomes the folder name, and you then edit the preset in its own files.')}</p><label className={css.field}><span>{i18n('Identifier')}</span><input className={css.input} autoFocus value={copy.id} onChange={(event) => { setCopy((previous) => previous ? { ...previous, id: event.target.value, error: null } : previous); }} placeholder="my-agent" /></label><label className={css.field}><span>{i18n('Name')}</span><input className={css.input} value={copy.name} onChange={(event) => { setCopy((previous) => previous ? { ...previous, name: event.target.value, error: null } : previous); }} placeholder={i18n('Name shown in the picker. Defaults to the identifier.')} /></label>{copy.error ? <p className={css.error} role="alert">{copy.error}</p> : null}<div className={css.footer}><button type="button" className={css.actionOutline} disabled={copy.saving} onClick={() => { setCopy(null); }}>{i18n('Cancel')}</button><button type="button" className={css.actionPrimary} disabled={copy.saving} onClick={() => { void confirmCopy(); }}>{copy.saving ? i18n('Creating...') : i18n('Create')}</button></div></div></div> : null}
        {view ? <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => { setView(null); }} /><div className={`${css.dialog} ${css.viewer}`} role="dialog" aria-modal="true"><h3>{i18n('View · {0}', view.title)}</h3><p className={css.dialogIntro}>{i18n('Assembly (agent.cordis.yml)')}</p><pre className={css.viewerCode}>{view.content}</pre><div className={css.footer}><button type="button" className={css.actionOutline} autoFocus onClick={() => { setView(null); }}>{i18n('Close')}</button></div></div></div> : null}
        {pendingDelete ? <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => { if (!deleting) setPendingDelete(null); }} /><div className={css.dialog} role="dialog" aria-modal="true"><h3>{i18n('Delete this preset?')}</h3><p className={css.dialogIntro}>{i18n('The preset folder will be deleted. Sessions already running on it are unaffected. New sessions will no longer be able to select it.')}</p><div className={css.footer}><button type="button" className={css.actionOutline} disabled={deleting} onClick={() => { setPendingDelete(null); }}>{i18n('Cancel')}</button><button type="button" className={`${css.actionPrimary} ${css.deleteAction}`} disabled={deleting} onClick={() => { void remove(); }}>{deleting ? i18n('Deleting...') : i18n('Delete')}</button></div></div></div> : null}
    </div>;
}
