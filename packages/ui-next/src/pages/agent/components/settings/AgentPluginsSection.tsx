import { useCallback, useEffect, useState } from 'react';
import type { SettingsRpc } from './cardForm';
import css from './AgentPluginsSection.module.css';

interface AgentPlugin {
    pluginId: string;
    displayName: string;
    description: string;
    enabled: boolean;
}

interface AgentPluginsSectionProps {
    rpc: SettingsRpc;
    sessionId?: string;
    onPluginChange?: (pluginId: string, enabled: boolean) => void;
}

export function AgentPluginsSection({ rpc, sessionId, onPluginChange }: AgentPluginsSectionProps) {
    const [plugins, setPlugins] = useState<AgentPlugin[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const value = await rpc<{ plugins?: AgentPlugin[] }>('agentPlugins.list', {});
            setPlugins(Array.isArray(value.plugins) ? value.plugins : []);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Agent 插件读取失败');
        } finally {
            setLoading(false);
        }
    }, [rpc]);

    useEffect(() => { void load(); }, [load]);

    const toggle = async (plugin: AgentPlugin) => {
        if (busy !== null) return;
        const enabled = !plugin.enabled;
        setBusy(plugin.pluginId);
        setError('');
        try {
            const result = await rpc<{ contextInjected?: boolean }>('agentPlugins.set', {
                pluginId: plugin.pluginId,
                enabled,
                ...(sessionId ? { sessionId } : {}),
            });
            setPlugins((items) => items.map((item) => item.pluginId === plugin.pluginId ? { ...item, enabled } : item));
            onPluginChange?.(plugin.pluginId, enabled);
            if (sessionId && result.contextInjected === false) setError('插件状态已保存，但未能将变更写入当前聊天。');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Agent 插件设置失败');
        } finally {
            setBusy(null);
        }
    };

    return <section className={css.section} aria-busy={loading || busy !== null}>
        <h2 className={css.heading}>Agent 插件</h2>
        <p className={css.intro}>选择会话上下文中可用的 Agent 插件。关闭后，该插件不会出现在上下文选项中。</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        {loading ? <p className={css.status}>正在读取 Agent 插件…</p> : null}
        {!loading && plugins.length === 0 ? <p className={css.status}>当前没有已注册的 Agent 插件。</p> : null}
        {!loading && plugins.length > 0 ? <ul className={css.list}>
            {plugins.map((plugin) => (
                <li className={css.row} key={plugin.pluginId}>
                    <div className={css.copy}>
                        <div className={css.name}>{plugin.displayName}</div>
                        <p className={css.description}>{plugin.description}</p>
                    </div>
                    <button
                        type="button"
                        className={css.toggle}
                        role="switch"
                        aria-checked={plugin.enabled}
                        aria-label={`${plugin.displayName}插件`}
                        disabled={busy !== null}
                        onClick={() => { void toggle(plugin); }}
                    >
                        <span className={css.toggleThumb} />
                    </button>
                </li>
            ))}
        </ul> : null}
    </section>;
}
