import type { SessionEvent } from './conversation';

export interface AgentTeamRole {
    roleId: string;
    name: string;
    permissions: string[];
}

export interface AgentTeamAcl {
    activeRoleId: string;
    roles: AgentTeamRole[];
}

export interface AgentTeamConfig {
    addons?: Record<string, boolean>;
    context?: string;
    acl?: AgentTeamAcl;
}

export interface AgentTeam {
    teamId: string;
    groupId?: number;
    parentTeamId?: string;
    isRootTeam?: boolean;
    text: string;
    order: number;
    config?: AgentTeamConfig;
    createdAt: string;
    updatedAt: string;
}

export interface AgentSummary {
    agentId: string;
    groupId?: number;
    teamId: string;
    title: string;
    order: number;
    settings: { runtimeId?: string; model?: { provider: string; model: string }; baseDocId?: string; agentPreset?: string; roleId?: string };
    config?: { context?: string };
    createdAt: string;
    updatedAt: string;
}

export interface SessionSummary {
    sessionId: string;
    createdAt?: number;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    started?: boolean;
    creatorUserId?: number;
    type?: 'generic' | 'base_detail';
    groupId?: number;
    agentId?: string;
    activeRuntimeId?: string;
    teamId?: string;
    /** Joined from the owning Agent; session configuration is persisted on the Agent. */
    agentSettings?: AgentSummary['settings'];
    projections?: { values?: Record<string, unknown> };
}

export interface BaseView {
    docId: number;
    title: string;
    slug?: string;
}

export interface MuxFrame {
    type?: string;
    sessionId?: string;
    event?: SessionEvent;
    key?: string;
    value?: unknown;
    items?: unknown[];
    rpcId?: string;
    questionRpcId?: string;
    approvalId?: string;
    toolName?: string;
    callId?: string;
    reason?: string;
    questions?: unknown[];
}

export interface HostFrame {
    type?: string;
    sessionId?: string;
    blank?: boolean;
    cwd?: string;
    agentPreset?: string;
    running?: boolean;
    message?: string;
}
