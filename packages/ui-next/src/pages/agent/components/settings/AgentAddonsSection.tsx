import { useCallback, useEffect, useState } from 'react';
import { i18n } from '@/i18n';
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
            setError(cause instanceof Error ? cause.message : i18n('Failed to load Agent add-ons'));
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
            setError(cause instanceof Error ? cause.message : i18n('Failed to update Agent add-ons'));
        } finally {
            setBusy(null);
        }
    };

    const installedAddons = addons.filter((addon) => addon.installed);

    return <section className={css.section} aria-busy={loading || busy !== null}>
        <h2 className={css.heading}>{i18n('Agent add-ons')}</h2>
        <p className={css.intro}>{i18n('Choose the add-ons available to this Agent. Install and uninstall them in the domain')} <a className={css.marketLink} href={marketHref}>{i18n('Add-on market')}</a>.</p>
        {error && <p className={css.error} role="alert">{error}</p>}
        {loading ? <p className={css.status}>{i18n('Loading Agent add-ons...')}</p> : null}
        {!loading && installedAddons.length === 0 ? <p className={css.status}>{i18n('No add-ons are installed in this domain. Install them from the')} <a className={css.marketLink} href={marketHref}>{i18n('Add-on market')}</a>.</p> : null}
        {!loading && installedAddons.length > 0 ? <ul className={css.list}>
            {installedAddons.map((addon) => (
                <li className={css.row} key={addon.addonId}>
                    <div className={css.copy}>
                        <div className={css.name}>{addon.displayName}</div>
                        <p className={css.description}>{addon.description}</p>
                        {addon.tools?.length ? <p className={css.tools}>{i18n('Tools')}: {addon.tools.map((tool) => tool.name).join(', ')}</p> : null}
                    </div>
                    <button
                        type="button"
                        className={css.toggle}
                        role="switch"
                        aria-checked={addon.enabled}
                        aria-label={i18n('{0} add-on', addon.displayName)}
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
