import { Logger } from '../logger';
import type { Context } from '../context';
import type { ToolArgs, ToolContext, ToolSpec } from '../lib/tool-types';
import { createAgentToolView } from './tool';
import type { AgentToolView, ToolAccess, WebServiceToolApi } from './tool';

export interface ProviderScope {
    readonly domainId: string;
    readonly owner: number;
    readonly baseDocId?: number;
    readonly sessionId?: string;
    readonly priv?: number;
    readonly perm?: bigint;
    readonly scope?: bigint;
    readonly mountedAddons?: ReadonlySet<string>;
    readonly agentPermissions?: ReadonlySet<string>;
}

export interface Provider {
    readonly scope: Readonly<ProviderScope>;
    catalog(source?: string): ToolSpec[];
    call(name: string, args: ToolArgs, signal: AbortSignal): Promise<unknown>;
}

const providerLogger = new Logger('tools/provider');

export function createProvider(ctx: Context, scope: ProviderScope): Provider {
    const get = (name: string) => (typeof ctx.get === 'function' ? ctx.get(name) : (ctx as any)[name]);
    const server = get('server') as WebServiceToolApi | undefined;
    if (!server) throw new Error('the host WebService is unavailable');
    const tools = () => createAgentToolView(server, ctx);
    const access = (): ToolAccess | undefined => (
        scope.priv === undefined && scope.perm === undefined && scope.agentPermissions === undefined ? undefined
            : { priv: scope.priv, perm: scope.perm, scope: scope.scope ?? scope.perm, agentPermissions: scope.agentPermissions }
    );
    const toolContext = (): ToolContext => ({
        domainId: scope.domainId,
        baseDocId: scope.baseDocId ?? 0,
        owner: scope.owner,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        ...(scope.priv !== undefined ? { priv: scope.priv } : {}),
        ...(scope.perm !== undefined ? { perm: scope.perm } : {}),
        ...(scope.scope !== undefined ? { scope: scope.scope } : {}),
        ...(scope.mountedAddons !== undefined ? { mountedAddons: scope.mountedAddons } : {}),
        ...(scope.agentPermissions !== undefined ? { agentPermissions: scope.agentPermissions } : {}),
        ...(typeof ctx.broadcast === 'function' ? { broadcastAgentEvent: (event, payload) => (ctx.broadcast as any)(event, payload) } : {}),
        setting: get('setting') as ToolContext['setting'],
    });
    return {
        scope: Object.freeze({ ...scope }),
        catalog: (source) => tools().catalog(source, undefined, scope.domainId, access(), scope.mountedAddons),
        async call(name, args, signal) {
            if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
            const startedAt = Date.now();
            providerLogger.info('[provider] call start name=%s domain=%s baseDocId=%d owner=%d', name, scope.domainId, scope.baseDocId ?? 0, scope.owner);
            try {
                const result = await tools().execute(name, args, toolContext());
                if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
                providerLogger.info('[provider] call done name=%s durationMs=%d', name, Date.now() - startedAt);
                return result;
            } catch (error) {
                providerLogger.warn('[provider] call failed name=%s domain=%s durationMs=%d error=%s', name, scope.domainId, Date.now() - startedAt, error instanceof Error ? error.message : String(error));
                throw error;
            }
        },
    };
}
