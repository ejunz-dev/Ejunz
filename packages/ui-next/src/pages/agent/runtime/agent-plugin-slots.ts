import type { BaseView, SessionSummary } from './session';

export interface AgentPluginUiDisableActions {
    currentSession?: SessionSummary | null;
    clearDraftContext(): void;
    clearCurrentContext(): Promise<void>;
}

interface AgentPluginUiRegistration {
    installSlots(): () => void;
    onDisabled?: (actions: AgentPluginUiDisableActions) => void;
    sessionCardTags?: (session: SessionSummary, bases: readonly BaseView[], showBase: boolean) => string[];
}

const registrations = new Map<string, AgentPluginUiRegistration>();
const activeDisposers = new Map<string, () => void>();
let enabledPluginIds = new Set<string>();

function install(pluginId: string, registration: AgentPluginUiRegistration): void {
    if (activeDisposers.has(pluginId)) return;
    try {
        activeDisposers.set(pluginId, registration.installSlots());
    } catch (error) {
        console.error(`Failed to register Agent UI slots for "${pluginId}"`, error);
    }
}

/** Register the slot contributions owned by one Agent UI plugin. */
export function registerAgentPluginSlots(
    pluginId: string,
    registration: AgentPluginUiRegistration,
): () => void {
    const previous = registrations.get(pluginId);
    if (previous) activeDisposers.get(pluginId)?.();
    registrations.set(pluginId, registration);
    activeDisposers.delete(pluginId);
    if (enabledPluginIds.has(pluginId)) install(pluginId, registration);
    return () => {
        if (registrations.get(pluginId) !== registration) return;
        activeDisposers.get(pluginId)?.();
        activeDisposers.delete(pluginId);
        registrations.delete(pluginId);
    };
}

/** Mount or unmount registered slot contributions to match persisted plugin state. */
export function setEnabledAgentPluginSlots(pluginIds: ReadonlySet<string>): void {
    enabledPluginIds = new Set(pluginIds);
    for (const [pluginId, dispose] of activeDisposers) {
        if (enabledPluginIds.has(pluginId)) continue;
        dispose();
        activeDisposers.delete(pluginId);
    }
    for (const [pluginId, registration] of registrations) {
        if (enabledPluginIds.has(pluginId)) install(pluginId, registration);
    }
}

/** Let a plugin clear its own per-session context when a user disables it. */
export function notifyAgentPluginDisabled(pluginId: string, actions: AgentPluginUiDisableActions): void {
    registrations.get(pluginId)?.onDisabled?.(actions);
}

export function hasAgentPluginSessionCardTags(): boolean {
    return [...registrations].some(([pluginId, registration]) =>
        enabledPluginIds.has(pluginId) && activeDisposers.has(pluginId) && registration.sessionCardTags !== undefined);
}

export function getAgentPluginSessionCardTags(
    session: SessionSummary,
    bases: readonly BaseView[],
    showBase: boolean,
): string[] {
    const tags: string[] = [];
    for (const [pluginId, registration] of registrations) {
        if (!enabledPluginIds.has(pluginId) || !activeDisposers.has(pluginId)) continue;
        try {
            tags.push(...(registration.sessionCardTags?.(session, bases, showBase) ?? []));
        } catch (error) {
            console.error(`Failed to render Agent session tags for "${pluginId}"`, error);
        }
    }
    return tags;
}
