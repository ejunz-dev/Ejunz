import { useEffect, useRef, useState } from 'react';
import type { AgentNode } from '../../runtime/session';

interface NodeContextSettingsPanelProps {
    node: AgentNode;
    saving: boolean;
    onSave: (context: string) => Promise<void>;
}

const MAX_NODE_CONTEXT_CHARS = 20_000;

export function NodeContextSettingsPanel({ node, saving, onSave }: NodeContextSettingsPanelProps) {
    const configuredContext = node.config?.context ?? '';
    const configKey = `${node.config?.context === undefined ? 'unset' : 'set'}:${configuredContext}`;
    const [draftContext, setDraftContext] = useState(configuredContext);
    const [error, setError] = useState('');
    const sourceRef = useRef({ nodeId: node.nodeId, configKey });
    const isDirty = draftContext !== configuredContext;

    useEffect(() => {
        const sourceChanged = sourceRef.current.nodeId !== node.nodeId || sourceRef.current.configKey !== configKey;
        sourceRef.current = { nodeId: node.nodeId, configKey };
        if (sourceChanged || !isDirty) setDraftContext(configuredContext);
    }, [configKey, configuredContext, isDirty, node.nodeId]);

    const save = async () => {
        if (!isDirty || saving) return;
        setError('');
        try {
            await onSave(draftContext);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };

    return <div className="eza-nodeAddonSettings">
        <div className="bd-edit-dialog__body eza-nodeAddonConfig">
            <div className="bd-edit-field">
                <h3>上下文</h3>
                <span className="bd-muted">这里填写的上下文会注入此节点下的 card；这是独立的节点上下文，不会关联 Ejunz Base。</span>
                <textarea
                    value={draftContext}
                    maxLength={MAX_NODE_CONTEXT_CHARS}
                    rows={12}
                    disabled={saving}
                    placeholder="为此节点下的会话补充背景、目标或行为说明…"
                    onChange={(event) => { setDraftContext(event.currentTarget.value); setError(''); }}
                />
                <span className="bd-muted">{draftContext.length.toLocaleString()} / {MAX_NODE_CONTEXT_CHARS.toLocaleString()}</span>
                {isDirty && <span className="bd-muted" role="status">上下文尚未保存</span>}
                {error && <span className="bd-edit-dialog__error" role="alert">{error}</span>}
            </div>
        </div>
        <footer className="bd-edit-dialog__footer eza-nodeAddonFooter">
            <span className="bd-muted">{saving ? '正在保存…' : ''}</span>
            <button type="button" className="eza-inputConfigCreate" disabled={!isDirty || saving} onClick={() => { void save(); }}>保存上下文</button>
        </footer>
    </div>;
}
