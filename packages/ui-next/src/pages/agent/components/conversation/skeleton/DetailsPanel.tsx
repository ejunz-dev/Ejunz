import type { ChatMessage, SessionModels } from '../../types';
import { ToolDetails } from '../../tool/ToolDetails';

interface DetailsPanelProps {
    title: string;
    agentPreset?: string;
    running: boolean;
    models: SessionModels | null;
    tool?: ChatMessage;
    onClose: () => void;
}

export function DetailsPanel({ title, agentPreset, running, models, tool, onClose }: DetailsPanelProps) {
    return <aside className="eza-detailsPanel">
        <div className="eza-detailsHeader"><strong>{tool ? '工具详情' : '会话详情'}</strong><button type="button" onClick={onClose}>×</button></div>
        {tool ? <ToolDetails message={tool} /> : <dl className="eza-detailsList">
            <dt>标题</dt><dd>{title}</dd>
            <dt>状态</dt><dd>{running ? '运行中' : '空闲'}</dd>
            <dt>Agent preset</dt><dd>{agentPreset || '默认'}</dd>
            {models && <><dt>模型</dt><dd>{models.current.model || '未选择'}</dd><dt>Provider</dt><dd>{models.current.provider || '未选择'}</dd></>}
        </dl>}
    </aside>;
}
