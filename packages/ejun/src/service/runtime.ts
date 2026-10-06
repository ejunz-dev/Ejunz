import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Context } from '../context';
import { Service } from '../context';
import { Logger } from '../logger';
import SystemModel from '../model/system';
import AgentDefinitionModel from '../model/agent';
import { createProvider } from './provider';
import { httpServer } from '@ejunz/framework';
import { AgentSessionModel as AgentModel, AgentRuntimeModel, AgentLinkModel, AgentStorageModel } from '../model/agent';
import { type AgentDisplayPrefs, type AgentDomainSettings, type AgentNodeDoc, type AgentSessionSummary, type AgentSessionType, type AgentWorkspaceDoc } from '../model/agent';
import { type AgentRuntimeSummary } from '../model/agent';

interface EjunContext {
    server?: { config?: { port?: number; host?: string } };
    effect(factory: () => () => void | Promise<void>): void;
    on?(event: string, listener: (...args: any[]) => unknown): void;
    get?(name: string): unknown;
    plugin(plugin: unknown): unknown;
    Route(name: string, path: string, handler: unknown, priv?: number): void;
    Connection(name: string, path: string, handler: unknown, priv?: number): void;
    Tool(name: string, execute: unknown, ...args: unknown[]): void;
}

interface RpcEnvelope {
    type?: string;
    rpcId?: string;
    method?: string;
    payload?: Record<string, unknown>;
    domainId?: string;
}

interface RpcBody {
    type?: string;
    rpcId?: string;
    result?: { ok?: boolean; value?: unknown };
    error?: { message?: string };
}


const { WebSocket } = require('ws');
const logger = new Logger('agent');
const agentRoot = path.resolve(__dirname, '../../../agent');
const agentEmbedEntry = path.join(agentRoot, 'apps/cli/src/embed.ts');
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Validate a credential-reference without importing the embedded Agent workspace. */
function credentialRef(value: string): string {
    if (!CREDENTIAL_REF_PATTERN.test(value)) {
        throw new TypeError(`credential ref "${value}" must match ${String(CREDENTIAL_REF_PATTERN)}`);
    }
    return value;
}


let agentRuntime: InProcessRuntime | null = null;
let agentStarting: Promise<InProcessRuntime> | null = null;let agentDisposing = false;
let upstreamTransportUnavailable = false;
let modelReady: Promise<void> = Promise.resolve();
let agentDataToken = '';
/** The key `system` stores the built-in host's bridge token under, so a hot reload reuses it. */
const BUILTIN_BRIDGE_TOKEN_KEY = 'agent.builtinBridgeToken';
/** Every runtime this plugin can reach, by the identity the registry uses. */
const runtimeLinks = new Map<string, RuntimeLink>();
/** Pages following every runtime's streams; each is woken when a runtime appears. */
const linkWatchers = new Set<(link: RuntimeLink) => void>();
/** Heartbeat that keeps the embedded runtime's registry row current. */
let runtimeHeartbeat: ReturnType<typeof setInterval> | null = null;

/**
 * Host moves requested by the authenticated Agent UI during a running turn.
 *
 * The running agent learns the new host the way it learns a permission change:
 * a context section is injected into the live session, and the next step of the
 * same turn reads it. The turn is not cancelled and no user message is queued.
 * Ownership of the shared log moves only after that turn has closed, so the
 * host that is still writing the turn is not fenced out from under itself.
 */
const liveHostMoves = new Map<string, {
    scope: AgentScope;
    /** Host that owns the turn when the tool is called. */
    previousRuntimeId: string;
    runtimeId: string;
    generation: number;
}>();
let liveHostMoveGeneration = 0;
const liveHostMoveWaiters = new Set<string>();
/** How often a deferred move re-reads the log while the turn is still open. */
const HOST_MOVE_POLL_MS = 200;
/**
 * After the turn closes, how long to wait before claiming the log. A host can
 * still flush the turn's last events after `turn/end`.
 */
const HOST_MOVE_IDLE_SETTLE_MS = 300;

/** How often this process reports itself to the runtime registry. */
const RUNTIME_HEARTBEAT_MS = 15_000;
/**
 * How long a report stays authoritative. A runtime that stops reporting — a
 * crash, a killed process — cannot correct its own row, so a viewer reads
 * liveness as "still reporting", not as the last value it wrote.
 */
const RUNTIME_STALE_MS = 45_000;

/**
 * The embedded runtime's registry identity: this host's, not this process's.
 *
 * One Ejunz process hosts one embedded runtime, and a session pinned to it must
 * survive that process restarting. An identity carrying the pid would change
 * with every start, which leaves one dead row per restart and a record naming a
 * host no process answers; the pid stays visible in the row the runtime reports.
 * @returns the identity of this host's embedded runtime.
 */
function runtimeId(): string {
    return `${hostname()}#builtin`;
}

/**
 * Drop the embedded runtime rows no process can come back under.
 *
 * A row written under an identity that is no longer this one describes a
 * process that is gone, so nothing will ever report into it again. Bound hosts
 * keep their rows: a binding is exactly what a host comes back as.
 * @returns how many rows were removed.
 */
async function pruneEmbeddedRuntimeRows(): Promise<number> {
    const stale = (await agentDataAdapter.listRuntimes())
        .filter((row) => row.kind === 'builtin' && row.runtimeId !== runtimeId());
    for (const row of stale) await agentDataAdapter.removeRuntime(row.runtimeId);
    return stale.length;
}

/**
 * The runtime a request goes to.
 *
 * The embedded runtime is this process's own, so while it is up it is the
 * deployment's runtime and a connected one stays a standby. A deployment that
 * runs its agents elsewhere has no embedded runtime, and the first runtime to
 * connect serves it.
 * @returns the link to dispatch through, or undefined when none is reachable.
 */
function defaultLink(): RuntimeLink | undefined {
    const builtin = runtimeLinks.get(runtimeId());
    if (builtin !== undefined) return builtin;
    return [...runtimeLinks.values()].find((link) => link.kind === 'websocket');
}

/**
 * Register one runtime as reachable, and wake the pages following them.
 * @param link - the runtime that just connected.
 */
function addLink(link: RuntimeLink): void {
    runtimeLinks.set(link.runtimeId, link);
    for (const watcher of linkWatchers) watcher(link);
}

/**
 * Follow every runtime, including ones that connect later.
 *
 * A page that chose its sessions' hosts must receive the sessions of whichever
 * host serves them, and a host may start while that page is already open.
 * @param watcher - called with each runtime, at once for the reachable ones.
 * @returns the disposer that stops following.
 */
function followLinks(watcher: (link: RuntimeLink) => void): () => void {
    linkWatchers.add(watcher);
    for (const link of runtimeLinks.values()) watcher(link);
    return () => { linkWatchers.delete(watcher); };
}

/** The label a host is known by, falling back to the identity it was bound under. */
function hostLabel(runtimeIdValue: string): string {
    return runtimeFacts.get(runtimeIdValue)?.label ?? runtimeIdValue;
}

/**
 * A refusal a caller must report as it stands: the host that owns the work is
 * not connected, so no other host may answer in its place.
 */
class HostUnreachableError extends Error {}

/**
 * The host one session is served by.
 *
 * A session names its host, so a switch reaches the host an operator chose and
 * a host that restarts keeps serving the sessions it already had. A session
 * recorded before hosts could be chosen names none and keeps the default.
 * @param scope - the owning domain and user, which own the session record.
 * @param sessionId - the session whose host is wanted.
 * @returns the link that serves it.
 * @throws HostUnreachableError when the session's host is not connected.
 */
async function linkForSession(scope: AgentScope, sessionId: string): Promise<RuntimeLink> {
    const named = (await agentDataAdapter.getSession(scope, sessionId))?.runtimeId ?? '';
    if (named === '') return await requireLink();
    const link = runtimeLinks.get(named);
    if (link === undefined) throw new HostUnreachableError(`这个会话所在的 host「${hostLabel(named)}」不在线`);
    return link;
}

/**
 * The host a new session goes to, from what the caller asked for.
 * @param requested - the host the caller named, empty for the default.
 * @returns the link that will serve the session.
 * @throws HostUnreachableError when the named host is not connected.
 */
function linkForCreate(requested: string): RuntimeLink {
    if (requested === '') {
        const link = defaultLink();
        if (link === undefined) throw new HostUnreachableError('没有可用的 host：请先启动一个 agent');
        return link;
    }
    const link = runtimeLinks.get(requested);
    if (link === undefined) throw new HostUnreachableError(`host「${hostLabel(requested)}」不在线，无法用它新建会话`);
    return link;
}

/**
 * The browser-facing envelope for one downlink frame, byte-for-byte the one the
 * WebSocket carrier sends (`@ejunz/client-connection`'s downlink): this process
 * is the browser's only peer, so the two carriers must not differ in what the
 * page receives.
 */
function serverRequestFrame(frame: AgentFrame): Record<string, unknown> {
    return {
        type: 'server-request',
        rpcId: frame.rpcId,
        method: frame.payload?.type,
        payload: frame.payload,
    };
}

function domainKey(domainId: string): string {
    return createHash('sha1').update(domainId).digest('hex').slice(0, 12);
}

function scopeOf(handler: any, requestedDomainId?: unknown): { domainId: string; userId: number } {
    const normalize = (value: unknown): string => {
        const text = String(value || '');
        return text === 'undefined' || text === 'null' ? '' : text;
    };
    const requested = normalize(requestedDomainId);
    const contextDomainId = normalize(handler.context?.domainId || handler.domain?._id || handler.UiContext?.domainId || handler.args?.domainId);
    const actualDomainId = contextDomainId || requested || 'system';
    const userId = Number(handler.user?._id || 0);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('agent user is unavailable');
    return { domainId: actualDomainId, userId };
}

function rpcOk(rpcId: string | undefined, value: unknown): RpcBody {
    return { type: 'server-response', ...(rpcId === undefined ? {} : { rpcId }), result: { ok: true, value } };
}

function rpcError(rpcId: string | undefined, message: string): RpcBody {
    return { type: 'server-response', ...(rpcId === undefined ? {} : { rpcId }), result: { ok: false, value: undefined }, error: { message } };
}

/**
 * Post one client-request envelope to the embedded runtime's `/api` channel and
 * read its response envelope, exactly as the HTTP carrier would have.
 *
 * The runtime is booted after the Ejunz server is listening — its data bridge
 * dials this server — so a request that arrives first waits for that boot
 * instead of failing.
 * @param method - the runtime method to call.
 * @param payload - the method payload.
 * @returns the transport status and the parsed response envelope.
 */
async function callRuntime(link: RuntimeLink, path: string, body: unknown): Promise<{ status: number; body: RpcBody }> {
    const reply = await link.call(path, body);
    let parsed: RpcBody;
    try {
        parsed = JSON.parse(reply.text) as RpcBody;
    } catch {
        parsed = rpcError(undefined, reply.text || `agent upstream HTTP ${reply.status}`);
    }
    return { status: reply.status, body: parsed };
}

async function callUpstream(method: string, payload: Record<string, unknown>, target?: RuntimeLink): Promise<{ status: number; body: RpcBody }> {
    try {
        const reply = await callRuntime(target ?? await requireLink(), `/api/${method}`, {
            type: 'client-request',
            rpcId: `host-${randomUUID()}`,
            method,
            payload,
        });
        upstreamTransportUnavailable = false;
        return reply;
    } catch (error) {
        if (!upstreamTransportUnavailable) {
            const detail = error instanceof Error ? error.message : String(error);
            logger.warn('Agent runtime unavailable method=%s error=%s', method, detail);
            upstreamTransportUnavailable = true;
        }
        return { status: 503, body: rpcError(undefined, 'agent runtime is unavailable') };
    }
}

function upstreamValue(body: RpcBody): any {
    if (!body.result?.ok) throw new Error(body.error?.message || 'agent upstream request failed');
    return body.result.value;
}

function workspaceView(workspace: AgentWorkspaceDoc) {
    return agentDataAdapter.viewWorkspace(workspace);
}

/** This host's section name in a session's injected context. */
const HOST_CONTEXT_SECTION = 'ejunz-agent-host';

/**
 * What a session's model is told about the host serving it.
 *
 * A session can move between hosts, and a host is a machine: the paths, the
 * installed tools, and the working directory are that machine's, so a model
 * that moved must not assume the previous host's answers still hold. The text
 * is the plugin's own context section, which the runtime re-states for every
 * request as long as it stands, so a later switch replaces this value rather
 * than piling up.
 * @param runtimeIdValue - the host now serving the session.
 * @param previous - the host it moved from, for a switch.
 * @returns the named section to inject.
 */
function hostContextSection(runtimeIdValue: string, previous?: string, wakeup = false): { name: string; text: string } {
    const moved = previous === undefined || previous === runtimeIdValue
        ? ''
        : `本会话原本由 host「${hostLabel(previous)}」（${previous}）服务，用户刚把它切换到这台 host。`;
    const continuation = wakeup ? '上一回合已经结束，系统现在自动在这台 host 继续处理，不需要用户再发消息。' : '';
    return {
        name: HOST_CONTEXT_SECTION,
        text: `${moved}本会话由 host「${hostLabel(runtimeIdValue)}」（${runtimeIdValue}）提供服务。${continuation}不同的 host 是不同的机器：文件路径、已装的工具和当前工作目录都按这台机器算，动文件或跑命令前请先确认它们在这台机器上存在。`,
    };
}

/**
 * Make a host's session runnable under the model its record states.
 *
 * A host composes a session when it is given a model, and a session that was
 * just created or just adopted has none: the model in a `session.create`
 * payload only reaches this server's record. Selecting it here is what lets the
 * session take context and answer a turn on this host at all.
 * @param sessionId - the session to compose.
 * @param link - the host that holds it.
 * @param model - the model the record states, if it states one.
 * @returns whether the host accepted the model.
 */
async function selectHostModel(sessionId: string, link: RuntimeLink, model?: { provider: string; model: string }): Promise<boolean> {
    if (model === undefined) return false;
    const selected = await callUpstream('session.selectModel', {
        sessionId,
        provider: model.provider,
        model: model.model,
        persistDefault: false,
    }, link);
    if (!selected.body.result?.ok) {
        logger.warn('Agent host model selection failed session=%s host=%s model=%s error=%s', sessionId, link.runtimeId, model.model, selected.body.error?.message || 'unknown error');
        return false;
    }
    return true;
}

/**
 * Tell one session's model which host serves it.
 * @param sessionId - the session to inform.
 * @param link - the host serving it, which receives the section.
 * @param previous - the host it moved from, for a switch.
 */
async function injectHostContext(sessionId: string, link: RuntimeLink, previous?: string, wakeup = false): Promise<void> {
    const injected = await callUpstream('session.inject', {
        sessionId,
        plugin: HOST_CONTEXT_SECTION,
        sections: [hostContextSection(link.runtimeId, previous, wakeup)],
        ...(wakeup ? { wakeup: true } : {}),
    }, link);
    if (!injected.body.result?.ok) {
        logger.warn('Agent host context injection failed session=%s host=%s error=%s', sessionId, link.runtimeId, injected.body.error?.message || 'unknown error');
    }
}

/**
 * Tell the agent that is running this turn which host the session is moving to.
 *
 * Same channel as a live permission change: `session.inject` queues a plugin
 * context section for the next step and does not wake a turn, so the in-flight
 * turn keeps going and no user message is added.
 * @param sessionId - the session to inform.
 * @param link - the host that is running the turn.
 * @param currentRuntimeId - the host the rest of this turn still executes on.
 * @param targetRuntimeId - the host that serves the session after this turn.
 */
