export interface AgentPermissionInfo {
    id: string;
    name: string;
    family: string;
    description?: string;
    addonId?: string;
}

export interface AgentAddonPermission {
    /** Add-on-local stable ID; the host keys it as `${addonId}:${id}`. */
    id: string;
    name: string;
    description?: string;
}

export interface AgentAddonDescriptor {
    addonId: string;
    displayName: string;
    description: string;
    permissions?: readonly AgentAddonPermission[];
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
    const permissionIds = new Set<string>();
    for (const permission of descriptor.permissions ?? []) {
        if (!permission || !/^[a-z][a-z0-9._-]{0,63}$/.test(permission.id) || typeof permission.name !== 'string' || !permission.name.trim()) {
            throw new Error('Agent add-on permissions require a valid id and name.');
        }
        if (permissionIds.has(permission.id)) throw new Error(`Agent add-on permission "${permission.id}" is duplicated.`);
        permissionIds.add(permission.id);
    }
    if (registry.addons.has(descriptor.addonId)) {
        throw new Error(`Agent add-on "${descriptor.addonId}" is already registered.`);
    }
    const value = {
        ...descriptor,
        ...(descriptor.toolPrefixes === undefined ? {} : { toolPrefixes: [...descriptor.toolPrefixes] }),
        ...(descriptor.contextSources === undefined ? {} : { contextSources: [...descriptor.contextSources] }),
        ...(descriptor.permissions === undefined ? {} : { permissions: descriptor.permissions.map((permission) => ({ ...permission })) }),
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
        ...(addon.permissions === undefined ? {} : { permissions: addon.permissions.map((permission) => ({ ...permission })) }),
    }));
}

export function addonAgentPermissionId(addonId: string, permissionId: string): string {
    return `${addonId}:${permissionId}`;
}

export function agentPermissionCatalog(): AgentPermissionInfo[] {
    return listAgentAddons().flatMap((addon) => (addon.permissions || []).map((permission) => ({
        id: addonAgentPermissionId(addon.addonId, permission.id),
        name: permission.name,
        family: addon.displayName,
        ...(permission.description ? { description: permission.description } : {}),
        addonId: addon.addonId,
    })));
}
