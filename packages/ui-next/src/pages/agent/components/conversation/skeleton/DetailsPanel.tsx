import type { ChatMessage, SessionModels } from '../../types';
import { ToolDetails } from '../../tool/ToolDetails';

interface DetailsPanelProps {
    title: string;
    cwd?: string;
    agentPreset?: string;
    running: boolean;
    models: SessionModels | null;
    tool?: ChatMessage;
    onClose: () => void;
}

export function DetailsPanel({ title, cwd, agentPreset, running, models, tool, onClose }: DetailsPanelProps) {
    return <aside className="eja-detailsPanel">
        <div className="eja-detailsHeader"><strong>{tool ? '工具详情' : '会话详情'}</strong><button type="button" onClick={onClose}>×</button></div>
        {tool ? <ToolDetails message={tool} /> : <dl className="eja-detailsList">
            <dt>标题</dt><dd>{title}</dd>
            <dt>状态</dt><dd>{running ? '运行中' : '空闲'}</dd>
            <dt>工作目录</dt><dd>{cwd || '未设置'}</dd>
            <dt>Agent preset</dt><dd>{agentPreset || '默认'}</dd>
            {models && <><dt>模型</dt><dd>{models.current.model || '未选择'}</dd><dt>Provider</dt><dd>{models.current.provider || '未选择'}</dd></>}
        </dl>}
    </aside>;
}