async function injectHostSwitchNotice(
    sessionId: string,
    link: RuntimeLink,
    currentRuntimeId: string,
    targetRuntimeId: string,
): Promise<void> {
    const current = `「${hostLabel(currentRuntimeId)}」（${currentRuntimeId}）`;
    const target = `「${hostLabel(targetRuntimeId)}」（${targetRuntimeId}）`;
    const injected = await callUpstream('session.inject', {
        sessionId,
        plugin: HOST_CONTEXT_SECTION,
        sections: [{
            name: HOST_CONTEXT_SECTION,
            text: `用户已经把这个会话的路由从 ${current} 切换到 ${target}。已经开始的工具调用仍在 ${current} 完成；当前回合结束后，系统会自动在 ${target} 续接，不需要用户再发消息。之前任何“需要下一条用户消息才能切换”的说明都已过时；文件路径、已装工具和工作目录按 ${target} 这台机器算。`,
        }],
    }, link);
    if (!injected.body.result?.ok) {
        logger.warn(
            'Agent host switch notice failed session=%s host=%s error=%s',
            sessionId,
            link.runtimeId,
            injected.body.error?.message || 'unknown error',
        );
    }
}

async function sessionCreate(envelope: RpcEnvelope, scope: AgentScope, metadata: { type?: AgentSessionType; baseDocId?: string } = {}): Promise<RpcBody> {
    const payload = { ...(envelope.payload ?? {}) };
    const domainSettings = await agentDataAdapter.getDomainSettings(scope.domainId);
    const domainDefault = domainSettings.sections['agent-default-model'];
    const deepseekSettings = domainSettings.sections['llm-deepseek'];
    if (typeof payload.provider !== 'string' && typeof payload.model !== 'string' && domainDefault
        && typeof domainDefault.provider === 'string' && typeof domainDefault.model === 'string'
        && domainDefault.provider.length > 0 && domainDefault.model.length > 0) {
        payload.provider = domainDefault.provider;
        payload.model = domainDefault.model;
    } else if (typeof payload.provider !== 'string' && typeof payload.model !== 'string'
        && deepseekSettings && typeof deepseekSettings.model === 'string' && deepseekSettings.model.length > 0) {
        payload.provider = 'deepseek-official';
        payload.model = deepseekSettings.model;
    }
    const requestedSessionId = typeof payload.sessionId === 'string' ? payload.sessionId : undefined;
    if (requestedSessionId) {
        const existing = await agentDataAdapter.getSessionAny(requestedSessionId);
        const agentMismatch = existing && scope.agentId !== undefined && (existing.agentId ?? null) !== scope.agentId;
        if (existing && (existing.domainId !== scope.domainId || existing.userId !== scope.userId || agentMismatch)) {
            return rpcError(envelope.rpcId, 'session not found');
        }
    }
    let selectedAgent: Awaited<ReturnType<typeof AgentDefinitionModel.get>> | null = null;
    if (typeof scope.agentId === 'number') {
        selectedAgent = await AgentDefinitionModel.get(scope.domainId, scope.agentId, AgentDefinitionModel.PROJECTION_LIST);
        if (!selectedAgent) return rpcError(envelope.rpcId, 'Agent not found in current domain');
        await AgentModel.ensureAgentRoot(scope.domainId, scope.userId, scope.agentId, selectedAgent.title);
    }
    const selectedBaseDocId = metadata.baseDocId ?? baseDocIdOf(payload.baseDocId);
    let selectedBase: { docId: number; title?: string } | undefined;
    if (selectedBaseDocId) {
        const baseModel = (global as any).Ejunz?.model?.base;
        const base = baseModel ? await baseModel.get(scope.domainId, Number(selectedBaseDocId)) : null;
        if (!base) return rpcError(envelope.rpcId, 'Base not found in current domain');
        selectedBase = { docId: Number(base.docId), ...(base.title ? { title: String(base.title) } : {}) };
    }
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : undefined;
    const workspace = workspaceId ? await agentDataAdapter.getWorkspace(scope, workspaceId) : null;
    if (workspaceId && !workspace) return rpcError(envelope.rpcId, 'workspace not found');
    const requestedNodeId = typeof payload.nodeId === 'string' && payload.nodeId.trim() ? payload.nodeId.trim() : undefined;
    const nodeId = requestedNodeId ?? (typeof scope.agentId === 'number' ? AgentModel.agentRootNodeId(scope.agentId) : undefined);
    const node = nodeId ? await agentDataAdapter.getNode(scope, nodeId) : null;
    if (nodeId && !node) return rpcError(envelope.rpcId, 'node not found in this Agent');
    // The host is chosen with the session and recorded here, so every later call
    // for this session reaches the host that owns it.
    const requestedHost = typeof payload.runtimeId === 'string' ? payload.runtimeId.trim() : '';
    const link = linkForCreate(requestedHost);
    const sessionId = `session-${domainKey(scope.domainId)}-${randomUUID()}`;
    delete payload.domainId;
    delete payload.agentId;
    delete payload.workspaceId;
    delete payload.nodeId;
    delete payload.baseDocId;
    delete payload.creatorUserId;
    delete payload.type;
    delete payload.runtimeId;
    payload.sessionId = sessionId;
    // A stated directory wins over the addon's own root: a caller that starts a run in a named
    // project must not have it silently replaced by the directory this addon happens to sit in.
    const statedCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
    const sessionCwd = workspace?.path ?? (statedCwd.length > 0 ? statedCwd : agentRoot);
    payload.cwd = sessionCwd;
    const createdAt = Date.now();
    const initialSummary: AgentSessionSummary = {
        sessionId,
        createdAt,
        updatedAt: createdAt,
        running: false,
        blank: true,
        creatorUserId: scope.userId,
        type: metadata.type ?? 'generic',
        ...(typeof scope.agentId === 'number' ? { agentId: scope.agentId } : {}),
        runtimeId: link.runtimeId,
        ...(selectedBaseDocId == null ? {} : { baseDocId: selectedBaseDocId }),
        ...(nodeId === undefined ? {} : { nodeId }),
        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}),
        ...(typeof payload.agentPreset === 'string' && payload.agentPreset.length > 0
            ? { agentPreset: payload.agentPreset }
            : {}),
        ...(typeof payload.provider === 'string' && payload.provider.length > 0 && typeof payload.model === 'string' && payload.model.length > 0
            ? { model: { provider: payload.provider, model: payload.model } }
            : {}),
    };
    // The record is written before the Agent composes the session, and it states the whole target:
    // the bridge resolves the session's domain — and with it the domain's tools — from this row, so
    // a session created without it starts with no domain-scoped tool; and the Agent treats a create
    // for an already-recorded session as adopting that record, which compares the preset and keeps
    // the recorded model, so a partial record is refused or run without the stated model.
    await agentDataAdapter.upsertSession(scope, initialSummary);
    // The header states the preset too: the Agent resolves a session's composition from the creation
    // header, and a create that names a preset for a record whose header names none is refused as an
    // adoption under a different composition, so a timer run never started.
    await agentDataAdapter.setSessionHeader(sessionId, {
        version: 0,
        id: sessionId,
        createdAt,
        ...(initialSummary.cwd === undefined ? {} : { cwd: initialSummary.cwd }),
        ...(initialSummary.agentPreset === undefined ? {} : { agentPreset: initialSummary.agentPreset }),
    });
    const upstream = await callUpstream('session.create', payload, link);
    if (!upstream.body.result?.ok) {
        await agentDataAdapter.deleteSession(scope, sessionId);
        return upstream.body;
    }
    const value = upstreamValue(upstream.body) as Record<string, unknown>;
    const summary: AgentSessionSummary = {
        ...initialSummary,
        updatedAt: Date.now(),
        ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
    };
    await agentDataAdapter.upsertSession(scope, summary);
    await selectHostModel(sessionId, link, summary.model);
    await injectHostContext(sessionId, link);
    if (selectedBase) {
        const injected = await callUpstream('session.inject', {
            sessionId,
            plugin: 'ejunz-base-selector',
            sections: [{
                name: 'ejunz-base-selector',
                text: `当前会话已选择 Ejunz Base #${selectedBase.docId}${selectedBase.title ? `（${selectedBase.title}）` : ''}，位于 domain ${scope.domainId}。请使用 Base 工具处理该知识库中的节点、卡片、文件和练习题。`,
            }],
        }, link);
        if (!injected.body.result?.ok) logger.warn('[agent-base] context injection failed session=%s domain=%s baseId=%d error=%s', sessionId, scope.domainId, selectedBase.docId, injected.body.error?.message || 'unknown error');
    }
    if (workspace) await agentDataAdapter.reorderWorkspaceSessions(scope, workspace.workspaceId, [...workspace.sessionIds, summary.sessionId]);
    return rpcOk(envelope.rpcId, { sessionId: summary.sessionId, ...(summary.agentPreset ? { agentPreset: summary.agentPreset } : {}), ...(nodeId ? { nodeId } : {}) });
}

async function sessionContextSave(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const payload = envelope.payload ?? {};
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const session = sessionId ? await agentDataAdapter.getSession(scope, sessionId) : null;
    if (!session) return rpcError(envelope.rpcId, 'session not found');

    const hasBase = Object.prototype.hasOwnProperty.call(payload, 'baseDocId');
    const existingBaseDocId = baseDocIdOf(session.baseDocId);
    const selectedBaseDocId = hasBase ? baseDocIdOf(payload.baseDocId) ?? undefined : existingBaseDocId;
    if (hasBase && payload.baseDocId !== null && payload.baseDocId !== undefined && selectedBaseDocId === undefined) {
        return rpcError(envelope.rpcId, 'invalid baseDocId');
    }
    let selectedBase: { docId: number; title?: string } | undefined;
    if (selectedBaseDocId !== undefined) {
        const baseModel = (global as any).Ejunz?.model?.base;
        const base = baseModel ? await baseModel.get(scope.domainId, Number(selectedBaseDocId)) : null;
        if (!base) return rpcError(envelope.rpcId, 'Base not found in current domain');
        selectedBase = { docId: Number(base.docId), ...(base.title ? { title: String(base.title) } : {}) };
    }

    const workspaces = await agentDataAdapter.listWorkspaces(scope);
    const currentWorkspace = workspaces.find((workspace) => workspace.sessionIds.includes(sessionId));
    const hasWorkspace = Object.prototype.hasOwnProperty.call(payload, 'workspaceId');
    const requestedWorkspaceId = hasWorkspace
        ? (typeof payload.workspaceId === 'string' && payload.workspaceId ? payload.workspaceId : undefined)
        : currentWorkspace?.workspaceId;
    const selectedWorkspace = requestedWorkspaceId === undefined
        ? undefined
        : workspaces.find((workspace) => workspace.workspaceId === requestedWorkspaceId);
    if (requestedWorkspaceId !== undefined && !selectedWorkspace) return rpcError(envelope.rpcId, 'workspace not found');

    if (selectedBase) {
        const injected = await callUpstream('session.inject', {
            sessionId,
            plugin: 'ejunz-base-selector',
            sections: [{
                name: 'ejunz-base-selector',
                text: `当前会话已选择 Ejunz Base #${selectedBase.docId}${selectedBase.title ? `（${selectedBase.title}）` : ''}，位于 domain ${scope.domainId}。请使用 Base 工具处理该知识库中的节点、卡片、文件和练习题。`,
            }],
        }, await linkForSession(scope, sessionId));
        if (!injected.body.result?.ok) return rpcError(envelope.rpcId, injected.body.error?.message || '知识库上下文保存失败');
    }

    await agentDataAdapter.updateSessionContext(scope, sessionId, selectedBaseDocId ?? undefined, selectedWorkspace?.path);
    if (currentWorkspace && currentWorkspace.workspaceId !== selectedWorkspace?.workspaceId) {
        await agentDataAdapter.reorderWorkspaceSessions(scope, currentWorkspace.workspaceId, currentWorkspace.sessionIds.filter((id) => id !== sessionId));
    }
    if (selectedWorkspace && selectedWorkspace.workspaceId !== currentWorkspace?.workspaceId) {
        await agentDataAdapter.reorderWorkspaceSessions(scope, selectedWorkspace.workspaceId, [...selectedWorkspace.sessionIds.filter((id) => id !== sessionId), sessionId]);
    }
    return rpcOk(envelope.rpcId, {
        sessionId,
        baseDocId: selectedBaseDocId ?? null,
        workspaceId: selectedWorkspace?.workspaceId ?? null,
    });
}

async function sessionHistory(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const payload = envelope.payload ?? {};
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    if (!sessionId || !await agentDataAdapter.getSession(scope, sessionId)) return rpcError(envelope.rpcId, 'session not found');
    const upstream = await callUpstream('session.history', payload);
    if (!upstream.body.result?.ok) return rpcError(envelope.rpcId, upstream.body.error?.message || 'session history failed');
    return rpcOk(envelope.rpcId, upstreamValue(upstream.body));
}

async function sessionMessageCount(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const sessionId = typeof envelope.payload?.sessionId === 'string' ? envelope.payload.sessionId : '';
    if (!sessionId || !await agentDataAdapter.getSession(scope, sessionId)) return rpcError(envelope.rpcId, 'session not found');
    return rpcOk(envelope.rpcId, { totalMessages: await agentDataAdapter.countMessages(scope, sessionId) });
}

function baseDocIdOf(value: unknown): string | null {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : null;
}

async function baseTutorSession(scope: AgentScope, baseDocId: string, sessionId?: string) {
    if (sessionId) {
        const session = await agentDataAdapter.getSession(scope, sessionId);
        return session?.type === 'base_detail' && session.baseDocId === baseDocId && !session.archived ? session : null;
    }
    return await agentDataAdapter.getSessionByContext(scope, 'base_detail', baseDocId);
}

async function baseTutorList(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const baseDocId = baseDocIdOf(envelope.payload?.baseDocId);
    if (!baseDocId) return rpcError(envelope.rpcId, 'base document is required');
    return rpcOk(envelope.rpcId, { items: await agentDataAdapter.listSessionsByContext(scope, 'base_detail', baseDocId) });
}

async function baseTutorCreate(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const baseDocId = baseDocIdOf(envelope.payload?.baseDocId);
    if (!baseDocId) return rpcError(envelope.rpcId, 'base document is required');
    const created = await sessionCreate({ ...envelope, payload: {} }, scope, { type: 'base_detail', baseDocId });
    if (!created.result?.ok) return created;
    const value = created.result.value as Record<string, unknown> | undefined;
    const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : '';
    const session = sessionId ? await agentDataAdapter.getSession(scope, sessionId) : null;
    if (!session) return rpcError(envelope.rpcId, 'base tutor session was not created');
    return rpcOk(envelope.rpcId, { sessionId: session.sessionId, type: session.type ?? 'base_detail', baseDocId });
}

async function baseTutorEnsure(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const baseDocId = baseDocIdOf(envelope.payload?.baseDocId);
    if (!baseDocId) return rpcError(envelope.rpcId, 'base document is required');
    const requestedSessionId = typeof envelope.payload?.sessionId === 'string' ? envelope.payload.sessionId : undefined;
    const existing = await baseTutorSession(scope, baseDocId, requestedSessionId);
    if (requestedSessionId && !existing) return rpcError(envelope.rpcId, 'base tutor session not found');
    if (existing) return rpcOk(envelope.rpcId, { sessionId: existing.sessionId, type: existing.type ?? 'base_detail', baseDocId });
    return await baseTutorCreate(envelope, scope);
}

