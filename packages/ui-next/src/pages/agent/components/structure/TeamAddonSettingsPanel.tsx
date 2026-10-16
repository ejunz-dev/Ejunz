import { useEffect, useMemo, useRef, useState } from 'react';
import { Notification } from '@ejunz/ui-next';
import type { AgentTeam } from '../../runtime/session';
import type { AgentAddonView } from '../types';
import { i18n } from '@/i18n';

interface TeamAddonSettingsPanelProps {
    team: AgentTeam;
    addons: readonly AgentAddonView[];
    saving: boolean;
    onSave: (addonIds: string[]) => Promise<void>;
}

function selectedAddonIds(team: AgentTeam, enabledIds: ReadonlySet<string>): string[] {
    const config = team.config?.addons;
    if (config === undefined) return [...enabledIds].sort();
    return Object.entries(config)
        .filter(([addonId, enabled]) => enabled && enabledIds.has(addonId))
        .map(([addonId]) => addonId)
        .sort();
}

function selectedKey(addonIds: readonly string[]): string {
    return JSON.stringify([...addonIds].sort());
}

export function TeamAddonSettingsPanel({ team, addons, saving, onSave }: TeamAddonSettingsPanelProps) {
    const enabledIds = useMemo(() => new Set(addons.filter((addon) => addon.installed && addon.enabled).map((addon) => addon.addonId)), [addons]);
    const configuredIds = useMemo(() => selectedAddonIds(team, enabledIds), [enabledIds, team.config?.addons, team.teamId]);
    const configuredKey = team.config?.addons === undefined
        ? 'inherit-global'
        : `configured:${selectedKey(configuredIds)}`;
    const [draftAddonIds, setDraftAddonIds] = useState(configuredIds);
    const sourceRef = useRef({ teamId: team.teamId, configuredKey });
    const isDirty = selectedKey(draftAddonIds) !== selectedKey(configuredIds);

    useEffect(() => {
        const sourceChanged = sourceRef.current.teamId !== team.teamId || sourceRef.current.configuredKey !== configuredKey;
        sourceRef.current = { teamId: team.teamId, configuredKey };
        if (sourceChanged || !isDirty) setDraftAddonIds(configuredIds);
    }, [configuredIds, configuredKey, isDirty, team.teamId]);

    const toggleAddon = (addonId: string) => {
        setDraftAddonIds((current) => current.includes(addonId)
            ? current.filter((id) => id !== addonId)
            : [...current, addonId]);
    };

    const save = async () => {
        if (!isDirty || saving) return;
        try {
            await onSave(draftAddonIds.filter((addonId) => enabledIds.has(addonId)));
        } catch (cause) {
            await Notification.error(cause instanceof Error ? cause.message : String(cause));
        }
    };

    return <div className="eza-teamAddonSettings">
        <div className="bd-edit-dialog__body eza-teamAddonConfig">
            <div className="bd-edit-field">
                <h3>{i18n('Add-ons')}</h3>
                <p className="bd-muted">{i18n('Select multiple add-ons. Changes remain a draft until you save. If unset, Agent-wide settings are used.')}</p>
                <div className="bd-edit-tags">
                    {addons.filter((addon) => addon.installed).map((addon) => {
                        const selected = draftAddonIds.includes(addon.addonId) && addon.enabled;
                        return <button
                            type="button"
                            className={`bd-edit-tag${selected ? ' is-selected' : ''}`}
                            aria-pressed={selected}
                            disabled={saving || !addon.enabled}
                            key={addon.addonId}
                            title={addon.description}
                            onClick={() => toggleAddon(addon.addonId)}
                        >{addon.displayName}{!addon.enabled ? ` · ${i18n('Disabled globally for Agent')}` : ''}</button>;
                    })}
                </div>
                {addons.every((addon) => !addon.installed) && <span className="bd-muted">{i18n('No add-ons are installed in this domain.')}</span>}
                {isDirty && <span className="bd-muted" role="status">{i18n('{0} add-ons selected. Not saved yet.', draftAddonIds.length)}</span>}
            </div>
        </div>
        <footer className="bd-edit-dialog__footer eza-teamAddonFooter">
            <span className="bd-muted">{saving ? i18n('Saving...') : ''}</span>
            <button type="button" className="eza-inputConfigCreate" disabled={!isDirty || saving} onClick={() => { void save(); }}>{i18n('Save configuration')}</button>
        </footer>
    </div>;
}
