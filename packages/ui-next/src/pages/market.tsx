import { useCallback, useEffect, useState } from 'react';
import { useAgentRpc } from './agent/runtime/rpc';
import css from './market.module.css';

interface MarketAddon {
    addonId: string;
    displayName: string;
    description: string;
    installed: boolean;
    tools?: { name: string; description: string }[];
}

export default function AgentAddonMarketPage() {
    const rpc = useAgentRpc();
    const [addons, setAddons] = useState<MarketAddon[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const value = await rpc('agent.addons.market.list', {}) as { addons?: MarketAddon[] };
            setAddons(Array.isArray(value.addons) ? value.addons : []);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Addon 市场读取失败');
        } finally {
            setLoading(false);
        }
    }, [rpc]);

    useEffect(() => { void load(); }, [load]);

    const toggleInstalled = async (addon: MarketAddon) => {
        if (busy !== null) return;
        const installed = !addon.installed;
        setBusy(addon.addonId);
        setError('');
        try {
            const result = await rpc(
                installed ? 'agent.addons.install' : 'agent.addons.uninstall',
                { addonId: addon.addonId },
            ) as { installed: boolean };
            setAddons((items) => items.map((item) => item.addonId === addon.addonId
                ? { ...item, installed: result.installed }
                : item));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Addon 安装状态更新失败');
        } finally {
            setBusy(null);
        }
    };

    return <main className={css.page}>
        <header className={css.header}>
            <h1 className={css.title}>Addon 市场</h1>
            <p className={css.intro}>安装状态作用于当前 domain 的所有 Agent。安装后，再到各 Agent 的设置中单独启用或关闭。</p>
        </header>
        {error ? <p className={css.error} role="alert">{error}</p> : null}
        {loading ? <p className={css.status}>正在读取 Addon 市场…</p> : null}
        {!loading && addons.length === 0 ? <p className={css.status}>当前没有已上架的 Agent Addon。</p> : null}
        {!loading && addons.length > 0 ? <ul className={css.list}>
            {addons.map((addon) => (
                <li className={css.card} key={addon.addonId}>
                    <div className={css.details}>
                        <div className={css.name}>{addon.displayName}</div>
                        <div className={css.id}>{addon.addonId}</div>
                        <p className={css.description}>{addon.description}</p>
                        {addon.tools?.length ? <p className={css.tools}>工具：{addon.tools.map((tool) => tool.name).join('、')}</p> : null}
                    </div>
                    <button
                        type="button"
                        className={addon.installed ? css.uninstall : css.install}
                        disabled={busy !== null}
                        onClick={() => { void toggleInstalled(addon); }}
                    >
                        {busy === addon.addonId ? '处理中…' : addon.installed ? '卸载' : '安装'}
                    </button>
                </li>
            ))}
        </ul> : null}
    </main>;
}
