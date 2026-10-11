import type { SessionEvent } from './conversation';

export interface AgentNode {
    nodeId: string;
    agentId?: number;
    parentId?: string;
    isRoot?: boolean;
    text: string;
    order: number;
    createdAt: string;
    updatedAt: string;
}

export interface SessionSummary {
    sessionId: string;
    createdAt?: number;
    updatedAt: number;
    running: boolean;
    blank: boolean;
    creatorUserId?: number;
    type?: 'generic' | 'base_detail';
    agentId?: number;
    baseDocId?: string;
    nodeId?: string;
    cwd?: string;
    agentPreset?: string;
    /** The host that serves this session, as the session's record names it. */
    runtimeId?: string;
    model?: { provider: string; model: string };
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