async function baseTutorHistory(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const baseDocId = baseDocIdOf(envelope.payload?.baseDocId);
    if (!baseDocId) return rpcError(envelope.rpcId, 'base document is required');
    const requestedSessionId = typeof envelope.payload?.sessionId === 'string' ? envelope.payload.sessionId : undefined;
    const session = await baseTutorSession(scope, baseDocId, requestedSessionId);
    if (requestedSessionId && !session) return rpcError(envelope.rpcId, 'base tutor session not found');
    if (!session) return rpcOk(envelope.rpcId, { sessionId: null, events: [], hasMore: false });
    const payload = envelope.payload ?? {};
    return await sessionHistory({
        ...envelope,
        payload: {
            sessionId: session.sessionId,
            ...(typeof payload.beforeSeq === 'number' ? { beforeSeq: payload.beforeSeq } : {}),
            ...(typeof payload.maxMessages === 'number' ? { maxMessages: payload.maxMessages } : {}),
        },
    }, scope);
}

async function baseTutorPrompt(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const baseDocId = baseDocIdOf(envelope.payload?.baseDocId);
    const message = String(envelope.payload?.message || '').trim();
    if (!baseDocId || !message) return rpcError(envelope.rpcId, 'base document and message are required');
    const requestedSessionId = typeof envelope.payload?.sessionId === 'string' ? envelope.payload.sessionId : undefined;
    let session = await baseTutorSession(scope, baseDocId, requestedSessionId);
    if (requestedSessionId && !session) return rpcError(envelope.rpcId, 'base tutor session not found');
    if (!session) {
        const ensured = await baseTutorEnsure(envelope, scope);
        if (!ensured.result?.ok) return ensured;
        const sessionId = String((ensured.result.value as Record<string, unknown>)?.sessionId || '');
        session = sessionId ? await agentDataAdapter.getSession(scope, sessionId) : null;
    }
    if (!session) return rpcError(envelope.rpcId, 'base tutor session was not created');
    const context = typeof envelope.payload?.context === 'string' ? envelope.payload.context.slice(0, 100000) : '';
    if (context) {
        const injected = await callUpstream('session.inject', {
            sessionId: session.sessionId,
            plugin: 'base-detail',
            sections: [{ name: 'base-detail', text: context }],
        }, await linkForSession(scope, session.sessionId));
        if (!injected.body.result?.ok) return rpcError(envelope.rpcId, injected.body.error?.message || 'base tutor context injection failed');
    }
    const upstream = await callUpstream('session.prompt', {
        sessionId: session.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: message }],
        ...(typeof envelope.payload?.clientTimeZone === 'string' ? { clientTimeZone: envelope.payload.clientTimeZone } : {}),
    }, await linkForSession(scope, session.sessionId));
    if (!upstream.body.result?.ok) return rpcError(envelope.rpcId, upstream.body.error?.message || 'base tutor prompt failed');
    return rpcOk(envelope.rpcId, { sessionId: session.sessionId, accepted: true });
}

/** The session targets one domain can compose. */
interface AgentTargetCatalog {
    presets: string[];
    providers: { id: string; models: string[] }[];
    defaultCwd: string;
    /** Permission preset every session of this deployment starts under. */
    defaultPermissionPreset: string;
    /** Permission presets a caller may state for the session it starts. */
    permissionPresets: string[];
}

/**
 * Read the permission presets the Agent advertises for its `defaultPreset` setting.
 *
 * The settings namespace ships one rehydrated schema graph per namespace: the root object's
 * `defaultPreset` field points at the union of the presets this deployment composes, and each union
 * member is a const node holding its id. A deployment composing no permission presets advertises no
 * such namespace, which is why the caller receives empty lists rather than a refusal.
 * @param projected - the `settings.project` value the Agent returned.
 * @returns the preset ids in declaration order, and the preset new sessions receive.
 */
function permissionCatalog(projected: unknown): { presets: string[]; current: string } {
    const namespaces = (projected as { namespaces?: unknown } | undefined)?.namespaces;
    const list = Array.isArray(namespaces) ? namespaces : [];
    const namespace = list.find((entry) => (entry as { ns?: unknown } | undefined)?.ns === 'permission') as
        | { schema?: { uid?: unknown; refs?: Record<string, unknown> }; value?: unknown; base?: unknown }
        | undefined;
    const schema = namespace?.schema;
    const ref = (id: unknown): Record<string, unknown> | undefined => {
        if (id === undefined || id === null) return undefined;
        return schema?.refs?.[String(id)] as Record<string, unknown> | undefined;
    };
    const root = ref(schema?.uid);
    const dict = root?.dict as Record<string, unknown> | undefined;
    const union = ref(dict?.defaultPreset);
    const members = Array.isArray(union?.list) ? union.list : [];
    const presets = members
        .map((id) => ref(id)?.value)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    const value = (namespace?.value ?? namespace?.base) as { defaultPreset?: unknown } | undefined;
    const current = typeof value?.defaultPreset === 'string' ? value.defaultPreset : '';
    return { presets, current };
}

/**
 * Read the failure message one upstream response carries.
 *
 * The Agent nests a refusal under `result.error`, so reading only the envelope's own `error` turns
 * every refusal into the caller's generic fallback.
 * @param body - the response body the upstream transport returned.
 * @returns the message the Agent named, when it named one.
 */
function upstreamErrorMessage(body: RpcBody): string | undefined {
    const nested = (body.result as { error?: { message?: unknown } } | undefined)?.error?.message;
    if (typeof nested === 'string' && nested.length > 0) return nested;
    return body.error?.message;
}

/** Read the preset ids one `agentPreset.list` response carries. */
function catalogPresets(body: RpcBody): string[] {
    const value = body.result?.ok ? body.result.value as { presets?: unknown } : undefined;
    const presets = Array.isArray(value?.presets) ? value.presets : [];
    return presets
        .map((entry) => String((entry as { id?: unknown } | undefined)?.id || ''))
        .filter((id) => id.length > 0);
}

/** Read a merged `llm.models` response as provider/model pairs. */
function catalogProviders(body: RpcBody): { id: string; models: string[] }[] {
    const value = body.result?.ok ? body.result.value as { groups?: unknown } : undefined;
    const groups = Array.isArray(value?.groups) ? value.groups : [];
    return groups.map((group) => {
        const entry = group as { id?: unknown; models?: unknown };
        const models = Array.isArray(entry.models) ? entry.models : [];
        return {
            id: String(entry.id || ''),
            models: models
                .map((model) => String((model as { id?: unknown } | undefined)?.id || ''))
                .filter((id) => id.length > 0),
        };
    }).filter((entry) => entry.id.length > 0);
}

/** One Agent turn another host addon asks for, with the session it runs in. */
interface AgentRunRequest {
    domainId: string;
    userId: number;
    /** Ejunz Base the run works on, when the caller selected one. */
    baseDocId?: number;
    /** Agent preset the run composes. The caller states it; a run never falls back to a default. */
    agentPreset: string;
    /** LLM provider the run uses. The caller states it; a run never falls back to a default. */
    provider: string;
    /** Model id the run uses, as the named provider serves it. */
    model: string;
    /** Working directory the run's session opens in. */
    cwd: string;
    /**
     * Permission preset the run's session starts under. The caller states it; a run that states
     * none keeps whatever the deployment gives a new session.
     */
    permissionPreset?: string;
    /** Session title, which the Agent session list shows. */
    title: string;
    /** First message of the session. */
    message: string;
}

/** What a host addon reads to start Agent work without touching Agent internals. */
interface AgentRunApi {
    start(input: AgentRunRequest): Promise<{ sessionId: string }>;

    /**
     * List every session target one domain can compose.
     * @param input - the domain whose targets are wanted.
     * @returns the presets, the providers with their model ids, the directory a run opens in, and
     * the permission presets a session may start under.
     */
    targets(input: { domainId: string }): Promise<AgentTargetCatalog>;

    status(input: { domainId: string; userId: number; sessionId: string }): Promise<{ running: boolean } | undefined>;
}

/**
 * The Agent runtime seam other host addons start Agent work through.
 *
 * The service owns the upstream transport, the domain's default model, and the stored session
 * summary, so a caller states the domain, owner, command, and optional Base and preset and receives
 * the session id: the session belongs to the calling user, appears in that user's session list
 * under the requested title, and receives the command as its first queued turn.
 */
class AgentRunService extends Service implements AgentRunApi {
    constructor(ctx: Context) {
        super(ctx, 'agentRun');
    }

    /**
     * Create one session for a user and queue the command as its first turn.
     *
     * The call carries the complete session target, so the created session composes what the caller
     * named and starts its first turn under it.
     * @param input - the domain, owner, Base, complete session target, session title, and command.
     * @returns the created session id.
     * @throws when the Agent upstream refuses to create the session or to queue the command.
     */
    async start(input: AgentRunRequest): Promise<{ sessionId: string }> {
        const scope = { domainId: input.domainId, userId: input.userId };
        const created = await sessionCreate({
            payload: {
                agentPreset: input.agentPreset,
                provider: input.provider,
                model: input.model,
                cwd: input.cwd,
                ...(input.baseDocId === undefined ? {} : { baseDocId: input.baseDocId }),
            },
        }, scope, { type: 'generic' });
        if (!created.result?.ok) throw new Error(upstreamErrorMessage(created) || 'The Agent runtime refused to create a session.');
        const sessionId = String((created.result.value as Record<string, unknown> | undefined)?.sessionId || '');
        if (!sessionId) throw new Error('The Agent runtime created a session without an id.');
        const acceptedPreset = (created.result.value as Record<string, unknown> | undefined)?.agentPreset;
        // The adopted session keeps the composition and the model its record carries, so the model
        // this run states is bound on the session explicitly before the command is queued.
        const selected = await callUpstream('session.selectModel', {
            sessionId,
            provider: input.provider,
            model: input.model,
            persistDefault: false,
        });
        if (!selected.body.result?.ok) {
            throw new Error(upstreamErrorMessage(selected.body) || 'The Agent runtime refused to select the stated model for this session.');
        }
        await agentDataAdapter.updateSession(scope, sessionId, {
            model: { provider: input.provider, model: input.model },
            ...(typeof acceptedPreset === 'string' ? { agentPreset: acceptedPreset } : {}),
        });
        if (input.title) {
            const renamed = await callUpstream('session.rename', { sessionId, title: input.title });
            const title = String((renamed.body.result?.value as Record<string, unknown> | undefined)?.title || '');
            if (title) {
                const existing = await agentDataAdapter.getSession(scope, sessionId);
                await agentDataAdapter.updateSession(scope, sessionId, {
                    projections: { values: { ...(existing?.projections?.values ?? {}), title } },
                });
            }
        }
        // The permission preset is switched before the command is queued, because a session's
        // sandbox and approval policy decide whether that first turn can act at all: a session
        // left on the deployment default can be unable to run any command it needs.
        if (input.permissionPreset) {
            const applied = await callUpstream('session.command', {
                sessionId,
                command: `/permission ${input.permissionPreset}`,
            });
            if (!applied.body.result?.ok) {
                throw new Error(upstreamErrorMessage(applied.body) || 'The Agent runtime refused the stated permission preset.');
            }
            const outcome = (applied.body.result.value as { result?: { kind?: unknown; text?: unknown } } | undefined)?.result;
            if (outcome?.kind !== 'success') {
                throw new Error(typeof outcome?.text === 'string' && outcome.text.length > 0
                    ? outcome.text
                    : `The Agent runtime has no permission preset "${input.permissionPreset}".`);
            }
        }
        const prompted = await callUpstream('session.prompt', {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: input.message }],
        });
        if (!prompted.body.result?.ok) throw new Error(upstreamErrorMessage(prompted.body) || 'The Agent runtime refused to queue the command.');
        return { sessionId };
    }

    /**
     * List every session target one domain can compose.
     *
     * The presets come from the Agent's preset roster, and the providers and models from the Agent's
     * model catalog merged with this domain's own settings, so a caller offers exactly what a run
     * could compose here. The permission presets come from the Agent's `permission` settings
     * namespace: a session's sandbox and approval policy decide whether its first turn can act, so a
     * caller states one from this list rather than inheriting the deployment default.
     * @param input - the domain whose targets are wanted.
     * @returns the presets, the providers with their model ids, the directory a run opens in, and
     * the permission presets a session may start under.
     * @throws when the Agent upstream refuses either catalog, because a caller that cannot read the
     * choices would have to guess a target the run then refuses.
     */
    async targets(input: { domainId: string }): Promise<AgentTargetCatalog> {
        const [presets, models, described] = await Promise.all([
            callUpstream('agentPreset.list', {}),
            callUpstream('llm.models', {}),
            callUpstream('host.describe', {}),
        ]);
        if (!presets.body.result?.ok) {
            throw new Error(upstreamErrorMessage(presets.body) || 'the Agent upstream refused the preset roster');
        }
        if (!models.body.result?.ok) {
            throw new Error(upstreamErrorMessage(models.body) || 'the Agent upstream refused the model catalog');
        }
        const domainSettings = await agentDataAdapter.getDomainSettings(input.domainId);
        const projected = await callUpstream('settings.project', { sections: domainSettings.sections });
        const permission = permissionCatalog(projected.body.result?.ok ? projected.body.result.value : undefined);
        const merged = mergeDomainModels(models.body, domainSettings.sections);
        const describedValue = described.body.result?.ok
            ? described.body.result.value as Record<string, unknown> | undefined
            : undefined;
        const catalogCwd = typeof describedValue?.cwd === 'string' && describedValue.cwd.length > 0
            ? describedValue.cwd
            : agentRoot;
        return {
            presets: catalogPresets(presets.body),
            providers: catalogProviders(merged),
            defaultCwd: catalogCwd,
            defaultPermissionPreset: permission.current,
            permissionPresets: permission.presets,
        };
    }

    /**
     * Report whether a session a run started is still working.
     *
     * The answer is the stored session summary: `running` covers the whole turn, and a session whose
     * turn failed still ends as not running, because the session log holds what happened.
     * @param input - the domain, owner, and Agent session id.
     * @returns whether the session runs now, or undefined when this owner holds no such session.
     */
    async status(input: { domainId: string; userId: number; sessionId: string }): Promise<{ running: boolean } | undefined> {
        const session = await agentDataAdapter.getSession({ domainId: input.domainId, userId: input.userId }, input.sessionId);
        if (!session) return undefined;
        return { running: session.running === true };
    }
}

function nodeView(node: AgentNodeDoc) {
    return {
        nodeId: node.nodeId,
        ...(node.agentId === undefined ? {} : { agentId: node.agentId }),
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
        ...(node.isRoot === undefined ? {} : { isRoot: node.isRoot }),
        text: node.text,
        order: node.order,
        createdAt: node.createdAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
    };
}

