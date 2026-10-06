import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EjunzLogo, IconSendOutline14 } from './icons';
import { ApprovalPanel } from './components/interaction/ApprovalPanel';
import { AttachmentRail } from './components/attachment/AttachmentRail';
import { ChatView } from './components/conversation/chat/ChatView';
import { TrajectoryView } from './components/conversation/trajectory/TrajectoryView';
import { ConversationRoot } from './components/conversation/skeleton/ConversationRoot';
import { DetailsPanel } from './components/conversation/skeleton/DetailsPanel';
import { InputBar } from './components/conversation/skeleton/InputBar';
import { TodoPanel } from './components/conversation/skeleton/TodoPanel';
import { QueueDock } from './components/conversation/queue/QueueDock';
import { InputConfigDialog } from './components/interaction/InputConfigDialog';
import { QuestionPanel } from './components/interaction/QuestionPanel';
import { toolRowModel } from './components/tool/tool-call-model';
import { AgentHeader, type AgentWebSocketStatus } from './components/structure/AgentHeader';
import { AgentDisplaySettingsDialog, defaultAgentDisplaySettings, readAgentDisplaySettings, type AgentDisplaySettings } from './components/structure/AgentDisplaySettingsDialog';
import { SessionSettingsPanel } from './components/structure/SessionSettingsPanel';
import { SessionDrawer } from './components/structure/SessionDrawer';
import { SessionTree } from './components/structure/SessionTree';
import type { HostOption } from './components/structure/HostPicker';
import { ActionDialog } from './components/primitives/ActionDialog';
import { GeneralSection } from './components/settings/GeneralSection';
import { EnterBehaviorRow, LanguageRow } from './components/settings/SettingsRows';
import { PluginsSection } from './components/settings/PluginsSection';
import { ModelsSection } from './components/settings/ModelsSection';
import { getPath } from './components/settings/modelsStore';
import { AgentPresetLabel } from './components/settings/AgentPresetLabel';
import { AgentPresetRow } from './components/settings/AgentPresetRow';
import { AgentPresetSeat, type AgentPresetOption } from './components/settings/AgentPresetSeat';
import { AgentPresetSection } from './components/settings/AgentPresetSection';
import { ToolsSection } from './components/settings/ToolsSection';
import { DeepSeekOnboarding } from './components/settings/DeepSeekOnboarding';
import { SettingsDocumentAction } from './components/settings/SettingsDocumentAction';
import { SettingsRoot } from './components/settings/SettingsRoot';
import type { ChatMessage, PendingApproval, PendingQuestion, QueueItem, SessionModels } from './components/types';
import { domainPrefix, useAgentRpc } from './runtime/rpc';
import { useAgentTheme } from './runtime/theme';
import { usePageData } from '../../context/page-data';
import { applyEvent, asObject, assistantStreamKey, eventFailureMessage, eventMessage, eventsToMessages, fileInjectionsAfterUser, flattenToolTree, foldToolTree, latestHistoryError, queueItems, settleRunningMessages } from './runtime/conversation';
import type { HistoryEntry } from './runtime/conversation';
import { agentRootNodeId, type AgentNode, type BaseView, type HostFrame, type MuxFrame, type SessionSummary } from './runtime/session';
import { useDraftAttachments } from './components/attachment/useDraftAttachments';
import { FILE_INJECTION_PLUGIN, FILE_INJECTION_SECTION, fileInjectionText, type DraftAttachment, type UploadedFileMeta } from './runtime/uploads';
import { Notification, useBuildUrl, useUiContext, useUserContext } from '@ejunz/ui-next';
import './tokens.css';
import './page.css';

const POLL_MS = 10000;
const EVENT_RECONNECT_MS = 2000;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_INITIAL_MESSAGES = 8;
const HISTORY_PREVIEW_MESSAGES = 1;
const HISTORY_PREVIEW_CONCURRENCY = 4;
const SESSION_DRAWER_DEFAULT = 420;
const SESSION_DRAWER_MIN = 320;

function readAgentSelection(): { nodeId: string | null; cardId: string | null } {
    if (typeof window === 'undefined') return { nodeId: null, cardId: null };
    const params = new URLSearchParams(window.location.search);
    return { nodeId: params.get('nodeId'), cardId: params.get('cardId') };
}

function updateAgentSelectionUrl(patch: { nodeId?: string | null; cardId?: string | null }): void {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
    }
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash}`;
    window.history.replaceState(window.history.state, '', next);
}

type DialogState =
    | { kind: 'rename-session'; id: string; value: string }
    | { kind: 'delete-session'; id: string; title: string }
    | { kind: 'delete-selected'; sessionIds: string[]; nodeIds: string[] }
    | { kind: 'create-node'; value: string }
    | { kind: 'rename-node'; id: string; value: string };

interface HistoryCacheEntry {
    history: HistoryEntry[];
    hasMore: boolean;
    totalMessages: number | null;
}

function sessionTitle(session: SessionSummary): string {
    const values = session.projections?.values;
    const title = values && typeof values.title === 'string' ? values.title : '';
    if (title.trim()) return title;
    if (session.blank) return '新会话';
    return `会话 ${session.sessionId.slice(8, 16)}`;
}

type AgentRpc = (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;

function readyFiles(attachments: DraftAttachment[]): UploadedFileMeta[] {
    return attachments.map((attachment) => attachment.meta).filter((meta): meta is UploadedFileMeta => meta !== undefined);
}

function promptParts(text: string, fileCount: number): Array<{ type: 'text'; text: string }> {
    const value = text || (fileCount > 0 ? `已上传 ${fileCount} 个文件` : '');
    return value ? [{ type: 'text' as const, text: value }] : [];
}

async function injectDraftFiles(rpc: AgentRpc, sessionId: string, files: UploadedFileMeta[]): Promise<void> {
    if (files.length === 0) return;
    await rpc('session.inject', {
        sessionId,
        plugin: FILE_INJECTION_PLUGIN,
        sections: [{ name: FILE_INJECTION_SECTION, text: fileInjectionText(files) }],
    });
}

function visibleHistoryMessageCount(entries: readonly HistoryEntry[]): number {
    return entries.filter((entry) => entry.event.type === 'user/message' || entry.event.type === 'assistant/message').length;
}

function firstHistorySeq(entries: readonly HistoryEntry[]): number | null {
    return entries.reduce<number | null>((first, entry) => first === null ? entry.event.seq : Math.min(first, entry.event.seq), null);
}

function runningTurnStartTime(entries: readonly HistoryEntry[]): number | null {
    let activeTurn: string | null = null;
    let startTime: number | null = null;
    for (const entry of entries) {
        const data = asObject(entry.event.data);
        const turn = String(data.turn ?? '');
        if (entry.event.type === 'turn/start') {
            activeTurn = turn;
            startTime = entry.event.time;
        } else if (entry.event.type === 'turn/end' && activeTurn === turn) {
            activeTurn = null;
            startTime = null;
        }
    }
    return startTime;
}

function mergeHistoryEntries(...groups: readonly (readonly HistoryEntry[])[]): HistoryEntry[] {
    const bySeq = new Map<number, HistoryEntry>();
    for (const group of groups) {
        for (const entry of group) {
            const previous = bySeq.get(entry.event.seq);
            bySeq.set(entry.event.seq, previous === undefined ? entry : {
                ...previous,
                ...entry,
                ...(entry.runtimeId === undefined && previous.runtimeId !== undefined ? { runtimeId: previous.runtimeId } : {}),
                ...(entry.host === undefined && previous.host !== undefined ? { host: previous.host } : {}),
            });
        }
    }
    return [...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq);
}

function pendingQuestionFromFrame(frame: MuxFrame): PendingQuestion | null {
    if (frame.type !== 'question/requested' || !frame.sessionId || !frame.rpcId) return null;
    return {
        rpcId: frame.rpcId,
        sessionId: frame.sessionId,
        questions: (frame.questions ?? []).map((item) => {
            const value = asObject(item);
            return {
                id: String(value.id ?? ''),
                question: typeof value.question === 'string' ? value.question : undefined,
                header: typeof value.header === 'string' ? value.header : undefined,
                multiSelect: value.multiSelect === true,
                options: Array.isArray(value.options) ? value.options.map((option) => {
                    const item = asObject(option);
                    return {
                        label: typeof item.label === 'string' ? item.label : undefined,
                        description: typeof item.description === 'string' ? item.description : undefined,
                    };
                }) : [],
            };
        }).filter((item) => item.id !== ''),
    };
}

function firstLine(value: string): string {
    return value.split('\n', 1)[0] ?? value;
}

function latestLine(value: string): string {
    const visible = value.trimEnd();
    const newline = visible.lastIndexOf('\n');
    return newline < 0 ? visible : visible.slice(newline + 1);
}

function flatLine(value: string): string {
    return value.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function assistantText(message: ChatMessage): string {
    return message.eventType === 'assistant/message'
        ? message.segments?.filter((segment) => segment.kind === 'text').map((segment) => segment.text).join('') || message.text
        : message.text;
}

function assistantStage(message: ChatMessage): 'Think' | 'Agent' {
    return message.eventType === 'assistant/chunk' && message.segments?.at(-1)?.kind === 'reasoning' ? 'Think' : 'Agent';
}

function activityPreview(message: ChatMessage): string {
    if (message.role === 'context') return `Inject · ${flatLine(message.text)}`;
    if (message.role === 'assistant') return `${assistantStage(message)} · ${latestLine(assistantText(message))}`;
    if (message.role === 'retry') return `Think · ${flatLine(message.text)}`;
    if (message.role === 'compaction') return `上下文整理 · ${flatLine(message.compactionSummary || '已更新')}`;
    if (message.role === 'system') return `${message.eventType === 'turn/error' ? 'Error' : 'Agent'} · ${flatLine(message.text)}`;
    if (message.role === 'user') return `Agent · ${flatLine(message.text)}`;
    const model = toolRowModel(message);
    if (model.errorSummary) return `Tool · ${model.errorSummary}`;
    if (message.eventType === 'tool/result' && model.output) return `Tool · ${firstLine(model.output)}`;
    return `Tool · ${model.title} · ${model.summary}`;
}

function appendAssistantActivity(previous: SessionActivityPreview, message: ChatMessage, key: string, seq: number): SessionActivityPreview {
    const content = (previous.content ?? '') + assistantText(message);
    return { seq, index: previous.index, key, content, text: `${assistantStage(message)} · ${latestLine(content)}` };
}

function assistantActivity(message: ChatMessage, key: string, seq: number, index: number): SessionActivityPreview {
    const content = assistantText(message);
    return { seq, index, key, content, text: `${assistantStage(message)} · ${latestLine(content)}` };
}

function activityKey(event: HistoryEntry['event'], message: ChatMessage): string {
    if (message.role === 'context') return `${message.key}-${event.seq}`;
    if (message.role !== 'assistant') return message.key;
    if (event.type !== 'assistant/chunk') {
        const textIndex = message.segments?.findIndex((segment) => segment.kind === 'text') ?? 0;
        return `${assistantStreamKey(event)}-agent-${Math.max(0, textIndex)}`;
    }
    const chunk = asObject(asObject(event.data).chunk);
    const type = String(chunk.type ?? '');
    const lane = type.includes('reason') ? 'think' : type.includes('text') ? 'agent' : type;
    return `${assistantStreamKey(event)}-${lane}-${String(chunk.index ?? '0')}`;
}

interface SessionActivityPreview {
    seq: number;
    index: number;
    key: string;
    text: string;
    content?: string;
}

function mergeActivityPreview(previous: Record<string, SessionActivityPreview>, sessionId: string, next: SessionActivityPreview): Record<string, SessionActivityPreview> {
    const prior = previous[sessionId];
    return prior && prior.seq > next.seq ? previous : { ...previous, [sessionId]: next };
}

function latestActivityPreview(entries: readonly HistoryEntry[]): SessionActivityPreview | null {
    let latest: SessionActivityPreview | undefined;
    let previewIndex = 0;
    const ordered = [...entries].sort((left, right) => left.event.seq - right.event.seq);
    for (const entry of ordered) {
        if (entry.event.type === 'turn/start') {
            const turn = String(asObject(entry.event.data).turn ?? entry.event.seq);
            const key = `turn-${turn}`;
            previewIndex += 1;
            latest = { seq: entry.event.seq, index: previewIndex, key, text: 'Think · 思考中…' };
            continue;
        }
        const message = eventMessage(entry.event);
        if (!message?.text || message.role === 'user') continue;
        const key = activityKey(entry.event, message);
        if (entry.event.type === 'assistant/chunk' && latest?.key === key) {
            latest = appendAssistantActivity(latest, message, key, entry.event.seq);
            continue;
        }
        previewIndex += 1;
        const index = previewIndex;
        latest = message.role === 'assistant'
            ? assistantActivity(message, key, entry.event.seq, index)
            : { seq: entry.event.seq, index, key, text: activityPreview(message) };
    }
    return latest ?? null;
}

function useAgentEvents(onMux: (frame: MuxFrame) => void, onHost: (frame: HostFrame) => void, enabled: boolean, domainId: string, agentId: number | null): AgentWebSocketStatus {
    const [status, setStatus] = useState<AgentWebSocketStatus>('connecting');
    useEffect(() => {
        if (!enabled) {
            setStatus('disconnected');
            return undefined;
        }
        let disposed = false;
        let everConnected = false;
        const timers: number[] = [];
        const sockets: WebSocket[] = [];
        const connectedSockets = new Set<WebSocket>();
        const updateStatus = () => {
            if (disposed) return;
            if (connectedSockets.size === 2) setStatus('connected');
            else if (connectedSockets.size === 0 && everConnected) setStatus('disconnected');
            else setStatus('connecting');
        };
        setStatus('connecting');
        const schedule = (stream: 'events.mux' | 'events.host', onFrame: (frame: MuxFrame | HostFrame) => void, delay: number) => {
            timers.push(window.setTimeout(() => open(stream, onFrame), delay));
        };
        function open(stream: 'events.mux' | 'events.host', onFrame: (frame: MuxFrame | HostFrame) => void) {
            if (disposed) return;
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const params = new URLSearchParams({ domainId });
            params.set('agentId', agentId === null ? 'unassigned' : String(agentId));
            const socket = new WebSocket(`${protocol}//${window.location.host}${domainPrefix(domainId)}/api/ejunz-agent/events/${stream}?${params}`);
            sockets.push(socket);
            socket.onopen = () => {
                if (disposed) return;
                everConnected = true;
                connectedSockets.add(socket);
                updateStatus();
            };
            socket.onmessage = (message) => {
                try {
                    const envelope = JSON.parse(String(message.data)) as { rpcId?: string; payload?: unknown };
                    onFrame({ ...asObject(envelope.payload), rpcId: envelope.rpcId } as MuxFrame | HostFrame);
                } catch { }
            };
            socket.onclose = () => {
                connectedSockets.delete(socket);
                updateStatus();
                if (!disposed) schedule(stream, onFrame, EVENT_RECONNECT_MS);
            };
            socket.onerror = () => socket.close();
        }
        schedule('events.mux', onMux, 0);
        schedule('events.host', onHost, 0);
        return () => {
            disposed = true;
            timers.forEach((timer) => window.clearTimeout(timer));
            sockets.forEach((socket) => {
                if (socket.readyState === WebSocket.OPEN) socket.close();
                else if (socket.readyState === WebSocket.CONNECTING) socket.onopen = () => socket.close();
            });
        };
    }, [agentId, domainId, enabled, onHost, onMux]);
    return status;
}

