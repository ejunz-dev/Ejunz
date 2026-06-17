/**
 * System-tool adapter: core delegates to plugins (e.g. @ejunz/ejunztools) for catalog + executor.
 * Core does not hard-code packages; getSystemToolCatalog / executeSystemTool / tryExecuteSystemTool use registration.
 */
import { Logger } from '../logger';

const logger = new Logger('systemTools');

export type SystemToolCatalogEntry = { name: string; description: string; inputSchema: any };
export interface SystemToolExecutionContext {
    domainId?: string;
    baseDocId?: number;
    branch?: string;
    owner?: number;
    setting?: { get: (k: string) => unknown };
}
export type SystemToolExecutor = (name: string, args: Record<string, unknown>, context?: SystemToolExecutionContext) => Promise<unknown>;

let registeredCatalog: SystemToolCatalogEntry[] = [];
let registeredExecutor: SystemToolExecutor | null = null;

/** Plugin: register executable system tools (name/description/inputSchema). */
export function registerSystemToolCatalog(catalog: SystemToolCatalogEntry[]): void {
    registeredCatalog = Array.isArray(catalog) ? catalog.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
    })) : [];
    logger.info('[tool] systemTools: registerSystemToolCatalog count=%d names=%s', registeredCatalog.length, registeredCatalog.map(t => t.name).join(','));
}

/** Plugin: register system-tool executor. */
export function registerSystemToolExecutor(fn: SystemToolExecutor): void {
    registeredExecutor = typeof fn === 'function' ? fn : null;
    logger.info('[tool] systemTools: registerSystemToolExecutor hasExecutor=%s', !!registeredExecutor);
}

/** Executable system tools; [] if unregistered. */
export function getSystemToolCatalog(): SystemToolCatalogEntry[] {
    return registeredCatalog;
}

/** Run a system tool via plugin executor; throws if not registered. */
export async function executeSystemTool(name: string, args: Record<string, unknown>, context?: SystemToolExecutionContext): Promise<unknown> {
    logger.info('[tool] systemTools: executeSystemTool name=%s hasExecutor=%s', name, !!registeredExecutor);
    if (!registeredExecutor) {
        throw new Error('System tool executor not registered (plugin not loaded)');
    }
    const result = await registeredExecutor(name, args || {}, context);
    logger.info('[tool] systemTools: executeSystemTool name=%s done', name);
    return result;
}

/**
 * If name is in the registered system-tool list, run it and return the result; else null.
 * callTool fallback when no edge metadata is available.
 */
export async function tryExecuteSystemTool(name: string, args: Record<string, unknown>, context?: SystemToolExecutionContext): Promise<unknown | null> {
    const inCatalog = registeredCatalog.some(t => t.name === name);
    logger.info('[tool] systemTools: tryExecuteSystemTool name=%s inCatalog=%s hasExecutor=%s', name, inCatalog, !!registeredExecutor);
    if (!registeredExecutor || !inCatalog) return null;
    try {
        const result = await registeredExecutor(name, args || {}, context);
        logger.info('[tool] systemTools: tryExecuteSystemTool name=%s done ok', name);
        return result;
    } catch (e) {
        logger.warn('[tool] systemTools: tryExecuteSystemTool name=%s caught %s', name, (e as Error)?.message);
        return null;
    }
}
