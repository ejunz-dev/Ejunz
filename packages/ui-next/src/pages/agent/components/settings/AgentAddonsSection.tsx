import { useCallback, useEffect, useState } from 'react';
import type { SettingsRpc } from './cardForm';
import css from './AgentAddonsSection.module.css';

interface AgentAddon {
    addonId: string;
    displayName: string;
    description: string;
    enabled: boolean;
}

interface AgentAddonsSectionProps {
    rpc: SettingsRpc;
    sessionId?: string;
    onAddonChange?: (addonId: string, enabled: boolean) => void;
}

export function AgentAddonsSection({ rpc, sessionId, onAddonChange }: AgentAddonsSectionProps) {
    const [addons, setAddons] = useState<AgentAddon[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const value = await rpc<{ addons?: AgentAddon[] }>('agent.addons.list', {});
            setAddons(Array.isArray(value.addons) ? value.addons : []);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Agent Addon读取失败');
        } finally {
            setLoading(false);
        }
    }, [rpc]);

    useEffect(() => { void load(); }, [load]);

    const toggle = async (addon: AgentAddon) => {
        if (busy !== null) return;
        const enabled = !addon.enabled;
        setBusy(addon.addonId);
        setError('');
        try {
            const result = await rpc<{ eventRecorded?: boolean }>('agent.addons.set', {
                addonId: addon.addonId,
                enabled,
                ...(sessionId ? { sessionId } : {}),
            });
            setAddons((items) => items.map((item) => item.addonId === addon.addonId ? { ...item, enabled } : item));
            onAddonChange?.(addon.addonId, enabled);
            if (sessionId && result.eventRecorded === false) setError('插件状态已保存，但未能写入当前会话。');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Agent Addon设置失败');
        } finally {
            setBusy(null);
        }
    };

    return <section className={css.section} aria-busy={loading || busy !== null}>
        <h2 className={css.heading}>Agent Addon</h2>
        <p className={css.intro}>选择会话上下文中可用的 Agent Addon。关闭后，该 Addon不会出现在上下文选项中。</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        {loading ? <p className={css.status}>正在读取 Agent Addon…</p> : null}
        {!loading && addons.length === 0 ? <p className={css.status}>当前没有已注册的 Agent Addon。</p> : null}
        {!loading && addons.length > 0 ? <ul className={css.list}>
            {addons.map((addon) => (
                <li className={css.row} key={addon.addonId}>
                    <div className={css.copy}>
                        <div className={css.name}>{addon.displayName}</div>
                        <p className={css.description}>{addon.description}</p>
                    </div>
                    <button
                        type="button"
                        className={css.toggle}
                        role="switch"
                        aria-checked={addon.enabled}
                        aria-label={`${addon.displayName} Addon`}
                        disabled={busy !== null}
                        onClick={() => { void toggle(addon); }}
                    >
                        <span className={css.toggleThumb} />
                    </button>
                </li>
            ))}
        </ul> : null}
    </section>;
}