async function nodeRpc(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const payload = envelope.payload ?? {};
    const method = String(envelope.method || '');
    if (typeof scope.agentId === 'number') {
        const agent = await AgentDefinitionModel.get(scope.domainId, scope.agentId, AgentDefinitionModel.PROJECTION_LIST);
        if (!agent) return rpcError(envelope.rpcId, 'Agent not found in current domain');
        await AgentModel.ensureAgentRoot(scope.domainId, scope.userId, scope.agentId, agent.title);
    }
    if (method === 'node.list') {
        return rpcOk(envelope.rpcId, { items: (await agentDataAdapter.listNodes(scope)).map(nodeView) });
    }
    if (method === 'node.create') {
        const text = String(payload.text || '').trim();
        if (!text) return rpcError(envelope.rpcId, 'node name is required');
        const parentId = typeof payload.parentId === 'string' && payload.parentId.length > 0 ? payload.parentId : undefined;
        try {
            return rpcOk(envelope.rpcId, { node: nodeView(await agentDataAdapter.createNode(scope, text, parentId)) });
        } catch (error) {
            return rpcError(envelope.rpcId, error instanceof Error ? error.message : String(error));
        }
    }
    const nodeId = String(payload.nodeId || '');
    if (!nodeId) return rpcError(envelope.rpcId, 'nodeId is required');
    if (method === 'node.rename') {
        const text = String(payload.text || '').trim();
        if (!text) return rpcError(envelope.rpcId, 'node name is required');
        try {
            const node = await agentDataAdapter.updateNode(scope, nodeId, text);
            return node ? rpcOk(envelope.rpcId, { node: nodeView(node) }) : rpcError(envelope.rpcId, 'node not found');
        } catch (error) {
            return rpcError(envelope.rpcId, error instanceof Error ? error.message : String(error));
        }
    }
    if (method === 'node.delete') {
        try {
            await agentDataAdapter.deleteNode(scope, nodeId);
            return rpcOk(envelope.rpcId, { deleted: true });
        } catch (error) {
            return rpcError(envelope.rpcId, error instanceof Error ? error.message : String(error));
        }
    }
    return rpcError(envelope.rpcId, `unsupported node method: ${method}`);
}

async function workspaceRpc(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const payload = envelope.payload ?? {};
    const method = String(envelope.method || '');
    if (method === 'workspace.list') {
        const [items, archivedSessionIds] = await Promise.all([
            agentDataAdapter.listWorkspaces(scope),
            agentDataAdapter.archivedSessionIds(scope),
        ]);
        return rpcOk(envelope.rpcId, { items: items.map(workspaceView), archivedSessionIds });
    }
    if (method === 'workspace.create') {
        const pathValue = String(payload.path || '').trim();
        if (!pathValue) return rpcError(envelope.rpcId, 'workspace path is required');
        const existing = await agentDataAdapter.getWorkspaceByPath(scope, pathValue);
        if (existing) return rpcOk(envelope.rpcId, { workspace: workspaceView(existing), created: false });
        const created = await agentDataAdapter.createWorkspace(scope, pathValue);
        return rpcOk(envelope.rpcId, { workspace: workspaceView(created.workspace), created: created.created });
    }
    if (method === 'workspace.archiveSession') {
        const sessionId = String(payload.sessionId || '');
        if (!await agentDataAdapter.getSession(scope, sessionId)) return rpcError(envelope.rpcId, 'session not found');
        await agentDataAdapter.updateSession(scope, sessionId, { archived: true });
        return rpcOk(envelope.rpcId, { archivedSessionIds: await agentDataAdapter.archivedSessionIds(scope) });
    }
    const workspaceId = String(payload.workspaceId || '');
    const workspace = await agentDataAdapter.getWorkspace(scope, workspaceId);
    if (!workspace) return rpcError(envelope.rpcId, 'workspace not found');
    if (method === 'workspace.rename') {
        const updated = await agentDataAdapter.updateWorkspace(scope, workspaceId, { title: String(payload.title || '').trim() });
        return rpcOk(envelope.rpcId, { workspace: workspaceView(updated!) });
    }
    if (method === 'workspace.delete') {
        await agentDataAdapter.deleteWorkspace(scope, workspaceId);
        return rpcOk(envelope.rpcId, { deleted: true });
    }
    if (method === 'workspace.insertBefore') {
        const items = await agentDataAdapter.listWorkspaces(scope);
        const ids = items.map((item) => item.workspaceId).filter((id) => id !== workspaceId);
        const before = typeof payload.beforeWorkspaceId === 'string' ? ids.indexOf(payload.beforeWorkspaceId) : -1;
        ids.splice(before < 0 ? ids.length : before, 0, workspaceId);
        await agentDataAdapter.reorderWorkspaces(scope, ids);
        return rpcOk(envelope.rpcId, { workspaceIds: ids });
    }
    if (method === 'workspace.insertSessionBefore') {
        const sessionId = String(payload.sessionId || '');
        if (!await agentDataAdapter.getSession(scope, sessionId)) return rpcError(envelope.rpcId, 'session not found');
        const ids = workspace.sessionIds.filter((id) => id !== sessionId);
        const before = typeof payload.beforeSessionId === 'string' ? ids.indexOf(payload.beforeSessionId) : -1;
        ids.splice(before < 0 ? ids.length : before, 0, sessionId);
        const updated = await agentDataAdapter.reorderWorkspaceSessions(scope, workspaceId, ids);
        return rpcOk(envelope.rpcId, { workspace: workspaceView(updated!) });
    }
    return rpcError(envelope.rpcId, `unsupported workspace method: ${method}`);
}

function agentDataOrigin(ctx: EjunContext): string {
    const port = Number(ctx.server?.config?.port);
    if (Number.isSafeInteger(port) && port > 0) return `http://127.0.0.1:${port}`;
    const configuredPort = Number(SystemModel.get('server.port'));
    if (Number.isSafeInteger(configuredPort) && configuredPort > 0) return `http://127.0.0.1:${configuredPort}`;
    const configuredUrl = String(SystemModel.get('server.url') || '').trim();
    if (/^https?:\/\//.test(configuredUrl)) return configuredUrl.replace(/\/$/, '');
    const configured = String(process.env.EJUNZ_AGENT_DATA_ORIGIN || '').trim();
    if (configured) return configured.replace(/\/$/, '');
    return 'http://127.0.0.1:2333';
}

async function baseSessionScope(sessionId: string, optional = false) {
    if (!sessionId) throw new Error('sessionId is required');
    const session = await agentDataAdapter.getSessionAny(sessionId);
    if (!session) {
        if (optional) return { session: undefined, scope: undefined };
        throw new Error('Base session not found');
    }
    if (session.archived) throw new Error('Base session not found');
    const baseModel = (global as any).Ejunz?.model?.base;
    if (!baseModel) {
        if (optional) return { session, scope: undefined };
        throw new Error('Ejunz Base model is unavailable');
    }
    const storedBaseId = Number(session.baseDocId);
    let base;
    try {
        base = Number.isSafeInteger(storedBaseId) && storedBaseId > 0
            ? await baseModel.get(session.domainId, storedBaseId)
            : await baseModel.getByDomain(session.domainId);
    } catch (error) {
        if (optional) {
            logger.warn('[agent-base] scope lookup failed session=%s domain=%s error=%s', sessionId, session.domainId, error instanceof Error ? error.message : String(error));
            return { session, scope: undefined };
        }
        throw error;
    }
    const baseId = Number(base?.docId);
    if (!Number.isSafeInteger(baseId) || baseId <= 0) {
        if (optional) return { session, scope: undefined };
        throw new Error('No Base is configured for this domain');
    }
    return {
        session,
        scope: {
            domain: session.domainId,
            baseId,
            owner: session.userId,
            ...(typeof base.title === 'string' && base.title ? { baseName: base.title } : {}),
        },
    };
}

/**
 * The host's tool registry, resolved through the service store rather than a service
 * property: a property read is checked against the reading fiber's inject list, while
 * `get` reaches the registry whichever scope the handler runs in.
 */
function toolRegistry(): {
    list(source?: string, domainId?: string, access?: { priv?: number; perm?: bigint; scope?: bigint }): { name: string; description: string; inputSchema: Record<string, unknown>; source: string; mutating: boolean }[];
    instructions(context: { domainId: string; baseDocId: number; sessionId?: string }, source?: string): Promise<string[]>;
} {
    const ejunzContext = (global as any).app || (global as any).Ejunz;
    const tools = typeof ejunzContext?.get === 'function' ? ejunzContext.get('tools') : ejunzContext?.tools;
    if (!tools) throw new Error('Ejunz tool registry is unavailable');
    return tools;
}

/**
 * Persist a Base switch from `base_select` and inject the prompt section the running
 * Agent reads. The tool itself is registered by ejun.
 */
async function onBaseSelect(payload: {
    sessionId: string;
    domainId: string;
    owner: number;
    baseDocId: number;
    baseName?: string;
}): Promise<void> {
    const scope = { domainId: payload.domainId, userId: payload.owner };
    const injected = await callUpstream('session.inject', {
        sessionId: payload.sessionId,
        plugin: 'ejunz-base-selector',
        sections: [{
            name: 'ejunz-base-selector',
            text: `当前会话已切换到 Ejunz Base #${payload.baseDocId}${payload.baseName ? `（${payload.baseName}）` : ''}，位于 domain ${payload.domainId}。请使用 Base 工具处理该知识库中的节点、卡片、文件和练习题。`,
        }],
    }, await linkForSession(scope, payload.sessionId));
    if (!injected.body.result?.ok) throw new Error(injected.body.error?.message || '知识库上下文切换失败');
    await agentDataAdapter.updateSessionContext(
        { domainId: payload.domainId, userId: payload.owner },
        payload.sessionId,
        String(payload.baseDocId),
    );
}

/**
 * Load or mint the built-in host's data-bridge token.
 *
 * A token minted fresh on every plugin load makes a host that already booted
 * (the previous load handed it the old token) unidentifiable: its appends then
 * pass the ownership fence and collide with the host that adopted the session.
 * The token is therefore kept in the system collection and only minted once.
 */
async function ensureBuiltinBridgeToken(): Promise<void> {
    const stored = SystemModel.get(BUILTIN_BRIDGE_TOKEN_KEY);
    if (typeof stored === 'string' && stored.length > 0) {
        agentDataToken = stored;
        return;
    }
    agentDataToken = randomUUID();
    await SystemModel.set(BUILTIN_BRIDGE_TOKEN_KEY, agentDataToken);
}

/**
 * Authorize one call to the data bridge.
 *
 * Two credentials reach this bridge: the runtime inside this process, which was
 * handed the token minted at load, and a runtime that connected from elsewhere,
 * which holds the credential pairing issued it. Both stand for the same thing —
 * a runtime this server accepted — so both open the same route, and the bridge's
 * own scope checks remain what decides which domain and user a call acts for.
 * @param presented - the token the caller sent.
 * @throws when the token is neither, because an unauthorized bridge call cannot
 * be answered with anything but a refusal.
 */
async function requireBridgeToken(presented: unknown): Promise<void> {
    const token = String(presented || '');
    if (token !== '' && (token === agentDataToken || await AgentLinkModel.findByToken(token) !== undefined)) return;
    throw new Error('invalid agent data token');
}

/**
 * Which host presented this bridge token, when the token names one.
 *
 * The built-in runtime uses the process token; a paired external runtime uses
 * the pairing code as its host id. Appends from a host that no longer owns the
 * session are dropped so a switch can keep the same session's log contiguous.
 * @param presented - the `x-ejunz-agent-token` header value.
 * @returns the host id, or undefined when the token cannot be mapped.
 */
async function bridgeRuntimeId(presented: unknown): Promise<string | undefined> {
    const token = String(presented || '');
    if (token === '') return undefined;
    if (token === agentDataToken) return runtimeId();
    const linked = await AgentLinkModel.findByToken(token);
    return linked?.code;
}



/**
 * The pairing page: where an operator approves a runtime that asked to be bound.
 *
 * It renders the same ui-next shell as the other pages, and the route's own
 * privilege gate is what sends an operator through login first.
 */

/**
 * The runtime status page. It renders the same ui-next shell as the chat page:
 * the template name is the page key the browser half registers, so no template
 * file exists for either.
 */

function recordAt(value: unknown, path: readonly string[]): unknown {
    let current = value;
    for (const key of path) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

function cloneSettingsSections(value: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
    return structuredClone(value);
}

function mergeSettingValues(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
    const next = structuredClone(current);
    for (const [key, value] of Object.entries(patch)) {
        const previous = next[key];
        if (previous && typeof previous === 'object' && !Array.isArray(previous) && value && typeof value === 'object' && !Array.isArray(value)) {
            next[key] = mergeSettingValues(previous as Record<string, unknown>, value as Record<string, unknown>);
        } else next[key] = structuredClone(value);
    }
    return next;
}

function applySettingsOps(
    current: Record<string, unknown>,
    mode: 'update' | 'replace' | 'mutate',
    input: unknown,
): Record<string, unknown> {
    if (mode === 'replace') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings section must be an object');
        return structuredClone(input as Record<string, unknown>);
    }
    if (mode === 'update') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('settings patch must be an object');
        return mergeSettingValues(current, input as Record<string, unknown>);
    }
    if (!Array.isArray(input)) throw new Error('settings ops must be an array');
    const next = structuredClone(current);
    for (const op of input) {
        if (!op || typeof op !== 'object' || Array.isArray(op)) throw new Error('invalid settings operation');
        const item = op as { op?: unknown; path?: unknown; value?: unknown };
        if ((item.op !== 'set' && item.op !== 'unset') || !Array.isArray(item.path) || item.path.some((part) => typeof part !== 'string')) {
            throw new Error('invalid settings operation');
        }
        const path = item.path as string[];
        if (path.length === 0) throw new Error('settings operation path cannot be empty');
        let cursor = next;
        for (const key of path.slice(0, -1)) {
            const child = cursor[key];
            if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[key] = {};
            cursor = cursor[key] as Record<string, unknown>;
        }
        const leaf = path[path.length - 1];
        if (item.op === 'unset') delete cursor[leaf];
        else cursor[leaf] = structuredClone(item.value);
    }
    return next;
}

function sectionHasSecret(section: Record<string, unknown>, descriptor: Record<string, unknown>): boolean {
    const secrets = Array.isArray(descriptor.secrets) ? descriptor.secrets : [];
    return secrets.some((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const path = (entry as Record<string, unknown>).path;
        return Array.isArray(path) && path.every((part) => typeof part === 'string') && recordAt(section, path as string[]) !== undefined;
    });
}

function domainPiAiProfiles(sections: Record<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
    const section = sections['llm-pi-ai'];
    const providers = section?.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return new Map();
    return new Map(Object.entries(providers).filter((entry): entry is [string, Record<string, unknown>] => {
        const [provider, profile] = entry;
        return provider.length > 0 && !!profile && typeof profile === 'object' && !Array.isArray(profile);
    }));
}

function providerName(provider: string, profile: Record<string, unknown>): string {
    return typeof profile.displayName === 'string' && profile.displayName.length > 0 ? profile.displayName : provider;
}

function providerModels(profile: Record<string, unknown>): Record<string, unknown>[] {
    if (!Array.isArray(profile.models)) return [];
    return profile.models.flatMap((model) => {
        if (!model || typeof model !== 'object' || Array.isArray(model)) return [];
        const value = model as Record<string, unknown>;
        if (typeof value.id !== 'string' || value.id.length === 0) return [];
        return [{
            id: value.id,
            name: typeof value.name === 'string' && value.name.length > 0 ? value.name : value.id,
            ...(typeof value.description === 'string' ? { description: value.description } : {}),
        }];
    });
}

function withRpcValue(body: RpcBody, value: Record<string, unknown>): RpcBody {
    return body.result === undefined ? body : { ...body, result: { ...body.result, value } };
}

function mergeDomainProviders(body: RpcBody, sections: Record<string, Record<string, unknown>>): RpcBody {
    const value = body.result?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return body;
    const result = value as Record<string, unknown>;
    const providers = Array.isArray(result.providers) ? [...result.providers] as Record<string, unknown>[] : [];
    const profiles = domainPiAiProfiles(sections);
    for (const [provider, profile] of profiles) {
        const index = providers.findIndex((entry) => entry?.provider === provider);
        const next = {
            ...(index < 0 ? {} : providers[index]),
            provider,
            displayName: providerName(provider, profile),
            settingsNs: 'llm-pi-ai',
            settingsPath: ['providers', provider],
            active: true,
            ...(index < 0 ? { declared: true } : {}),
        };
        if (index < 0) providers.push(next);
        else providers[index] = next;
    }
    return withRpcValue(body, { ...result, providers });
}

