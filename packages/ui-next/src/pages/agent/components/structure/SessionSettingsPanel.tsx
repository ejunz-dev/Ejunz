import { useEffect, useState } from 'react';
import type { BaseView } from '../../runtime/session';
import type { SessionModels } from '../types';
import type { HostOption } from './HostPicker';

type SessionSettingsSection = 'model' | 'context' | 'host';

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
}

export function SessionSettingsPanel({
    section, models, bases, selectedBaseId,
    hosts = [], selectedHostId = '', onModel, onBase, onHost,
}: SessionSettingsPanelProps) {
    const [saving, setSaving] = useState<string | null>(null);
    const [modelSelection, setModelSelection] = useState(models?.current);
    const [baseSelection, setBaseSelection] = useState(selectedBaseId);
    const [hostSelection, setHostSelection] = useState(selectedHostId);
    useEffect(() => setBaseSelection(selectedBaseId), [selectedBaseId]);
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
    return <section className="eja-sessionSettingsPanel" aria-label={label}>
        {error && <div className="bd-edit-dialog__error" role="alert">{error}</div>}
        {section === 'model' ? <div className="bd-edit-field">
            <h2>模型</h2>
            {models ? models.groups.map((group) => <div className="eja-sessionSettingsGroup" key={group.id}>
                <span className="eja-sessionSettingsGroupName">{group.name}</span>
                <div className="bd-edit-tags">
                    {group.models.map((item) => <button type="button" className={`bd-edit-tag${modelSelection?.provider === group.id && modelSelection.model === item.id ? ' is-selected' : ''}`} disabled={saving !== null} key={`${group.id}:${item.id}`} onClick={() => void apply(`${group.id}:${item.id}`, () => { setModelSelection({ provider: group.id, model: item.id }); return onModel(group.id, item.id); })} title={item.description || item.name}>{item.name}</button>)}
                </div>
            </div>) : <span className="bd-muted">模型加载中…</span>}
        </div> : section === 'host' ? <div className="bd-edit-field">
            <h2>主机</h2>
            <div className="bd-edit-tags">
                {onlineHosts.map((host) => <button type="button" className={`bd-edit-tag${hostSelection === host.runtimeId ? ' is-selected' : ''}`} disabled={saving !== null} key={host.runtimeId} title={host.runtimeId} onClick={() => void apply(host.runtimeId, () => { setHostSelection(host.runtimeId); return onHost(host.runtimeId); })}>{host.label}</button>)}
                {onlineHosts.length === 0 && <span className="bd-muted">没有在线的 host</span>}
            </div>
        </div> : <>
            <div className="bd-edit-field">
                <h2>知识库</h2>
                <div className="bd-edit-tags">
                    <button type="button" className={`bd-edit-tag${baseSelection === undefined ? ' is-selected' : ''}`} disabled={saving !== null} onClick={() => { setBaseSelection(undefined); void apply('base:none', () => onBase(undefined)); }}>不使用</button>
                    {bases.map((base) => <button type="button" className={`bd-edit-tag${baseSelection === base.docId ? ' is-selected' : ''}`} disabled={saving !== null} key={base.docId} onClick={() => { setBaseSelection(base.docId); void apply(`base:${base.docId}`, () => onBase(base.docId)); }}>{base.title}</button>)}
                </div>
            </div>
        </>}
    </section>;
}
