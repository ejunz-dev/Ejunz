export type MessageRole = 'user' | 'assistant' | 'tool' | 'context' | 'retry' | 'compaction' | 'system';

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
    retry?: number;
    retryDelayMs?: number;
    retryState?: 'scheduled' | 'started' | 'cancelled';
    compactionSummary?: string;
    shadowedItemCount?: number;
    shadowedTokenCount?: number;
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