function mergeDomainModels(body: RpcBody, sections: Record<string, Record<string, unknown>>): RpcBody {
    const value = body.result?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return body;
    const result = value as Record<string, unknown>;
    const groups = Array.isArray(result.groups) ? [...result.groups] as Record<string, unknown>[] : [];
    const profiles = domainPiAiProfiles(sections);
    for (const [provider, profile] of profiles) {
        const models = providerModels(profile);
        if (models.length === 0) continue;
        const index = groups.findIndex((entry) => entry?.id === provider);
        const next = { ...(index < 0 ? {} : groups[index]), id: provider, name: providerName(provider, profile), models };
        if (index < 0) groups.push(next);
        else groups[index] = next;
    }
    const current = result.current;
    const routable = current && typeof current === 'object' && !Array.isArray(current)
        && profiles.has(String((current as Record<string, unknown>).provider))
        ? true
        : result.routable;
    return withRpcValue(body, { ...result, groups, routable });
}

async function domainSettingsRpc(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const method = String(envelope.method || '');
    const current = await agentDataAdapter.getDomainSettings(scope.domainId);
    const upstream = await callUpstream('settings.project', { sections: current.sections });
    if (!upstream.body.result?.ok) return rpcError(envelope.rpcId, upstream.body.error?.message || 'domain settings unavailable');
    const projected = upstreamValue(upstream.body) as { namespaces?: unknown[] };
    const namespaces = Array.isArray(projected.namespaces) ? projected.namespaces : [];
    if (method === 'settings.describe') {
        return rpcOk(envelope.rpcId, { writable: true, hasDocument: false, namespaces: namespaces.map((value) => ({ ...(value as Record<string, unknown>), revision: current.revision })) });
    }
    const payload = envelope.payload ?? {};
    const ns = typeof payload.ns === 'string' ? payload.ns : '';
    const existing = current.sections[ns] ?? {};
    let nextSection: Record<string, unknown>;
    try {
        const mode = method === 'settings.update' ? 'update' : method === 'settings.replace' ? 'replace' : 'mutate';
        const input = mode === 'update' ? payload.patch : mode === 'replace' ? payload.section : payload.ops;
        nextSection = applySettingsOps(existing, mode, input);
    } catch (error) {
        return rpcError(envelope.rpcId, error instanceof Error ? error.message : String(error));
    }
    const descriptor = namespaces.find((value) => value && typeof value === 'object' && (value as Record<string, unknown>).ns === ns) as Record<string, unknown> | undefined;
    if (!descriptor) return rpcError(envelope.rpcId, `settings namespace "${ns}" is unavailable`);
    if (sectionHasSecret(nextSection, descriptor)) return rpcError(envelope.rpcId, 'secret settings must be stored through credentials.set');
    const nextSections = cloneSettingsSections(current.sections);
    if (Object.keys(nextSection).length === 0) delete nextSections[ns];
    else nextSections[ns] = nextSection;
    const saved = await agentDataAdapter.updateDomainSettings(scope.domainId, nextSections, typeof payload.expectedRevision === 'number' ? payload.expectedRevision : undefined);
    if (!saved) return rpcError(envelope.rpcId, 'settings revision conflict');
    const projectedNext = await callUpstream('settings.project', { sections: saved.sections });
    if (!projectedNext.body.result?.ok) return rpcError(envelope.rpcId, projectedNext.body.error?.message || 'domain settings unavailable after update');
    const nextValue = upstreamValue(projectedNext.body) as { namespaces?: unknown[] };
    const result = Array.isArray(nextValue.namespaces)
        ? nextValue.namespaces.find((value) => value && typeof value === 'object' && (value as Record<string, unknown>).ns === ns)
        : undefined;
    return rpcOk(envelope.rpcId, result ? { ...(result as Record<string, unknown>), revision: saved.revision } : { ns, revision: saved.revision });
}

async function domainCredentialsRpc(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const payload = envelope.payload ?? {};
    const method = String(envelope.method || '');
    if (method === 'credentials.describe') {
        const rawRefs = Array.isArray(payload.refs) ? payload.refs : [];
        try {
            rawRefs.forEach((ref) => credentialRef(String(ref)));
        } catch (error) {
            return rpcError(envelope.rpcId, error instanceof Error ? error.message : String(error));
        }
        const entries = await Promise.all(rawRefs.map(async (ref) => {
            const name = String(ref);
            const info = await agentDataAdapter.describeCredential(scope.domainId, name);
            return [name, info] as const;
        }));
        return rpcOk(envelope.rpcId, { credentials: Object.fromEntries(entries) });
    }
    const ref = typeof payload.ref === 'string' ? payload.ref : '';
    try {
        credentialRef(ref);
        if (method === 'credentials.set') await agentDataAdapter.setCredential(scope.domainId, ref, typeof payload.value === 'string' ? payload.value : '');
        else await agentDataAdapter.unsetCredential(scope.domainId, ref);
        return rpcOk(envelope.rpcId, {});
    } catch (error) {
        return rpcError(envelope.rpcId, error instanceof Error ? error.message : String(error));
    }
}



/**
 * The client-plugin reload channel is a development surface of the runtime's
 * own checkout watcher, and only its HTTP carrier serves it. An embedded
 * runtime has no watcher and no browser bundle of its own to reload, so this
 * route states that instead of proxying a channel nothing owns.
 */


/**
 * Load the Ejunz-Agent embed entry.
 *
 * That application is a separate ESM program whose workspace imports resolve
 * through its own tsconfig `paths` — the source plane its CLI boots from — so it
 * is loaded through a loader namespace scoped to this one import. This host
 * process's own loader resolves this host's packages and would hand back the
 * application's unbuilt `lib/` entries instead.
 * @returns the embed entry's exports.
 */
async function importAgentEmbed(): Promise<{ embedAgentRuntime(options: { bridge: { origin: string; token: string } }): Promise<InProcessRuntime> }> {
    const agentRequire = createRequire(path.join(agentRoot, 'package.json'));
    const requireEntry = agentRequire.resolve('tsx/esm/api');
    const tsxApiPath = requireEntry.endsWith('.cjs') ? requireEntry.slice(0, -4) + '.mjs' : requireEntry;
    const { register } = await import(pathToFileURL(tsxApiPath).href) as {
        register(options: { namespace: string; tsconfig: string }): {
            import(specifier: string, parent: string): Promise<unknown>;
        };
    };
    const scoped = register({ namespace: 'ejunz-agent', tsconfig: path.join(agentRoot, 'tsconfig.base.json') });
    return await scoped.import(agentEmbedEntry, pathToFileURL(__filename).href) as Awaited<ReturnType<typeof importAgentEmbed>>;
}

/**
 * The booted runtime, waiting for a boot that is still in flight.
 * @returns the runtime.
 * @throws when no boot is in flight and none settled, because a caller that
 * proceeded would answer a session with no runtime behind it.
 */
async function requireLink(): Promise<RuntimeLink> {
    if (agentStarting) await agentStarting;
    const link = defaultLink();
    if (link !== undefined) return link;
    throw new Error(agentDisposing ? 'the agent runtime is shutting down' : 'no agent runtime is reachable');
}

/**
 * What each reachable runtime said about itself, outside the facts its own
 * `host.describe` answers: identity, and when it started.
 */
interface RuntimeFacts {
    label: string;
    host: string;
    pid: number;
    startedAt: number;
}

const runtimeFacts = new Map<string, RuntimeFacts>();

/**
 * Report one runtime to the registry.
 *
 * Every fact comes from the runtime itself: `host.describe` answers what the
 * runtime knows — its version, the directory it resolves paths against, how
 * many sessions it holds live agents for — so the registry never states
 * something the runtime did not say. A failed read leaves the previous report
 * in place; its age is what a viewer reads as "no longer reporting".
 * @param link - the runtime to report.
 */
async function reportRuntime(link: RuntimeLink): Promise<void> {
    const described = await callRuntime(link, '/api/host.describe', {
        type: 'client-request',
        rpcId: `host-${randomUUID()}`,
        method: 'host.describe',
        payload: {},
    });
    if (!described.body.result?.ok) return;
    const value = upstreamValue(described.body) as Record<string, unknown>;
    const facts = runtimeFacts.get(link.runtimeId);
    await agentDataAdapter.upsertRuntime({
        runtimeId: link.runtimeId,
        label: facts?.label ?? link.kind,
        kind: link.kind,
        host: facts?.host ?? hostname(),
        pid: facts?.pid ?? process.pid,
        version: String(value.version || 'unknown'),
        cwd: String(value.cwd || ''),
        attachedSessions: Number(value.attachedSessions) || 0,
        online: true,
        startedAt: facts?.startedAt ?? processStart(),
        updatedAt: Date.now(),
    });
}

/**
 * Record a runtime's identity, so every later report and row carries it.
 * @param runtimeIdValue - the identity this server assigned.
 * @param facts - what the runtime reported about itself.
 */
function rememberRuntime(runtimeIdValue: string, facts: RuntimeFacts): void {
    runtimeFacts.set(runtimeIdValue, facts);
}

/** This process's start instant, derived from its own uptime. */
function processStart(): number {
    return Date.now() - Math.round(process.uptime() * 1000);
}

/**
 * One registry row as a status page reads it: the stored facts plus the two
 * readings derived from when they were reported.
 */
interface AgentRuntimeStatusView extends AgentRuntimeSummary {
    /**
     * Whether this is the host a session that names none is served by, which is
     * what a page shows for the sessions recorded before hosts were chosen.
     */
    fallback: boolean;
    /** Whether the last report is still authoritative. */
    responded: boolean;
    /** Milliseconds since the runtime started. */
    uptimeMs: number;
    /** Milliseconds since the runtime last reported. */
    sinceReportMs: number;
}

/**
 * The rows a status page reads.
 * @returns one entry per known runtime, newest report first.
 */
async function runtimeStatusItems(): Promise<AgentRuntimeStatusView[]> {
    const rows = await agentDataAdapter.listRuntimes();
    const now = Date.now();
    return rows.map((row) => {
        // A row outlives the process that wrote it, so a host counts as online
        // only while this server still holds its connection.
        const online = row.online && runtimeLinks.has(row.runtimeId);
        return {
            ...row,
            online,
            fallback: runtimeLinks.has(row.runtimeId) && row.runtimeId === defaultLink()?.runtimeId,
            responded: online && now - row.updatedAt < RUNTIME_STALE_MS,
            uptimeMs: Math.max(0, now - row.startedAt),
            sinceReportMs: Math.max(0, now - row.updatedAt),
        };
    });
}

/**
 * One pairing request, as the page that approves it reads it.
 * @param envelope - the RPC envelope carrying `code`.
 * @returns the RPC body: the request, or why it is not there.
 */
async function linkStatus(envelope: RpcEnvelope): Promise<RpcBody> {
    const code = String(envelope.payload?.code || '').trim().toUpperCase();
    if (!code) return rpcError(envelope.rpcId, 'code is required');
    const link = await AgentLinkModel.get(code);
    if (!link) return rpcError(envelope.rpcId, 'link request not found');
    return rpcOk(envelope.rpcId, {
        ...link,
        expired: link.status === 'pending' && link.expiresAt < Date.now(),
    });
}

/**
 * Answer one pairing request on behalf of the operator reading it.
 *
 * The credential stays server-side: this method records the approval, and the
 * socket that asked collects the token on its next poll. A page therefore never
 * sees a secret it could leak.
 * @param envelope - the RPC envelope carrying `code`.
 * @param scope - the approving operator, recorded with the binding.
 * @returns the RPC body: the approval, or why it was refused.
 */
async function linkApprove(envelope: RpcEnvelope, scope: AgentScope): Promise<RpcBody> {
    const code = String(envelope.payload?.code || '').trim().toUpperCase();
    if (!code) return rpcError(envelope.rpcId, 'code is required');
    const approved = await AgentLinkModel.approve(code, scope.userId);
    if ('error' in approved) return rpcError(envelope.rpcId, approved.error);
    logger.info('Agent link %s approved by user %d', code, scope.userId);
    return rpcOk(envelope.rpcId, { code, status: 'approved' });
}

/** The longest label the registry accepts; a page shows it in one row. */
const RUNTIME_LABEL_MAX = 64;

/**
 * Stop the previous host from writing the shared session log before another
 * host adopts it.
 *
 * Every host persists through this server's append-only event log. A switch that
 * lets the previous host keep appending while the next host creates, injects, or
 * answers collides on the same seq and fails with a payload conflict. Cancelling
 * the in-flight turn and waiting until the session is idle drains that writer
 * first; a short settle then covers write-behind that lands after `running`
 * flips false.
 *
 * Do not call this from inside an in-flight `tools/call` on the previous host:
 * cancel aborts that bridge request. A tool switch does not use this fence; it
 * injects context into the live turn and adopts the next host only after the
 * turn has closed — see {@link applyLiveHostMove}.
 * @param sessionId - the session being moved.
 * @param previousRuntimeId - the host that currently holds it, if any.
 * @param scope - the owning domain and user, which own the running flag.
 */
async function fencePreviousHostWriter(
    sessionId: string,
    previousRuntimeId: string | undefined,
    scope: AgentScope,
): Promise<void> {
    if (previousRuntimeId === undefined || previousRuntimeId === '') return;
    const previous = runtimeLinks.get(previousRuntimeId);
    if (previous === undefined) return;
    const cancelled = await callUpstream('session.cancel', { sessionId }, previous);
    if (!cancelled.body.result?.ok) {
        logger.info(
            'Agent host switch cancel on previous host session=%s host=%s ok=%s',
            sessionId,
            previousRuntimeId,
            cancelled.body.error?.message || 'not attached',
        );
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const row = await agentDataAdapter.getSession(scope, sessionId);
        if (row?.running !== true) break;
        await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    }
    // Write-behind can still flush a few events after the status flips idle.
    await new Promise<void>((resolve) => { setTimeout(resolve, 300); });
}

/**
 * Whether this tail shows a turn that has already closed.
 *
 * A tail with neither boundary is the middle of a long turn, which is not
 * idle. A `turn/start` after the last `turn/end` is a turn that is still open.
 * @param events - a session log tail, oldest first.
 * @returns whether the newest turn boundary in the tail is a close.
 */
function turnClosedInTail(events: readonly Record<string, unknown>[]): boolean {
    let phase: 'unknown' | 'open' | 'closed' = 'unknown';
    for (const event of events) {
        if (event.type === 'turn/start') phase = 'open';
        else if (event.type === 'turn/end') phase = 'closed';
    }
    return phase === 'closed';
}

/**
 * Wait until the turn that is writing this session has closed, then until a
 * short settle shows no newer event.
 *
 * The host that is running the turn keeps the log until then. Claiming earlier
 * drops its next step and the model never reads the switch it just requested.
 * @param sessionId - the session whose log is read.
 * @param superseded - whether a newer move replaced this one.
 * @returns whether the turn is closed and this move is still the pending one.
 */
async function waitUntilTurnClosed(sessionId: string, superseded: () => boolean): Promise<boolean> {
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
        if (superseded()) return false;
        const tail = await agentDataAdapter.listEventsTailAny(sessionId, undefined, 80);
        if (!turnClosedInTail(tail.events)) {
            await sleep(HOST_MOVE_POLL_MS);
            continue;
        }
        const closedAt = tail.events[tail.events.length - 1]?.seq;
        await sleep(HOST_MOVE_IDLE_SETTLE_MS);
        if (superseded()) return false;
        const again = await agentDataAdapter.listEventsTailAny(sessionId, undefined, 80);
        const stillClosed = turnClosedInTail(again.events);
        const sameEnd = again.events[again.events.length - 1]?.seq === closedAt;
        if (stillClosed && sameEnd) return true;
    }
    logger.warn('Agent host move gave up waiting for the turn to close session=%s', sessionId);
    return false;
}

