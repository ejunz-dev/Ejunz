import { useEffect, useState } from 'react';
import { defineSlot } from '../../../../registry';
import type { BaseView } from '../../runtime/session';
import type { SessionModels } from '../types';
import type { HostOption } from './HostPicker';

type SessionSettingsSection = 'model' | 'context' | 'host';

interface AgentSessionContextSlotProps {
    bases: readonly BaseView[];
    selectedBaseId?: number;
    disabled: boolean;
    onSelectBase: (baseId: number | undefined) => void;
}

const AgentSessionContextSlot = defineSlot<AgentSessionContextSlotProps>(
    'component:agent-session-context',
    () => null,
);

interface SessionSettingsPanelProps {
    section: SessionSettingsSection;
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
}

export function SessionSettingsPanel({
    section, models, bases, selectedBaseId,
    hosts = [], selectedHostId = '', onModel, onBase, onHost,
    readOnly = false, readOnlyMessage,
}: SessionSettingsPanelProps) {
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
    const label = section === 'model' ? '模型' : section === 'host' ? '主机' : '上下文';
    return <section className="eza-sessionSettingsPanel" aria-label={label}>
        {readOnly && readOnlyMessage ? <p className="bd-muted">{readOnlyMessage}</p> : null}
        {error && <div className="bd-edit-dialog__error" role="alert">{error}</div>}
        {section === 'model' ? <div className="bd-edit-field">
            <h2>模型</h2>
            {models ? models.groups.map((group) => <div className="eza-sessionSettingsGroup" key={group.id}>
                <span className="eza-sessionSettingsGroupName">{group.name}</span>
                <div className="bd-edit-tags">
                    {group.models.map((item) => <button type="button" className={`bd-edit-tag${modelSelection?.provider === group.id && modelSelection.model === item.id ? ' is-selected' : ''}`} disabled={saving !== null || readOnly} key={`${group.id}:${item.id}`} onClick={() => void apply(`${group.id}:${item.id}`, () => { setModelSelection({ provider: group.id, model: item.id }); return onModel(group.id, item.id); })} title={item.description || item.name}>{item.name}</button>)}
                </div>
            </div>) : <span className="bd-muted">模型加载中…</span>}
        </div> : section === 'host' ? <div className="bd-edit-field">
            <h2>主机</h2>
            <div className="bd-edit-tags">
                {onlineHosts.map((host) => <button type="button" className={`bd-edit-tag${hostSelection === host.runtimeId ? ' is-selected' : ''}`} disabled={saving !== null || readOnly} key={host.runtimeId} title={host.runtimeId} onClick={() => void apply(host.runtimeId, () => { setHostSelection(host.runtimeId); return onHost(host.runtimeId); })}>{host.label}</button>)}
                {onlineHosts.length === 0 && <span className="bd-muted">没有在线的 host</span>}
            </div>
        </div> : <AgentSessionContextSlot
            bases={bases}
            selectedBaseId={selectedBaseId}
            disabled={saving !== null || readOnly}
            onSelectBase={(value) => { void apply(`context:${value ?? 'none'}`, () => onBase(value)); }}
        />}
    </section>;
}
