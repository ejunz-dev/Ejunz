/**
 * 系统工具适配层：核心逻辑在 core，由插件（如 @ejunz/ejunztools）注册 catalog 与 executor。
 * core 不写死任何 package，getSystemToolCatalog / executeSystemTool / tryExecuteSystemTool 均走注册。
 */
import { Logger } from '../logger';

const logger = new Logger('systemTools');

export type SystemToolCatalogEntry = { name: string; description: string; inputSchema: any };
export type SystemToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

let registeredCatalog: SystemToolCatalogEntry[] = [];
let registeredExecutor: SystemToolExecutor | null = null;

/** 插件注册可执行系统工具列表（name/description/inputSchema）。 */
export function registerSystemToolCatalog(catalog: SystemToolCatalogEntry[]): void {
    registeredCatalog = Array.isArray(catalog) ? catalog.map(t => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
    })) : [];
    logger.info('[tool] systemTools: registerSystemToolCatalog count=%d names=%s', registeredCatalog.length, registeredCatalog.map(t => t.name).join(','));
}

/** 插件注册系统工具执行器。 */
export function registerSystemToolExecutor(fn: SystemToolExecutor): void {
    registeredExecutor = typeof fn === 'function' ? fn : null;
    logger.info('[tool] systemTools: registerSystemToolExecutor hasExecutor=%s', !!registeredExecutor);
}

/** 可执行的系统工具列表，用于 getAssignedTools 按 Skill 引用补全；未注册时返回 []。 */
export function getSystemToolCatalog(): SystemToolCatalogEntry[] {
    return registeredCatalog;
}

/** 执行系统工具（由插件注册的 executor 执行）；未注册时抛错。 */
export async function executeSystemTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    logger.info('[tool] systemTools: executeSystemTool name=%s hasExecutor=%s', name, !!registeredExecutor);
    if (!registeredExecutor) {
        throw new Error('System tool executor not registered (plugin not loaded)');
    }
    const result = await registeredExecutor(name, args || {});
    logger.info('[tool] systemTools: executeSystemTool name=%s done', name);
    return result;
}

/**
 * 若 name 在已注册的可执行系统工具列表中则执行并返回结果，否则返回 null。
 * 用于 callTool 兜底：仅配 Skill、参数写在 card 里时，凭 system 字段或此兜底直接调用系统工具。
 */
export async function tryExecuteSystemTool(name: string, args: Record<string, unknown>): Promise<unknown | null> {
    const inCatalog = registeredCatalog.some(t => t.name === name);
    logger.info('[tool] systemTools: tryExecuteSystemTool name=%s inCatalog=%s hasExecutor=%s', name, inCatalog, !!registeredExecutor);
    if (!registeredExecutor || !inCatalog) return null;
    try {
        const result = await registeredExecutor(name, args || {});
        logger.info('[tool] systemTools: tryExecuteSystemTool name=%s done ok', name);
        return result;
    } catch (e) {
        logger.warn('[tool] systemTools: tryExecuteSystemTool name=%s caught %s', name, (e as Error)?.message);
        return null;
    }
}
