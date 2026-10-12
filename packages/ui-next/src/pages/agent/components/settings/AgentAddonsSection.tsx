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
    marketHref: string;
    onAddonChange?: (addonId: string, enabled: boolean, installed: boolean) => void;
}

export function AgentAddonsSection({ rpc, marketHref, onAddonChange }: AgentAddonsSectionProps) {
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
            await rpc('agent.addons.set', { addonId: addon.addonId, enabled });
            setAddons((items) => items.map((item) => item.addonId === addon.addonId ? { ...item, enabled } : item));
            onAddonChange?.(addon.addonId, enabled, addon.installed);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Agent Addon设置失败');
        } finally {
            setBusy(null);
        }
    };

    const installedAddons = addons.filter((addon) => addon.installed);

    return <section className={css.section} aria-busy={loading || busy !== null}>
        <h2 className={css.heading}>Agent Addons</h2>
        <p className={css.intro}>这里设置当前 Agent 可用的 Addon。安装与卸载由 domain 级 <a className={css.marketLink} href={marketHref}>Addon 市场</a>管理。</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        {loading ? <p className={css.status}>正在读取 Agent Addon…</p> : null}
        {!loading && installedAddons.length === 0 ? <p className={css.status}>当前 domain 尚未安装 Addon，可前往 <a className={css.marketLink} href={marketHref}>Addon 市场</a>安装。</p> : null}
        {!loading && installedAddons.length > 0 ? <ul className={css.list}>
            {installedAddons.map((addon) => (
                <li className={css.row} key={addon.addonId}>
                    <div className={css.copy}>
                        <div className={css.name}>{addon.displayName}</div>
                        <p className={css.description}>{addon.description}</p>
                        {addon.tools?.length ? <p className={css.tools}>工具：{addon.tools.map((tool) => tool.name).join('、')}</p> : null}
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
