import { useCallback, useEffect, useMemo, useState } from 'react';
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
        name: '标准模式',
        description: '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。',
    },
    code: {
        name: 'PTC 模式',
        description: '具备标准模式的全部能力，并通过 Code Mode SDK 呈现工具，让模型用一个 TypeScript 程序组合多步操作。',
    },
    minimal: {
        name: '极简模式',
        description: '仅提供持久 bash 与 str_replace_editor 的双工具编码 Agent。',
    },
    cordis: {
        name: '创造模式',
        description: '用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。',
    },
};

function presetText(row: PresetRow): { name: string; description?: string } {
    const builtIn = row.trust === 'system' ? BUILT_IN_TEXT[row.id] : undefined;
    if (builtIn) return builtIn;
    return { name: row.name ?? row.id, description: row.description };
}

function copyError(draft: CopyDraft, rows: PresetRow[]): string | null {
    if (!draft.id) return '请填写标识符。';
    if (!PRESET_ID.test(draft.id)) return '只能使用小写字母、数字与连字符，且以字母或数字开头。';
    if (rows.some((row) => row.id === draft.id)) return '该标识符已被占用。';
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
                title={row.broken ?? (row.isDefault ? '当前使用' : '设为默认')}
                onClick={() => { void makeDefault(row.id); }}
            >
                <span className={css.cardHead}>
                    <span className={css.cardName}>{text.name}</span>
                    {row.broken ? <span className={css.brokenBadge}>加载失败</span> : null}
                    <span className={css.badge}>{row.trust === 'user' ? '自定义' : '内置'}</span>
                    {row.isDefault ? <span className={css.inUse}>当前使用</span> : null}
                </span>
                <span className={css.cardDesc}>{text.description ?? '暂无描述。'}</span>
                {row.broken ? <span className={css.cardBrokenReason} role="alert">{row.broken}</span> : null}
                <code className={css.cardId}>{row.id}</code>
            </button>
            <div className={css.cardFoot}>
                {row.trust === 'system' && !row.broken ? <button type="button" className={css.textButton} onClick={() => { void openView(row.id); }}>查看</button> : null}
                {row.trust === 'user' ? <button type="button" className={css.textButton} onClick={() => { void openLocation(row.id); }}>{hasDocument ? '打开目录' : '查看路径'}</button> : null}
                <button type="button" className={css.textButton} disabled={!authorable || Boolean(row.broken)} onClick={() => { setCopy({ from: row.id, id: '', name: '', saving: false, error: null }); }}>复制</button>
                {row.trust === 'user' ? <button type="button" className={`${css.textButton} ${css.dangerButton}`} onClick={() => { setPendingDelete(row.id); }}>删除</button> : null}
            </div>
            {revealedPaths[row.id] ? <p className={css.revealedPath}><span>预设文件：</span><code>{revealedPaths[row.id]}</code></p> : null}
        </li>;
    };

    if (status === 'error') return <div className={css.section}><h2 className={css.title}>Agent 预设</h2><p className={css.error}>无法加载 Agent 预设：{error}</p><button type="button" className={css.secondaryButton} onClick={() => { void load(); }}>重试</button></div>;
    if (status !== 'ready') return <div className={css.section}><h2 className={css.title}>Agent 预设</h2><p className={css.intro}>预设即一个会话的 Agent 所运行的插件组装。</p>{status === 'unavailable' ? <p className={css.advancedHint}>当前部署没有可用的 Agent 预设。</p> : <p className={css.advancedHint}>正在加载…</p>}</div>;

    return <div className={css.section}>
        <h2 className={css.title}>Agent 预设</h2>
        <p className={css.intro}>预设即一个会话的 Agent 所运行的插件组装 —— 它的工具、提示词与能力。复制一份既有预设改成自己的。</p>
        {error ? <p className={css.error}>{error}</p> : null}
        {(['system', 'user'] as const).map((trust) => {
            const group = trust === 'system' ? systemRows : customRows;
            if (group.length === 0 && trust === 'system') return null;
            return <section key={trust} className={css.group}>
                <h3 className={css.groupHead}>{trust === 'system' ? '内置' : '自定义'}</h3>
                {group.length > 0 ? <ul className={css.cards}>{group.map(renderCard)}</ul> : <p className={css.emptyGroup}>暂无自定义预设。</p>}
                {trust === 'user' && creatorAvailable ? <button type="button" className={css.creatorButton} onClick={onCreatorDraft}>用「创造模式」创作自定义 Agent preset</button> : null}
            </section>;
        })}
        {copy ? <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => { if (!copy.saving) setCopy(null); }} /><div className={css.dialog} role="dialog" aria-modal="true"><h3>复制预设</h3><p className={css.dialogIntro}>整个预设会在本机复制一份。标识符将成为目录名，之后直接在预设自己的文件里编辑。</p><label className={css.field}><span>标识符</span><input className={css.input} autoFocus value={copy.id} onChange={(event) => { setCopy((previous) => previous ? { ...previous, id: event.target.value, error: null } : previous); }} placeholder="my-agent" /></label><label className={css.field}><span>名称</span><input className={css.input} value={copy.name} onChange={(event) => { setCopy((previous) => previous ? { ...previous, name: event.target.value, error: null } : previous); }} placeholder="选择器中显示的名字，缺省用标识符" /></label>{copy.error ? <p className={css.error} role="alert">{copy.error}</p> : null}<div className={css.footer}><button type="button" className={css.actionOutline} disabled={copy.saving} onClick={() => { setCopy(null); }}>取消</button><button type="button" className={css.actionPrimary} disabled={copy.saving} onClick={() => { void confirmCopy(); }}>{copy.saving ? '正在创建…' : '创建'}</button></div></div></div> : null}
        {view ? <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => { setView(null); }} /><div className={`${css.dialog} ${css.viewer}`} role="dialog" aria-modal="true"><h3>查看 · {view.title}</h3><p className={css.dialogIntro}>组装（agent.cordis.yml）</p><pre className={css.viewerCode}>{view.content}</pre><div className={css.footer}><button type="button" className={css.actionOutline} autoFocus onClick={() => { setView(null); }}>关闭</button></div></div></div> : null}
        {pendingDelete ? <div className={css.overlay} role="presentation"><div className={css.mask} aria-hidden="true" onClick={() => { if (!deleting) setPendingDelete(null); }} /><div className={css.dialog} role="dialog" aria-modal="true"><h3>删除该预设？</h3><p className={css.dialogIntro}>预设目录将被删除。已在其上运行的会话不受影响；新会话将无法再选择它。</p><div className={css.footer}><button type="button" className={css.actionOutline} disabled={deleting} onClick={() => { setPendingDelete(null); }}>取消</button><button type="button" className={`${css.actionPrimary} ${css.deleteAction}`} disabled={deleting} onClick={() => { void remove(); }}>{deleting ? '正在删除…' : '删除'}</button></div></div></div> : null}
    </div>;
}
