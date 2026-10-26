import { i18n } from '@/i18n';
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
    return <aside className="ea-detailsPanel">
        <div className="ea-detailsHeader"><strong>{tool ? i18n('Tool details') : i18n('Session details')}</strong><button type="button" onClick={onClose}>×</button></div>
        {tool ? <ToolDetails message={tool} /> : <dl className="ea-detailsList">
            <dt>{i18n('Title')}</dt><dd>{title}</dd>
            <dt>{i18n('Status')}</dt><dd>{running ? i18n('Running') : i18n('Idle')}</dd>
            <dt>{i18n('Agent preset')}</dt><dd>{agentPreset || i18n('Default')}</dd>
            {models && <><dt>{i18n('Model')}</dt><dd>{models.current.model || i18n('Not selected')}</dd><dt>{i18n('Provider')}</dt><dd>{models.current.provider || i18n('Not selected')}</dd></>}
        </dl>}
    </aside>;
}
