import { useEffect, useState, type ReactNode } from 'react';
import type { DraftAttachment } from '../../runtime/uploads';
import type { AgentSummary, AgentTeam, BaseView } from '../../runtime/session';
import { defineSlot } from '../../../../registry';
import type { HostOption } from '../structure/HostPicker';
import type { SessionModels } from '../types';
import { InputBar } from '../conversation/skeleton/InputBar';
import type { AgentPresetOption } from '../settings/AgentPresetSeat';

interface InputConfigDialogProps {
    hosts: readonly HostOption[];
    selectedHostId: string;
    onPickHost: (runtimeId: string) => void;
    bases: readonly BaseView[];
    selectedBaseId?: number;
    onPickBase: (baseId: number | undefined) => void;
    teams: readonly AgentTeam[];
    agents: readonly AgentSummary[];
    selectedAgentId?: string;
    onPickAgent: (agentId: string | undefined) => void;
    selectedTeamId?: string;
    onPickTeam: (teamId: string | undefined) => void;
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
    onCreateOnly: (name: string) => void;
    onClose: () => void;
}

interface NewSessionContextSlotProps {
    bases: readonly BaseView[];
    selectedBaseId?: number;
    disabled: boolean;
    onSelectBase: (baseId: number | undefined) => void;
}

const NewSessionContextSlot = defineSlot<NewSessionContextSlotProps>(
    'component:agent-settings-context',
    () => null,
);

function buttonClass(selected: boolean): string {
    return `bd-edit-tag${selected ? ' is-selected' : ''}`;
}

export function InputConfigDialog({
    hosts, selectedHostId, onPickHost,
    bases, selectedBaseId, onPickBase, teams, agents, selectedAgentId, onPickAgent, selectedTeamId, onPickTeam, models, selectModel, agentPresetOptions, agentPresetChoice, onSelectAgentPreset, agentPresetError,
    input, setInput, attachments, onAddFiles, onRemoveAttachment, modelMenuOpen, setModelMenuOpen,
    notice, onCancel, sending, loading, onConfirm, onCreateOnly, onClose,
}: InputConfigDialogProps) {
    const [sessionName, setSessionName] = useState(selectedAgentId ? '新会话' : '新 Agent');
    const [nameEditing, setNameEditing] = useState(false);
    const nameLabel = selectedAgentId ? 'Session 名称' : 'Agent 名称';
    useEffect(() => setSessionName(selectedAgentId ? '新会话' : '新 Agent'), [selectedAgentId]);
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending) onClose(); };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onClose, sending]);
    return <div className="bd-edit-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !sending) onClose(); }}>
        <section className="bd-edit-dialog eza-inputConfigDialog" role="dialog" aria-modal="true" aria-labelledby="eza-input-config-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="bd-edit-dialog__header">
                <div className="eza-inputConfigTitle">
                    {nameEditing ? <input className="eza-titleEditor" autoFocus value={sessionName} disabled={sending} onChange={(event) => setSessionName(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') setNameEditing(false); }} /> : <h2 id="eza-input-config-title">{sessionName}</h2>}
                    <button type="button" className="eza-inputConfigTitleEdit" disabled={sending} onClick={() => setNameEditing((value) => !value)} aria-label={nameEditing ? `完成编辑${nameLabel}` : `编辑${nameLabel}`}>{nameEditing ? '✓' : '✎'}</button>
                </div>
                <button type="button" className="bd-drawer__close" onClick={onClose} disabled={sending} aria-label="关闭">×</button>
            </header>
            {loading ? <div className="eza-inputConfigLoading" role="status"><span className="eza-sessionSettingsLoadingSpinner" aria-hidden="true" />正在加载最新配置…</div> : <>
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
                        <div className="eza-agentSettingsGroup" key={group.id}>
                            <span className="eza-agentSettingsGroupName">{group.name}</span>
                            <div className="bd-edit-tags">
                                {group.models.map((item) => <button type="button" className={buttonClass(models.current.provider === group.id && models.current.model === item.id)} disabled={sending} key={`${group.id}:${item.id}`} title={item.description || item.name} onClick={() => selectModel(group.id, item.id)}>{item.name}</button>)}
                            </div>
                        </div>
                    )) : <div className="eza-sessionSettingsLoading" role="status"><span className="eza-sessionSettingsLoadingSpinner" aria-hidden="true" />模型加载中…</div>}
                </div>
                <NewSessionContextSlot
                    bases={bases}
                    selectedBaseId={selectedBaseId}
                    disabled={sending}
                    onSelectBase={onPickBase}
                />
                <div className="bd-edit-field">
                    <h3>团队</h3>
                    <div className="bd-edit-tags">
                        <button type="button" className={buttonClass(selectedTeamId === undefined)} disabled={sending} onClick={() => onPickTeam(undefined)}>未分组</button>
                        {teams.map((team) => <button type="button" className={buttonClass(selectedTeamId === team.teamId)} disabled={sending} key={team.teamId} onClick={() => onPickTeam(team.teamId)}>{team.text}</button>)}
                    </div>
                </div>
                <div className="bd-edit-field">
                    <h3>Agent</h3>
                    <div className="bd-edit-tags">
                        <button type="button" className={buttonClass(selectedAgentId === undefined)} disabled={sending} onClick={() => onPickAgent(undefined)}>新建 Agent</button>
                        {agents.filter((agent) => agent.teamId === selectedTeamId).map((agent) => <button type="button" className={buttonClass(selectedAgentId === agent.agentId)} disabled={sending} key={agent.agentId} onClick={() => onPickAgent(agent.agentId)}>{agent.title}</button>)}
                    </div>
                    <span className="bd-muted">{selectedAgentId ? '以下设置会更新所选 Agent，其 Sessions 共用这些设置。' : '以下设置将保存到新建的 Agent。'}</span>
                </div>
                <div className="bd-edit-field">
                    <h3>Agent 预设</h3>
                    <div className="bd-edit-tags">
                        {agentPresetOptions.map((option) => <button type="button" className={buttonClass(agentPresetChoice === option.id)} disabled={sending} key={option.id} title={option.description} onClick={() => onSelectAgentPreset(option.id)}>{option.name || option.id}{option.trust === 'user' ? ' · 自定义' : ''}</button>)}
                    </div>
                    {agentPresetError ? <p className="bd-edit-dialog__error" role="alert">{agentPresetError}</p> : null}
                </div>
            </div>
            <div className="eza-inputConfigHero">
                <div className="eza-inputConfigCreateRow">
                    <button type="button" className="eza-inputConfigCreate" disabled={sending} onClick={() => onCreateOnly(sessionName.trim() || (selectedAgentId ? '新会话' : '新 Agent'))}>{selectedAgentId ? '只创建 Session' : '只创建 Agent'}</button>
                    <span>{selectedAgentId ? '所选 Agent 的设置会应用到这个 Session。' : '参数保存在 Agent 上；创建后可以再添加多个 Session。'}</span>
                </div>
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
                    placeholder={selectedAgentId ? '输入第一条消息，或只创建 Session' : '输入第一条消息，或只创建 Agent'}
                />
            </div>
            </>}
        </section>
    </div>;
}
