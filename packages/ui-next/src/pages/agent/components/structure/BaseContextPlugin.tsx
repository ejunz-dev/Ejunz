import type { Context } from 'cordis';
import { after } from '../../../../registry';
import type { BaseView, SessionSummary } from '../../runtime/session';
import type { AgentPluginUiRegistration } from '../../runtime/agent-plugin-slots';

interface ContextChoicesProps {
    bases: readonly BaseView[];
    selectedBaseId?: number;
    disabled: boolean;
    onSelectBase: (baseId: number | undefined) => void;
}

interface ContextTabProps {
    view: 'chat' | 'trajectory' | 'model' | 'context' | 'host';
    onViewChange: (view: ContextTabProps['view']) => void;
}

interface BaseDisplaySettingProps {
    value: boolean;
    disabled: boolean;
    onChange: (value: boolean) => void;
}

function baseLabel(session: SessionSummary, bases: readonly BaseView[]): string {
    const rawId = session.agentSettings?.baseDocId;
    const baseId = rawId === undefined || rawId === null || rawId === '' ? NaN : Number(rawId);
    const base = Number.isSafeInteger(baseId) ? bases.find((item) => item.docId === baseId) : undefined;
    return base?.title || (Number.isSafeInteger(baseId) ? `Base #${baseId}` : '未选择');
}

function selectedClass(selected: boolean): string {
    return `bd-edit-tag${selected ? ' is-selected' : ''}`;
}

function BaseChoices({ bases, selectedBaseId, disabled, onSelectBase }: ContextChoicesProps) {
    return <div className="bd-edit-field">
        <h3>知识库</h3>
        <div className="bd-edit-tags">
            <button type="button" className={selectedClass(selectedBaseId === undefined)} disabled={disabled} onClick={() => onSelectBase(undefined)}>不使用</button>
            {bases.map((base) => <button type="button" className={selectedClass(selectedBaseId === base.docId)} disabled={disabled} key={base.docId} onClick={() => onSelectBase(base.docId)}>{base.title}</button>)}
        </div>
    </div>;
}

function BaseContextTab({ view, onViewChange }: ContextTabProps) {
    return <button type="button" role="tab" className={view === 'context' ? 'is-active' : ''} aria-selected={view === 'context'} onClick={() => onViewChange('context')}>插件</button>;
}

function BaseDisplaySetting({ value, disabled, onChange }: BaseDisplaySettingProps) {
    return <label className="bd-settings-dialog__row">
        <span className="bd-settings-dialog__row-text">
            <span className="bd-settings-dialog__row-label">显示知识库</span>
            <span className="bd-settings-dialog__row-description">在 Agent 的标签区域显示使用的知识库。</span>
        </span>
        <input type="checkbox" checked={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    </label>;
}

const baseContextPlugin: AgentPluginUiRegistration = {
    apply(ctx: Context) {
        ctx.effect(() => {
            const disposers = [
                after<ContextChoicesProps>('component:agent-settings-context', BaseChoices, { id: 'agent-base-settings-context' }),
                after<ContextTabProps>('component:agent-context-tab', BaseContextTab, { id: 'agent-base-context-tab' }),
                after<BaseDisplaySettingProps>('component:agent-display-setting-base', BaseDisplaySetting, { id: 'agent-base-display-setting' }),
            ];
            return () => { disposers.forEach((dispose) => dispose()); };
        }, 'Base context UI slots');
    },
    onDisabled({ currentSession, clearDraftContext, clearCurrentContext }) {
        clearDraftContext();
        if (currentSession?.type === 'base_detail') return;
        void clearCurrentContext();
    },
    sessionAgentTags(session, bases, showBase) {
        return showBase ? [`知识库: ${baseLabel(session, bases)}`] : [];
    },
};

export default baseContextPlugin;
