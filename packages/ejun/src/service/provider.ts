import { Logger } from 'ejun/src/logger';
import type { Context } from 'ejun/src/context';
import type { ToolAccess } from './registry';
import type { ToolArgs, ToolContext, ToolSpec } from '../lib/tool-types';

const logger = new Logger('tools/provider');

export interface ProviderScope {
    readonly domainId: string;
    readonly owner: number;
    readonly baseDocId?: number;
    readonly sessionId?: string;
    readonly priv?: number;
    readonly perm?: bigint;
    readonly scope?: bigint;
}

export interface Provider {
    readonly scope: Readonly<ProviderScope>;
    catalog(source?: string): ToolSpec[];
    call(name: string, args: ToolArgs, signal: AbortSignal): Promise<unknown>;
}

export function createProvider(
    ctx: Context,
    scope: ProviderScope,
): Provider {
    const services = ctx as any;
    const get = (name: string) => (typeof services.get === 'function' ? services.get(name) : services[name]);
    const registry = () => {
        const tools = get('tools');
        if (!tools) throw new Error('the host tool registry is unavailable');
        return tools;
    };
    const access = (): ToolAccess | undefined => (
        scope.priv === undefined && scope.perm === undefined ? undefined
            : { priv: scope.priv, perm: scope.perm, scope: scope.scope ?? scope.perm }
    );
    const toolContext = (): ToolContext => ({
        domainId: scope.domainId,
        baseDocId: scope.baseDocId ?? 0,
        owner: scope.owner,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        ...(scope.priv !== undefined ? { priv: scope.priv } : {}),
        ...(scope.perm !== undefined ? { perm: scope.perm } : {}),
        ...(scope.scope !== undefined ? { scope: scope.scope } : {}),
        setting: get('setting'),
    });
    return {
        scope: Object.freeze({ ...scope }),
        catalog: (source?: string) => registry().catalog(source, undefined, scope.domainId, access()),
        async call(name, args, signal) {
            if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
            const startedAt = Date.now();
            logger.info('[provider] call start name=%s domain=%s baseDocId=%d owner=%d', name, scope.domainId, scope.baseDocId ?? 0, scope.owner);
            try {
                const result = await registry().execute(name, args, toolContext());
                if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
                logger.info('[provider] call done name=%s durationMs=%d', name, Date.now() - startedAt);
                return result;
            } catch (error) {
                logger.warn('[provider] call failed name=%s domain=%s durationMs=%d error=%s', name, scope.domainId, Date.now() - startedAt, error instanceof Error ? error.message : String(error));
                throw error;
            }
        },
    };
}