/**
 * Move one session to another host after the turn that requested it has closed.
 *
 * The running agent already has the switch in its context (see
 * {@link injectHostSwitchNotice}). This only hands the shared log to the target
 * once that host is the one that will serve the next turn. It does not cancel
 * the turn and does not queue a user message.
 * @param input - session, target host, the host the turn started on, generation, and owning scope.
 */
async function applyLiveHostMove(input: {
    scope: AgentScope;
    sessionId: string;
    previousRuntimeId: string;
    runtimeId: string;
    generation: number;
}): Promise<void> {
    const { scope, sessionId } = input;
    const superseded = (): boolean => liveHostMoves.get(sessionId)?.generation !== input.generation;
    try {
        const closed = await waitUntilTurnClosed(sessionId, superseded);
        if (!closed || superseded()) return;
        const session = await agentDataAdapter.getSession(scope, sessionId);
        if (!session) {
            logger.warn('Agent host move skipped session=%s reason=session-gone', sessionId);
            return;
        }
        if (session.runtimeId === input.runtimeId) return;
        const link = runtimeLinks.get(input.runtimeId);
        if (link === undefined) {
            logger.warn('Agent host move skipped session=%s host=%s reason=host-offline', sessionId, input.runtimeId);
            return;
        }
        const previousRuntimeId = input.previousRuntimeId;
        await agentDataAdapter.updateSession(scope, sessionId, { runtimeId: input.runtimeId });
        const adopted = await callUpstream('session.create', {
            sessionId,
            ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
            ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
            ...(session.model === undefined ? {} : { provider: session.model.provider, model: session.model.model }),
        }, link);
        if (!adopted.body.result?.ok) {
            await agentDataAdapter.updateSession(scope, sessionId, { runtimeId: previousRuntimeId || '' });
            logger.warn(
                'Agent host move refused session=%s host=%s error=%s',
                sessionId,
                input.runtimeId,
                adopted.body.error?.message || 'unknown',
            );
            return;
        }
        await selectHostModel(sessionId, link, session.model);
        await injectHostContext(sessionId, link, previousRuntimeId, true);
        logger.info(
            'Agent host move applied after turn session=%s host=%s generation=%d',
            sessionId,
            input.runtimeId,
            input.generation,
        );
    } catch (error) {
        logger.warn(
            'Agent host move crashed session=%s error=%s',
            sessionId,
            error instanceof Error ? error.message : String(error),
        );
    } finally {
        if (liveHostMoves.get(sessionId)?.generation === input.generation) liveHostMoves.delete(sessionId);
    }
}

/**
 * Run the pending move of one session, unless a mover already runs for it.
 *
 * One mover per session keeps two requests from interleaving their claims; a
 * newer request replaces the pending entry, and the mover that finishes first
 * picks the newer one up.
 * @param sessionId - the session whose pending move is run.
 */
function pumpLiveHostMove(sessionId: string): void {
    if (liveHostMoveWaiters.has(sessionId)) return;
    const pending = liveHostMoves.get(sessionId);
    if (pending === undefined) return;
    liveHostMoveWaiters.add(sessionId);
    void applyLiveHostMove({
        scope: pending.scope,
        sessionId,
        previousRuntimeId: pending.previousRuntimeId,
        runtimeId: pending.runtimeId,
        generation: pending.generation,
    }).finally(() => {
        liveHostMoveWaiters.delete(sessionId);
        if (liveHostMoves.has(sessionId)) pumpLiveHostMove(sessionId);
    }).catch(() => undefined);
}

/**
 * Record a host move requested by the authenticated UI and notify the running agent.
 *
 * The notice is queued before the UI request returns. The next step of the same
 * turn reads it. The session record moves only after the turn closes, in
 * {@link applyLiveHostMove}.
 * @param input - session, target host, and owning scope.
 * @returns the accepted move summary.
 */
async function startLiveHostMove(input: {
    domainId: string;
    userId: number;
    sessionId: string;
    callerSessionId?: string;
    runtimeId: string;
}): Promise<{ sessionId: string; runtimeId: string; label: string; note: string }> {
    const scope = { domainId: input.domainId, userId: input.userId };
    const session = await agentDataAdapter.getSession(scope, input.sessionId);
    if (!session) throw new Error('session not found');
    const requested = input.runtimeId.trim();
    if (!requested) throw new Error('runtimeId is required');
    if (session.runtimeId === requested) {
        return {
            sessionId: input.sessionId,
            runtimeId: requested,
            label: hostLabel(requested),
            note: 'Already on this host; no switch needed.',
        };
    }
    if (runtimeLinks.get(requested) === undefined) {
        throw new Error(`host「${hostLabel(requested)}」不在线`);
    }
    const currentId = session.runtimeId || '';
    const current = runtimeLinks.get(currentId);
    if (current !== undefined) {
        await injectHostSwitchNotice(input.sessionId, current, currentId, requested);
    }
    liveHostMoves.set(input.sessionId, {
        scope,
        previousRuntimeId: currentId,
        runtimeId: requested,
        generation: ++liveHostMoveGeneration,
    });
    pumpLiveHostMove(input.sessionId);
    return {
        sessionId: input.sessionId,
        runtimeId: requested,
        label: hostLabel(requested),
        note: `会话路由已切换到目标 host「${hostLabel(requested)}」。已经开始的工具调用仍由当前 host 完成；当前回合结束后系统会自动在目标 host 续接，不需要用户再发消息。`,
    };
}

/**
 * Move one session to another host and keep chatting on the same session id.
 *
 * Continuity is the shared event log on this server: the previous host is
 * fenced (cancel + idle), ownership of that log moves to the new host, then the
 * new host resumes the same sessionId from persistence so prior turns stay in
 * context. Appends from the previous host are ignored after ownership moves, so
 * late write-behind cannot collide with the resume/inject the new host writes.
 * The injected host context is what tells the model the machine changed. If the
 * new host refuses to adopt, ownership is rolled back.
 * @param envelope - the RPC envelope carrying `sessionId` and `runtimeId`.
 * @param scope - the owning domain and user, which own the session record.
 * @param options.cancelPrevious - when false, skip cancel/idle wait (deferred
 *   tool moves apply only after the session is already idle).
 * @returns the RPC body: the host now serving the session, or why it did not move.
 */
async function sessionSetHost(
    envelope: RpcEnvelope,
    scope: AgentScope,
    options?: { cancelPrevious?: boolean },
): Promise<RpcBody> {
    const sessionId = String(envelope.payload?.sessionId || '');
    const requested = String(envelope.payload?.runtimeId || '').trim();
    if (!sessionId) return rpcError(envelope.rpcId, 'sessionId is required');
    if (!requested) return rpcError(envelope.rpcId, 'runtimeId is required');
    const session = await agentDataAdapter.getSession(scope, sessionId);
    if (!session) return rpcError(envelope.rpcId, 'session not found');
    if (session.runtimeId === requested) return rpcOk(envelope.rpcId, { sessionId, runtimeId: requested, label: hostLabel(requested) });
    const link = runtimeLinks.get(requested);
    if (link === undefined) return rpcError(envelope.rpcId, `host「${hostLabel(requested)}」不在线`);
    // A tool may have queued the same move; drop it so its mover does not redo it.
    liveHostMoves.delete(sessionId);
    const previousRuntimeId = session.runtimeId;
    if (options?.cancelPrevious !== false) {
        await fencePreviousHostWriter(sessionId, previousRuntimeId, scope);
    }
    // Claim the shared log before the new host resumes it, so a flush from the
    // previous host cannot race the adopt/inject writes.
    await agentDataAdapter.updateSession(scope, sessionId, { runtimeId: requested, running: false });
    // Same sessionId: the new host resumes from this server's event log, so the
    // chat continues rather than starting empty.
    const adopted = await callUpstream('session.create', {
        sessionId,
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
        ...(session.model === undefined ? {} : { provider: session.model.provider, model: session.model.model }),
    }, link);
    if (!adopted.body.result?.ok) {
        await agentDataAdapter.updateSession(scope, sessionId, {
            runtimeId: previousRuntimeId || '',
            running: false,
        });
        return rpcError(envelope.rpcId, adopted.body.error?.message || `host「${link.runtimeId}」无法接管这个会话`);
    }
    await selectHostModel(sessionId, link, session.model);
    await injectHostContext(sessionId, link, previousRuntimeId);
    logger.info('Agent session %s moved to host %s (same session continued)', sessionId, requested);
    return rpcOk(envelope.rpcId, { sessionId, runtimeId: requested, label: hostLabel(requested) });
}

/**
 * Set one runtime's display label.
 * @param envelope - the RPC envelope carrying `runtimeId` and `label`.
 * @returns the RPC body: the stored label, or why the request was refused.
 */
async function runtimeRelabel(envelope: RpcEnvelope): Promise<RpcBody> {
    const id = String(envelope.payload?.runtimeId || '');
    const label = String(envelope.payload?.label ?? '').trim();
    if (!id) return rpcError(envelope.rpcId, 'runtimeId is required');
    if (label.length === 0) return rpcError(envelope.rpcId, 'label cannot be empty');
    if (label.length > RUNTIME_LABEL_MAX) return rpcError(envelope.rpcId, `label is longer than ${RUNTIME_LABEL_MAX} characters`);
    if (!await agentDataAdapter.setRuntimeLabel(id, label)) return rpcError(envelope.rpcId, 'runtime not found');
    return rpcOk(envelope.rpcId, { runtimeId: id, label });
}

/**
 * Forget one runtime's record.
 *
 * A runtime that still reports owns its row: removing it would hide a process
 * that may be serving sessions right now, so the refusal reads the same fact
 * the page shows.
 * @param envelope - the RPC envelope carrying `runtimeId`.
 * @returns the RPC body: the removal, or why the request was refused.
 */
async function runtimeRemove(envelope: RpcEnvelope): Promise<RpcBody> {
    const id = String(envelope.payload?.runtimeId || '');
    if (!id) return rpcError(envelope.rpcId, 'runtimeId is required');
    const row = (await runtimeStatusItems()).find((item) => item.runtimeId === id);
    if (!row) return rpcError(envelope.rpcId, 'runtime not found');
    if (row.responded) return rpcError(envelope.rpcId, 'runtime is still reporting; a record outlives its runtime, not the other way round');
    if (!await agentDataAdapter.removeRuntime(id)) return rpcError(envelope.rpcId, 'runtime not found');
    return rpcOk(envelope.rpcId, { runtimeId: id, removed: true });
}

/**
 * Boot the Ejunz-Agent runtime inside this process.
 *
 * The runtime's persistence, storage, and host-tool rows all dial this server's
 * data bridge, so the boot belongs after `app/listen`, and the bridge's origin
 * is this server's own port. One runtime serves every domain and user: it
 * resolves a session's domain from the record this plugin stores, exactly as
 * the spawned surface did.
 * @param ctx - the plugin context, for the server port the bridge is reachable at.
 */
async function startAgent(ctx: EjunContext): Promise<void> {
    if (agentRuntime || agentStarting) return;
    const dataOrigin = agentDataOrigin(ctx);
    logger.info('Ejunz-Agent data bridge origin: %s', dataOrigin);
    agentStarting = (async () => {
        const { embedAgentRuntime } = await importAgentEmbed();
        return await embedAgentRuntime({ bridge: { origin: dataOrigin, token: agentDataToken } }) as InProcessRuntime;
    })();
    try {
        agentRuntime = await agentStarting;
        // Before this process publishes its own row, so the roster never shows
        // two embedded runtimes for one host.
        const pruned = await pruneEmbeddedRuntimeRows();
        if (pruned > 0) logger.info('Removed %d embedded runtime row(s) no process can return to', pruned);
        addLink(createInProcessLink(runtimeId(), agentRuntime));
        rememberRuntime(runtimeId(), {
            label: `builtin@${hostname()}`,
            host: hostname(),
            pid: process.pid,
            startedAt: processStart(),
        });
        logger.info('EJunz-Agent runtime ready');
        // Published only once the runtime answers, so a failed boot leaves no
        // row claiming a runtime that is not there.
        await reportRuntime(runtimeLinks.get(runtimeId())!);
        if (runtimeHeartbeat) clearInterval(runtimeHeartbeat);
        runtimeHeartbeat = setInterval(() => {
            const link = runtimeLinks.get(runtimeId());
            if (link !== undefined) void reportRuntime(link).catch((error) => logger.warn('Agent runtime heartbeat failed: %o', error));
        }, RUNTIME_HEARTBEAT_MS);
        (runtimeHeartbeat as unknown as { unref?: () => void }).unref?.();
    } catch (error) {
        // A failed boot leaves no runtime, so every route answers 503 until the
        // next load: the failure is logged here because nothing else survives to
        // report it.
        logger.error('EJunz-Agent runtime failed to boot: %o', error);
    } finally {
        agentStarting = null;
    }
}

/** Dispose the embedded runtime, ending every session it holds with this call. */
async function stopAgent(): Promise<void> {
    agentDisposing = true;
    if (runtimeHeartbeat) {
        clearInterval(runtimeHeartbeat);
        runtimeHeartbeat = null;
    }
    runtimeLinks.delete(runtimeId());
    const runtime = agentRuntime;
    const starting = agentStarting;
    agentRuntime = null;
    agentStarting = null;
    if (runtime === null && starting === null) return;
    logger.info('Stopping EJunz-Agent runtime...');
    try {
        if (runtime !== null) await runtime.ctx.fiber.dispose();
        else if (starting !== null) await (await starting).ctx.fiber.dispose();
        // Recorded after disposal: a row that outlives its runtime says so
        // rather than waiting for a viewer to notice the report went stale.
        await agentDataAdapter.markRuntimeOffline(runtimeId());
        runtimeFacts.delete(runtimeId());
    } catch (error) {
        logger.warn('EJunz-Agent runtime disposal failed: %o', error);
    }
}

/** How long a connecting runtime has to identify itself. */
const RUNTIME_HELLO_TIMEOUT_MS = 10_000;

/**
 * One agent runtime that connected to this server.
 *
 * The runtime dials out and authenticates as a user holding the runtime
 * privilege — the same `sid` session token (bearer header, cookie, or query)
 * every other surface of this server accepts. It then reports what it is, and
 * serves the same `/api` paths and downlink streams the embedded runtime serves
 * in process: this handler only carries the frames and keeps the registry row
 * current, so routing above it does not know which transport a session runs on.
 */




export async function initializeAgentRuntime(ctx: EjunContext): Promise<() => Promise<void>> {
    modelReady = Promise.all([agentDataAdapter.ensureIndexes(), AgentStorageModel.ensureIndexes(), AgentLinkModel.ensureIndexes()]).then(() => undefined);
    await modelReady;
    await agentDataAdapter.resetRunningSessions();
    await ensureBuiltinBridgeToken();
    ctx.on?.('tool/base-select', onBaseSelect);
    ctx.plugin(AgentRunService);
    agentDisposing = false;
    const startWhenListening = (): void => {
        if (agentRuntime || agentStarting) return;
        logger.info('Starting EJunz-Agent after EJunz server is listening...');
        void startAgent(ctx);
    };
    if (httpServer.listening) startWhenListening();
    else ctx.on?.('app/listen', startWhenListening);
    return stopAgent;
}


