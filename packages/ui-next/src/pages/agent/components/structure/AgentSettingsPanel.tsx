import { useEffect, useState, type ReactNode } from 'react';
import { i18n } from '@/i18n';
import { defineSlot } from '../../../../registry';
import type { BaseView } from '../../runtime/session';
import type { SessionModels } from '../types';
import type { HostOption } from './HostPicker';

type AgentSettingsSection = 'model' | 'context' | 'host';

interface AgentSettingsContextSlotProps {
    bases: readonly BaseView[];
    selectedBaseId?: number;
    disabled: boolean;
    onSelectBase: (baseId: number | undefined) => void;
}

const AgentSettingsContextSlot = defineSlot<AgentSettingsContextSlotProps>(
    'component:agent-settings-context',
    () => null,
);

interface AgentSettingsPanelProps {
    section: AgentSettingsSection;
    models: SessionModels | null;
    bases: readonly BaseView[];
    selectedBaseId?: number;
    hosts?: readonly HostOption[];
    selectedHostId?: string;
    onModel: (provider: string, model: string) => Promise<void>;
    onBase: (value: number | undefined) => Promise<void>;
    onHost: (runtimeId: string) => Promise<void>;
    readOnly?: boolean;
    readOnlyMessage?: string;
    modelActions?: ReactNode;
}

export function AgentSettingsPanel({
    section, models, bases, selectedBaseId,
    hosts = [], selectedHostId = '', onModel, onBase, onHost,
    readOnly = false, readOnlyMessage, modelActions,
}: AgentSettingsPanelProps) {
    const [saving, setSaving] = useState<string | null>(null);
    const [modelSelection, setModelSelection] = useState(models?.current);
    const [hostSelection, setHostSelection] = useState(selectedHostId);
    useEffect(() => setModelSelection(models?.current), [models]);
    useEffect(() => setHostSelection(selectedHostId), [selectedHostId]);
    const [error, setError] = useState('');
    const apply = async (key: string, action: () => Promise<void>) => {
        if (saving !== null) return;
        setSaving(key);
        setError('');
        try {
            await action();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSaving(null);
        }
    };
    const onlineHosts = hosts.filter((host) => host.online !== false);
    const label = i18n(section === 'model' ? 'Model' : section === 'host' ? 'Host' : 'Context');
    return <section className="ea-agentSettingsFields" aria-label={label}>
        {readOnly && readOnlyMessage ? <p className="bd-muted">{readOnlyMessage}</p> : null}
        {error && <div className="bd-edit-dialog__error" role="alert">{error}</div>}
        {section === 'model' ? <div className="bd-edit-field">
            <div className="ea-agentSettingsModelHeader">
                <h2>{i18n('Model')}</h2>
                {modelActions}
            </div>
            {models ? models.groups.map((group) => <div className="ea-agentSettingsGroup" key={group.id}>
                <span className="ea-agentSettingsGroupName">{group.name}</span>
                <div className="bd-edit-tags">
                    {group.models.map((item) => <button type="button" className={`bd-edit-tag${modelSelection?.provider === group.id && modelSelection.model === item.id ? ' is-selected' : ''}`} disabled={saving !== null || readOnly} key={`${group.id}:${item.id}`} onClick={() => void apply(`${group.id}:${item.id}`, () => { setModelSelection({ provider: group.id, model: item.id }); return onModel(group.id, item.id); })} title={item.description || item.name}>{item.name}</button>)}
                </div>
            </div>) : <span className="bd-muted">{i18n('Loading models...')}</span>}
        </div> : section === 'host' ? <div className="bd-edit-field">
            <h2>{i18n('Host')}</h2>
            <div className="bd-edit-tags">
                {onlineHosts.map((host) => <button type="button" className={`bd-edit-tag${hostSelection === host.runtimeId ? ' is-selected' : ''}`} disabled={saving !== null || readOnly} key={host.runtimeId} title={host.runtimeId} onClick={() => void apply(host.runtimeId, () => { setHostSelection(host.runtimeId); return onHost(host.runtimeId); })}>{host.label}</button>)}
                {onlineHosts.length === 0 && <span className="bd-muted">{i18n('No hosts online')}</span>}
            </div>
        </div> : <AgentSettingsContextSlot
            bases={bases}
            selectedBaseId={selectedBaseId}
            disabled={saving !== null || readOnly}
            onSelectBase={(value) => { void apply(`context:${value ?? 'none'}`, () => onBase(value)); }}
        />}
    </section>;
}
