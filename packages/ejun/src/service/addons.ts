export interface AgentAddonDescriptor {
    addonId: string;
    displayName: string;
    description: string;
    /** Tool-name prefixes owned by this add-on, used to label its tool calls in chat. */
    toolPrefixes?: readonly string[];
    /** Context-source IDs owned by this add-on, used to label its context messages in chat. */
    contextSources?: readonly string[];
    /** Whether this add-on is available before the domain overrides it. Defaults to enabled. */
    defaultEnabled?: boolean;
}

interface AgentAddonRegistry {
    addons: Map<string, AgentAddonDescriptor>;
}

const root = globalThis as typeof globalThis & { __ejunzAgentAddons?: AgentAddonRegistry };
const registry = root.__ejunzAgentAddons ||= { addons: new Map() };

/** Register one add-on that owns a tool bundle and optional context sources. */
export function registerAgentAddon(descriptor: AgentAddonDescriptor): () => void {
    if (!descriptor?.displayName || !/^[a-z][a-z0-9._-]{0,63}$/.test(descriptor.addonId)) {
        throw new Error('Agent add-on requires a valid addonId and displayName.');
    }
    if (descriptor.toolPrefixes?.some((prefix) => typeof prefix !== 'string' || prefix.length === 0)) {
        throw new Error('Agent add-on toolPrefixes must be non-empty strings.');
    }
    if (descriptor.contextSources?.some((source) => typeof source !== 'string' || source.length === 0)) {
        throw new Error('Agent add-on contextSources must be non-empty strings.');
    }
    if (registry.addons.has(descriptor.addonId)) {
        throw new Error(`Agent add-on "${descriptor.addonId}" is already registered.`);
    }
    const value = {
        ...descriptor,
        ...(descriptor.toolPrefixes === undefined ? {} : { toolPrefixes: [...descriptor.toolPrefixes] }),
        ...(descriptor.contextSources === undefined ? {} : { contextSources: [...descriptor.contextSources] }),
    };
    registry.addons.set(value.addonId, value);
    return () => {
        if (registry.addons.get(value.addonId) === value) registry.addons.delete(value.addonId);
    };
}

export function listAgentAddons(): AgentAddonDescriptor[] {
    return [...registry.addons.values()].map((addon) => ({
        ...addon,
        ...(addon.toolPrefixes === undefined ? {} : { toolPrefixes: [...addon.toolPrefixes] }),
        ...(addon.contextSources === undefined ? {} : { contextSources: [...addon.contextSources] }),
    }));
}
