export interface ToolContext {
    domainId: string;
    baseDocId: number;
    owner: number;
    sessionId?: string;
    priv?: number;
    perm?: bigint;
    scope?: bigint;
    setting?: { get: (k: string) => unknown };
}

export type ToolArgs = Record<string, any>;

export interface SystemToolExecutionContext {
    domainId?: string;
    baseDocId?: number;
    owner?: number;
    setting?: { get: (k: string) => unknown };
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

export interface ToolBaseSelectPayload {
    sessionId: string;
    domainId: string;
    owner: number;
    baseDocId: number;
    baseName?: string;
}
