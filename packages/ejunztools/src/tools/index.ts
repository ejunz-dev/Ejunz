import type { SystemToolEntry } from './types';
import { get_current_time } from './get_current_time';
import { fetch_webpage } from './fetch_webpage';

const TOOL_MODULES = [get_current_time, fetch_webpage];

export type { SystemToolEntry } from './types';

export const SYSTEM_TOOLS_CATALOG: SystemToolEntry[] = TOOL_MODULES.map((m) => m.catalog);

const EXECUTORS = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>(
    TOOL_MODULES.map((m) => [m.catalog.id, m.execute.bind(m)])
);

/**
 * Execute a built-in system tool by name.
 * Used by handler/tool (mcp/tool/call/local), model/agent, and worker.
 */
export async function executeSystemTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const execute = EXECUTORS.get(name);
    if (!execute) {
        throw new Error(`Unknown system tool: ${name}`);
    }
    return execute(args || {});
}