// Runtime transport protocol
/**
 * The wire between this server and an agent runtime that connects from
 * elsewhere.
 *
 * The socket carries exactly what the in-process surface calls directly: one
 * `/api` request with its response envelope, the two downlink streams, and the
 * runtime's own reports. Every frame is a transport fact — nothing here
 * describes a session, a tool, or a turn, so the same protocol would carry a
 * future surface without changing this file.
 */

/** The two downlink streams a browser client receives. */
export type RuntimeStream = 'mux' | 'host';

/** One request for the runtime to answer, named by its `/api` path. */
export interface RuntimeRequestFrame {
    key: 'request';
    rpcId: string;
    /** Absolute path, e.g. `/api/session.create` or `/api/respond`. */
    path: string;
    /** The request body, verbatim: the same envelope the HTTP route parses. */
    body: unknown;
}

/** The runtime's answer to one request, in the shape its HTTP carrier returns. */
export interface RuntimeResponseFrame {
    key: 'response';
    rpcId: string;
    status: number;
    contentType: string;
    text: string;
}

/**
 * What a runtime says about itself when it connects.
 *
 * A runtime that was bound presents the credential pairing issued it; one that
 * was not presents the secret its socket generated, and this server answers with
 * a request an operator approves in a browser.
 */
export interface RuntimeHelloFrame {
    key: 'hello';
    /** The credential pairing issued, once an operator approved a request. */
    token?: string;
    /** This socket's own secret, so an approval binds the socket that asked. */
    pairSecret?: string;
    label?: string;
    version?: string;
    /** The runtime's own host name and pid: together they are its registry identity. */
    host?: string;
    pid?: number;
    /** The runtime's own process start, so a row can show how long it has run. */
    startedAt?: number;
}

/** The runtime's periodic self-report. */
export interface RuntimeStatusFrame {
    key: 'status';
    attachedSessions?: number;
    /** Whether the runtime still holds the sessions it was serving. */
    online?: boolean;
}

/** One downlink frame, as the runtime's own carrier produces it. */
export interface RuntimeEventFrame {
    key: 'event';
    stream: RuntimeStream;
    frame: { rpcId?: string; payload?: Record<string, unknown> };
}

/** A downlink stream that ended inside the runtime. */
export interface RuntimeStreamErrorFrame {
    key: 'stream-error';
    stream: RuntimeStream;
    message: string;
}

/**
 * The asking socket asks whether an operator answered its request yet.
 *
 * Polling, rather than a push, is what lets a request outlive the connection
 * that opened it: a runtime that reconnects finds its request already approved.
 */
export interface RuntimeLinkPollFrame {
    key: 'link-poll';
    code: string;
    pairSecret: string;
}

/** Frames a connected runtime sends. */
export type RuntimeInboundFrame =
    | RuntimeHelloFrame
    | RuntimeStatusFrame
    | RuntimeResponseFrame
    | RuntimeEventFrame
    | RuntimeStreamErrorFrame
    | RuntimeLinkPollFrame
    | { key: 'pong' };

/** A request an operator has to approve in a browser. */
export interface RuntimePairingFrame {
    key: 'pairing';
    code: string;
    /** The URL the runtime prints for its operator. */
    url: string;
    expiresAt: number;
    /** Set when the runtime presented a credential this server no longer knows. */
    staleToken?: true;
}

/** The answer to one {@link RuntimeLinkPollFrame}. */
export type RuntimeLinkFrame =
    | { key: 'link'; status: 'pending' }
    | { key: 'link'; status: 'approved'; token: string }
    | { key: 'link'; error: string };

/** Frames this server sends to a connected runtime. */
export type RuntimeOutboundFrame =
    | { key: 'hello'; accepted: true; runtimeId: string }
    | { key: 'hello'; accepted: false; reason: string }
    | RuntimePairingFrame
    | RuntimeLinkFrame
    | RuntimeRequestFrame
    | { key: 'subscribe'; stream: RuntimeStream }
    | { key: 'unsubscribe'; stream: RuntimeStream }
    | { key: 'ping' }
    /**
     * Ask the connected process to exit so its process manager (for example
     * PM2) brings it back with a fresh load of code.
     */
    | { key: 'restart'; reason?: string };

/**
 * Read one socket message as a frame.
 *
 * A carrier hands over either the raw text or the object it already parsed, so
 * both shapes are accepted here; anything without a frame key is not ours.
 * @param value - the message as the carrier delivered it.
 * @returns the frame, or undefined when it is not one we know.
 */
export function parseRuntimeFrame(value: unknown): RuntimeInboundFrame | undefined {
    let parsed: unknown = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            return undefined;
        }
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const key = (parsed as { key?: unknown }).key;
    return typeof key === 'string' ? parsed as RuntimeInboundFrame : undefined;
}


// Runtime links

/**
 * How this plugin reaches one agent runtime.
 *
 * Two transports exist for the same three faces: dispatch a `/api` path and
 * answer it, and follow the two downlink streams. The embedded runtime calls
 * this process's own composed handler; a runtime that dialled in sends and
 * receives frames over its socket. Everything above this file — routing,
 * persistence, the browser's own carriers — is transport-independent, which is
 * what lets a session run in either place.
 */

/** One frame of a downlink stream, as the runtime's carrier produces it. */
export interface AgentFrame {
    rpcId?: string;
    payload?: Record<string, unknown>;
}

/** One `/api` exchange, in the shape the HTTP carrier returns. */
export interface RuntimeReply {
    status: number;
    contentType: string;
    text: string;
}

/** One reachable runtime: dispatch, streams, and disposal. */
export interface RuntimeLink {
    readonly runtimeId: string;
    readonly kind: 'builtin' | 'websocket';
    /**
     * Dispatch one `/api` path and read its response.
     * @param path - absolute path, e.g. `/api/session.create`.
     * @param body - request body, verbatim.
     * @param signal - caller cancellation; the link rejects when it aborts.
     */
    call(path: string, body: unknown, signal?: AbortSignal): Promise<RuntimeReply>;
    /**
     * Follow one downlink stream until the caller stops consuming it.
     * @param stream - which stream to follow.
     */
    subscribe(stream: RuntimeStream): AsyncIterable<AgentFrame>;
    /**
     * Ask this runtime to exit so its process manager can restart it.
     * Built-in (in-process) links do not support this; websocket links send a
     * `restart` frame. Returns false when the peer is gone or the kind cannot.
     * @param reason - optional note the remote logs before exiting.
     */
    restart(reason?: string): boolean;
    /** Release whatever this link holds; it is unreachable afterwards. */
    dispose(): void;
}

/** The embedded runtime's faces, as its embed entry returns them. */
export interface InProcessRuntime {
    api: { fetch(request: Request): Promise<Response> };
    events: {
        mux(signal: AbortSignal): AsyncIterable<AgentFrame>;
        host(signal: AbortSignal): AsyncIterable<AgentFrame>;
    };
    ctx: { fiber: { dispose(): Promise<void> } };
}

/** Authority for in-process dispatch: the runtime's own loopback carrier presented this. */
const IN_PROCESS_AUTHORITY = '127.0.0.1';

/**
 * Reach a runtime that runs inside this process.
 * @param runtimeId - the runtime's registry identity.
 * @param runtime - the embed entry's handle.
 * @returns the link over that handle.
 */
export function createInProcessLink(runtimeId: string, runtime: InProcessRuntime): RuntimeLink {
    return {
        runtimeId,
        kind: 'builtin',
        async call(path, body, signal) {
            const response = await runtime.api.fetch(new Request(`http://${IN_PROCESS_AUTHORITY}${path}`, {
                method: 'POST',
                headers: { host: IN_PROCESS_AUTHORITY, 'content-type': 'application/json' },
                body: JSON.stringify(body),
                ...(signal === undefined ? {} : { signal }),
            }));
            const text = await response.text();
            return { status: response.status, contentType: response.headers.get('content-type') || 'application/json', text };
        },
        subscribe(stream) {
            const controller = new AbortController();
            const source = stream === 'mux' ? runtime.events.mux(controller.signal) : runtime.events.host(controller.signal);
            return (async function* iterate() {
                try {
                    yield* source;
                } finally {
                    controller.abort();
                }
            })();
        },
        restart() {
            // The built-in host is this Ejunz process; exit/reload belongs to
            // the server operator, not to a session tool.
            return false;
        },
        dispose() { /* the embedder owns this runtime's lifetime, not the link */ },
    };
}

/** The socket end of a connected runtime, as the connection handler exposes it. */
export interface SocketPeer {
    /** Send one frame; returns false when the socket is already gone. */
    send(frame: unknown): boolean;
    /** Register the frame listener for this peer's lifetime. */
    onFrame(listener: (frame: RuntimeInboundFrame) => void): void;
    /** Register the close listener for this peer's lifetime. */
    onClose(listener: () => void): void;
}

/** How long one dispatched request may wait for its answer. */
const REQUEST_TIMEOUT_MS = 120_000;

interface PendingCall {
    resolve: (reply: RuntimeReply) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface StreamCursor {
    queue: AgentFrame[];
    wake: (() => void) | null;
    ended: Error | null;
    subscribed: boolean;
}

/**
 * Reach a runtime that connected to this server.
 *
 * Requests are correlated by the id this side mints; streams are pulled only
 * while somebody consumes them, so a runtime never pumps frames into a socket
 * that has no reader.
 * @param runtimeId - the identity this server assigned at registration.
 * @param peer - the connected socket's frame face.
 * @returns the link over that socket.
 */
export function createSocketLink(runtimeId: string, peer: SocketPeer): RuntimeLink {
    const pending = new Map<string, PendingCall>();
    const cursors = new Map<RuntimeStream, StreamCursor>();
    let closed = false;

    const failEverything = (error: Error): void => {
        closed = true;
        for (const call of pending.values()) {
            clearTimeout(call.timer);
            call.reject(error);
        }
        pending.clear();
        for (const cursor of cursors.values()) {
            cursor.ended = error;
            cursor.wake?.();
            cursor.wake = null;
        }
    };

    peer.onFrame((frame) => {
        if (frame.key === 'response') {
            const call = pending.get(frame.rpcId);
            if (!call) return;
            pending.delete(frame.rpcId);
            clearTimeout(call.timer);
            call.resolve({ status: frame.status, contentType: frame.contentType, text: frame.text });
            return;
        }
        if (frame.key === 'event') {
            const cursor = cursors.get(frame.stream);
            if (!cursor) return;
            cursor.queue.push(frame.frame);
            cursor.wake?.();
            cursor.wake = null;
            return;
        }
        if (frame.key === 'stream-error') {
            const cursor = cursors.get(frame.stream);
            if (!cursor) return;
            cursor.ended = new Error(frame.message);
            cursor.wake?.();
            cursor.wake = null;
        }
    });
    peer.onClose(() => failEverything(new Error('the agent runtime disconnected')));

    return {
        runtimeId,
        kind: 'websocket',
        async call(path, body, signal) {
            if (closed) throw new Error('the agent runtime disconnected');
            if (signal?.aborted) throw new Error('the request was cancelled');
            const rpcId = randomUUID();
            const reply = new Promise<RuntimeReply>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(rpcId);
                    reject(new Error(`the agent runtime did not answer ${path} within ${REQUEST_TIMEOUT_MS}ms`));
                }, REQUEST_TIMEOUT_MS);
                (timer as unknown as { unref?: () => void }).unref?.();
                pending.set(rpcId, { resolve, reject, timer });
                signal?.addEventListener('abort', () => {
                    if (!pending.delete(rpcId)) return;
                    clearTimeout(timer);
                    reject(new Error('the request was cancelled'));
                }, { once: true });
            });
            if (!peer.send({ key: 'request', rpcId, path, body })) {
                const call = pending.get(rpcId);
                if (call) {
                    pending.delete(rpcId);
                    clearTimeout(call.timer);
                }
                throw new Error('the agent runtime disconnected');
            }
            return await reply;
        },
        subscribe(stream) {
            const cursor = ((): StreamCursor => {
                const existing = cursors.get(stream);
                if (existing) return existing;
                const created: StreamCursor = { queue: [], wake: null, ended: null, subscribed: false };
                cursors.set(stream, created);
                return created;
            })();
            return (async function* iterate() {
                if (!cursor.subscribed) {
                    cursor.subscribed = true;
                    peer.send({ key: 'subscribe', stream });
                }
                try {
                    while (true) {
                        const next = cursor.queue.shift();
                        if (next !== undefined) {
                            yield next;
                            continue;
                        }
                        if (cursor.ended) throw cursor.ended;
                        if (closed) throw new Error('the agent runtime disconnected');
                        await new Promise<void>((resolve) => { cursor.wake = resolve; });
                    }
                } finally {
                    // One consumer per stream: the runtime stops pumping as soon
                    // as nobody reads, and a later subscriber starts it again.
                    if (cursor.subscribed) {
                        cursor.subscribed = false;
                        peer.send({ key: 'unsubscribe', stream });
                        cursors.delete(stream);
                    }
                }
            })();
        },
        restart(reason) {
            if (closed) return false;
            return peer.send({
                key: 'restart',
                ...(reason === undefined || reason === '' ? {} : { reason }),
            });
        },
        dispose() { failEverything(new Error('the agent runtime link was disposed')); },
    };
}


// Mongo data adapter
export interface AgentScope {
    domainId: string;
    userId: number;
    /** Numeric TYPE_AGENT document ID; null scopes the legacy unassigned workspace. */
    agentId?: number | null;
}

