import { useEffect, useState, type ReactNode } from 'react';
import type { DraftAttachment } from '../../runtime/uploads';
import type { BaseView, WorkspaceView } from '../../runtime/session';
import type { HostOption } from '../structure/HostPicker';
import type { SessionModels } from '../types';
import { InputBar } from '../conversation/skeleton/InputBar';
import { AgentPresetSeat, type AgentPresetOption } from '../settings/AgentPresetSeat';

interface InputConfigDialogProps {
    hosts: readonly HostOption[];
    selectedHostId: string;
    onPickHost: (runtimeId: string) => void;
    bases: readonly BaseView[];
    selectedBaseId?: number;
    onPickBase: (baseId: number | undefined) => void;
    workspaces: readonly WorkspaceView[];
    selectedWorkspaceId?: string;
    onPickWorkspace: (workspaceId: string | undefined) => void;
    onCreateWorkspace: () => void;
    models: SessionModels | null;
    selectModel: (provider: string, model: string) => void;
    agentPresetOptions: readonly AgentPresetOption[];
    agentPresetChoice: string;
    onSelectAgentPreset: (id: string) => void;
    agentPresetError?: string | null;
    input: string;
    setInput: (value: string) => void;
    attachments: DraftAttachment[];
    onAddFiles: (files: File[]) => void;
    onRemoveAttachment: (id: string) => void;
    modelMenuOpen: boolean;
    setModelMenuOpen: (value: boolean) => void;
    notice?: ReactNode;
    onCancel: () => void;
    sending: boolean;
    loading: boolean;
    onConfirm: (name: string) => void;
    onClose: () => void;
}

function buttonClass(selected: boolean): string {
    return `bd-edit-tag${selected ? ' is-selected' : ''}`;
}

export function InputConfigDialog({
    hosts, selectedHostId, onPickHost,
    bases, selectedBaseId, onPickBase, workspaces, selectedWorkspaceId, onPickWorkspace,
    onCreateWorkspace, models, selectModel, agentPresetOptions, agentPresetChoice, onSelectAgentPreset, agentPresetError,
    input, setInput, attachments, onAddFiles, onRemoveAttachment, modelMenuOpen, setModelMenuOpen,
    notice, onCancel, sending, loading, onConfirm, onClose,
}: InputConfigDialogProps) {
    const [sessionName, setSessionName] = useState('新会话');
    const [nameEditing, setNameEditing] = useState(false);
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending) onClose(); };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onClose, sending]);

    return <div className="bd-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose(); }}>
        <section className="bd-edit-dialog eja-inputConfigDialog" role="dialog" aria-modal="true" aria-labelledby="eja-input-config-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="bd-edit-dialog__header">
                <div className="eja-inputConfigTitle">
                    {nameEditing ? <input className="eja-titleEditor" autoFocus value={sessionName} disabled={sending} onChange={(event) => setSessionName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') setNameEditing(false); }} /> : <h2 id="eja-input-config-title">{sessionName}</h2>}
                    <button type="button" className="eja-inputConfigTitleEdit" disabled={sending} onClick={() => setNameEditing((value) => !value)} aria-label={nameEditing ? '完成编辑会话名称' : '编辑会话名称'}>{nameEditing ? '✓' : '✎'}</button>
                </div>
                <button type="button" className="bd-drawer__close" onClick={onClose} disabled={sending} aria-label="关闭">×</button>
            </header>
            {loading ? <div className="eja-inputConfigLoading" role="status"><span className="eja-sessionSettingsLoadingSpinner" aria-hidden="true" />正在加载最新配置…</div> : <>
            <div className="bd-edit-dialog__body">
                <div className="bd-edit-field">
                    <h3>主机</h3>
                    <div className="bd-edit-tags">
                        {hosts.filter((host) => host.online !== false).map((host) => (
                            <button type="button" className={buttonClass(host.runtimeId === selectedHostId)} disabled={sending} key={host.runtimeId} title={host.runtimeId} onClick={() => onPickHost(host.runtimeId)}>{host.label}</button>
                        ))}
                        {!hosts.some((host) => host.online !== false) && <span className="bd-muted">没有在线的 host</span>}
                    </div>
                </div>
                <div className="bd-edit-field">
                    <h3>模型</h3>
                    {models ? models.groups.map((group) => (
                        <div className="eja-sessionSettingsGroup" key={group.id}>
                            <span className="eja-sessionSettingsGroupName">{group.name}</span>
                            <div className="bd-edit-tags">
                                {group.models.map((item) => <button type="button" className={buttonClass(models.current.provider === group.id && models.current.model === item.id)} disabled={sending} key={`${group.id}:${item.id}`} title={item.description || item.name} onClick={() => selectModel(group.id, item.id)}>{item.name}</button>)}
                            </div>
                        </div>
                    )) : <div className="eja-sessionSettingsLoading" role="status"><span className="eja-sessionSettingsLoadingSpinner" aria-hidden="true" />模型加载中…</div>}
                </div>
                <div className="bd-edit-field">
                    <h3>知识库</h3>
                    <div className="bd-edit-tags">
                        <button type="button" className={buttonClass(selectedBaseId === undefined)} disabled={sending} onClick={() => onPickBase(undefined)}>不使用</button>
                        {bases.map((base) => <button type="button" className={buttonClass(selectedBaseId === base.docId)} disabled={sending} key={base.docId} onClick={() => onPickBase(base.docId)}>{base.title}</button>)}
                    </div>
                </div>
                <div className="bd-edit-field">
                    <h3>工作区</h3>
                    <div className="bd-edit-tags">
                        <button type="button" className={buttonClass(selectedWorkspaceId === undefined)} disabled={sending} onClick={() => onPickWorkspace(undefined)}>未分组</button>
                        {workspaces.map((workspace) => <button type="button" className={buttonClass(selectedWorkspaceId === workspace.workspaceId)} disabled={sending} key={workspace.workspaceId} onClick={() => onPickWorkspace(workspace.workspaceId)}>{workspace.title}</button>)}
                        <button type="button" className="bd-edit-tag" disabled={sending} onClick={onCreateWorkspace}>新建工作区</button>
                    </div>
                </div>
                <div className="bd-edit-field">
                    <h3>Agent 预设</h3>
                    <div className="bd-edit-tags">
                        {agentPresetOptions.map((option) => <button type="button" className={buttonClass(agentPresetChoice === option.id)} disabled={sending} key={option.id} title={option.description} onClick={() => onSelectAgentPreset(option.id)}>{option.name || option.id}{option.trust === 'user' ? ' · 自定义' : ''}</button>)}
                    </div>
                    {agentPresetError ? <p className="bd-edit-dialog__error" role="alert">{agentPresetError}</p> : null}
                </div>
            </div>
            <div className="eja-inputConfigHero">
                <InputBar
                    hero
                    input={input}
                    setInput={setInput}
                    send={() => onConfirm(sessionName.trim() || '新会话')}
                    cancel={onCancel}
                    running={false}
                    sending={sending}
                    attachments={attachments}
                    onAddFiles={onAddFiles}
                    onRemoveAttachment={onRemoveAttachment}
                    models={models}
                    showModelPicker={false}
                    modelMenuOpen={modelMenuOpen}
                    setModelMenuOpen={setModelMenuOpen}
                    selectModel={selectModel}
                    notice={notice}
                    placeholder="输入第一条消息"
                />
            </div>
            </>}
        </section>
    </div>;
}
