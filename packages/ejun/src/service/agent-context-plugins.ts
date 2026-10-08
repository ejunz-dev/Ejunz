export interface AgentContextPluginDescriptor {
    pluginId: string;
    displayName: string;
    description: string;
    /** Whether this plugin is available before the domain overrides it. Defaults to enabled. */
    defaultEnabled?: boolean;
}

interface AgentContextPluginRegistry {
    plugins: Map<string, AgentContextPluginDescriptor>;
}

const root = globalThis as typeof globalThis & { __ejunzAgentContextPlugins?: AgentContextPluginRegistry };
const registry = root.__ejunzAgentContextPlugins ||= { plugins: new Map() };

/** Register one plugin that can contribute context to Agent sessions. */
export function registerAgentContextPlugin(descriptor: AgentContextPluginDescriptor): () => void {
    if (!descriptor?.displayName || !/^[a-z][a-z0-9._-]{0,63}$/.test(descriptor.pluginId)) {
        throw new Error('Agent context plugin requires a valid pluginId and displayName.');
    }
    if (registry.plugins.has(descriptor.pluginId)) {
        throw new Error(`Agent context plugin "${descriptor.pluginId}" is already registered.`);
    }
    const value = { ...descriptor };
    registry.plugins.set(value.pluginId, value);
    return () => {
        if (registry.plugins.get(value.pluginId) === value) registry.plugins.delete(value.pluginId);
    };
}

export function listAgentContextPlugins(): AgentContextPluginDescriptor[] {
    return [...registry.plugins.values()].map((plugin) => ({ ...plugin }));
}
