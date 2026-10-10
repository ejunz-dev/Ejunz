import { listAgentAddons, registerAgentAddon } from './addons';

/** Legacy descriptor shape kept for plugins that have not moved to addonId yet. */
export interface AgentContextPluginDescriptor {
    pluginId: string;
    displayName: string;
    description: string;
    toolPrefixes?: readonly string[];
    contextSources?: readonly string[];
    defaultEnabled?: boolean;
}

/** Compatibility adapter; new registrations should use registerAgentAddon. */
export function registerAgentContextPlugin(descriptor: AgentContextPluginDescriptor): () => void {
    return registerAgentAddon({
        addonId: descriptor.pluginId,
        displayName: descriptor.displayName,
        description: descriptor.description,
        ...(descriptor.toolPrefixes === undefined ? {} : { toolPrefixes: descriptor.toolPrefixes }),
        ...(descriptor.contextSources === undefined ? {} : { contextSources: descriptor.contextSources }),
        ...(descriptor.defaultEnabled === undefined ? {} : { defaultEnabled: descriptor.defaultEnabled }),
    });
}

/** Compatibility view of addon descriptors using the old pluginId property. */
export function listAgentContextPlugins(): AgentContextPluginDescriptor[] {
    return listAgentAddons().map((addon) => ({
        pluginId: addon.addonId,
        displayName: addon.displayName,
        description: addon.description,
        ...(addon.toolPrefixes === undefined ? {} : { toolPrefixes: addon.toolPrefixes }),
        ...(addon.contextSources === undefined ? {} : { contextSources: addon.contextSources }),
        ...(addon.defaultEnabled === undefined ? {} : { defaultEnabled: addon.defaultEnabled }),
    }));
}
