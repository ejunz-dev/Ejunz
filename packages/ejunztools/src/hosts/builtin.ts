import { SYSTEM_TOOLS_CATALOG, executeSystemTool } from '../tools';
import { toolsVersion } from '../config';
import log from '../log';

export interface EjunzToolsRuntimeInfo {
    packageName: string;
    provider: 'ejunztools';
    mode: 'builtin';
    version: string;
    label: string;
    toolCount: number;
    startedAt: Date;
}

function runtimeInfo(config: any = {}): EjunzToolsRuntimeInfo {
    return {
        packageName: '@ejunz/ejunztools',
        provider: 'ejunztools',
        mode: 'builtin',
        version: toolsVersion(config),
        label: process.env.EJUNZ_TOOLS_LABEL || config.toolsLabel || 'Ejunz Tools',
        toolCount: SYSTEM_TOOLS_CATALOG.length,
        startedAt: new Date(),
    };
}

export function getBuiltinRuntime(config: any = {}): EjunzToolsRuntimeInfo {
    return runtimeInfo(config);
}

export function apply(ctx: any, config: any = {}) {
    const runtime = runtimeInfo(config);
    (globalThis as any).__ejunzToolsRuntime = runtime;
    if ((global as any).Ejunz) (global as any).Ejunz.ejunzToolsRuntime = runtime;
    try {
        require('ejun/src/lib/ejunzToolsMcp').registerBuiltinEjunzToolsRuntime(runtime);
    } catch {
        // ejun is not available when ejunztools is used as a standalone package.
    }
    try {
        (ctx?.emit as any)?.('ejunztools/runtime/register', runtime);
    } catch {
        // ignore registration event failures; the global marker remains available.
    }
    log.info('Ejunz Tools builtin MCP provider started (version=%s, tools=%d). Install it from /mcp/market per domain to show it in /mcp.', runtime.version, runtime.toolCount);
    return runtime;
}

export { SYSTEM_TOOLS_CATALOG, executeSystemTool };
