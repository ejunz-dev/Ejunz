import { useCallback, useEffect, useState } from 'react';
import { i18n } from '@/i18n';
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
            setError(cause instanceof Error ? cause.message : i18n('Failed to load the add-on market'));
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
            setError(cause instanceof Error ? cause.message : i18n('Failed to update add-on installation status'));
        } finally {
            setBusy(null);
        }
    };

    const installedCount = addons.filter((addon) => addon.installed).length;

    return <main className={css.page}>
        <header className={css.hero}>
            <div className={css.heroCopy}>
                <h1 className={css.title}>{i18n('Add-on market')}</h1>
                <p className={css.intro}>{i18n('Installation is limited to this domain and does not enable add-ons automatically. Enable each add-on separately in each Agent’s settings.')}</p>
            </div>
            <aside className={css.scope} aria-label={i18n('Installation scope')}>
                <span className={css.scopeMark} aria-hidden="true" />
                <div>
                    <div className={css.scopeLabel}>{i18n('Installation scope')}</div>
                    <div className={css.scopeValue}>{i18n('Current domain')}</div>
                    <div className={css.scopeNote}>{i18n('All Agents share installation status')}</div>
                </div>
            </aside>
        </header>

        {error ? <p className={css.error} role="alert">{error}</p> : null}
        <section className={css.registry} aria-labelledby="market-list-title" aria-busy={loading || busy !== null}>
            <div className={css.registryHeader}>
                <h2 className={css.registryTitle} id="market-list-title">{i18n('Available add-ons')}</h2>
                {!loading ? <p className={css.count}><strong>{installedCount}</strong><span> / {addons.length} {i18n('installed')}</span></p> : null}
            </div>
            {loading ? <p className={css.status} role="status">{i18n('Loading add-on market...')}</p> : null}
            {!loading && addons.length === 0 ? <p className={css.status}>{i18n('No Agent add-ons are listed yet.')}</p> : null}
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
                                <span className={css.toolsLabel}>{i18n('Includes')}</span>
                                {addon.tools.slice(0, 4).map((tool) => <code className={css.tool} key={tool.name}>{tool.name}</code>)}
                                {addon.tools.length > 4 ? <span className={css.moreTools}>+{addon.tools.length - 4}</span> : null}
                            </div> : null}
                        </div>
                        <div className={css.actions}>
                            <div className={addon.installed ? css.installedState : css.availableState}>
                                <span className={css.stateDot} aria-hidden="true" />
                                {addon.installed ? i18n('Installed') : i18n('Available to install')}
                            </div>
                            <button
                                type="button"
                                className={addon.installed ? css.uninstall : css.install}
                                disabled={busy !== null}
                                aria-label={i18n(addon.installed ? 'Uninstall {0}' : 'Install {0}', addon.displayName)}
                                onClick={() => { void toggleInstalled(addon); }}
                            >
                                {busy === addon.addonId ? i18n('Working...') : addon.installed ? i18n('Uninstall') : i18n('Install')}
                            </button>
                        </div>
                    </li>
                ))}
            </ul> : null}
        </section>
    </main>;
}
