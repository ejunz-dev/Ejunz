export interface ToolContext {
    domainId: string;
    baseDocId: number;
    owner: number;
    sessionId?: string;
    priv?: number;
    perm?: bigint;
    scope?: bigint;
    /** Agent role permission flags for this session. */
    agentPerm?: bigint;
    /** Session add-ons allowed to expose and execute tools for this Agent request. */
    mountedAddons?: ReadonlySet<string>;
    /** Non-core permission IDs contributed by mounted Addons. */
    agentPermissions?: ReadonlySet<string>;
    broadcastAgentEvent?: (event: 'agent/addon-state' | 'agent/team-context' | 'agent/group-context' | 'agent/agent-context' | 'agent/acl-update', payload: Record<string, unknown>) => Promise<unknown> | unknown;
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
