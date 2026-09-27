import { useEffect, useState } from 'react';
import { RowMenu, type RowMenuItem } from './RowMenu';
import type { SettingsRpc } from './SettingsRows';
import css from './SettingsRows.module.css';

interface PresetRow {
    id: string;
    trust: 'system' | 'user';
    isDefault: boolean;
    name?: string;
    broken?: string;
}

interface PresetList {
    presets?: PresetRow[];
}

interface SettingsDescribe {
    writable?: boolean;
}

export function AgentPresetRow({ rpc }: { rpc: SettingsRpc }) {
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [writable, setWritable] = useState(false);
    const [options, setOptions] = useState<RowMenuItem[]>([]);
    const [selectedId, setSelectedId] = useState('');

    useEffect(() => {
        let disposed = false;
        setStatus('loading');
        void (async () => {
            try {
                const [list, settings] = await Promise.all([
                    rpc('agentPreset.list', {}) as Promise<PresetList>,
                    rpc('settings.describe', {}) as Promise<SettingsDescribe>,
                ]);
                if (disposed) return;
                const presets = (list.presets ?? []).filter((preset) => !preset.broken);
                if (!presets.length) {
                    setStatus('unavailable');
                    return;
                }
                setOptions(presets.map((preset) => ({ id: preset.id, label: preset.name ?? preset.id })));
                setSelectedId(presets.find((preset) => preset.isDefault)?.id ?? presets[0].id);
                setWritable(settings.writable === true);
                setStatus('ready');
            } catch (caught) {
                if (disposed) return;
                setError(caught instanceof Error ? caught.message : String(caught));
                setStatus('error');
            }
        })();
        return () => { disposed = true; };
    }, [rpc]);

    if (status === 'unavailable' || status === 'idle') return null;
    if (status === 'loading') return <div className={css.row}><div className={css.rowText}><div className={css.title}>Agent 预设</div><div className={css.desc}>正在加载预设…</div></div></div>;
    if (status === 'error') return <div className={css.row}><div className={css.rowText}><div className={css.title}>Agent 预设</div><div className={css.desc} role="alert">{error}</div></div></div>;

    const select = (id: string) => {
        if (id === selectedId || !writable) return;
        setSelectedId(id);
        void rpc('settings.update', { ns: 'agent-presets', patch: { default: id } }).catch((caught) => {
            setError(caught instanceof Error ? caught.message : String(caught));
        });
    };

    return <div className={css.row}>
        <div className={css.rowText}>
            <div className={css.title}>Agent 预设</div>
            <div className={css.desc} role={error ? 'alert' : undefined}>{error ?? '选择新会话使用的默认 Agent 预设。运行中的会话不会改变。'}</div>
        </div>
        <RowMenu items={options} selectedId={selectedId} disabled={!writable} onSelect={select} />
    </div>;
}
