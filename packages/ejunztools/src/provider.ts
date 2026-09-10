import { Logger } from 'ejun/src/logger';
import type { Context } from 'ejun/src/context';
import type {} from './registry';
import type { ToolArgs, ToolContext, ToolSpec } from './types';

const logger = new Logger('ejunztools/provider');

export interface ProviderScope {
    readonly domainId: string;
    readonly owner: number;
    readonly baseDocId?: number;
    readonly sessionId?: string;
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
        if (!tools) throw new Error('ejunztools: the host tool registry is unavailable');
        return tools;
    };
    const toolContext = (): ToolContext => ({
        domainId: scope.domainId,
        baseDocId: scope.baseDocId ?? 0,
        owner: scope.owner,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
        setting: get('setting'),
        embedding: get('embedding'),
    });
    return {
        scope: Object.freeze({ ...scope }),
        catalog: (source?: string) => registry().catalog(source, undefined, scope.domainId),
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
