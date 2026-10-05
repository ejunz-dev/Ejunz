import { BaseDetailHeader } from '@ejunz/ui-next';
import { StateDot, type StateDotState } from '../primitives/StateDot';

export type AgentWebSocketStatus = 'connecting' | 'connected' | 'disconnected';

interface AgentHeaderProps {
    domainId: string;
    domainName: string;
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
    if (status === 'connected') return 'WS 已连接';
    if (status === 'disconnected') return 'WS 未连接';
    return 'WS 连接中';
}

export function AgentHeader({ domainId, domainName, webSocketStatus, onOpenSettings, onOpenDisplaySettings, treeOpen, onToggleTree, onEditClick, editActive }: AgentHeaderProps) {
    return <BaseDetailHeader
        title="Ejunz agent"
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
        metadata={<span className="eja-webSocketStatus" role="status" aria-live="polite">
            <StateDot state={webSocketDotState(webSocketStatus)} size={10} />
            <span>{webSocketLabel(webSocketStatus)}</span>
        </span>}
    />;
}
