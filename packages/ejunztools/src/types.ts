import type { EmbeddingService } from 'ejun/src/service/embedding';

export interface ToolContext {
    domainId: string;
    baseDocId: number;
    owner: number;
    sessionId?: string;
    setting?: { get: (k: string) => unknown };
    embedding?: EmbeddingService;
}

export type ToolArgs = Record<string, any>;

export interface SystemToolExecutionContext {
    domainId?: string;
    baseDocId?: number;
    owner?: number;
    setting?: { get: (k: string) => unknown };
    embedding?: EmbeddingService;
}

export interface ToolSpec {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

export interface ToolCalledPayload {
    name: string;
    source: string;
    domainId: string;
    baseDocId: number;
    owner: number;
}
