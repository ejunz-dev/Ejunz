import { useCallback, useEffect, useState } from 'react';
import type { SettingsRpc } from './cardForm';
import css from './AgentAddonsSection.module.css';

interface AgentAddon {
    addonId: string;
    displayName: string;
    description: string;
    installed: boolean;
    enabled: boolean;
    tools?: { name: string; description: string }[];
}

interface AgentAddonsSectionProps {
    rpc: SettingsRpc;
    sessionId?: string;
    onAddonChange?: (addonId: string, enabled: boolean, installed: boolean) => void;
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
        if (busy !== null || !addon.installed) return;
        const enabled = !addon.enabled;
        setBusy(addon.addonId);
        setError('');
        try {
            await rpc('agent.addons.set', {
                addonId: addon.addonId,
                enabled,
                ...(sessionId ? { sessionId } : {}),
            });
            setAddons((items) => items.map((item) => item.addonId === addon.addonId ? { ...item, enabled } : item));
            onAddonChange?.(addon.addonId, enabled, addon.installed);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Agent Addon设置失败');
        } finally {
            setBusy(null);
        }
    };

    const install = async (addon: AgentAddon) => {
        if (busy !== null) return;
        const shouldInstall = !addon.installed;
        setBusy(addon.addonId);
        setError('');
        try {
            const result = await rpc<{ installed: boolean; enabled: boolean }>(
                shouldInstall ? 'agent.addons.install' : 'agent.addons.uninstall',
                { addonId: addon.addonId },
            );
            setAddons((items) => items.map((item) => item.addonId === addon.addonId
                ? { ...item, installed: result.installed, enabled: result.enabled }
                : item));
            onAddonChange?.(addon.addonId, result.enabled, result.installed);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Agent Addon安装状态更新失败');
        } finally {
            setBusy(null);
        }
    };

    return <section className={css.section} aria-busy={loading || busy !== null}>
        <h2 className={css.heading}>Agent Addon 市场</h2>
        <p className={css.intro}>浏览服务端已上架的 Agent Addon。安装后，该 addon 对当前 domain 可用；关闭开关只会停用它，不会卸载。</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        {loading ? <p className={css.status}>正在读取 Agent Addon…</p> : null}
        {!loading && addons.length === 0 ? <p className={css.status}>当前没有已上架的 Agent Addon。</p> : null}
        {!loading && addons.length > 0 ? <ul className={css.list}>
            {addons.map((addon) => (
                <li className={css.row} key={addon.addonId}>
                    <div className={css.copy}>
                        <div className={css.name}>{addon.displayName}</div>
                        <p className={css.description}>{addon.description}</p>
                        {addon.tools?.length ? <p className={css.tools}>工具：{addon.tools.map((tool) => tool.name).join('、')}</p> : null}
                    </div>
                    <div className={css.actions}>
                        {addon.installed ? <>
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
                            <button
                                type="button"
                                className={css.installButton}
                                disabled={busy !== null}
                                onClick={() => { void install(addon); }}
                            >卸载</button>
                        </> : <button
                            type="button"
                            className={css.installButton}
                            disabled={busy !== null}
                            onClick={() => { void install(addon); }}
                        >安装</button>}
                    </div>
                </li>
            ))}
        </ul> : null}
    </section>;
}
