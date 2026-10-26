import { BaseDetailHeader } from '@ejunz/ui-next';
import { i18n } from '@/i18n';
import { StateDot, type StateDotState } from '../primitives/StateDot';

export type AgentWebSocketStatus = 'connecting' | 'connected' | 'disconnected';

interface AgentHeaderProps {
    domainId: string;
    domainName: string;
    title?: string;
    webSocketStatus: AgentWebSocketStatus;
    onOpenSettings: () => void;
    onOpenDisplaySettings: () => void;
    treeOpen: boolean;
    onToggleTree: () => void;
    onEditClick: () => void;
    editActive: boolean;
}

function webSocketDotState(status: AgentWebSocketStatus): StateDotState {
    if (status === 'connected') return 'done';
    if (status === 'disconnected') return 'error';
    return 'ongoing';
}

function webSocketLabel(status: AgentWebSocketStatus): string {
    if (status === 'connected') return i18n('WS connected');
    if (status === 'disconnected') return i18n('WS disconnected');
    return i18n('WS connecting');
}

export function AgentHeader({ domainId, domainName, title = 'Ejunz agent', webSocketStatus, onOpenSettings, onOpenDisplaySettings, treeOpen, onToggleTree, onEditClick, editActive }: AgentHeaderProps) {
    return <BaseDetailHeader
        title={title}
        description={domainName}
        domainId={domainId}
        docId="ejunz-agent"
        treeOpen={treeOpen}
        onToggleTree={onToggleTree}
        onShare={() => undefined}
        onOpenSettings={onOpenSettings}
        onOpenDisplaySettings={onOpenDisplaySettings}
        onEditClick={onEditClick}
        editActive={editActive}
        metadata={<span className="ea-webSocketStatus" role="status" aria-live="polite">
            <StateDot state={webSocketDotState(webSocketStatus)} size={10} />
            <span>{webSocketLabel(webSocketStatus)}</span>
        </span>}
    />;
}