export interface AgentDataAdapter {
    ensureIndexes(): Promise<void>;
    resetRunningSessions(): Promise<void>;
    listSessions(scope: AgentScope): Promise<AgentSessionSummary[]>;
    getSession(scope: AgentScope, sessionId: string): Promise<Awaited<ReturnType<typeof AgentModel.getSession>>>;
    getSessionByContext(scope: AgentScope, type: 'generic' | 'base_detail', baseDocId: string): Promise<Awaited<ReturnType<typeof AgentModel.getSessionByContext>>>;
    listSessionsByContext(scope: AgentScope, type: 'generic' | 'base_detail', baseDocId: string): Promise<AgentSessionSummary[]>;
    upsertSession(scope: AgentScope, summary: AgentSessionSummary, archived?: boolean): Promise<void>;
    updateSession(scope: AgentScope, sessionId: string, patch: Parameters<typeof AgentModel.updateSession>[3]): Promise<void>;
    updateSessionContext(scope: AgentScope, sessionId: string, baseDocId?: string, cwd?: string): Promise<void>;
    deleteSessions(scope: AgentScope, sessionIds: readonly string[]): Promise<void>;
    appendEvent(scope: AgentScope, sessionId: string, event: Record<string, unknown>): Promise<void>;
    appendEventsAny(sessionId: string, events: readonly Record<string, unknown>[]): Promise<void>;
    countEvents(scope: AgentScope, sessionId: string): Promise<number>;
    countMessages(scope: AgentScope, sessionId: string): Promise<number>;
    listEvents(scope: AgentScope, sessionId: string, beforeSeq?: number, limit?: number): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }>;
    listEventsTailAny(sessionId: string, beforeSeq?: number, limit?: number): Promise<{ events: Record<string, unknown>[]; hasMore: boolean }>;
    search(scope: AgentScope, query: string): Promise<{ sessionId: string; snippet: string }[]>;
    listWorkspaces(scope: AgentScope): Promise<AgentWorkspaceDoc[]>;
    listNodes(scope: AgentScope): Promise<AgentNodeDoc[]>;
    getNode(scope: AgentScope, nodeId: string): Promise<AgentNodeDoc | null>;
    createNode(scope: AgentScope, text: string, parentId?: string): Promise<AgentNodeDoc>;
    updateNode(scope: AgentScope, nodeId: string, text: string): Promise<AgentNodeDoc | null>;
    deleteNode(scope: AgentScope, nodeId: string): Promise<void>;
    getWorkspace(scope: AgentScope, workspaceId: string): Promise<AgentWorkspaceDoc | null>;
    getWorkspaceByPath(scope: AgentScope, path: string): Promise<AgentWorkspaceDoc | null>;
    getDisplayPrefs(scope: AgentScope): Promise<AgentDisplayPrefs>;
    saveDisplayPrefs(scope: AgentScope, raw: unknown): Promise<AgentDisplayPrefs>;
    createWorkspace(scope: AgentScope, path: string): Promise<{ workspace: AgentWorkspaceDoc; created: boolean }>;
    updateWorkspace(scope: AgentScope, workspaceId: string, patch: Partial<AgentWorkspaceDoc>): Promise<AgentWorkspaceDoc | null>;
    deleteWorkspace(scope: AgentScope, workspaceId: string): Promise<void>;
    reorderWorkspaces(scope: AgentScope, workspaceIds: string[]): Promise<void>;
    reorderWorkspaceSessions(scope: AgentScope, workspaceId: string, sessionIds: string[]): Promise<AgentWorkspaceDoc | null>;
    archivedSessionIds(scope: AgentScope): Promise<string[]>;
    getDomainSettings(domainId: string): Promise<AgentDomainSettings>;
    updateDomainSettings(domainId: string, sections: Record<string, Record<string, unknown>>, expectedRevision?: number): Promise<AgentDomainSettings | null>;
    resolveCredential(domainId: string, ref: string): Promise<string | undefined>;
    describeCredential(domainId: string, ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
    setCredential(domainId: string, ref: string, value: string): Promise<void>;
    unsetCredential(domainId: string, ref: string): Promise<void>;
    domainRuntime(sessionId: string): Promise<{ domainId: string; settings: Record<string, Record<string, unknown>>; credentials: Record<string, string> } | undefined>;
    deleteDomain(domainId: string): Promise<void>;
    listRuntimes(): Promise<AgentRuntimeSummary[]>;
    upsertRuntime(summary: AgentRuntimeSummary): Promise<void>;
    touchRuntime(runtimeId: string, attachedSessions: number): Promise<boolean>;
    setRuntimeLabel(runtimeId: string, label: string): Promise<boolean>;
    markRuntimeOffline(runtimeId: string): Promise<boolean>;
    removeRuntime(runtimeId: string): Promise<boolean>;
}

function adapterWorkspaceView(workspace: AgentWorkspaceDoc) {
    return {
        workspaceId: workspace.workspaceId,
        path: workspace.path,
        title: workspace.title,
        sessionIds: workspace.sessionIds,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
    };
}

export class MongoAgentDataAdapter implements AgentDataAdapter {
    async ensureIndexes(): Promise<void> {
        await AgentModel.ensureIndexes();
    }

    async resetRunningSessions(): Promise<void> {
        await AgentModel.resetRunningSessions();
    }

    async listSessions(scope: AgentScope): Promise<AgentSessionSummary[]> {
        return await AgentModel.listSessions(scope.domainId, scope.userId, scope.agentId);
    }

    async getSession(scope: AgentScope, sessionId: string) {
        return await AgentModel.getSession(scope.domainId, scope.userId, sessionId, scope.agentId);
    }

    async getSessionByContext(scope: AgentScope, type: 'generic' | 'base_detail', baseDocId: string) {
        return await AgentModel.getSessionByContext(scope.domainId, scope.userId, type, baseDocId, scope.agentId);
    }

    async listSessionsByContext(scope: AgentScope, type: 'generic' | 'base_detail', baseDocId: string) {
        return await AgentModel.listSessionsByContext(scope.domainId, scope.userId, type, baseDocId, scope.agentId);
    }

    async upsertSession(scope: AgentScope, summary: AgentSessionSummary, archived?: boolean): Promise<void> {
        await AgentModel.upsertSession(scope.domainId, scope.userId, summary, archived);
    }

    async updateSession(scope: AgentScope, sessionId: string, patch: Parameters<typeof AgentModel.updateSession>[3]): Promise<void> {
        await AgentModel.updateSession(scope.domainId, scope.userId, sessionId, patch, scope.agentId);
    }

    async updateSessionContext(scope: AgentScope, sessionId: string, baseDocId?: string, cwd?: string): Promise<void> {
        await AgentModel.updateSessionContext(scope.domainId, scope.userId, sessionId, baseDocId, cwd, scope.agentId);
    }

    async appendEvent(scope: AgentScope, sessionId: string, event: Record<string, unknown>): Promise<void> {
        await AgentModel.appendEvent(scope.domainId, scope.userId, sessionId, event);
    }

    async countEvents(scope: AgentScope, sessionId: string): Promise<number> {
        return await AgentModel.countEvents(scope.domainId, scope.userId, sessionId, scope.agentId);
    }

    async countMessages(scope: AgentScope, sessionId: string): Promise<number> {
        return await AgentModel.countMessages(scope.domainId, scope.userId, sessionId, scope.agentId);
    }

    async listEvents(scope: AgentScope, sessionId: string, beforeSeq?: number, limit = 50) {
        return await AgentModel.listEvents(scope.domainId, scope.userId, sessionId, beforeSeq, limit, scope.agentId);
    }

    async listEventsTailAny(sessionId: string, beforeSeq?: number, limit = 100) {
        return await AgentModel.listEventsTailAny(sessionId, beforeSeq, limit);
    }

    async search(scope: AgentScope, query: string): Promise<{ sessionId: string; snippet: string }[]> {
        return await AgentModel.search(scope.domainId, scope.userId, query, scope.agentId);
    }

    async getSessionAny(sessionId: string) {
        return await AgentModel.getSessionAny(sessionId);
    }

    async setSessionHeader(sessionId: string, header: Record<string, unknown>): Promise<void> {
        await AgentModel.setSessionHeader(sessionId, header);
    }

    async listAllSessions() {
        return await AgentModel.listAllSessions();
    }

    async appendEventAny(sessionId: string, event: Record<string, unknown>): Promise<void> {
        await this.appendEventsAny(sessionId, [event]);
    }

    async appendEventsAny(sessionId: string, items: readonly Record<string, unknown>[]): Promise<void> {
        const session = await this.getSessionAny(sessionId);
        if (!session) throw new Error(`session "${sessionId}" not found`);
        await AgentModel.appendEvents(session.domainId, session.userId, sessionId, items);
    }

    async loadEventsAny(sessionId: string): Promise<Record<string, unknown>[]> {
        return await AgentModel.listAllEventsAny(sessionId);
    }

    async listWorkspaces(scope: AgentScope): Promise<AgentWorkspaceDoc[]> {
        return await AgentModel.listWorkspaces(scope.domainId, scope.userId);
    }

    async listNodes(scope: AgentScope): Promise<AgentNodeDoc[]> {
        return await AgentModel.listNodes(scope.domainId, scope.userId, scope.agentId);
    }

    async getNode(scope: AgentScope, nodeId: string): Promise<AgentNodeDoc | null> {
        return await AgentModel.getNode(scope.domainId, scope.userId, nodeId, scope.agentId);
    }

    async createNode(scope: AgentScope, text: string, parentId?: string): Promise<AgentNodeDoc> {
        return await AgentModel.createNode(scope.domainId, scope.userId, text, scope.agentId, parentId);
    }

    async updateNode(scope: AgentScope, nodeId: string, text: string): Promise<AgentNodeDoc | null> {
        return await AgentModel.updateNode(scope.domainId, scope.userId, nodeId, text, scope.agentId);
    }

    async deleteNode(scope: AgentScope, nodeId: string): Promise<void> {
        await AgentModel.deleteNode(scope.domainId, scope.userId, nodeId, scope.agentId);
    }

    async getWorkspace(scope: AgentScope, workspaceId: string): Promise<AgentWorkspaceDoc | null> {
        return await AgentModel.getWorkspace(scope.domainId, scope.userId, workspaceId);
    }

    async getWorkspaceByPath(scope: AgentScope, path: string): Promise<AgentWorkspaceDoc | null> {
        return await AgentModel.getWorkspaceByPath(scope.domainId, scope.userId, path);
    }

    async getDisplayPrefs(scope: AgentScope): Promise<AgentDisplayPrefs> {
        return await AgentModel.getDisplayPrefs(scope.domainId, scope.userId);
    }

    async saveDisplayPrefs(scope: AgentScope, raw: unknown): Promise<AgentDisplayPrefs> {
        return await AgentModel.saveDisplayPrefs(scope.domainId, scope.userId, raw);
    }

    async createWorkspace(scope: AgentScope, path: string): Promise<{ workspace: AgentWorkspaceDoc; created: boolean }> {
        const existing = await this.getWorkspaceByPath(scope, path);
        if (existing) return { workspace: existing, created: false };
        const items = await this.listWorkspaces(scope);
        const pathParts = path.split(/[\\/]/).filter(Boolean);
        const title = pathParts[pathParts.length - 1] || path;
        const workspace = await AgentModel.upsertWorkspace(scope.domainId, scope.userId, {
            domainId: scope.domainId,
            userId: scope.userId,
            workspaceId: `workspace-${randomUUID()}`,
            path,
            title,
            sessionIds: [],
            order: items.length,
        });
        return { workspace, created: true };
    }

    async deleteSession(scope: AgentScope, sessionId: string): Promise<void> {
        await AgentModel.deleteSession(scope.domainId, scope.userId, sessionId, scope.agentId);
    }

    async deleteSessions(scope: AgentScope, sessionIds: readonly string[]): Promise<void> {
        await AgentModel.deleteSessions(scope.domainId, scope.userId, sessionIds, scope.agentId);
    }

    async updateWorkspace(scope: AgentScope, workspaceId: string, patch: Partial<AgentWorkspaceDoc>): Promise<AgentWorkspaceDoc | null> {
        return await AgentModel.updateWorkspace(scope.domainId, scope.userId, workspaceId, patch);
    }

    async deleteWorkspace(scope: AgentScope, workspaceId: string): Promise<void> {
        await AgentModel.deleteWorkspace(scope.domainId, scope.userId, workspaceId);
    }

    async reorderWorkspaces(scope: AgentScope, workspaceIds: string[]): Promise<void> {
        await AgentModel.reorderWorkspaces(scope.domainId, scope.userId, workspaceIds);
    }

    async reorderWorkspaceSessions(scope: AgentScope, workspaceId: string, sessionIds: string[]): Promise<AgentWorkspaceDoc | null> {
        return await AgentModel.reorderWorkspaceSessions(scope.domainId, scope.userId, workspaceId, sessionIds);
    }

    async archivedSessionIds(scope: AgentScope): Promise<string[]> {
        return await AgentModel.archivedSessionIds(scope.domainId, scope.userId, scope.agentId);
    }

    async getDomainSettings(domainId: string) {
        return await AgentModel.getDomainSettings(domainId);
    }

    async updateDomainSettings(domainId: string, sections: Record<string, Record<string, unknown>>, expectedRevision?: number) {
        return await AgentModel.updateDomainSettings(domainId, sections, expectedRevision);
    }

    async resolveCredential(domainId: string, ref: string) {
        return await AgentModel.resolveCredential(domainId, ref);
    }

    async describeCredential(domainId: string, ref: string) {
        return await AgentModel.describeCredential(domainId, ref);
    }

    async setCredential(domainId: string, ref: string, value: string) {
        return await AgentModel.setCredential(domainId, ref, value);
    }

    async unsetCredential(domainId: string, ref: string) {
        return await AgentModel.unsetCredential(domainId, ref);
    }

    async domainRuntime(sessionId: string) {
        return await AgentModel.domainRuntime(sessionId);
    }

    async deleteDomain(domainId: string): Promise<void> {
        await AgentModel.deleteDomain(domainId);
    }

    async cacheHistory(scope: AgentScope, sessionId: string, value: any): Promise<void> {
        const session = await this.getSession(scope, sessionId);
        if (session && !session.header) {
            await this.setSessionHeader(sessionId, {
                version: 0,
                id: sessionId,
                createdAt: session.createdAt.getTime(),
                ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
                ...(session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset }),
            });
        }
        for (const entry of value.events ?? []) {
            const event = entry?.event;
            if (event && typeof event === 'object') await this.appendEvent(scope, sessionId, event as Record<string, unknown>);
        }
        if (value.projections) await this.updateSession(scope, sessionId, { projections: value.projections });
    }

    async history(scope: AgentScope, sessionId: string, beforeSeq?: number, maxMessages = 50): Promise<any> {
        const page = await this.listEvents(scope, sessionId, beforeSeq, Math.min(Math.max(maxMessages, 1), 500));
        const entries = page.events.map((event) => ({ event }));
        const last = page.events[page.events.length - 1];
        const session = await this.getSession(scope, sessionId);
        return {
            events: entries,
            hasMore: page.hasMore,
            ...(session?.projections ? { projections: { asOfSeq: typeof last?.seq === 'number' ? last.seq : -1, values: session.projections.values ?? {} } } : {}),
        };
    }

    viewWorkspace(workspace: AgentWorkspaceDoc) {
        return adapterWorkspaceView(workspace);
    }

    async listRuntimes(): Promise<AgentRuntimeSummary[]> {
        return await AgentRuntimeModel.list();
    }

    async upsertRuntime(summary: AgentRuntimeSummary): Promise<void> {
        await AgentRuntimeModel.upsert(summary);
    }

    async touchRuntime(runtimeId: string, attachedSessions: number): Promise<boolean> {
        return await AgentRuntimeModel.touch(runtimeId, attachedSessions);
    }

    async setRuntimeLabel(runtimeId: string, label: string): Promise<boolean> {
        return await AgentRuntimeModel.setLabel(runtimeId, label);
    }

    async markRuntimeOffline(runtimeId: string): Promise<boolean> {
        return await AgentRuntimeModel.markOffline(runtimeId);
    }

    async removeRuntime(runtimeId: string): Promise<boolean> {
        return await AgentRuntimeModel.remove(runtimeId);
    }
}

export const agentDataAdapter = new MongoAgentDataAdapter();



export const agentRuntimeHandlerContext = {
    modelReady: () => modelReady,
    requireBridgeToken, baseSessionScope, toolRegistry,
    scopeOf, rpcOk, rpcError, serverRequestFrame, callUpstream, upstreamValue,
    nodeRpc, workspaceRpc, domainSettingsRpc, domainCredentialsRpc, baseTutorEnsure, baseTutorList,
    baseTutorCreate, baseTutorHistory, baseTutorPrompt, linkStatus, linkApprove, runtimeStatusItems,
    runtimeRelabel, runtimeRemove, sessionCreate, sessionHistory, sessionMessageCount,
    sessionContextSave, sessionSetHost, HostUnreachableError, linkForSession, requireLink,
    agentDataAdapter, AgentStorageModel, AgentLinkModel, createProvider,
    logger, WebSocket, randomUUID, parseRuntimeFrame, createSocketLink, addLink, rememberRuntime,
    reportRuntime, runtimeLinks, runtimeFacts, hostname, SystemModel, RUNTIME_HELLO_TIMEOUT_MS,
    followLinks, bridgeRuntimeId, mergeDomainProviders, mergeDomainModels, cloneSettingsSections,
};


declare module '../context' {
    interface Context {
        agentRuntime: AgentRuntimeService;
    }
}

export default class AgentRuntimeService extends Service {
    constructor(ctx: Context) {
        super(ctx, 'agentRuntime');
    }

    async *[Service.init]() {
        const dispose = await initializeAgentRuntime(this.ctx as unknown as EjunContext);
        yield dispose;
    }
}
