import { Context } from 'cordis';
import type { BaseView, SessionSummary } from './session';

export interface AgentPluginUiDisableActions {
    currentSession?: SessionSummary | null;
    clearDraftContext(): void;
    clearCurrentContext(): Promise<void>;
}

export interface AgentPluginUiRegistration {
    apply(ctx: Context): void;
    onDisabled?: (actions: AgentPluginUiDisableActions) => void;
    sessionAgentTags?: (session: SessionSummary, bases: readonly BaseView[], showBase: boolean) => string[];
}

type AgentPluginUiLoader = () => Promise<{ default: AgentPluginUiRegistration }>;
type AgentPluginUiFiber = ReturnType<Context['plugin']>;

const uiContext = new Context();
const loaders = new Map<string, AgentPluginUiLoader>();
const registrations = new Map<string, AgentPluginUiRegistration>();
const activeFibers = new Map<string, AgentPluginUiFiber>();
const pendingLoads = new Map<string, Promise<void>>();
const pendingDisposals = new Map<string, Promise<void>>();
let enabledPluginIds = new Set<string>();

async function dispose(pluginId: string): Promise<void> {
    const fiber = activeFibers.get(pluginId);
    if (!fiber) return pendingDisposals.get(pluginId);
    activeFibers.delete(pluginId);
    let pending: Promise<void>;
    pending = fiber.dispose().catch((error) => {
        console.error(`Failed to dispose Agent UI plugin "${pluginId}"`, error);
    }).finally(() => {
        if (pendingDisposals.get(pluginId) === pending) pendingDisposals.delete(pluginId);
    });
    pendingDisposals.set(pluginId, pending);
    return pending;
}

async function loadAndInstall(pluginId: string): Promise<void> {
    if (activeFibers.has(pluginId)) return;
    const existing = pendingLoads.get(pluginId);
    if (existing) return existing;
    const loader = loaders.get(pluginId);
    if (!loader) return;

    let pending: Promise<void>;
    pending = (async () => {
        await pendingDisposals.get(pluginId);
        if (!enabledPluginIds.has(pluginId) || loaders.get(pluginId) !== loader) return;
        try {
            const { default: registration } = await loader();
            registrations.set(pluginId, registration);
            if (!enabledPluginIds.has(pluginId) || loaders.get(pluginId) !== loader) return;
            const fiber = uiContext.plugin(registration);
            activeFibers.set(pluginId, fiber);
            await fiber;
            if (!enabledPluginIds.has(pluginId) && activeFibers.get(pluginId) === fiber) await dispose(pluginId);
        } catch (error) {
            console.error(`Failed to load Agent UI plugin "${pluginId}"`, error);
            await dispose(pluginId);
        }
    })().finally(() => {
        if (pendingLoads.get(pluginId) === pending) pendingLoads.delete(pluginId);
    });
    pendingLoads.set(pluginId, pending);
    return pending;
}

/** Register a lazy loader for a Cordis-managed Agent UI plugin. */
export function registerAgentPluginUiLoader(pluginId: string, loader: AgentPluginUiLoader): () => void {
    loaders.set(pluginId, loader);
    if (enabledPluginIds.has(pluginId)) void loadAndInstall(pluginId);
    return () => {
        if (loaders.get(pluginId) !== loader) return;
        void dispose(pluginId);
        registrations.delete(pluginId);
        loaders.delete(pluginId);
    };
}

/** Mount or unmount Cordis plugin fibers to match persisted Agent plugin state. */
export async function setEnabledAgentPluginSlots(pluginIds: ReadonlySet<string>): Promise<void> {
    enabledPluginIds = new Set(pluginIds);
    await Promise.all([...activeFibers.keys()]
        .filter((pluginId) => !enabledPluginIds.has(pluginId))
        .map(dispose));
    await Promise.all([...loaders.keys()]
        .filter((pluginId) => enabledPluginIds.has(pluginId))
        .map(loadAndInstall));
}

/** Let a plugin clear its own per-session context when a user disables it. */
export async function notifyAgentPluginDisabled(pluginId: string, actions: AgentPluginUiDisableActions): Promise<void> {
    await pendingLoads.get(pluginId);
    let registration = registrations.get(pluginId);
    const loader = loaders.get(pluginId);
    if (!registration && loader) {
        try {
            registration = (await loader()).default;
            if (loaders.get(pluginId) === loader) registrations.set(pluginId, registration);
        } catch (error) {
            console.error(`Failed to load Agent UI plugin "${pluginId}"`, error);
        }
    }
    registration?.onDisabled?.(actions);
}

export function hasAgentPluginSessionAgentTags(): boolean {
    return [...registrations].some(([pluginId, registration]) =>
        enabledPluginIds.has(pluginId) && activeFibers.has(pluginId) && registration.sessionAgentTags !== undefined);
}

export function getAgentPluginSessionAgentTags(
    session: SessionSummary,
    bases: readonly BaseView[],
    showBase: boolean,
): string[] {
    const tags: string[] = [];
    for (const [pluginId, registration] of registrations) {
        if (!enabledPluginIds.has(pluginId) || !activeFibers.has(pluginId)) continue;
        try {
            tags.push(...(registration.sessionAgentTags?.(session, bases, showBase) ?? []));
        } catch (error) {
            console.error(`Failed to render Agent session tags for "${pluginId}"`, error);
        }
    }
    return tags;
}
