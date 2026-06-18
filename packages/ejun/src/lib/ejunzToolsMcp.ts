import { SYSTEM_TOOLS_CATALOG, executeSystemTool } from '@ejunz/ejunztools';

export interface EjunzToolsRuntimeInfo {
    packageName?: string;
    provider?: 'ejunztools';
    mode?: 'builtin' | 'ws';
    version?: string;
    label?: string;
    toolCount?: number;
    startedAt?: Date;
}

const PACKAGE_NAME = '@ejunz/ejunztools';
const DEFAULT_LABEL = 'Ejunz Tools';

let builtinRuntime: EjunzToolsRuntimeInfo | null = null;

function packageVersion() {
    try {
        return require('@ejunz/ejunztools/package.json').version;
    } catch {
        return 'unknown';
    }
}

export function registerBuiltinEjunzToolsRuntime(runtime: EjunzToolsRuntimeInfo) {
    builtinRuntime = {
        packageName: PACKAGE_NAME,
        provider: 'ejunztools',
        mode: 'builtin',
        label: DEFAULT_LABEL,
        version: packageVersion(),
        toolCount: SYSTEM_TOOLS_CATALOG.length,
        ...runtime,
    };
    (globalThis as any).__ejunzToolsRuntime = builtinRuntime;
    return builtinRuntime;
}

export function getBuiltinEjunzToolsRuntime(): EjunzToolsRuntimeInfo | null {
    const globalRuntime = (globalThis as any).__ejunzToolsRuntime
        || (global as any).Ejunz?.ejunzToolsRuntime;
    if (globalRuntime?.provider === 'ejunztools' || globalRuntime?.packageName === PACKAGE_NAME) {
        return registerBuiltinEjunzToolsRuntime(globalRuntime);
    }
    return builtinRuntime;
}

export function getBuiltinEjunzToolsVersion() {
    return getBuiltinEjunzToolsRuntime()?.version || process.env.EJUNZ_TOOLS_VERSION || packageVersion();
}

export function getBuiltinEjunzToolsLabel() {
    return getBuiltinEjunzToolsRuntime()?.label || DEFAULT_LABEL;
}

export function getEjunzToolsCatalog() {
    return SYSTEM_TOOLS_CATALOG;
}

export async function executeBuiltinEjunzToolsTool(name: string, args: Record<string, unknown>) {
    return executeSystemTool(name, args || {});
}

export function apply(ctx: any) {
    (ctx as any).on?.('ejunztools/runtime/register', (runtime: EjunzToolsRuntimeInfo) => {
        registerBuiltinEjunzToolsRuntime(runtime);
    });
}