export default function AgentPage() {
    const rpc = useAgentRpc();
    const { args: pageArgs } = usePageData();
    const parsedAgentId = Number(pageArgs.agentId);
    const agentId = pageArgs.agentId === null || !Number.isSafeInteger(parsedAgentId) || parsedAgentId <= 0 ? null : parsedAgentId;
    const pageAgent = pageArgs.agent && typeof pageArgs.agent === 'object' ? pageArgs.agent as { title?: unknown } : undefined;
    const agentTitle = typeof pageAgent?.title === 'string' && pageAgent.title.trim() ? pageAgent.title : 'Ejunz agent';
    const rootNodeId = agentId === null ? null : agentRootNodeId(agentId);
    const { domainId, domain } = useUiContext();
    const domainName = typeof domain?.name === 'string' && domain.name.trim() ? domain.name : String(domainId || 'system');
    const user = useUserContext();
    const buildUrl = useBuildUrl();
    const guest = !user || user._id == null || user._id === 0 || user._id === '0';
    const { dark, applyTheme } = useAgentTheme();
    useEffect(() => {
        if (!guest) return;
        const redirect = `${window.location.pathname}${window.location.search}`;
        window.location.href = buildUrl('user_login', {}, { redirect });
    }, [buildUrl, guest]);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [nodes, setNodes] = useState<AgentNode[]>([]);
    const [treeOpen, setTreeOpen] = useState(false);
    const [activeTreeNodeId, setActiveTreeNodeId] = useState<string | null>(() => readAgentSelection().nodeId ?? rootNodeId);
    const [bases, setBases] = useState<BaseView[]>([]);
    const [draftBaseId, setDraftBaseId] = useState<number | undefined>();
    const [draftNodeId, setDraftNodeId] = useState<string | undefined>();
    const [draftModelSelection, setDraftModelSelection] = useState<{ provider: string; model: string } | undefined>();
    const [modelCatalog, setModelCatalog] = useState<{ groups: SessionModels['groups'] } | null>(null);
    const [models, setModels] = useState<SessionModels | null>(null);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [selectedTool, setSelectedTool] = useState<ChatMessage | null>(null);
    const [newSessionConfigOpen, setNewSessionConfigOpen] = useState(false);
    const [newSessionConfigLoading, setNewSessionConfigLoading] = useState(false);
    const [creatingSession, setCreatingSession] = useState(false);
    const newSessionLoadRef = useRef(0);
    const [sessionDrawerWidth, setSessionDrawerWidth] = useState(SESSION_DRAWER_DEFAULT);
    const [renaming, setRenaming] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const [current, setCurrent] = useState<string | null>(() => readAgentSelection().cardId);
    const [view, setView] = useState<'chat' | 'trajectory' | 'model' | 'context' | 'host'>('chat');
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyHasMore, setHistoryHasMore] = useState(false);
    const [historyTotalMessages, setHistoryTotalMessages] = useState<number | null>(null);
    const [historyProgress, setHistoryProgress] = useState(0);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [queue, setQueue] = useState<QueueItem[]>([]);
    const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
    const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
    const [pendingQuestions, setPendingQuestions] = useState<Record<string, PendingQuestion>>({});
    const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({});
    const [hosts, setHosts] = useState<HostOption[]>([]);
    const [draftHostId, setDraftHostId] = useState('');
    const [sessionActivityPreviews, setSessionActivityPreviews] = useState<Record<string, SessionActivityPreview>>({});
    const [input, setInput] = useState('');
    const {
        attachments, addFiles: addAttachments, removeAttachment, clear: clearAttachments,
    } = useDraftAttachments({ prefix: domainPrefix(String(domainId || 'system')), ownerId: user?._id });
    const [sending, setSending] = useState(false);
    const [booting, setBooting] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [dialogBusy, setDialogBusy] = useState(false);
    const [dialogError, setDialogError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [searchMatches, setSearchMatches] = useState<{ sessionId: string; snippet: string }[] | null>(null);
    const [searchHasMore, setSearchHasMore] = useState(false);
    const [busyEnter, setBusyEnter] = useState<'queue' | 'steer'>('queue');
    const [agentPresetOptions, setAgentPresetOptions] = useState<AgentPresetOption[]>([]);
    const [agentPresetChoice, setAgentPresetChoice] = useState('');
    const [agentPresetError, setAgentPresetError] = useState<string | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [settingsSection, setSettingsSection] = useState<string | null>(null);
    const [displaySettingsOpen, setDisplaySettingsOpen] = useState(false);
    const [displaySettingsSaving, setDisplaySettingsSaving] = useState(false);
    const [displaySettings, setDisplaySettings] = useState<AgentDisplaySettings>(() => ({ ...defaultAgentDisplaySettings }));
    const [editMode, setEditMode] = useState(false);
    const [sessionTitleDrafts, setSessionTitleDrafts] = useState<Record<string, string>>({});
    const [sessionTitleSaving, setSessionTitleSaving] = useState(false);
    const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(() => new Set());
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
    const currentRef = useRef<string | null>(null);
    const sessionsRef = useRef(sessions);
    const hostsRef = useRef(hosts);
    const modelsCacheRef = useRef(new Map<string, SessionModels>());
    const displaySettingsRequestRef = useRef(0);
    sessionsRef.current = sessions;
    hostsRef.current = hosts;

    useEffect(() => { currentRef.current = current; }, [current]);

    const loadSessions = useCallback(async () => {
        try {
            const value = await rpc('session.list', {}) as { items?: SessionSummary[] };
            const next = Array.isArray(value.items) ? value.items : [];
            setSessions((previous) => {
                const currentBlank = previous.find((session) => session.sessionId === currentRef.current && session.blank);
                return currentBlank && !next.some((session) => session.sessionId === currentBlank.sessionId)
                    ? [currentBlank, ...next]
                    : next;
            });
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const loadNodes = useCallback(async () => {
        try {
            const value = await rpc('node.list', {}) as { items?: AgentNode[] };
            setNodes(Array.isArray(value.items) ? value.items : []);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const loadHosts = useCallback(async () => {
        try {
            const value = await rpc('host.status', {}) as { items?: HostOption[] };
            setHosts(Array.isArray(value.items) ? value.items : []);
        } catch {
            // A roster that cannot be read leaves the control showing the host
            // the session itself names; the poll retries, and a switch or a new
            // session reports the same failure through its own call.
            setHosts([]);
        }
    }, [rpc]);

    const loadBases = useCallback(async () => {
        try {
            const value = await rpc('base.list', {}) as { items?: BaseView[] };
            setBases(Array.isArray(value.items) ? value.items : []);
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const loadDisplaySettings = useCallback(async () => {
        const requestId = ++displaySettingsRequestRef.current;
        try {
            const value = await rpc('ui.displayPrefs.get', {}) as { display?: unknown };
            if (requestId !== displaySettingsRequestRef.current) return;
            setDisplaySettings(readAgentDisplaySettings(value.display));
        } catch (error) {
            if (requestId !== displaySettingsRequestRef.current) return;
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const loadAgentPresets = useCallback(async () => {
        try {
            const value = await rpc('agentPreset.list', {}) as { presets?: (AgentPresetOption & { isDefault?: boolean; broken?: string })[] };
            const options = (value.presets ?? []).filter((preset) => !preset.broken).map(({ id, trust, name, description }) => ({ id, trust, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) }));
            setAgentPresetOptions(options);
            setAgentPresetChoice((currentChoice) => currentChoice || value.presets?.find((preset) => preset.isDefault && !preset.broken)?.id || options[0]?.id || '');
            setAgentPresetError(null);
        } catch (caught) {
            setAgentPresetError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [rpc]);

    const loadModelCatalog = useCallback(async () => {
        try {
            const [catalogValue, providersValue, settingsValue] = await Promise.all([
                rpc('llm.models', {}) as Promise<{ groups?: SessionModels['groups'] }>,
                rpc('llm.providers', {}) as Promise<{ providers?: { provider: string; settingsNs: string; settingsPath: readonly string[] }[] }>,
                rpc('settings.describe', {}) as Promise<{ namespaces?: { ns: string; value: unknown; user?: unknown }[] }>,
            ]);
            const namespaces = new Map((settingsValue.namespaces ?? []).map((namespace) => [namespace.ns, namespace] as const));
            const providers = providersValue.providers ?? [];
            const groups = (Array.isArray(catalogValue.groups) ? catalogValue.groups : []).flatMap((group) => {
                const provider = providers.find((entry) => entry.provider === group.id);
                if (!provider || provider.settingsNs === '') return [group];
                const namespace = namespaces.get(provider.settingsNs);
                const configured = namespace !== undefined
                    && (provider.settingsPath.length === 0 ? namespace.user !== undefined : getPath(namespace.value, provider.settingsPath) !== undefined);
                if (!configured) return [];
                const profile = provider.settingsPath.length === 0 ? namespace.value : getPath(namespace.value, provider.settingsPath);
                const configuredModels = profile && typeof profile === 'object' && !Array.isArray(profile)
                    ? (profile as Record<string, unknown>).models
                    : undefined;
                if (!Array.isArray(configuredModels)) return [group];
                const models = configuredModels.flatMap((model) => {
                    if (!model || typeof model !== 'object' || Array.isArray(model)) return [];
                    const entry = model as Record<string, unknown>;
                    if (typeof entry.id !== 'string' || entry.id.length === 0) return [];
                    return [{
                        ...group.models.find((candidate) => candidate.id === entry.id),
                        id: entry.id,
                        name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
                        ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
                    }];
                });
                return [{ ...group, models }];
            }).filter((group) => group.models.length > 0);
            setModelCatalog({ groups });
        } catch (error) {
            setModelCatalog(null);
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const loadModels = useCallback(async (sessionId: string) => {
        const cached = modelsCacheRef.current.get(sessionId);
        if (cached) {
            if (currentRef.current === sessionId) setModels(cached);
            return;
        }
        try {
            const value = await rpc('session.models', { sessionId }) as SessionModels;
            modelsCacheRef.current.set(sessionId, value);
            if (currentRef.current !== sessionId) return;
            setModels(value);
        } catch (error) {
            if (currentRef.current !== sessionId) return;
            setModels(null);
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const historyFirstSeq = useRef<number | null>(null);
    const historyLoadRef = useRef(0);
    const historyTotalRequestRef = useRef(0);
    const historyTotalsRef = useRef(new Map<string, number>());
    const historyRef = useRef<HistoryEntry[]>([]);
    const historyCacheRef = useRef(new Map<string, HistoryCacheEntry>());
    const historyPreviewRef = useRef(new Map<string, Promise<void>>());
    const historyPreviewAttemptedRef = useRef(new Set<string>());
    const historyPreviewActiveRef = useRef(0);
    const historyPreviewWaitersRef = useRef<(() => void)[]>([]);
    const acquireHistoryPreview = useCallback(async () => {
        if (historyPreviewActiveRef.current < HISTORY_PREVIEW_CONCURRENCY) {
            historyPreviewActiveRef.current += 1;
            return;
        }
        await new Promise<void>((resolve) => historyPreviewWaitersRef.current.push(resolve));
        historyPreviewActiveRef.current += 1;
    }, []);
    const releaseHistoryPreview = useCallback(() => {
        historyPreviewActiveRef.current -= 1;
        historyPreviewWaitersRef.current.shift()?.();
    }, []);
    const preloadHistoryPreview = useCallback((sessionId: string): Promise<void> => {
        if (sessionId === current || historyPreviewAttemptedRef.current.has(sessionId)) return Promise.resolve();
        const existing = historyPreviewRef.current.get(sessionId);
        if (existing) return existing;
        historyPreviewAttemptedRef.current.add(sessionId);
        const promise = (async () => {
            await acquireHistoryPreview();
            try {
                if (sessionId === currentRef.current) return;
                const value = await rpc('session.history', {
                    sessionId,
                    maxMessages: HISTORY_PREVIEW_MESSAGES,
                }) as { events?: HistoryEntry[] };
                const entries = Array.isArray(value.events) ? value.events : [];
                const preview = latestActivityPreview(entries);
                if (preview) setSessionActivityPreviews((previous) => mergeActivityPreview(previous, sessionId, preview));
                const historyError = latestHistoryError(entries);
                if (historyError !== null) setSessionErrors((previous) => previous[sessionId] === historyError ? previous : { ...previous, [sessionId]: historyError });
            } finally {
                releaseHistoryPreview();
            }
        })().catch(() => {
            // Card previews are optional; the selected session loads its own history and reports errors.
        });
        historyPreviewRef.current.set(sessionId, promise);
        void promise.finally(() => {
            if (historyPreviewRef.current.get(sessionId) === promise) historyPreviewRef.current.delete(sessionId);
        });
        return promise;
    }, [acquireHistoryPreview, current, releaseHistoryPreview, rpc]);
    const loadHistory = useCallback(async (sessionId: string, beforeSeq?: number) => {
        const initialLoad = beforeSeq === undefined;
        const loadId = ++historyLoadRef.current;
        const isCurrentLoad = () => currentRef.current === sessionId && historyLoadRef.current === loadId;
        if (initialLoad) setHistoryLoading(true);
        try {
            const value = await rpc('session.history', { sessionId, ...(beforeSeq === undefined ? {} : { beforeSeq }), maxMessages: HISTORY_PAGE_SIZE }) as {
                events?: HistoryEntry[];
                hasMore?: boolean;
                totalMessages?: number;
                projections?: { values?: Record<string, unknown> };
            };
            if (!isCurrentLoad()) return;
            const entries = Array.isArray(value.events) ? value.events : [];
            const parsed = eventsToMessages(entries);
            if (beforeSeq === undefined) {
                const preview = latestActivityPreview(entries);
                if (preview) setSessionActivityPreviews((previous) => mergeActivityPreview(previous, sessionId, preview));
            }
            const firstSeq = firstHistorySeq(entries);
            const hasMore = value.hasMore === true;
            const reportedTotalMessages = typeof value.totalMessages === 'number' && Number.isSafeInteger(value.totalMessages)
                ? value.totalMessages : undefined;
            const cached = historyCacheRef.current.get(sessionId);
            const totalMessages = reportedTotalMessages ?? cached?.totalMessages ?? null;
            const nextHistory = beforeSeq === undefined ? entries : mergeHistoryEntries(entries, historyRef.current);
            const historyError = latestHistoryError(nextHistory);
            if (historyError !== null) setSessionErrors((previous) => previous[sessionId] === historyError ? previous : { ...previous, [sessionId]: historyError });
            historyRef.current = nextHistory;
            if (firstSeq !== null) historyFirstSeq.current = firstSeq;
            setHistory(nextHistory);
            if (beforeSeq === undefined) setMessages(parsed);
            else setMessages((previous) => [...parsed, ...previous]);
            historyCacheRef.current.set(sessionId, { history: nextHistory, hasMore, totalMessages });
            setHistoryHasMore(hasMore);
            if (reportedTotalMessages !== undefined) setHistoryTotalMessages(reportedTotalMessages);
            if (value.projections) {
                setSessions((prev) => prev.map((session) => session.sessionId === sessionId
                    ? { ...session, projections: value.projections } : session));
            }
            setLoadError(null);
        } catch (error) {
            if (!isCurrentLoad()) return;
            if (beforeSeq === undefined) setMessages([]);
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            if (initialLoad && isCurrentLoad()) setHistoryLoading(false);
        }
    }, [rpc]);

    const loadInitialHistory = useCallback(async (sessionId: string) => {
        const loadId = ++historyLoadRef.current;
        const isCurrentLoad = () => currentRef.current === sessionId && historyLoadRef.current === loadId;
        historyRef.current = [];
        historyFirstSeq.current = null;
        setHistory([]);
        setHistoryHasMore(false);
        setLoadingOlder(false);
        setHistoryLoading(true);
        setHistoryProgress(0);
        setHistoryTotalMessages(historyTotalsRef.current.get(sessionId) ?? null);
        let beforeSeq: number | undefined;
        let combined: HistoryEntry[] = [];
        let hasMore = true;
        let totalMessages: number | null = null;
        let projections: { values?: Record<string, unknown> } | undefined;
        try {
            while (hasMore && visibleHistoryMessageCount(combined) < HISTORY_INITIAL_MESSAGES) {
                const value = await rpc('session.history', {
                    sessionId,
                    ...(beforeSeq === undefined ? {} : { beforeSeq }),
                    maxMessages: HISTORY_INITIAL_MESSAGES,
                }) as { events?: HistoryEntry[]; hasMore?: boolean; totalMessages?: number; projections?: { values?: Record<string, unknown> } };
                if (!isCurrentLoad()) return;
                const entries = Array.isArray(value.events) ? value.events : [];
                if (entries.length === 0) {
                    hasMore = false;
                    break;
                }
                combined = [...entries, ...combined];
                projections = value.projections ?? projections;
                if (typeof value.totalMessages === 'number' && Number.isSafeInteger(value.totalMessages)) {
                    totalMessages = value.totalMessages;
                    historyTotalsRef.current.set(sessionId, value.totalMessages);
                    setHistoryTotalMessages(value.totalMessages);
                }
                setHistoryProgress(visibleHistoryMessageCount(combined));
                hasMore = value.hasMore === true;
                const nextBeforeSeq = firstHistorySeq(entries);
                if (nextBeforeSeq === null || nextBeforeSeq === beforeSeq) break;
                beforeSeq = nextBeforeSeq;
            }
            if (!isCurrentLoad()) return;
            const nextHistory = mergeHistoryEntries(combined, historyRef.current);
            const historyError = latestHistoryError(nextHistory);
            if (historyError !== null) setSessionErrors((previous) => previous[sessionId] === historyError ? previous : { ...previous, [sessionId]: historyError });
            const resolvedTotalMessages = historyTotalsRef.current.get(sessionId) ?? totalMessages;
            historyRef.current = nextHistory;
            historyCacheRef.current.set(sessionId, { history: nextHistory, hasMore, totalMessages: resolvedTotalMessages });
            setHistory(nextHistory);
            const parsed = eventsToMessages(nextHistory);
            const preview = latestActivityPreview(nextHistory);
            if (preview) setSessionActivityPreviews((previous) => mergeActivityPreview(previous, sessionId, preview));
            setMessages(parsed);
            historyFirstSeq.current = firstHistorySeq(nextHistory);
            setHistoryHasMore(hasMore);
            if (projections) setSessions((prev) => prev.map((session) => session.sessionId === sessionId ? { ...session, projections } : session));
            setLoadError(null);
        } catch (error) {
            if (!isCurrentLoad()) return;
            setMessages([]);
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            if (isCurrentLoad()) setHistoryLoading(false);
        }
    }, [rpc]);

    const loadHistoryTotal = useCallback(async (sessionId: string) => {
        const requestId = ++historyTotalRequestRef.current;
        try {
            const value = await rpc('session.count', { sessionId }) as { totalMessages?: number };
            if (currentRef.current !== sessionId || historyTotalRequestRef.current !== requestId) return;
            if (typeof value.totalMessages !== 'number' || !Number.isSafeInteger(value.totalMessages)) return;
            historyTotalsRef.current.set(sessionId, value.totalMessages);
            const cached = historyCacheRef.current.get(sessionId);
            if (cached) historyCacheRef.current.set(sessionId, { ...cached, totalMessages: value.totalMessages });
            setHistoryTotalMessages(value.totalMessages);
        } catch {
            return;
        }
    }, [rpc]);

    const loadOlder = useCallback(async () => {
        if (!current || loadingOlder || !historyHasMore || historyFirstSeq.current === null) return;
        setLoadingOlder(true);
        try {
            await loadHistory(current, historyFirstSeq.current);
        } finally {
            setLoadingOlder(false);
        }
    }, [current, historyHasMore, loadHistory, loadingOlder, view]);

    const onMux = useCallback((frame: MuxFrame) => {
        if (frame.sessionId === currentRef.current && frame.type === 'approval/requested' && frame.rpcId && frame.approvalId && frame.toolName) {
            setPendingApproval({ rpcId: frame.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, toolName: frame.toolName, reason: frame.reason });
        }
        if (frame.sessionId === currentRef.current && frame.type === 'approval/resolved') setPendingApproval(null);
        const requestedQuestion = pendingQuestionFromFrame(frame);
        if (requestedQuestion) {
            setPendingQuestions((previous) => ({ ...previous, [requestedQuestion.sessionId]: requestedQuestion }));
            if (requestedQuestion.sessionId === currentRef.current) setPendingQuestion(requestedQuestion);
        }
        const resolvedQuestionSessionId = frame.type === 'question/resolved' ? frame.sessionId : undefined;
        if (resolvedQuestionSessionId) {
            setPendingQuestions((previous) => {
                const pending = previous[resolvedQuestionSessionId];
                if (!pending || (frame.questionRpcId && pending.rpcId !== frame.questionRpcId)) return previous;
                const next = { ...previous };
                delete next[resolvedQuestionSessionId];
                return next;
            });
            if (resolvedQuestionSessionId === currentRef.current) {
                setPendingQuestion((pending) => pending && (!frame.questionRpcId || pending.rpcId === frame.questionRpcId) ? null : pending);
            }
        }
        if (frame.sessionId === currentRef.current && frame.type === 'session/queue') {
            setQueue(queueItems(frame.items ?? []));
        }
        if (frame.type === 'session/event' && frame.sessionId && frame.event) {
            const event = frame.event;
            const activityMessage = eventMessage(event);
            if (activityMessage?.text && activityMessage.role !== 'user') {
                const streamKey = activityKey(event, activityMessage);
                setSessionActivityPreviews((previous) => {
                    const prior = previous[frame.sessionId!];
                    const index = prior?.key === streamKey ? prior.index : (prior?.index ?? 0) + 1;
                    const next = event.type === 'assistant/chunk' && prior?.key === streamKey
                        ? appendAssistantActivity(prior, activityMessage, streamKey, event.seq)
                        : activityMessage.role === 'assistant'
                            ? assistantActivity(activityMessage, streamKey, event.seq, index)
                            : { seq: event.seq, index, key: streamKey, text: activityPreview(activityMessage) };
                    if (prior?.key === next.key && prior.text === next.text) return previous;
                    return mergeActivityPreview(previous, frame.sessionId!, next);
                });
            } else if (event.type === 'turn/start') {
                const turn = String(asObject(event.data).turn ?? event.seq);
                setSessionActivityPreviews((previous) => {
                    const prior = previous[frame.sessionId!];
                    const next = { seq: event.seq, index: prior?.key === `turn-${turn}` ? prior.index : (prior?.index ?? 0) + 1, key: `turn-${turn}`, text: 'Think · 思考中…' };
                    return prior?.key === next.key && prior.text === next.text
                        ? previous
                        : mergeActivityPreview(previous, frame.sessionId!, next);
                });
            }
            const eventError = eventFailureMessage(event);
            if (eventError !== null) setSessionErrors((previous) => previous[frame.sessionId!] === eventError ? previous : { ...previous, [frame.sessionId!]: eventError });
            const runtimeId = sessionsRef.current.find((session) => session.sessionId === frame.sessionId)?.runtimeId;
            const host = runtimeId === undefined ? undefined : hostsRef.current.find((item) => item.runtimeId === runtimeId)?.host;
            const origin = runtimeId === undefined && host === undefined ? undefined : {
                ...(runtimeId === undefined ? {} : { runtimeId }),
                ...(host === undefined ? {} : { host }),
            };
            const historyEntry: HistoryEntry = { event: event, ...origin };
            const cached = historyCacheRef.current.get(frame.sessionId);
            if (cached) historyCacheRef.current.set(frame.sessionId, { ...cached, history: mergeHistoryEntries(cached.history, [historyEntry]) });
            if (frame.sessionId !== currentRef.current) return;
            if (event.type === 'user/message') setSessions((items) => items.map((session) => session.sessionId === frame.sessionId ? { ...session, blank: false } : session));
            const nextHistory = mergeHistoryEntries(historyRef.current, [historyEntry]);
            historyRef.current = nextHistory;
            setHistory(nextHistory);
            setMessages((prev) => fileInjectionsAfterUser(foldToolTree(applyEvent(flattenToolTree(prev), event, origin))));
        }
        if (frame.type === 'session/projection' && frame.sessionId) {
            setSessions((prev) => prev.map((session) => session.sessionId === frame.sessionId
                ? { ...session, projections: { values: { ...(session.projections?.values ?? {}), [String(frame.key)]: frame.value } } }
                : session));
        }
    }, []);

    const onHost = useCallback((frame: HostFrame) => {
        if (!frame.sessionId) return;
        if (frame.type === 'host/agent-error') {
            const message = frame.message?.trim() || '本轮运行失败';
            setSessionErrors((previous) => previous[frame.sessionId!] === message ? previous : { ...previous, [frame.sessionId!]: message });
            return;
        }
        if (frame.type === 'host/session-removed') {
            setSessionErrors((previous) => {
                if (previous[frame.sessionId!] === undefined) return previous;
                const next = { ...previous };
                delete next[frame.sessionId!];
                return next;
            });
            setSessionActivityPreviews((previous) => {
                if (previous[frame.sessionId!] === undefined) return previous;
                const next = { ...previous };
                delete next[frame.sessionId!];
                return next;
            });
            historyCacheRef.current.delete(frame.sessionId);
            historyPreviewAttemptedRef.current.delete(frame.sessionId);
            historyPreviewRef.current.delete(frame.sessionId);
            modelsCacheRef.current.delete(frame.sessionId);
            setSessions((prev) => prev.filter((session) => session.sessionId !== frame.sessionId));
            if (currentRef.current === frame.sessionId) {
                setCurrent(null);
                setDetailsOpen(false);
                updateAgentSelectionUrl({ cardId: null });
            }
            return;
        }
        setSessions((prev) => {
            const index = prev.findIndex((session) => session.sessionId === frame.sessionId);
            if (index < 0) return prev;
            const next = prev.slice();
            next[index] = {
                ...next[index],
                ...(frame.type === 'host/session-status' ? { running: frame.running === true } : {}),
                ...(frame.type === 'host/session-added' ? {
                    blank: frame.blank === true,
                    cwd: frame.cwd,
                    agentPreset: frame.agentPreset,
                } : {}),
            };
            return next;
        });
    }, []);

    useEffect(() => {
        if (guest) return;
        void Promise.all([
            loadSessions(),
            loadNodes(),
            loadHosts(),
            loadBases(),
            loadDisplaySettings(),
            loadAgentPresets(),
            loadModelCatalog(),
        ]).finally(() => setBooting(false));
    }, [guest, loadAgentPresets, loadBases, loadDisplaySettings, loadHosts, loadModelCatalog, loadNodes, loadSessions]);
    useEffect(() => {
        if (guest) return undefined;
        const timer = window.setInterval(() => { void loadSessions(); void loadNodes(); void loadHosts(); void loadBases(); }, POLL_MS);
        return () => window.clearInterval(timer);
    }, [guest, loadBases, loadHosts, loadNodes, loadSessions]);
    useEffect(() => {
        if (booting) return;
        const selectedSession = current ? sessions.find((session) => session.sessionId === current) : undefined;
        const cardId = selectedSession?.sessionId ?? null;
        const sessionNodeId = selectedSession?.nodeId && nodes.some((node) => node.nodeId === selectedSession.nodeId)
            ? selectedSession.nodeId
            : rootNodeId;
        const selectedNodeId = sessionNodeId
            ?? (activeTreeNodeId && nodes.some((node) => node.nodeId === activeTreeNodeId) ? activeTreeNodeId : null);
        if (current && !selectedSession) {
            setCurrent(null);
            setDetailsOpen(false);
        }
        if (selectedNodeId !== activeTreeNodeId) setActiveTreeNodeId(selectedNodeId);
        const urlSelection = readAgentSelection();
        if (urlSelection.nodeId !== selectedNodeId || urlSelection.cardId !== cardId) {
            updateAgentSelectionUrl({ nodeId: selectedNodeId, cardId });
        }
    }, [activeTreeNodeId, booting, current, nodes, rootNodeId, sessions]);
    useEffect(() => {
        if (guest) return;
        sessions.forEach((session) => {
            if (!session.blank && session.sessionId !== current) void preloadHistoryPreview(session.sessionId);
        });
    }, [current, guest, preloadHistoryPreview, sessions]);
    useEffect(() => {
        ++historyLoadRef.current;
        ++historyTotalRequestRef.current;
        setModels(null);
        historyRef.current = [];
        setHistory([]);
        setHistoryHasMore(false);
        setHistoryTotalMessages(current ? historyTotalsRef.current.get(current) ?? null : null);
        setHistoryProgress(0);
        setLoadingOlder(false);
        historyFirstSeq.current = null;
        setQueue([]);
        setPendingApproval(null);
        setPendingQuestion(null);
        setSelectedTool(null);
        setRenaming(false);
        setView('chat');
        setModelMenuOpen(false);
        if (!current) {
            setHistoryLoading(false);
            return;
        }
        void loadModels(current);
        const cached = historyCacheRef.current.get(current);
        if (!cached) {
            void loadHistoryTotal(current);
            void loadInitialHistory(current);
            return;
        }
        historyRef.current = cached.history;
        historyFirstSeq.current = firstHistorySeq(cached.history);
        setHistory(cached.history);
        setMessages(eventsToMessages(cached.history));
        setHistoryHasMore(cached.hasMore);
        setHistoryTotalMessages(cached.totalMessages);
        setHistoryProgress(Math.min(HISTORY_PAGE_SIZE, visibleHistoryMessageCount(cached.history)));
        setHistoryLoading(false);
    }, [current, loadHistoryTotal, loadInitialHistory, loadModels]);
    useEffect(() => {
        setPendingQuestion(current ? pendingQuestions[current] ?? null : null);
    }, [current, pendingQuestions]);
    const webSocketStatus = useAgentEvents(onMux, onHost, !booting && !guest, String(domainId || 'system'), agentId);
    useEffect(() => {
        const search = query.trim().replaceAll('\0', '').slice(0, 500);
        if (!search) { setSearchMatches(null); setSearchHasMore(false); return undefined; }
        let disposed = false;
        const timer = window.setTimeout(async () => {
            try {
                const result = await rpc('session.search', { query: search }) as { items?: { sessionId: string; snippet: string }[]; hasMore?: boolean };
                if (disposed) return;
                setSearchMatches(Array.isArray(result.items) ? result.items : []);
                setSearchHasMore(result.hasMore === true);
            } catch (error) {
                if (disposed) return;
                setSearchMatches(null);
                setSearchHasMore(false);
                setLoadError(error instanceof Error ? error.message : String(error));
            }
        }, 250);
        return () => { disposed = true; window.clearTimeout(timer); };
    }, [query, rpc]);
    const pendingQuestionSessionIds = useMemo(() => new Set(Object.keys(pendingQuestions)), [pendingQuestions]);
    const sessionErrorMap = useMemo(() => new Map(Object.entries(sessionErrors)), [sessionErrors]);
    const sessionActivityPreviewMap = useMemo(() => new Map(Object.entries(sessionActivityPreviews).map(([sessionId, preview]) => [sessionId, { index: preview.index, text: preview.text }])), [sessionActivityPreviews]);
    const currentSession = useMemo(() => {
        const found = sessions.find((session) => session.sessionId === current);
        if (found) return found;
        if (!current) return null;
        const now = Date.now();
        return { sessionId: current, createdAt: now, updatedAt: now, running: false, blank: true };
    }, [sessions, current]);
    const loadedHistoryMessages = useMemo(() => history.filter((entry) => entry.event.type === 'user/message' || entry.event.type === 'assistant/message').length, [history]);
    const historyLoadingRangeEnd = historyTotalMessages === null ? null : Math.max(0, historyTotalMessages - historyProgress);
    const historyLoadingLabel = historyLoadingRangeEnd === null
        ? '加载中…'
        : `加载中… ${Math.max(0, historyLoadingRangeEnd - HISTORY_INITIAL_MESSAGES)}-${historyLoadingRangeEnd}`;
    const selectedBaseId = current
        ? (currentSession?.baseDocId === undefined || currentSession.baseDocId === null || currentSession.baseDocId === '' ? undefined : Number(currentSession.baseDocId))
        : draftBaseId;
    const running = currentSession?.running === true;
    const fallbackHostId = hosts.find((host) => host.fallback === true)?.runtimeId ?? '';
    const currentSessionError = current ? sessionErrors[current] : undefined;
    const runningTurnStart = useMemo(() => runningTurnStartTime(history), [history]);
    const composerModels = current
        ? models
        : (modelCatalog ? {
            current: draftModelSelection ?? { provider: '', model: '' },
            routable: draftModelSelection !== undefined,
            groups: modelCatalog.groups,
        } : null);
    const startSession = useCallback(async (firstMessage = '', presetOverride?: string, baseId?: number, titleOverride?: string, modelOverride?: { provider: string; model: string }) => {
        let sessionPublished = false;
        setCreatingSession(true);
        setNewSessionConfigOpen(false);
        setDetailsOpen(true);
        try {
            const selectedBaseId = baseId ?? draftBaseId;
            const selectedNodeId = draftNodeId ?? rootNodeId ?? undefined;
            const selectedModel = modelOverride ?? draftModelSelection;
            // The host is part of what a session is created with: it serves this
            // session until another one is chosen for it.
            const selectedHostId = draftHostId ?? '';
            const value = await rpc('session.create', {
                ...(selectedBaseId === undefined ? {} : { baseDocId: selectedBaseId }),
                ...(selectedNodeId === undefined ? {} : { nodeId: selectedNodeId }),
                ...(selectedHostId === '' ? {} : { runtimeId: selectedHostId }),
            }) as { sessionId?: string; agentPreset?: string; runtimeId?: string; nodeId?: string };
            if (!value.sessionId) throw new Error('会话创建未返回会话 ID');
            const actualHostId = value.runtimeId ?? selectedHostId;
            const actualNodeId = value.nodeId ?? selectedNodeId;
            const requestedPreset = presetOverride ?? agentPresetChoice;
            let agentPreset = value.agentPreset;
            if (requestedPreset && requestedPreset !== agentPreset) {
                const selected = await rpc('agentPreset.select', { sessionId: value.sessionId, agentPreset: requestedPreset }) as { agentPreset?: string };
                agentPreset = selected.agentPreset ?? requestedPreset;
            }
            const title = titleOverride?.trim();
            if (title) {
                const renamed = await rpc('session.rename', { sessionId: value.sessionId, title }) as { title?: string };
                if (renamed.title !== title) throw new Error('会话名称保存失败');
            }
            if (selectedModel) {
                await rpc('session.selectModel', { sessionId: value.sessionId, ...selectedModel });
            }
            const text = firstMessage.trim();
            const files = readyFiles(attachments);
            const hasContent = Boolean(text || files.length);
            const optimisticCreatedAt = Date.now();
            setSessions((items) => items.some((session) => session.sessionId === value.sessionId)
                ? items
                : [{ sessionId: value.sessionId!, createdAt: optimisticCreatedAt, updatedAt: optimisticCreatedAt, running: false, blank: !hasContent, ...(agentId === null ? {} : { agentId }), agentPreset, ...(actualHostId === '' ? {} : { runtimeId: actualHostId }), ...(title ? { projections: { values: { title } } } : {}), ...(selectedBaseId === undefined ? {} : { baseDocId: String(selectedBaseId) }), ...(actualNodeId === undefined ? {} : { nodeId: actualNodeId }), ...(selectedModel === undefined ? {} : { model: selectedModel }) }, ...items]);
            setDraftBaseId(undefined);
            setDraftNodeId(undefined);
            setDraftHostId('');
            setActiveTreeNodeId(actualNodeId ?? null);
            setCurrent(value.sessionId);
            updateAgentSelectionUrl({ nodeId: actualNodeId ?? null, cardId: value.sessionId });
            sessionPublished = true;
            setCreatingSession(false);
            setNewSessionConfigOpen(false);
            setDetailsOpen(true);
            setMessages([]);
            if (hasContent) {
                setSending(true);
                setInput('');
                setSessions((items) => items.map((session) => session.sessionId === value.sessionId ? { ...session, blank: false, updatedAt: Date.now() } : session));
                await injectDraftFiles(rpc, String(value.sessionId), files);
                await rpc('session.prompt', {
                    sessionId: value.sessionId,
                    mode: 'queue',
                    content: promptParts(text, files.length),
                    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
                clearAttachments();
            }
            void loadSessions();
            setLoadError(null);
        } catch (error) {
            setCreatingSession(false);
            if (!sessionPublished) {
                setDetailsOpen(false);
                setNewSessionConfigOpen(true);
            }
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            setCreatingSession(false);
            setSending(false);
        }
    }, [agentId, agentPresetChoice, attachments, draftBaseId, draftModelSelection, draftNodeId, loadSessions, rootNodeId, rpc]);

    const confirmNewSession = useCallback(async (title: string) => {
        const selectedModel = draftModelSelection ?? (composerModels?.current?.provider && composerModels.current.model
            ? { provider: composerModels.current.provider, model: composerModels.current.model }
            : undefined);
        await startSession(input, agentPresetChoice, draftBaseId, title, selectedModel);
    }, [agentPresetChoice, composerModels, draftBaseId, draftModelSelection, input, startSession]);

    const prepareNewSession = useCallback(async (baseId?: number) => {
        const loadId = ++newSessionLoadRef.current;
        setCurrent(null);
        setDetailsOpen(false);
        setSelectedTool(null);
        const selectedNodeId = nodes.some((node) => node.nodeId === activeTreeNodeId) ? activeTreeNodeId : rootNodeId;
        setActiveTreeNodeId(selectedNodeId);
        updateAgentSelectionUrl({ nodeId: selectedNodeId, cardId: null });
        setNewSessionConfigOpen(true);
        setNewSessionConfigLoading(true);
        setModelCatalog(null);
        setInput('');
        clearAttachments();
        setDraftBaseId(baseId);
        setDraftNodeId(selectedNodeId ?? undefined);
        // The host the dialog opens on: the last one chosen, else the server's
        // own fallback, so the choice is stated rather than left to chance.
        setDraftHostId((previous) => (previous !== '' && hosts.some((host) => host.runtimeId === previous && host.online !== false)
            ? previous
            : fallbackHostId !== ''
                ? fallbackHostId
                : hosts.find((host) => host.online !== false)?.runtimeId ?? ''));
        setDraftModelSelection(undefined);
        await loadModelCatalog();
        if (newSessionLoadRef.current === loadId) setNewSessionConfigLoading(false);
    }, [activeTreeNodeId, fallbackHostId, hosts, loadModelCatalog, nodes, rootNodeId]);

    /**
     * Move the open session to another host.
     *
     * The session moves on this server's record, so the next message reaches the
     * chosen host; the page states the choice before that message, and a refusal
     * leaves the session where it was. A session that does not exist yet has no
     * host to move: its host is the one its creation window was given.
     */
    const switchHost = useCallback(async (runtimeId: string) => {
        if (!current) return;
        const sessionId = current;
        try {
            await rpc('session.setHost', { sessionId, runtimeId });
            setSessions((items) => items.map((session) => session.sessionId === sessionId ? { ...session, runtimeId } : session));
            setSessionErrors((previous) => {
                if (previous[sessionId] === undefined) return previous;
                const next = { ...previous };
                delete next[sessionId];
                return next;
            });
            await Notification.success('已切换 host，下一条消息由它处理');
        } catch (error) {
            setSessionErrors((previous) => ({ ...previous, [sessionId]: error instanceof Error ? error.message : String(error) }));
            throw error;
        }
    }, [current, rpc]);

    const saveBaseSetting = useCallback(async (baseId: number | undefined) => {
        if (!current) {
            setDraftBaseId(baseId);
            await Notification.success('上下文已保存');
            return;
        }
        const value = await rpc('session.context.save', { sessionId: current, baseDocId: baseId ?? null }) as { baseDocId?: number | string | null };
        const persistedBaseDocId = value.baseDocId === null || value.baseDocId === undefined ? undefined : String(value.baseDocId);
        setSessions((items) => items.map((session) => session.sessionId === current
            ? { ...session, ...(persistedBaseDocId === undefined ? { baseDocId: undefined } : { baseDocId: persistedBaseDocId }) }
            : session));
        setDraftBaseId(undefined);
        void loadSessions();
        await Notification.success('上下文已保存');
    }, [current, loadSessions, rpc]);

    const saveDisplaySettings = useCallback(async (next: AgentDisplaySettings) => {
        const requestId = ++displaySettingsRequestRef.current;
        const previous = displaySettings;
        setDisplaySettings(next);
        setDisplaySettingsSaving(true);
        try {
            const value = await rpc('ui.displayPrefs.save', { display: next }) as { display?: unknown };
            if (requestId !== displaySettingsRequestRef.current) return;
            setDisplaySettings(readAgentDisplaySettings(value.display ?? next));
            setDisplaySettingsOpen(false);
            await Notification.success('显示设置已保存');
        } catch (error) {
            if (requestId !== displaySettingsRequestRef.current) return;
            setDisplaySettings(previous);
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            setDisplaySettingsSaving(false);
        }
    }, [displaySettings, rpc]);

    const startCreatorDraft = useCallback(() => {
        setAgentPresetChoice('cordis');
        setSettingsOpen(false);
        setSettingsSection(null);
        setDraftBaseId(undefined);
        void prepareNewSession();
    }, [prepareNewSession]);

    const selectAgentPreset = useCallback(async (id: string) => {
        setAgentPresetChoice(id);
        setAgentPresetError(null);
        if (!current || !currentSession?.blank) return;
        try {
            const value = await rpc('agentPreset.select', { sessionId: current, agentPreset: id }) as { agentPreset?: string };
            const applied = value.agentPreset ?? id;
            setSessions((items) => items.map((session) => session.sessionId === current ? { ...session, agentPreset: applied } : session));
            setAgentPresetChoice(applied);
        } catch (caught) {
            setAgentPresetError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [current, currentSession?.blank, rpc]);

    const send = useCallback(async (mode: 'queue' | 'steer' = 'queue') => {
        const text = input.trim();
        const effective = !running ? 'queue' : mode === 'steer' ? 'steer' : busyEnter;
        const files = readyFiles(attachments);
        if (attachments.some((attachment) => attachment.meta === undefined && attachment.error === undefined)) {
            setLoadError('文件仍在上传中，请稍候');
            return;
        }
        if ((!text && !files.length) || !current || sending) return;
        setSessionErrors((previous) => {
            if (previous[current] === undefined) return previous;
            const next = { ...previous };
            delete next[current];
            return next;
        });
        setSending(true);
        setInput('');
        try {
            await injectDraftFiles(rpc, current, files);
            await rpc('session.prompt', {
                sessionId: current,
                mode: effective,
                content: promptParts(text, files.length),
                clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            clearAttachments();
            setSessions((items) => items.map((session) => session.sessionId === current ? { ...session, blank: false, updatedAt: Date.now() } : session));
            setLoadError(null);
        } catch (error) {
            setInput(text);
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            setSending(false);
        }
    }, [attachments, busyEnter, current, input, rpc, running, sending]);

    const cancel = useCallback(async () => {
        if (!current || !running) return;
        try {
            await rpc('session.cancel', { sessionId: current });
            setSessions((items) => items.map((session) => session.sessionId === current ? { ...session, running: false } : session));
            setMessages(settleRunningMessages);
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [current, rpc, running]);

    const openFile = useCallback(async (path: string) => {
        try {
            await rpc('host.openPath', { path });
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const answerServerRequest = useCallback(async (rpcId: string, value: unknown) => {
        const response = await fetch(`${domainPrefix(String(domainId || 'system'))}/api/ejunz-agent/respond`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value }, agentId }),
        });
        if (response.redirected) {
            window.location.href = response.url;
            throw new Error('登录跳转中');
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }, [domainId]);

    const answerApproval = useCallback(async (outcome: 'allowed-once' | 'rejected') => {
        if (!pendingApproval) return;
        await answerServerRequest(pendingApproval.rpcId, { sessionId: pendingApproval.sessionId, approvalId: pendingApproval.approvalId, outcome });
        setPendingApproval(null);
    }, [answerServerRequest, pendingApproval]);

    const answerQuestion = useCallback(async (answer: { answers: { id: string; selected: string[]; custom?: string }[] }) => {
        if (!pendingQuestion) return;
        await answerServerRequest(pendingQuestion.rpcId, { sessionId: pendingQuestion.sessionId, answer });
        setPendingQuestions((previous) => {
            if (previous[pendingQuestion.sessionId]?.rpcId !== pendingQuestion.rpcId) return previous;
            const next = { ...previous };
            delete next[pendingQuestion.sessionId];
            return next;
        });
        setPendingQuestion(null);
    }, [answerServerRequest, pendingQuestion]);

    const selectModel = useCallback(async (provider: string, model: string) => {
        const sessionId = current;
        if (!sessionId) {
            setDraftModelSelection({ provider, model });
            setModelMenuOpen(false);
            return;
        }
        try {
            await rpc('session.selectModel', { sessionId, provider, model });
            setModels((value) => {
                if (!value) return value;
                const next = { ...value, current: { ...value.current, provider, model } };
                modelsCacheRef.current.set(sessionId, next);
                return next;
            });
            setSessions((items) => items.map((session) => session.sessionId === sessionId ? { ...session, model: { provider, model } } : session));
            setModelMenuOpen(false);
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [current, rpc]);

    const saveSessionModel = useCallback(async (provider: string, model: string) => {
        const sessionId = current;
        if (!sessionId) throw new Error('当前没有会话');
        await rpc('session.selectModel', { sessionId: sessionId, provider, model });
        setModels((value) => {
            if (!value) return value;
            const next = { ...value, current: { ...value.current, provider, model } };
            modelsCacheRef.current.set(sessionId, next);
            return next;
        });
        setModelMenuOpen(false);
        setLoadError(null);
        await Notification.success('模型已保存');
    }, [current, rpc]);

    const renameSession = useCallback(async (sessionId = current ?? '', requestedTitle = titleDraft) => {
        if (!sessionId || !requestedTitle.trim()) return;
        try {
            const value = await rpc('session.rename', { sessionId, title: requestedTitle.trim() }) as { title?: string };
            if (value.title) setSessions((items) => items.map((session) => session.sessionId === sessionId ? { ...session, projections: { values: { ...(session.projections?.values ?? {}), title: value.title } } } : session));
            setRenaming(false);
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [current, rpc, titleDraft]);

    const startSessionTitleEdit = useCallback(() => {
        setSessionTitleDrafts(Object.fromEntries(sessions.map((session) => [session.sessionId, sessionTitle(session)])));
        setSelectedCardIds(new Set());
        setSelectedNodeIds(new Set());
        setEditMode(true);
        setLoadError(null);
    }, [sessions]);

    const updateSessionTitleDraft = useCallback((sessionId: string, title: string) => {
        setSessionTitleDrafts((drafts) => ({ ...drafts, [sessionId]: title }));
    }, []);

    const saveSessionTitleEdits = useCallback(async () => {
        if (sessionTitleSaving) return;
        const changes = sessions.flatMap((session) => {
            const title = (sessionTitleDrafts[session.sessionId] ?? sessionTitle(session)).trim();
            if (title === '') return [{ sessionId: session.sessionId, title }];
            return title === sessionTitle(session) ? [] : [{ sessionId: session.sessionId, title }];
        });
        if (changes.some((change) => change.title === '')) {
            setLoadError('会话名称不能为空');
            return;
        }
        if (changes.length === 0) {
            setEditMode(false);
            setSessionTitleDrafts({});
                setSelectedCardIds(new Set());
            return;
        }
        setSessionTitleSaving(true);
        try {
            const results = await Promise.all(changes.map(async (change) => {
                const value = await rpc('session.rename', { sessionId: change.sessionId, title: change.title }) as { title?: string };
                if (value.title !== change.title) throw new Error('会话名称保存失败');
                return { ...change, title: value.title };
            }));
            const titles = new Map(results.map((change) => [change.sessionId, change.title]));
            setSessions((items) => items.map((session) => {
                const title = titles.get(session.sessionId);
                return title === undefined ? session : { ...session, projections: { values: { ...(session.projections?.values ?? {}), title } } };
            }));
            setEditMode(false);
            setSessionTitleDrafts({});
                setSelectedCardIds(new Set());
            setLoadError(null);
            await Notification.success('会话名称已保存');
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
            void loadSessions();
        } finally {
            setSessionTitleSaving(false);
        }
    }, [loadSessions, rpc, sessionTitleDrafts, sessionTitleSaving, sessions]);

    const forkSession = useCallback(async (sessionId = current ?? '') => {
        if (!sessionId) return;
        try {
            const value = await rpc('session.fork', { sessionId }) as { sessionId?: string };
            if (value.sessionId) {
                await loadSessions();
                setCurrent(value.sessionId);
            }
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [current, loadSessions, rpc]);

    const hardDeleteSession = useCallback((sessionId: string) => {
        const session = sessions.find((item) => item.sessionId === sessionId);
        setDialogError(null);
        setDialog({ kind: 'delete-session', id: sessionId, title: session ? sessionTitle(session) : sessionId });
    }, [sessions]);

    const performHardDelete = useCallback(async (sessionId: string) => {
        await rpc('session.delete', { sessionId });
        historyCacheRef.current.delete(sessionId);
        historyPreviewAttemptedRef.current.delete(sessionId);
        historyPreviewRef.current.delete(sessionId);
        modelsCacheRef.current.delete(sessionId);
        setSessions((items) => items.filter((item) => item.sessionId !== sessionId));
        if (current === sessionId) {
            setCurrent(null);
            updateAgentSelectionUrl({ cardId: null });
            setDetailsOpen(false);
            setSelectedTool(null);
            setMessages([]);
            setHistory([]);
            setQueue([]);
            setPendingApproval(null);
            setPendingQuestion(null);
        }
        await Notification.success('会话已删除');
    }, [current, rpc]);

    const performHardDeleteMany = useCallback(async (sessionIds: readonly string[]) => {
        if (sessionIds.length === 0) return;
        await rpc('session.deleteMany', { sessionIds });
        sessionIds.forEach((sessionId) => {
            historyCacheRef.current.delete(sessionId);
            historyPreviewAttemptedRef.current.delete(sessionId);
            historyPreviewRef.current.delete(sessionId);
            modelsCacheRef.current.delete(sessionId);
        });
        const deleted = new Set(sessionIds);
        setSessions((items) => items.filter((session) => !deleted.has(session.sessionId)));
        if (current && deleted.has(current)) {
            setCurrent(null);
            updateAgentSelectionUrl({ cardId: null });
            setDetailsOpen(false);
            setSelectedTool(null);
            setMessages([]);
            setHistory([]);
            setQueue([]);
            setPendingApproval(null);
            setPendingQuestion(null);
        }
    }, [current, rpc]);

    const submitDialog = useCallback(async () => {
        if (!dialog || (('value' in dialog) && !dialog.value.trim())) return;
        const active = dialog;
        setDialogBusy(true);
        setDialogError(null);
        try {
            if (active.kind === 'rename-session') {
                const value = await rpc('session.rename', { sessionId: active.id, title: active.value.trim() }) as { title?: string };
                if (value.title) setSessions((items) => items.map((session) => session.sessionId === active.id ? { ...session, projections: { values: { ...(session.projections?.values ?? {}), title: value.title } } } : session));
            } else if (active.kind === 'create-node') {
                const parentId = activeTreeNodeId ?? rootNodeId ?? undefined;
                const value = await rpc('node.create', { text: active.value.trim(), ...(parentId === undefined ? {} : { parentId }) }) as { node?: AgentNode };
                if (!value.node) throw new Error('节点创建失败');
                setNodes((items) => [...items, value.node!]);
                setActiveTreeNodeId(value.node.nodeId);
                updateAgentSelectionUrl({ nodeId: value.node.nodeId, cardId: null });
                await Notification.success('节点已创建');
            } else if (active.kind === 'rename-node') {
                const value = await rpc('node.rename', { nodeId: active.id, text: active.value.trim() }) as { node?: AgentNode };
                if (!value.node) throw new Error('文件夹重命名失败');
                setNodes((items) => items.map((node) => node.nodeId === active.id ? value.node! : node));
                await Notification.success('文件夹已重命名');
            } else if (active.kind === 'delete-selected') {
                if (active.sessionIds.length > 0) await performHardDeleteMany(active.sessionIds);
                const removedNodes = nodes.filter((node) => active.nodeIds.includes(node.nodeId));
                await Promise.all(active.nodeIds.map((nodeId) => rpc('node.delete', { nodeId })));
                const removedNodeIds = new Set(active.nodeIds);
                const nextActiveNodeId = activeTreeNodeId && removedNodeIds.has(activeTreeNodeId)
                    ? removedNodes.find((node) => node.nodeId === activeTreeNodeId)?.parentId ?? rootNodeId
                    : activeTreeNodeId;
                setSessions((items) => items.map((session) => {
                    const removedNode = removedNodes.find((node) => node.nodeId === session.nodeId);
                    return removedNode ? { ...session, nodeId: removedNode.parentId ?? rootNodeId ?? undefined } : session;
                }));
                setNodes((items) => items.filter((node) => !removedNodeIds.has(node.nodeId)));
                setActiveTreeNodeId(nextActiveNodeId);
                updateAgentSelectionUrl({ nodeId: nextActiveNodeId, cardId: current && active.sessionIds.includes(current) ? null : current });
                setSelectedCardIds(new Set());
                setSelectedNodeIds(new Set());
                setSessionTitleDrafts({});
                setEditMode(false);
                const deletedCount = active.sessionIds.length + active.nodeIds.length;
                await Notification.success(`已删除 ${deletedCount} 项`);
            } else {
                await performHardDelete(active.id);
            }
            setDialog(null);
        } catch (error) {
            setDialogError(error instanceof Error ? error.message : String(error));
        } finally {
            setDialogBusy(false);
        }
    }, [activeTreeNodeId, current, dialog, nodes, performHardDelete, performHardDeleteMany, rootNodeId, rpc]);

    const updateQueue = useCallback(async (itemId: string, action: { kind: 'remove' | 'steer' | 'edit'; text?: string }) => {
        if (!current) return;
        await rpc('session.updateQueue', {
            sessionId: current,
            itemId,
            action: action.kind === 'edit'
                ? { kind: 'edit', content: [{ type: 'text', text: action.text ?? '' }] }
                : { kind: action.kind },
        });
        setQueue((items) => action.kind === 'remove' ? items.filter((item) => item.id !== itemId) : items);
    }, [current, rpc]);

    const searchMatchSet = useMemo(() => searchMatches === null ? null : new Set(searchMatches.map((item) => item.sessionId)), [searchMatches]);
    const searchSnippetMap = useMemo(() => searchMatches === null ? new Map<string, string>() : new Map(searchMatches.map((item) => [item.sessionId, item.snippet])), [searchMatches]);
    const toggleCardSelection = useCallback((cardId: string) => {
        setSelectedCardIds((currentIds) => {
            const next = new Set(currentIds);
            if (next.has(cardId)) next.delete(cardId);
            else next.add(cardId);
            return next;
        });
    }, []);
    const toggleNodeSelection = useCallback((nodeIds: readonly string[], cardIds: readonly string[], ancestorIds: readonly string[]) => {
        const deselect = nodeIds.every((nodeId) => selectedNodeIds.has(nodeId))
            && cardIds.every((cardId) => selectedCardIds.has(cardId));
        setSelectedNodeIds((currentIds) => {
            const next = new Set(currentIds);
            nodeIds.forEach((nodeId) => { if (deselect) next.delete(nodeId); else next.add(nodeId); });
            if (deselect) ancestorIds.forEach((nodeId) => next.delete(nodeId));
            return next;
        });
        setSelectedCardIds((currentIds) => {
            const next = new Set(currentIds);
            cardIds.forEach((cardId) => { if (deselect) next.delete(cardId); else next.add(cardId); });
            return next;
        });
    }, [selectedCardIds, selectedNodeIds]);
    const requestCreateNode = useCallback(() => {
        setDialogError(null);
        setDialog({ kind: 'create-node', value: '' });
    }, []);
    const requestRenameNode = useCallback((nodeId: string) => {
        const node = nodes.find((item) => item.nodeId === nodeId);
        if (!node || node.isRoot) return;
        setDialogError(null);
        setDialog({ kind: 'rename-node', id: nodeId, value: node.text });
    }, [nodes]);
    const requestDeleteSelected = useCallback(() => {
        const sessionIds = [...selectedCardIds];
        const nodeIds = nodes.filter((node) => selectedNodeIds.has(node.nodeId)).map((node) => node.nodeId);
        if (sessionIds.length === 0 && nodeIds.length === 0) return;
        setDialogError(null);
        setDialog({ kind: 'delete-selected', sessionIds, nodeIds });
    }, [nodes, selectedCardIds, selectedNodeIds]);
    const selectTreeNode = useCallback((nodeId: string) => {
        setActiveTreeNodeId(nodeId);
        setCurrent(null);
        setDetailsOpen(false);
        setSelectedTool(null);
        updateAgentSelectionUrl({ nodeId, cardId: null });
    }, []);
    const selectSession = useCallback((sessionId: string) => {
        const session = sessions.find((item) => item.sessionId === sessionId);
        const selectedNodeId = session?.nodeId && nodes.some((node) => node.nodeId === session.nodeId)
            ? session.nodeId
            : rootNodeId;
        if (selectedNodeId) setActiveTreeNodeId(selectedNodeId);
        setDetailsOpen(true);
        setSelectedTool(null);
        if (current !== sessionId) {
            setHistoryLoading(!historyCacheRef.current.has(sessionId));
            setCurrent(sessionId);
        }
        updateAgentSelectionUrl({ ...(selectedNodeId ? { nodeId: selectedNodeId } : {}), cardId: sessionId });
    }, [current, nodes, rootNodeId, sessions]);
    if (guest) return null;
    if (booting) {
        return <div className="eja-app" data-ds-dark-theme={dark || undefined}><div className="eja-boot"><div className="eja-bootCard"><EjunzLogo size={40} className="eja-heroLogo" /><div className="eja-bootSpinner" /><div className="eja-bootHint">正在连接 Ejunz Agent…</div></div></div></div>;
    }

    return (
        <div className="eja-app" data-ds-dark-theme={dark || undefined}>
            <DeepSeekOnboarding rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} />
            {newSessionConfigOpen && <InputConfigDialog
                hosts={hosts}
                selectedHostId={draftHostId}
                onPickHost={setDraftHostId}
                bases={bases}
                selectedBaseId={draftBaseId}
                onPickBase={(baseId) => setDraftBaseId(baseId)}
                nodes={nodes}
                selectedNodeId={draftNodeId}
                onPickNode={setDraftNodeId}
                models={newSessionConfigLoading ? null : composerModels}
                selectModel={(provider, model) => { setDraftModelSelection({ provider, model }); }}
                agentPresetOptions={agentPresetOptions}
                agentPresetChoice={agentPresetChoice}
                onSelectAgentPreset={(id) => { void selectAgentPreset(id); }}
                agentPresetError={agentPresetError}
                input={input}
                setInput={setInput}
                attachments={attachments}
                onAddFiles={addAttachments}
                onRemoveAttachment={removeAttachment}
                modelMenuOpen={modelMenuOpen}
                setModelMenuOpen={setModelMenuOpen}
                notice={loadError}
                onCancel={cancel}
                sending={sending || newSessionConfigLoading}
                loading={newSessionConfigLoading}
                onConfirm={(name) => { void confirmNewSession(name); }}
                onClose={() => { newSessionLoadRef.current += 1; setNewSessionConfigLoading(false); setNewSessionConfigOpen(false); }}
            />}
            <AgentDisplaySettingsDialog
                open={displaySettingsOpen}
                settings={displaySettings}
                saving={displaySettingsSaving}
                onClose={() => setDisplaySettingsOpen(false)}
                onSave={saveDisplaySettings}
            />
            {settingsOpen && <SettingsRoot
                open={settingsOpen}
                onClose={() => { setSettingsOpen(false); setSettingsSection(null); }}
                activeId={settingsSection}
                onSelect={setSettingsSection}
                headerAction={<SettingsDocumentAction rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} />}
                sections={[
                    { id: 'general', label: '通用设置', render: () => <div className="eja-settingsColumn">
                    <AgentPresetRow rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} />
                    <LanguageRow rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} />
                    <GeneralSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} onThemeChange={applyTheme} />
                    <EnterBehaviorRow rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} onBehaviorChange={setBusyEnter} />
                </div> },
                    { id: 'models', label: '模型', render: () => <ModelsSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} /> },
                    { id: 'agent-presets', label: 'Agent 预设', render: () => <AgentPresetSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} onCreatorDraft={startCreatorDraft} /> },
                    { id: 'tools', label: '工具', render: () => <ToolsSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} sessionId={current ?? undefined} refreshKey={currentSession?.agentPreset} /> },
                    { id: 'plugins', label: '插件', render: () => <PluginsSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} /> },
                ]}
            />}
            {dialog && <ActionDialog
                open
                title={dialog.kind === 'rename-session' ? '重命名会话' : dialog.kind === 'create-node' ? '新建节点' : dialog.kind === 'rename-node' ? '重命名节点' : dialog.kind === 'delete-selected' ? '删除所选项目？' : '永久删除会话？'}
                description={dialog.kind === 'delete-selected' ? [
                    dialog.nodeIds.length > 0 ? `删除 ${dialog.nodeIds.length} 个文件夹节点（不会删除工作目录）` : '',
                    dialog.sessionIds.length > 0 ? `永久删除 ${dialog.sessionIds.length} 个会话及其历史消息、工具调用，无法恢复` : '',
                ].filter(Boolean).join('；') + '。' : dialog.kind === 'delete-session' ? `永久删除“${dialog.title}”及其历史消息、工具调用，无法恢复。` : undefined}
                inputLabel={dialog.kind === 'create-node' ? '节点名称' : dialog.kind === 'rename-session' || dialog.kind === 'rename-node' ? '名称' : undefined}
                inputValue={'value' in dialog ? dialog.value : ''}
                inputPlaceholder="请输入名称"
                confirmLabel={dialog.kind === 'create-node' ? '创建' : dialog.kind === 'rename-session' || dialog.kind === 'rename-node' ? '保存' : '删除'}
                danger={dialog.kind === 'delete-selected' || dialog.kind === 'delete-session'}
                busy={dialogBusy}
                error={dialogError}
                onInputChange={(value) => setDialog((previous) => previous && 'value' in previous ? { ...previous, value } : previous)}
                onClose={() => { if (!dialogBusy) setDialog(null); }}
                onConfirm={() => { void submitDialog(); }}
            />}
            <div className="eja-pageShell bd-page">
                <AgentHeader
                    domainId={String(domainId || 'system')}
                    domainName={domainName}
                    title={agentTitle}
                    webSocketStatus={webSocketStatus}
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOpenDisplaySettings={() => setDisplaySettingsOpen(true)}
                    treeOpen={treeOpen}
                    onToggleTree={() => setTreeOpen((open) => !open)}
                    onEditClick={() => {
                        if (sessionTitleSaving) return;
                        if (editMode) {
                            setEditMode(false);
                            setSessionTitleDrafts({});
                            setSelectedCardIds(new Set());
                            setSelectedNodeIds(new Set());
                            return;
                        }
                        startSessionTitleEdit();
                    }}
                    editActive={editMode}
                />
                <div className="eja-pageBody">
                    <main className="eja-mainSurface">
                        <SessionTree
                            sessions={sessions}
                            nodes={nodes}
                            treeOpen={treeOpen}
                            activeNodeId={activeTreeNodeId}
                            onSelectNode={selectTreeNode}
                            onCloseTree={() => setTreeOpen(false)}
                            bases={bases}
                            current={current}
                            pendingQuestionSessionIds={pendingQuestionSessionIds}
                            sessionErrors={sessionErrorMap}
                            sessionActivityPreviews={sessionActivityPreviewMap}
                            modelGroups={modelCatalog?.groups}
                            displaySettings={displaySettings}
                            query={query}
                            searchMatches={searchMatchSet}
                            searchSnippets={searchSnippetMap}
                            searchHasMore={searchHasMore}
                            editMode={editMode}
                            selectedCardIds={selectedCardIds}
                            selectedNodeIds={selectedNodeIds}
                            sessionTitleDrafts={sessionTitleDrafts}
                            onToggleCardSelection={toggleCardSelection}
                            onToggleNodeSelection={toggleNodeSelection}
                            onCreateNode={requestCreateNode}
                            onRenameNode={requestRenameNode}
                            onSessionTitleChange={updateSessionTitleDraft}
                            onSaveSessionTitles={saveSessionTitleEdits}
                            sessionTitleSaving={sessionTitleSaving}
                            onQuery={setQuery}
                            onSelect={selectSession}
                            onStartSession={() => { void prepareNewSession(); }}
                            onDeleteSelected={requestDeleteSelected}
                            onExitEdit={() => { setEditMode(false); setSessionTitleDrafts({}); setSelectedCardIds(new Set()); setSelectedNodeIds(new Set()); }}
                        />
                    </main>
                </div>
                {detailsOpen && (currentSession || creatingSession) && <SessionDrawer
                            loading={creatingSession || historyLoading}
                            loadingLabel={creatingSession ? '正在创建会话…' : historyLoadingLabel}
                            drawerWidth={sessionDrawerWidth}
                            view={view}
                            onViewChange={setView}
                            onResize={(delta) => setSessionDrawerWidth((width) => Math.max(SESSION_DRAWER_MIN, width + delta))}
                            onClose={() => { setDetailsOpen(false); setSelectedTool(null); setCurrent(null); updateAgentSelectionUrl({ cardId: null }); }}
                            overlay={selectedTool && currentSession && <DetailsPanel title={sessionTitle(currentSession)} cwd={currentSession.cwd} agentPreset={currentSession.agentPreset} running={running} models={models} tool={selectedTool} onClose={() => setSelectedTool(null)} />}
                        >
                            {creatingSession || !currentSession
                                ? null
                                : view === 'model' || view === 'context' || view === 'host'
                                ? <SessionSettingsPanel
                                    section={view}
                                    models={models}
                                    onModel={saveSessionModel}
                                    bases={bases}
                                    selectedBaseId={selectedBaseId}
                                    hosts={hosts}
                                    selectedHostId={currentSession.runtimeId ?? fallbackHostId}
                                    onBase={saveBaseSetting}
                                    onHost={switchHost}
                                />
                                : currentSession.blank
                                    ? <div className="eja-sessionEmpty"><span>这个会话还没有消息。</span><button type="button" onClick={() => { void prepareNewSession(); }}>生成新会话</button></div>
                                : <ConversationRoot
                                    blank={false}
                                    title={sessionTitle(currentSession)}
                                    renaming={renaming}
                                    titleEditor={<input className="eja-titleEditor" autoFocus value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false); if (event.key === 'Enter') void renameSession(); }} />}
                                    actions={<AgentPresetLabel preset={currentSession.agentPreset} options={agentPresetOptions} />}
                                    view={view === 'trajectory' ? 'trajectory' : 'chat'}
                                    onViewChange={setView}
                                    hideHeader
                                    chat={<ChatView messages={messages} running={running} runningTurnStartTime={runningTurnStart} historyHasMore={historyHasMore} loadingOlder={loadingOlder} loadedMessages={loadedHistoryMessages} totalMessages={historyTotalMessages} historyPageSize={HISTORY_PAGE_SIZE} onLoadOlder={() => void loadOlder()} onOpenFile={openFile} onOpenDetails={(tool) => { setSelectedTool(tool); }} />}
                                    trajectory={<TrajectoryView messages={messages} history={history} session={currentSession} historyHasMore={historyHasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} />}
                                    composer={<div className="eja-composerLayer">
                                        <InputBar input={input} setInput={setInput} send={send} cancel={cancel} running={running} sending={sending} attachments={attachments} onAddFiles={addAttachments} onRemoveAttachment={removeAttachment} models={composerModels} showModelPicker={false} projections={currentSession.projections?.values} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} selectModel={selectModel} notice={currentSessionError ?? loadError} placeholder="输入消息，Shift+Enter 换行">
                                            <TodoPanel value={currentSession.projections?.values?.todos} />
                                            {pendingQuestion && <QuestionPanel question={pendingQuestion} onAnswer={answerQuestion} />}
                                            {queue.length > 0 && <QueueDock items={queue} running={running} onAction={updateQueue} />}
                                        </InputBar>
                                        {pendingApproval && <div className="eja-approvalOverlay"><ApprovalPanel approval={pendingApproval} onAnswer={answerApproval} /></div>}
                                    </div>}
                                />}
                        </SessionDrawer>}
            </div>
        </div>
    );
}
