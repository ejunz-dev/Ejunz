import { useEffect, useState } from 'react';
import { i18n } from '@/i18n';
import { defineSlot } from '../../../../registry';

interface BaseDisplaySettingSlotProps {
    value: boolean;
    disabled: boolean;
    onChange: (value: boolean) => void;
}

const BaseDisplaySettingSlot = defineSlot<BaseDisplaySettingSlotProps>(
    'component:agent-display-setting-base',
    () => null,
);

export interface AgentDisplaySettings {
    showModel: boolean;
    showBase: boolean;
    showTimestamps: boolean;
    showStatus: boolean;
}

export const defaultAgentDisplaySettings: AgentDisplaySettings = {
    showModel: true,
    showBase: true,
    showTimestamps: true,
    showStatus: true,
};

export function readAgentDisplaySettings(raw: unknown): AgentDisplaySettings {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...defaultAgentDisplaySettings };
    const value = raw as Record<string, unknown>;
    return {
        showModel: value.showModel !== false,
        showBase: value.showBase !== false,
        showTimestamps: value.showTimestamps !== false,
        showStatus: value.showStatus as boolean,
    };
}

interface AgentDisplaySettingsDialogProps {
    open: boolean;
    settings: AgentDisplaySettings;
    saving?: boolean;
    onClose: () => void;
    onSave: (settings: AgentDisplaySettings) => void | Promise<void>;
}

const rows: Array<{ key: keyof AgentDisplaySettings; label: string; description: string }> = [
    { key: 'showModel', label: i18n('Show model'), description: i18n('Show the selected model in the session card tags.') },
    { key: 'showTimestamps', label: i18n('Show creation and update times'), description: i18n('Show the creation time and relative update time in the Base Detail style.') },
    { key: 'showStatus', label: i18n('Show live status'), description: i18n('Show the current runtime status before each session card title.') },
];

export function AgentDisplaySettingsDialog({ open, settings, saving = false, onClose, onSave }: AgentDisplaySettingsDialogProps) {
    const [draft, setDraft] = useState(settings);

    useEffect(() => {
        if (!open) return undefined;
        setDraft(settings);
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !saving) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        const previousBodyOverflow = document.body.style.overflow;
        const previousDocumentOverflow = document.documentElement.style.overflow;
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = previousBodyOverflow;
            document.documentElement.style.overflow = previousDocumentOverflow;
        };
    }, [onClose, open, settings, saving]);

    if (!open) return null;
    return (
        <div className="bd-settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
            <section className="bd-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="ea-display-settings-title">
                <header className="bd-settings-dialog__header">
                    <h2 id="ea-display-settings-title">◌ {i18n('Display settings')}</h2>
                    <button type="button" className="bd-settings-dialog__close" onClick={onClose} disabled={saving} aria-label={i18n('Close')}>×</button>
                </header>
                <p className="bd-settings-dialog__hint">{i18n('Choose which information to show on session cards.')}</p>
                <div className="bd-settings-dialog__list">
                    {rows.map((row) => (
                        <label className="bd-settings-dialog__row" key={row.key}>
                            <span className="bd-settings-dialog__row-text">
                                <span className="bd-settings-dialog__row-label">{row.label}</span>
                                <span className="bd-settings-dialog__row-description">{row.description}</span>
                            </span>
                            <input
                                type="checkbox"
                                checked={draft[row.key]}
                                disabled={saving}
                                onChange={(event) => {
                                    const checked = event.currentTarget.checked;
                                    setDraft((current) => ({ ...current, [row.key]: checked }));
                                }}
                            />
                        </label>
                    ))}
                    <BaseDisplaySettingSlot
                        value={draft.showBase}
                        disabled={saving}
                        onChange={(showBase) => setDraft((current) => ({ ...current, showBase }))}
                    />
                </div>
                <footer className="bd-settings-dialog__footer">
                    <button type="button" className="bd-settings-button" onClick={onClose} disabled={saving}>{i18n('Cancel')}</button>
                    <button type="button" className="bd-settings-button bd-settings-button--primary" onClick={() => void onSave(draft)} disabled={saving}>{saving ? i18n('Saving...') : i18n('Save')}</button>
                </footer>
            </section>
        </div>
    );
}
