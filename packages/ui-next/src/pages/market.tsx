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

    const installedCount = addons.filter((addon) => addon.installed).length;

    return <main className={css.page}>
        <header className={css.hero}>
            <div className={css.heroCopy}>
                <h1 className={css.title}>Addon 市场</h1>
                <p className={css.intro}>安装只开放给当前 domain，不会自动启用；每个 Agent 都需在自己的设置中单独开启。</p>
            </div>
            <aside className={css.scope} aria-label="安装范围">
                <span className={css.scopeMark} aria-hidden="true" />
                <div>
                    <div className={css.scopeLabel}>安装范围</div>
                    <div className={css.scopeValue}>当前 domain</div>
                    <div className={css.scopeNote}>所有 Agent 共用安装状态</div>
                </div>
            </aside>
        </header>

        {error ? <p className={css.error} role="alert">{error}</p> : null}
        <section className={css.registry} aria-labelledby="market-list-title" aria-busy={loading || busy !== null}>
            <div className={css.registryHeader}>
                <h2 className={css.registryTitle} id="market-list-title">可用 Addon</h2>
                {!loading ? <p className={css.count}><strong>{installedCount}</strong><span> / {addons.length} 已安装</span></p> : null}
            </div>
            {loading ? <p className={css.status} role="status">正在读取 Addon 市场…</p> : null}
            {!loading && addons.length === 0 ? <p className={css.status}>当前没有已上架的 Agent Addon。</p> : null}
            {!loading && addons.length > 0 ? <ul className={css.list}>
                {addons.map((addon) => (
                    <li className={css.row} key={addon.addonId}>
                        <div className={css.signature} aria-hidden="true">{addon.addonId.slice(0, 2).toUpperCase()}</div>
                        <div className={css.details}>
                            <div className={css.titleLine}>
                                <h3 className={css.name}>{addon.displayName}</h3>
                                <code className={css.id}>{addon.addonId}</code>
                            </div>
                            <p className={css.description}>{addon.description}</p>
                            {addon.tools?.length ? <div className={css.tools}>
                                <span className={css.toolsLabel}>包含</span>
                                {addon.tools.slice(0, 4).map((tool) => <code className={css.tool} key={tool.name}>{tool.name}</code>)}
                                {addon.tools.length > 4 ? <span className={css.moreTools}>+{addon.tools.length - 4}</span> : null}
                            </div> : null}
                        </div>
                        <div className={css.actions}>
                            <div className={addon.installed ? css.installedState : css.availableState}>
                                <span className={css.stateDot} aria-hidden="true" />
                                {addon.installed ? '已安装' : '可安装'}
                            </div>
                            <button
                                type="button"
                                className={addon.installed ? css.uninstall : css.install}
                                disabled={busy !== null}
                                aria-label={`${addon.installed ? '卸载' : '安装'} ${addon.displayName}`}
                                onClick={() => { void toggleInstalled(addon); }}
                            >
                                {busy === addon.addonId ? '处理中…' : addon.installed ? '卸载' : '安装'}
                            </button>
                        </div>
                    </li>
                ))}
            </ul> : null}
        </section>
    </main>;
}
