import { Logger } from 'ejun/src/logger';
import type { Context } from 'ejun/src/context';
// Pulls the `ctx.tools` declaration on Context into this program's types.
import type {} from 'ejun/src/service/tools';
import type { ToolArgs, ToolContext, ToolSpec } from './types';

const logger = new Logger('ejunztools/provider');

/** Scope one provider acts for. */
export interface ProviderScope {
    readonly domainId: string;
    readonly owner: number;
    /** Base the tools act on, when the scope is bound to one. */
    readonly baseDocId?: number;
}

/**
 * Executes the tools an addon registered, for one scope.
 *
 * The provider holds no tool list of its own: it reads the registry on every call,
 * so a tool registered later — by any addon — is callable without rebuilding it.
 */
export interface Provider {
    readonly scope: Readonly<ProviderScope>;
    /**
     * Read the tools this scope exposes.
     * @param source - restrict to one registered source; omitted reads every source.
     * @returns the model-facing declarations.
     */
    catalog(source?: string): ToolSpec[];
    /**
     * Execute one registered tool.
     * @param name - tool name.
     * @param args - tool arguments.
     * @param signal - aborts the call.
     * @returns the tool result.
     */
    call(name: string, args: ToolArgs, signal: AbortSignal): Promise<unknown>;
}

/**
 * Build a provider over the tools registered in `ctx`.
 * @param ctx - context holding the tool registry.
 * @param scope - domain, Base, and owner every call acts for.
 * @returns the provider for that scope.
 */
export function createProvider(
    ctx: Context,
    scope: ProviderScope,
): Provider {
    const services = ctx as any;
    const get = (name: string) => (typeof services.get === 'function' ? services.get(name) : services[name]);
    // The registry is read through the service store: a service property read is checked
    // against the reading fiber's inject list, which the caller's context need not declare.
    const registry = () => {
        const tools = get('tools');
        if (!tools) throw new Error('ejunztools: the host tool registry is unavailable');
        return tools;
    };
    const toolContext = (): ToolContext => ({
        domainId: scope.domainId,
        baseDocId: scope.baseDocId ?? 0,
        owner: scope.owner,
        setting: get('setting'),
        embedding: get('embedding'),
    });
    return {
        scope: Object.freeze({ ...scope }),
        catalog: (source?: string) => registry().catalog(source),
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
