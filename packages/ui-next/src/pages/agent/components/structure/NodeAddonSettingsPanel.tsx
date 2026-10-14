import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentNode } from '../../runtime/session';
import type { AgentAddonView } from '../types';

interface NodeAddonSettingsPanelProps {
    node: AgentNode;
    addons: readonly AgentAddonView[];
    saving: boolean;
    onSave: (addonIds: string[]) => Promise<void>;
}

function selectedAddonIds(node: AgentNode, enabledIds: ReadonlySet<string>): string[] {
    const config = node.config?.addons;
    if (config === undefined) return [...enabledIds].sort();
    return Object.entries(config)
        .filter(([addonId, enabled]) => enabled && enabledIds.has(addonId))
        .map(([addonId]) => addonId)
        .sort();
}

function selectedKey(addonIds: readonly string[]): string {
    return JSON.stringify([...addonIds].sort());
}

export function NodeAddonSettingsPanel({ node, addons, saving, onSave }: NodeAddonSettingsPanelProps) {
    const enabledIds = useMemo(() => new Set(addons.filter((addon) => addon.installed && addon.enabled).map((addon) => addon.addonId)), [addons]);
    const configuredIds = useMemo(() => selectedAddonIds(node, enabledIds), [enabledIds, node.config?.addons, node.nodeId]);
    const configuredKey = node.config?.addons === undefined
        ? 'inherit-global'
        : `configured:${selectedKey(configuredIds)}`;
    const [draftAddonIds, setDraftAddonIds] = useState(configuredIds);
    const [error, setError] = useState('');
    const sourceRef = useRef({ nodeId: node.nodeId, configuredKey });
    const isDirty = selectedKey(draftAddonIds) !== selectedKey(configuredIds);

    useEffect(() => {
        const sourceChanged = sourceRef.current.nodeId !== node.nodeId || sourceRef.current.configuredKey !== configuredKey;
        sourceRef.current = { nodeId: node.nodeId, configuredKey };
        if (sourceChanged || !isDirty) setDraftAddonIds(configuredIds);
    }, [configuredIds, configuredKey, isDirty, node.nodeId]);

    const toggleAddon = (addonId: string) => {
        setDraftAddonIds((current) => current.includes(addonId)
            ? current.filter((id) => id !== addonId)
            : [...current, addonId]);
        setError('');
    };

    const save = async () => {
        if (!isDirty || saving) return;
        setError('');
        try {
            await onSave(draftAddonIds.filter((addonId) => enabledIds.has(addonId)));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    return <div className="eza-nodeAddonSettings">
        <div className="bd-edit-dialog__body eza-nodeAddonConfig">
            <div className="bd-edit-field">
                <h3>Addons</h3>
                <p className="bd-muted">可多选；勾选只修改草稿，不会立即保存。选完后统一点击保存配置。未配置时沿用 Agent 全局设置。</p>
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
                        >{addon.displayName}{!addon.enabled ? ' · Agent 全局未启用' : ''}</button>;
                    })}
                </div>
                {addons.every((addon) => !addon.installed) && <span className="bd-muted">当前 domain 尚未安装 Addon。</span>}
                {isDirty && <span className="bd-muted" role="status">已选择 {draftAddonIds.length} 个 Addon，尚未保存</span>}
                {error && <span className="bd-edit-dialog__error" role="alert">{error}</span>}
            </div>
        </div>
        <footer className="bd-edit-dialog__footer eza-nodeAddonFooter">
            <span className="bd-muted">{saving ? '正在保存…' : ''}</span>
            <button type="button" className="eza-inputConfigCreate" disabled={!isDirty || saving} onClick={() => { void save(); }}>保存配置</button>
        </footer>
    </div>;
}
