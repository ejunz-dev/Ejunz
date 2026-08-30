import { Logger } from '../logger';
import type { Context } from '../context';
import { executeBaseTool, isMcpBuiltinMutatingTool } from '../model/tool';

const logger = new Logger('service/provider');

export interface Provider {
    readonly scope: {
        readonly domain: string;
        readonly baseId: number;
        readonly owner: number;
        readonly baseName?: string;
    };
    call(name: string, args: Record<string, any>, signal: AbortSignal): Promise<any>;
}

export function createProvider(
    ctx: Context,
    scope: Provider['scope'],
): Provider {
    return {
        scope: Object.freeze({ ...scope }),
        async call(name, args, signal) {
            const startedAt = Date.now();
            if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
            logger.info('[base-provider] call start name=%s domain=%s baseId=%d owner=%d', name, scope.domain, scope.baseId, scope.owner);
            try {
                const services = ctx as any;
                const get = typeof services.get === 'function' ? (name: string) => services.get(name) : (name: string) => services[name];
                const result = await executeBaseTool({
                    domainId: scope.domain,
                    baseDocId: scope.baseId,
                    owner: scope.owner,
                    setting: get('setting'),
                    embedding: get('embedding'),
                }, name, args);
                if (signal.aborted) throw signal.reason ?? new Error('provider call aborted');
                if (isMcpBuiltinMutatingTool(name)) {
                    ctx.broadcast('base/update', scope.baseId, scope.owner, undefined, name);
                }
                logger.info('[base-provider] call done name=%s domain=%s baseId=%d durationMs=%d', name, scope.domain, scope.baseId, Date.now() - startedAt);
                return result;
            } catch (error) {
                logger.warn('[base-provider] call failed name=%s domain=%s baseId=%d durationMs=%d error=%s', name, scope.domain, scope.baseId, Date.now() - startedAt, error instanceof Error ? error.message : String(error));
                throw error;
            }
        },
    };
}
