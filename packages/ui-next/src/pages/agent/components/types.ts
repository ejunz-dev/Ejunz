export type MessageRole = 'user' | 'assistant' | 'tool' | 'context' | 'addon' | 'retry' | 'compaction' | 'system';

export interface ChatSegment {
    kind: 'text' | 'reasoning';
    text: string;
}

import type { UploadedFileMeta } from '../runtime/uploads';

export interface ChatMessage {
    key: string;
    role: MessageRole;
    text: string;
    eventType: string;
    time: number;
    host?: string;
    callId?: string;
    running?: boolean;
    segments?: ChatSegment[];
    toolName?: string;
    toolInput?: string;
    toolOutput?: string;
    toolMeta?: unknown;
    toolError?: boolean;
    parentCallId?: string;
    rootCallId?: string;
    subCallId?: string;
    children?: ChatMessage[];
    contextLabel?: string;
    contextRole?: 'inject' | 'recall';
    contextSummary?: string;
    contextSource?: unknown;
    contextForm?: string;
    contextFiles?: UploadedFileMeta[];
    addonMount?: { addonId: string; enabled: boolean; snapshot?: boolean };
    retry?: number;
    retryDelayMs?: number;
    retryState?: 'scheduled' | 'started' | 'cancelled';
    compactionSummary?: string;
    shadowedItemCount?: number;
    shadowedTokenCount?: number;
    sendStatus?: 'sending' | 'sent';
    pendingEcho?: boolean;
    pendingSessionId?: string;
}

export interface AgentAddonPermissionView {
    id: string;
    name: string;
    description?: string;
}

export interface AgentAddonView {
    addonId: string;
    displayName: string;
    description: string;
    installed: boolean;
    enabled: boolean;
    permissions?: readonly AgentAddonPermissionView[];
    toolPrefixes?: readonly string[];
    contextSources?: readonly string[];
    tools?: { name: string; description: string }[];
}

export interface SessionModels {
    current: { provider: string; model: string; reasoningEffort?: string };
    routable: boolean;
    groups: { id: string; name: string; models: { id: string; name: string; description?: string }[] }[];
}

export interface QueueItem {
    id: string;
    preview: string;
    text?: string;
}

export interface PendingApproval {
    rpcId: string;
    sessionId: string;
    approvalId: string;
    toolName: string;
    reason?: string;
}

export interface QuestionOption {
    label?: string;
    description?: string;
}

export interface PendingQuestion {
    rpcId: string;
    sessionId: string;
    questions: { id: string; question?: string; header?: string; options?: QuestionOption[]; multiSelect?: boolean }[];
}
