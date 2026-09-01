import type { EmbeddingService } from '../service/embedding';

export interface ToolContext {
    domainId: string;
    baseDocId: number;
    owner: number;
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
