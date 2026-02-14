/**
 * Shared type for a single system tool catalog entry.
 */
export interface SystemToolEntry {
    id: string;
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, { type: string; description?: string; items?: unknown }>;
    };
}

/**
 * Contract for a tool module: catalog entry + execute function.
 */
export interface ToolModule {
    catalog: SystemToolEntry;
    execute(args: Record<string, unknown>): Promise<unknown>;
}
