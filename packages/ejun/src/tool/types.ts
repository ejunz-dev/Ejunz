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

/** Model-facing declaration of one registered tool. */
export interface ToolSpec {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}

/** Payload of the `tool/called` event, emitted after a mutating tool call succeeds. */
export interface ToolCalledPayload {
    name: string;
    source: string;
    domainId: string;
    baseDocId: number;
    owner: number;
}
