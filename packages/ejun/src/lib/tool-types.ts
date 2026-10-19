export interface ToolContext {
    domainId: string;
    baseDocId: number;
    owner: number;
    sessionId?: string;
    priv?: number;
    perm?: bigint;
    scope?: bigint;
    /** Session add-ons allowed to expose and execute tools for this Agent request. */
    mountedAddons?: ReadonlySet<string>;
    /** Permissions granted to the Agent role active in this session's Group. */
    agentPermissions?: ReadonlySet<string>;
    broadcastAgentEvent?: (event: 'agent/addon-state' | 'agent/team-context' | 'agent/agent-context' | 'agent/acl-update', payload: Record<string, unknown>) => Promise<unknown> | unknown;
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
    addonId: string;
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
