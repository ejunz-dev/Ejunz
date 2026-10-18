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
import { AgentSettingsPanel } from './components/structure/AgentSettingsPanel';
import { AgentContextSettingsPanel } from './components/structure/AgentContextSettingsPanel';
import { SessionDrawer } from './components/structure/SessionDrawer';
import { TeamAddonSettingsPanel } from './components/structure/TeamAddonSettingsPanel';
import { TeamContextSettingsPanel } from './components/structure/TeamContextSettingsPanel';
import { TeamPermissionsPanel } from './components/structure/TeamPermissionsPanel';
import { TeamTree } from './components/structure/TeamTree';
import type { HostOption } from './components/structure/HostPicker';
import { ActionDialog } from './components/primitives/ActionDialog';
import type { HierarchySelectOption } from './components/primitives/HierarchySelect';
import { i18n } from '@/i18n';
import { GeneralSection } from './components/settings/GeneralSection';
import { EnterBehaviorRow, LanguageRow } from './components/settings/SettingsRows';
import { PluginsSection } from './components/settings/PluginsSection';
import { AgentAddonsSection } from './components/settings/AgentAddonsSection';
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
import type { AgentAddonView, ChatMessage, PendingApproval, PendingQuestion, QueueItem, SessionModels } from './components/types';
import { domainPrefix, useAgentRpc } from './runtime/rpc';
import { notifyAgentPluginDisabled, registerAgentPluginUiLoader, setEnabledAgentPluginSlots } from './runtime/agent-plugin-slots';
import { useAgentTheme } from './runtime/theme';
import { usePageData } from '../../context/page-data';
import { applyEvent, asObject, assistantStreamKey, eventFailureMessage, eventMessage, eventsToMessages, fileInjectionsAfterUser, flattenToolTree, foldToolTree, latestHistoryError, queueItems, settleRunningMessages } from './runtime/conversation';
import type { HistoryEntry } from './runtime/conversation';
import type { AgentSummary, AgentTeam, AgentTeamAcl, BaseView, HostFrame, MuxFrame, SessionSummary } from './runtime/session';
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
const HISTORY_PREVIEW_CONCURRENCY = 2;
// Sidebar previews are optional; cap tail-history reads so they do not contend with the active session.
const HISTORY_PREVIEW_MAX_SESSIONS = 6;
const ADDON_POLL_MS = 60_000;
const SESSION_DRAWER_DEFAULT = 420;

registerAgentPluginUiLoader('base', () => import('./components/structure/BaseContextPlugin'));
const SESSION_DRAWER_MIN = 320;

function readAgentSelection(): { teamId: string | null; agentId: string | null; sessionId: string | null } {
    if (typeof window === 'undefined') return { teamId: null, agentId: null, sessionId: null };
    const params = new URLSearchParams(window.location.search);
    return { teamId: params.get('teamId'), agentId: params.get('agentId'), sessionId: params.get('sessionId') };
}

function updateAgentSelectionUrl(patch: { teamId?: string | null; agentId?: string | null; sessionId?: string | null }): void {
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
    | { kind: 'delete-selected'; agentIds: string[]; sessionIds: string[]; teamIds: string[] }
    | { kind: 'create-team'; value: string; parentTeamId?: string }
    | { kind: 'rename-team'; id: string; value: string };

interface HistoryCacheEntry {
    history: HistoryEntry[];
    hasMore: boolean;
    totalMessages: number | null;
}

function sessionTitle(session: SessionSummary): string {
    const values = session.projections?.values;
    const title = values && typeof values.title === 'string' ? values.title : '';
    if (title.trim()) return title;
    if (session.blank) return i18n('New session');
    return i18n('Session {0}', session.sessionId.slice(8, 16));
}

function buildTeamParentOptions(teams: readonly AgentTeam[]): HierarchySelectOption[] {
    const byId = new Map(teams.map((team) => [team.teamId, team]));
    const children = new Map<string, AgentTeam[]>();
    const roots: AgentTeam[] = [];
    const sortedTeams = [...teams].sort((left, right) => left.order - right.order || left.text.localeCompare(right.text));
    sortedTeams.forEach((team) => {
        const parentTeamId = team.parentTeamId;
        if (!parentTeamId || parentTeamId === team.teamId || !byId.has(parentTeamId)) {
            roots.push(team);
            return;
        }
        const siblings = children.get(parentTeamId) ?? [];
        siblings.push(team);
        children.set(parentTeamId, siblings);
    });

    const visited = new Set<string>();
    const build = (team: AgentTeam, ancestors: ReadonlySet<string>): HierarchySelectOption => {
        visited.add(team.teamId);
        const path = new Set(ancestors);
        path.add(team.teamId);
        const nested = (children.get(team.teamId) ?? []).filter((child) => !path.has(child.teamId));
        return {
            value: team.teamId,
            label: team.isRootTeam ? i18n('{0} (root team)', team.text) : team.text,
            ...(nested.length === 0 ? {} : { children: nested.map((child) => build(child, path)) }),
        };
    };
    const options = roots.map((team) => build(team, new Set()));
    sortedTeams.forEach((team) => {
        if (!visited.has(team.teamId)) options.push(build(team, new Set()));
    });
    return options;
}

function newSessionId(): string {
    const id = typeof window !== 'undefined' && typeof window.crypto?.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return `session-${id}`;
}

type AgentRpc = (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;

type AgentSettingsPatch = {
    agentPreset?: string;
    runtimeId?: string;
    model?: { provider: string; model: string };
    baseDocId?: string | number | null;
};

function readyFiles(attachments: DraftAttachment[]): UploadedFileMeta[] {
    return attachments.map((attachment) => attachment.meta).filter((meta): meta is UploadedFileMeta => meta !== undefined);
}

function promptParts(text: string, fileCount: number): Array<{ type: 'text'; text: string }> {
    const value = text || (fileCount > 0 ? i18n('Uploaded {0} files', fileCount) : '');
    return value ? [{ type: 'text' as const, text: value }] : [];
}

function optimisticUserMessage(text: string, fileCount: number, sessionId: string): ChatMessage {
    return {
        key: `user-local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: 'user',
        text: text || i18n('Uploaded {0} files', fileCount),
        eventType: 'user/message',
        time: Date.now(),
        sendStatus: 'sending',
        pendingEcho: true,
        pendingSessionId: sessionId,
    };
}

function preservePendingUserMessages(parsed: ChatMessage[], previous: ChatMessage[], sessionId: string): ChatMessage[] {
    const next = parsed.slice();
    previous.filter((message) => message.role === 'user' && message.pendingSessionId === sessionId && message.sendStatus).forEach((message) => {
        const index = next.findIndex((item) => item.role === 'user' && item.text === message.text);
        if (index < 0) next.push(message);
        else next[index] = { ...next[index], key: message.key, sendStatus: message.sendStatus, pendingEcho: message.pendingEcho, pendingSessionId: sessionId };
    });
    return next;
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

function assistantStage(message: ChatMessage): string {
    return message.eventType === 'assistant/chunk' && message.segments?.at(-1)?.kind === 'reasoning' ? i18n('Thinking') : i18n('Agent');
}

function activityPreview(message: ChatMessage, userName = i18n('User')): string {
    if (message.role === 'context') return `${i18n('Context injection')} · ${flatLine(message.text)}`;
    if (message.role === 'addon' && message.addonMount) {
        return `${i18n('Plugin mounted')} · ${message.addonMount.addonId}`;
    }
    if (message.role === 'user') return `${userName} · ${flatLine(message.text)}`;
    if (message.role === 'assistant') return `${assistantStage(message)} · ${latestLine(assistantText(message))}`;
    if (message.role === 'retry') return `${i18n('Thinking')} · ${flatLine(message.text)}`;
    if (message.role === 'compaction') return `${i18n('Context compacted')} · ${flatLine(message.compactionSummary || i18n('Updated'))}`;
    if (message.role === 'system') return `${i18n(message.eventType === 'turn/error' ? 'Error' : 'Agent')} · ${flatLine(message.text)}`;
    const model = toolRowModel(message);
    if (model.errorSummary) return `${i18n('Tool')} · ${model.errorSummary}`;
    if (message.eventType === 'tool/result' && model.output) return `${i18n('Tool')} · ${firstLine(model.output)}`;
    return `${i18n('Tool')} · ${model.title} · ${model.summary}`;
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
    sendStatus?: 'sending' | 'sent' | 'failed';
}

function mergeActivityPreview(previous: Record<string, SessionActivityPreview>, sessionId: string, next: SessionActivityPreview): Record<string, SessionActivityPreview> {
    const prior = previous[sessionId];
    return prior && prior.seq > next.seq && prior.key !== next.key ? previous : { ...previous, [sessionId]: next };
}

function mergeUserActivityPreview(previous: Record<string, SessionActivityPreview>, sessionId: string, key: string, text: string, sendStatus: 'sending' | 'sent' | 'failed', userName: string): Record<string, SessionActivityPreview> {
    const prior = previous[sessionId];
    if (sendStatus !== 'sending' && prior && prior.key !== key) return previous;
    const same = prior?.key === key ? prior : undefined;
    return mergeActivityPreview(previous, sessionId, {
        seq: same ? same.seq : (prior?.seq ?? 0) + 0.5,
        index: same ? same.index : (prior?.index ?? 0) + 1,
        key,
        text: `${userName} · ${flatLine(text)}`,
        content: text,
        sendStatus,
    });
}

function latestActivityPreview(entries: readonly HistoryEntry[], userName = 'User'): SessionActivityPreview | null {
    let latest: SessionActivityPreview | undefined;
    let previewIndex = 0;
    const ordered = [...entries].sort((left, right) => left.event.seq - right.event.seq);
    for (const entry of ordered) {
        if (entry.event.type === 'turn/start') {
            const turn = String(asObject(entry.event.data).turn ?? entry.event.seq);
            const key = `turn-${turn}`;
            previewIndex += 1;
            latest = { seq: entry.event.seq, index: previewIndex, key, text: `${i18n('Thinking')} · ${i18n('Thinking...')}` };
            continue;
        }
        const message = eventMessage(entry.event);
        if (!message?.text) continue;
        const key = activityKey(entry.event, message);
        if (message.role === 'user') {
            previewIndex += 1;
            latest = { seq: entry.event.seq, index: previewIndex, key, text: activityPreview(message, userName), content: message.text, sendStatus: 'sent' };
            continue;
        }
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

function useAgentEvents(onMux: (frame: MuxFrame) => void, onHost: (frame: HostFrame) => void, enabled: boolean, domainId: string, groupId: number | null): AgentWebSocketStatus {
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
            params.set('groupId', groupId === null ? 'unassigned' : String(groupId));
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
    }, [groupId, domainId, enabled, onHost, onMux]);
    return status;
}

export default function AgentPage() {
    const rpc = useAgentRpc();
    const { args: pageArgs } = usePageData();
    const parsedAgentId = Number(pageArgs.groupId);
    const groupId = pageArgs.groupId === null || !Number.isSafeInteger(parsedAgentId) || parsedAgentId <= 0 ? null : parsedAgentId;
    const pageGroup = pageArgs.group && typeof pageArgs.group === 'object' ? pageArgs.group as { title?: unknown } : undefined;
    const agentTitle = typeof pageGroup?.title === 'string' && pageGroup.title.trim() ? pageGroup.title : 'Ejunz agent';
    const pageRootTeamId = typeof pageArgs.rootTeamId === 'string' ? pageArgs.rootTeamId : null;
    const { domainId, domain } = useUiContext();
    const domainName = typeof domain?.name === 'string' && domain.name.trim() ? domain.name : String(domainId || 'system');
    const user = useUserContext();
    const buildUrl = useBuildUrl();
    const guest = !user || user._id == null || user._id === 0 || user._id === '0';
    const activityUserName = typeof user?.uname === 'string' && user.uname.trim()
        ? user.uname.trim()
        : user?._id == null ? 'User' : `#${user._id}`;
    const { dark, applyTheme } = useAgentTheme();
    useEffect(() => {
        if (!guest) return;
        const redirect = `${window.location.pathname}${window.location.search}`;
        window.location.href = buildUrl('user_login', {}, { redirect });
    }, [buildUrl, guest]);
    const [sessions, setSessions] = useState<SessionSummary[]>([]);
    const [agents, setAgents] = useState<AgentSummary[]>([]);
    const [teams, setTeams] = useState<AgentTeam[]>([]);
    const rootTeamId = teams.find((team) => team.isRootTeam)?.teamId ?? pageRootTeamId;
    const [treeOpen, setTreeOpen] = useState(false);
    const [activeTreeTeamId, setActiveTreeTeamId] = useState<string | null>(() => readAgentSelection().teamId ?? pageRootTeamId);
    const [bases, setBases] = useState<BaseView[]>([]);
    const [agentAddons, setAgentAddons] = useState<AgentAddonView[]>([]);
    const [enabledAgentAddonIds, setEnabledAgentAddonIds] = useState<Set<string>>(new Set());
    const [draftBaseId, setDraftBaseId] = useState<number | undefined>();
    const [draftTeamId, setDraftTeamId] = useState<string | undefined>();
    const [draftAgentId, setDraftAgentId] = useState<string | undefined>();
    const [draftModelSelection, setDraftModelSelection] = useState<{ provider: string; model: string } | undefined>();
    const [modelCatalog, setModelCatalog] = useState<{ groups: SessionModels['groups'] } | null>(null);
    const [models, setModels] = useState<SessionModels | null>(null);
    const [modelMenuOpen, setModelMenuOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    const [teamSettingsId, setTeamSettingsId] = useState<string | null>(null);
    const [teamSettingsTab, setTeamSettingsTab] = useState<'context' | 'role' | 'permissions' | 'addons'>('context');
    const [teamContextEditing, setTeamContextEditing] = useState(false);
    const [teamConfigSaving, setTeamConfigSaving] = useState(false);
    const [selectedAgentSettingsId, setSelectedAgentSettingsId] = useState<string | null>(() => readAgentSelection().agentId);
    const [agentSettingsSection, setAgentSettingsSection] = useState<'model' | 'context' | 'host'>('context');
    const [agentContextEditing, setAgentContextEditing] = useState(false);
    const [agentContextSaving, setAgentContextSaving] = useState(false);
    const [selectedTool, setSelectedTool] = useState<ChatMessage | null>(null);
    const [newSessionConfigOpen, setNewSessionConfigOpen] = useState(false);
    const [newAgentTargetRequired, setNewAgentTargetRequired] = useState(false);
    const [quickSessionOnly, setQuickSessionOnly] = useState(false);
    const [newSessionConfigLoading, setNewSessionConfigLoading] = useState(false);
    const [creatingSession, setCreatingSession] = useState(false);
    const newSessionLoadRef = useRef(0);
    const [sessionDrawerWidth, setSessionDrawerWidth] = useState(SESSION_DRAWER_DEFAULT);
    const [renaming, setRenaming] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');
    const [current, setCurrent] = useState<string | null>(() => readAgentSelection().sessionId);
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
    const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(() => new Set());
    const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(() => new Set());
    const [selectedTeamIds, setSelectedTeamIds] = useState<Set<string>>(() => new Set());
    const agentById = useMemo(() => new Map(agents.map((agent) => [agent.agentId, agent])), [agents]);
    const teamParentTree = useMemo(() => buildTeamParentOptions(teams), [teams]);
    const selectedAgentSettings = selectedAgentSettingsId ? agentById.get(selectedAgentSettingsId) : undefined;
    const openAgentSettings = useCallback((agentId: string) => {
        const agent = agentById.get(agentId);
        if (!agent) return;
        setSelectedAgentSettingsId(agentId);
        setActiveTreeTeamId(agent.teamId);
        updateAgentSelectionUrl({ teamId: agent.teamId, agentId, sessionId: null });
        setAgentSettingsSection('context');
        setAgentContextEditing(false);
        setTeamSettingsId(null);
        setCurrent(null);
        currentRef.current = null;
        setDetailsOpen(false);
        setSelectedTool(null);
        setMessages([]);
        setHistory([]);
        setQueue([]);
        updateAgentSelectionUrl({ teamId: agent.teamId, agentId, sessionId: null });
    }, [agentById]);
    const sessionsWithAgentSettings = useMemo(() => sessions.map((session) => {
        const settings = session.agentId ? agentById.get(session.agentId)?.settings : undefined;
        return settings ? { ...session, agentSettings: settings } : session;
    }), [agentById, sessions]);
    const currentRef = useRef<string | null>(null);
    const activityUserNameRef = useRef(activityUserName);
    const sessionsRef = useRef(sessions);
    const hostsRef = useRef(hosts);
    const modelsCacheRef = useRef(new Map<string, SessionModels>());
    const displaySettingsRequestRef = useRef(0);
    sessionsRef.current = sessionsWithAgentSettings;
    hostsRef.current = hosts;
    activityUserNameRef.current = activityUserName;

    useEffect(() => { currentRef.current = current; }, [current]);

    const loadSessions = useCallback(async () => {
        try {
            const value = await rpc('session.list', {}) as { items?: SessionSummary[] };
            const next = Array.isArray(value.items) ? value.items : [];
            const serverIds = new Set(next.map((session) => session.sessionId));
            setSessions((previous) => {
                const currentSession = previous.find((session) => session.sessionId === currentRef.current);
                const keptCurrent = currentSession && !serverIds.has(currentSession.sessionId) ? [currentSession] : [];
                const merged = next.map((session) => {
                    const existing = previous.find((item) => item.sessionId === session.sessionId);
                    if (!existing) return session;
                    const previousValues = existing.projections?.values ?? {};
                    const serverValues = session.projections?.values ?? {};
                    const previousTitle = previousValues.title;
                    const serverTitle = serverValues.title;
                    const title = typeof serverTitle === 'string' && serverTitle.trim()
                        ? serverTitle
                        : typeof previousTitle === 'string' && previousTitle.trim() ? previousTitle : undefined;
                    return {
                        ...existing,
                        ...session,
                        ...(existing.blank === false ? { blank: false } : {}),
                        ...(title === undefined ? {} : { projections: { values: { ...previousValues, ...serverValues, title } } }),
                    };
                });
                return [...keptCurrent, ...merged];
            });
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const loadTeams = useCallback(async () => {
        try {
            const value = await rpc('team.list', {}) as { items?: AgentTeam[] };
            setTeams(Array.isArray(value.items) ? value.items : []);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const loadAgents = useCallback(async () => {
        try {
            const value = await rpc('agent.list', {}) as { items?: AgentSummary[] };
            setAgents(Array.isArray(value.items) ? value.items : []);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [rpc]);

    const saveTeamConfig = useCallback(async (teamId: string, patch: Record<string, unknown>) => {
        setTeamConfigSaving(true);
        try {
            await rpc('team.config.save', { teamId: teamId, patch });
            await Promise.all([loadTeams(), loadSessions()]);
        } finally {
            setTeamConfigSaving(false);
        }
    }, [loadTeams, loadSessions, rpc]);

    const saveAgentSettings = useCallback(async (agentId: string, patch: AgentSettingsPatch) => {
        const agent = agentById.get(agentId);
        if (!agent) throw new Error(i18n('Agent not found'));
        const settings = { ...agent.settings };
        if (patch.runtimeId !== undefined) settings.runtimeId = patch.runtimeId;
        if (patch.model !== undefined) settings.model = patch.model;
        if (Object.prototype.hasOwnProperty.call(patch, 'baseDocId')) {
            if (patch.baseDocId == null) delete settings.baseDocId;
            else settings.baseDocId = String(patch.baseDocId);
        }
        if (patch.agentPreset !== undefined) settings.agentPreset = patch.agentPreset;
        await rpc('agent.update', { agentId, settings });
        setAgents((items) => items.map((item) => item.agentId === agentId
            ? { ...item, settings, updatedAt: new Date().toISOString() }
            : item));
        void loadSessions();
    }, [agentById, loadSessions, rpc]);

    const saveAgentContext = useCallback(async (agentId: string, context: string) => {
        const agent = agentById.get(agentId);
        if (!agent) throw new Error(i18n('Agent not found'));
        setAgentContextSaving(true);
        try {
            await rpc('agent.config.save', { agentId, patch: { context } });
            setAgents((items) => items.map((item) => item.agentId === agentId
                ? { ...item, config: { ...(item.config ?? {}), context }, updatedAt: new Date().toISOString() }
                : item));
            await loadAgents();
        } finally {
            setAgentContextSaving(false);
        }
    }, [agentById, loadAgents, rpc]);

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

    const loadAgentAddons = useCallback(async () => {
        try {
            const value = await rpc('agent.addons.list', {}) as { addons?: AgentAddonView[] };
            const addons = value.addons ?? [];
            const enabled = new Set(addons.filter((addon) => addon.enabled).map((addon) => addon.addonId));
            setAgentAddons(addons);
            setEnabledAgentAddonIds(enabled);
            void setEnabledAgentPluginSlots(enabled);
        } catch {
            const disabled = new Set<string>();
            setAgentAddons([]);
            setEnabledAgentAddonIds(disabled);
            void setEnabledAgentPluginSlots(disabled);
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
    const historyReadySessionRef = useRef<string | null>(null);
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
                const preview = latestActivityPreview(entries, activityUserName);
                if (preview) setSessionActivityPreviews((previous) => mergeActivityPreview(previous, sessionId, preview));
                const historyError = latestHistoryError(entries);
                if (historyError !== null) setSessionErrors((previous) => previous[sessionId] === historyError ? previous : { ...previous, [sessionId]: historyError });
            } finally {
                releaseHistoryPreview();
            }
        })().catch(() => {
            // Agent previews are optional; the selected agent loads its own history and reports errors.
        });
        historyPreviewRef.current.set(sessionId, promise);
        void promise.finally(() => {
            if (historyPreviewRef.current.get(sessionId) === promise) historyPreviewRef.current.delete(sessionId);
        });
        return promise;
    }, [acquireHistoryPreview, activityUserName, current, releaseHistoryPreview, rpc]);
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
                const preview = latestActivityPreview(entries, activityUserName);
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
    }, [activityUserName, rpc]);

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
            const preview = latestActivityPreview(nextHistory, activityUserName);
            if (preview) setSessionActivityPreviews((previous) => mergeActivityPreview(previous, sessionId, preview));
            setMessages((previous) => preservePendingUserMessages(parsed, previous, sessionId));
            historyFirstSeq.current = firstHistorySeq(nextHistory);
            setHistoryHasMore(hasMore);
            if (projections) setSessions((prev) => prev.map((session) => session.sessionId === sessionId ? { ...session, projections } : session));
            setLoadError(null);
        } catch (error) {
            if (!isCurrentLoad()) return;
            setMessages([]);
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            if (isCurrentLoad()) {
                historyReadySessionRef.current = sessionId;
                setHistoryLoading(false);
            }
        }
    }, [activityUserName, rpc]);

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
            if (activityMessage?.text) {
                const streamKey = activityKey(event, activityMessage);
                setSessionActivityPreviews((previous) => {
                    const prior = previous[frame.sessionId!];
                    const confirmedPendingUser = activityMessage.role === 'user'
                        && prior?.sendStatus !== undefined
                        && prior.content === activityMessage.text;
                    const index = confirmedPendingUser && prior ? prior.index : prior?.key === streamKey ? prior.index : (prior?.index ?? 0) + 1;
                    const next = activityMessage.role === 'user'
                        ? {
                            seq: event.seq,
                            index,
                            key: confirmedPendingUser && prior ? prior.key : streamKey,
                            text: activityPreview(activityMessage, activityUserNameRef.current),
                            content: activityMessage.text,
                            sendStatus: 'sent' as const,
                        }
                        : event.type === 'assistant/chunk' && prior?.key === streamKey
                            ? appendAssistantActivity(prior, activityMessage, streamKey, event.seq)
                            : activityMessage.role === 'assistant'
                                ? assistantActivity(activityMessage, streamKey, event.seq, index)
                                : { seq: event.seq, index, key: streamKey, text: activityPreview(activityMessage, activityUserNameRef.current) };
                    if (prior?.key === next.key && prior.text === next.text && prior.sendStatus === next.sendStatus) return previous;
                    return mergeActivityPreview(previous, frame.sessionId!, next);
                });
            } else if (event.type === 'turn/start') {
                const turn = String(asObject(event.data).turn ?? event.seq);
                setSessionActivityPreviews((previous) => {
                    const prior = previous[frame.sessionId!];
                    const next = { seq: event.seq, index: prior?.key === `turn-${turn}` ? prior.index : (prior?.index ?? 0) + 1, key: `turn-${turn}`, text: `${i18n('Thinking')} · ${i18n('Thinking...')}` };
                    return prior?.key === next.key && prior.text === next.text
                        ? previous
                        : mergeActivityPreview(previous, frame.sessionId!, next);
                });
            }
            const eventError = eventFailureMessage(event);
            if (eventError !== null) setSessionErrors((previous) => previous[frame.sessionId!] === eventError ? previous : { ...previous, [frame.sessionId!]: eventError });
            const session = sessionsRef.current.find((item) => item.sessionId === frame.sessionId);
            const runtimeId = session?.activeRuntimeId ?? session?.agentSettings?.runtimeId;
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
            const message = frame.message?.trim() || i18n('This turn failed');
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
                updateAgentSelectionUrl({ sessionId: null });
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
                    blank: next[index].blank === false ? false : frame.blank === true,
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
            (async () => { await loadSessions(); await loadAgents(); })(),
            loadTeams(),
            loadHosts(),
            loadBases(),
            loadAgentAddons(),
            loadDisplaySettings(),
            loadAgentPresets(),
            loadModelCatalog(),
        ]).finally(() => setBooting(false));
    }, [guest, loadAgentAddons, loadAgentPresets, loadAgents, loadBases, loadDisplaySettings, loadHosts, loadModelCatalog, loadTeams, loadSessions]);
    useEffect(() => {
        if (guest) return undefined;
        const timer = window.setInterval(() => { void Promise.all([loadSessions(), loadAgents()]); void loadTeams(); void loadHosts(); void loadBases(); }, POLL_MS);
        return () => window.clearInterval(timer);
    }, [guest, loadAgents, loadBases, loadHosts, loadTeams, loadSessions]);
    useEffect(() => {
        if (guest) return undefined;
        const timer = window.setInterval(() => { void loadAgentAddons(); }, ADDON_POLL_MS);
        return () => window.clearInterval(timer);
    }, [guest, loadAgentAddons]);
    useEffect(() => {
        if (booting) return;
        const selectedSession = current ? sessions.find((session) => session.sessionId === current) : undefined;
        const agentId = selectedSession?.agentId ?? selectedAgentSettingsId;
        const selectedAgent = agentId ? agentById.get(agentId) : undefined;
        const sessionTeamId = selectedSession?.teamId && teams.some((team) => team.teamId === selectedSession.teamId)
            ? selectedSession.teamId
            : selectedAgent?.teamId ?? rootTeamId;
        const selectedTeamId = sessionTeamId
            ?? (activeTreeTeamId && teams.some((team) => team.teamId === activeTreeTeamId) ? activeTreeTeamId : null);
        if (current && !selectedSession) {
            setCurrent(null);
            setDetailsOpen(false);
        }
        if (selectedTeamId !== activeTreeTeamId) setActiveTreeTeamId(selectedTeamId);
        const sessionId = selectedSession?.sessionId ?? null;
        const urlSelection = readAgentSelection();
        if (urlSelection.teamId !== selectedTeamId || urlSelection.agentId !== agentId || urlSelection.sessionId !== sessionId) {
            updateAgentSelectionUrl({ teamId: selectedTeamId, agentId, sessionId });
        }
    }, [activeTreeTeamId, agentById, booting, current, selectedAgentSettingsId, teams, rootTeamId, sessions]);
    useEffect(() => {
        const currentSessionRunning = sessions.find((session) => session.sessionId === current)?.running === true;
        if (booting || guest || !current || currentSessionRunning || sending || historyLoading || historyReadySessionRef.current !== current) return;
        let requested = 0;
        for (const session of sessions) {
            if (session.blank || session.sessionId === current) continue;
            void preloadHistoryPreview(session.sessionId);
            requested += 1;
            if (requested >= HISTORY_PREVIEW_MAX_SESSIONS) break;
        }
    }, [booting, current, guest, historyLoading, preloadHistoryPreview, sending, sessions]);
    useEffect(() => {
        if (booting) return;
        historyReadySessionRef.current = null;
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
        if (sessionsRef.current.find((session) => session.sessionId === current)?.started === false) {
            historyReadySessionRef.current = current;
            setMessages([]);
            setHistoryLoading(false);
            return;
        }
        void loadModels(current);
        const cached = historyCacheRef.current.get(current);
        if (!cached) {
            setHistoryLoading(true);
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
        setHistoryLoading(true);
        void loadInitialHistory(current);
    }, [booting, current, loadHistoryTotal, loadInitialHistory, loadModels]);
    useEffect(() => {
        setPendingQuestion(current ? pendingQuestions[current] ?? null : null);
    }, [current, pendingQuestions]);
    const webSocketStatus = useAgentEvents(onMux, onHost, !booting && !guest, String(domainId || 'system'), groupId);
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
    const sessionActivityPreviewMap = useMemo(() => new Map(Object.entries(sessionActivityPreviews).map(([sessionId, preview]) => [sessionId, { index: preview.index, text: preview.text, sendStatus: preview.sendStatus }])), [sessionActivityPreviews]);
    const currentSession = useMemo(() => {
        const found = sessionsWithAgentSettings.find((session) => session.sessionId === current);
        if (found) return found;
        if (!current) return null;
        const now = Date.now();
        return { sessionId: current, createdAt: now, updatedAt: now, running: false, blank: true };
    }, [sessionsWithAgentSettings, current]);
    const teamSettingsTeam = teamSettingsId ? teams.find((team) => team.teamId === teamSettingsId) : undefined;
    const selectedAgentModels = useMemo(() => modelCatalog ? {
        current: selectedAgentSettings?.settings.model ?? { provider: '', model: '' },
        routable: selectedAgentSettings?.settings.model !== undefined,
        groups: modelCatalog.groups,
    } : null, [modelCatalog, selectedAgentSettings]);
    const loadedHistoryMessages = useMemo(() => history.filter((entry) => entry.event.type === 'user/message' || entry.event.type === 'assistant/message').length, [history]);
    const historyLoadingRangeEnd = historyTotalMessages === null ? null : Math.max(0, historyTotalMessages - historyProgress);
    const historyLoadingLabel = historyLoadingRangeEnd === null
        ? i18n('Loading...')
        : i18n('Loading... {0}-{1}', Math.max(0, historyLoadingRangeEnd - HISTORY_INITIAL_MESSAGES), historyLoadingRangeEnd);
    const selectedBaseId = current
        ? (currentSession?.agentSettings?.baseDocId === undefined ? undefined : Number(currentSession.agentSettings.baseDocId))
        : draftBaseId;
    const running = currentSession?.running === true;
    const fallbackHostId = hosts.find((host) => host.fallback === true)?.runtimeId ?? '';
    const currentSessionError = current ? sessionErrors[current] : undefined;
    const pendingSendVisible = current !== null && messages.some((message) => message.role === 'user' && message.pendingSessionId === current && message.sendStatus !== undefined);
    const runningTurnStart = useMemo(() => runningTurnStartTime(history), [history]);
    const isUnstartedCurrent = currentSession?.started === false;
    const previousStartedRef = useRef<boolean | undefined>(undefined);
    useEffect(() => {
        const started = currentSession?.started !== false;
        const previous = previousStartedRef.current;
        previousStartedRef.current = started;
        if (previous === false && started && current) void loadModels(current);
    }, [current, currentSession?.started, loadModels]);
    const composerModels = current && !isUnstartedCurrent
        ? models
        : (modelCatalog ? {
            current: currentSession?.agentSettings?.model ?? draftModelSelection ?? { provider: '', model: '' },
            routable: currentSession?.agentSettings?.model !== undefined || draftModelSelection !== undefined,
            groups: modelCatalog.groups,
        } : null);
    const createAgentRecord = useCallback(async (
        title: string,
        teamId: string | undefined,
        settings: AgentSummary['settings'],
    ) => {
        if (!teamId) throw new Error(i18n('Please choose a team first.'));
        const value = await rpc('agent.create', { teamId, title: title.trim() || i18n('New agent'), settings }) as { agent?: AgentSummary };
        if (!value.agent?.agentId) throw new Error(i18n('Agent creation failed'));
        return value.agent;
    }, [rpc]);

    const startSession = useCallback(async (firstMessage: string, presetOverride: string | undefined, baseId: number | undefined, titleOverride: string, modelOverride: { provider: string; model: string } | undefined, existingSession?: SessionSummary, agentIdOverride?: string) => {
        let sessionPublished = false;
        let createdAgentId: string | undefined;
        const requestedSessionId = existingSession?.sessionId ?? newSessionId();
        let optimisticKey: string | undefined;
        let optimisticMessage: ChatMessage | undefined;
        setCreatingSession(!existingSession);
        setNewSessionConfigOpen(false);
        if (!existingSession) setDetailsOpen(true);
        try {
            const selectedAgentId = existingSession?.agentId ?? agentIdOverride ?? draftAgentId;
            const selectedAgent = selectedAgentId ? agentById.get(selectedAgentId) : undefined;
            const existingSettings = existingSession?.agentSettings ?? selectedAgent?.settings;
            const selectedBaseId = baseId ?? (existingSettings?.baseDocId ? Number(existingSettings.baseDocId) : draftBaseId);
            const selectedTeamId = existingSession?.teamId ?? selectedAgent?.teamId ?? draftTeamId;
            const selectedModel = modelOverride ?? existingSettings?.model ?? draftModelSelection;
            const title = titleOverride?.trim();
            const sessionTitle = existingSession || agentIdOverride || draftAgentId ? title : undefined;
            const text = firstMessage.trim();
            const files = readyFiles(attachments);
            const hasContent = Boolean(text || files.length);
            if (hasContent) {
                const optimistic = optimisticUserMessage(text, files.length, requestedSessionId);
                optimisticKey = optimistic.key;
                optimisticMessage = optimistic;
                setMessages((items) => [...items, optimistic]);
                setSessionActivityPreviews((previous) => mergeUserActivityPreview(previous, requestedSessionId, optimistic.key, optimistic.text, 'sending', activityUserName));
                setSending(true);
                setInput('');
            }
            const selectedHostId = draftHostId !== '' ? draftHostId : existingSettings?.runtimeId ?? '';
            const requestedPreset = presetOverride || agentPresetChoice || existingSettings?.agentPreset;
            const settings: AgentSummary['settings'] = {
                ...(existingSettings ?? {}),
                ...(selectedHostId === '' ? {} : { runtimeId: selectedHostId }),
                ...(selectedBaseId === undefined ? {} : { baseDocId: String(selectedBaseId) }),
                ...(requestedPreset ? { agentPreset: requestedPreset } : {}),
                ...(selectedModel === undefined ? {} : { model: selectedModel }),
            };
            let agentId = existingSession?.agentId ?? agentIdOverride ?? draftAgentId;
            if (!agentId) {
                const createdAgent = await createAgentRecord(title, selectedTeamId ?? rootTeamId ?? undefined, settings);
                agentId = createdAgent.agentId;
                createdAgentId = agentId;
                setAgents((items) => [createdAgent, ...items.filter((item) => item.agentId !== createdAgent.agentId)]);
            } else if (selectedAgent && JSON.stringify(settings) !== JSON.stringify(existingSettings)) {
                await saveAgentSettings(agentId, settings);
            }
            const value = await rpc('session.create', { sessionId: requestedSessionId, agentId, ...(sessionTitle ? { title: sessionTitle } : {}) }) as {
                sessionId?: string; agentId?: string; activeRuntimeId?: string; teamId?: string; title?: string;
            };
            if (value.sessionId !== requestedSessionId) throw new Error(i18n('Session creation failed'));
            if (optimisticKey) setMessages((items) => items.map((message) => message.key === optimisticKey ? { ...message, pendingSessionId: value.sessionId } : message));
            const actualHostId = value.activeRuntimeId ?? selectedHostId;
            const actualTeamId = value.teamId ?? selectedTeamId;
            const createdAt = Date.now();
            const session: SessionSummary = {
                sessionId: value.sessionId,
                createdAt,
                updatedAt: createdAt,
                running: false,
                blank: !hasContent,
                started: true,
                groupId: groupId ?? undefined,
                agentId,
                ...(actualHostId === '' ? {} : { activeRuntimeId: actualHostId }),
                ...(actualTeamId === undefined ? {} : { teamId: actualTeamId }),
                agentSettings: settings,
                projections: { values: { title: value.title || sessionTitle || i18n('Session {0}', 1) } },
            };
            setSessions((items) => [session, ...items.filter((item) => item.sessionId !== session.sessionId)]);
            setDraftBaseId(undefined);
            setDraftTeamId(undefined);
            setDraftAgentId(undefined);
            setDraftHostId('');
            setDraftModelSelection(undefined);
            setActiveTreeTeamId(actualTeamId ?? null);
            currentRef.current = value.sessionId;
            setCurrent(value.sessionId);
            updateAgentSelectionUrl({ teamId: actualTeamId ?? null, agentId, sessionId: value.sessionId });
            sessionPublished = true;
            setCreatingSession(false);

            setCreatingSession(false);
            setNewSessionConfigOpen(false);
            if (!existingSession) setDetailsOpen(true);
            if (!hasContent) setMessages([]);
            if (hasContent) {
                setSessions((items) => items.map((session) => session.sessionId === value.sessionId ? { ...session, blank: false, updatedAt: Date.now() } : session));
                await injectDraftFiles(rpc, String(value.sessionId), files);
                await rpc('session.prompt', {
                    sessionId: value.sessionId,
                    mode: 'queue',
                    content: promptParts(text, files.length),
                    clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
                if (optimisticKey) setMessages((items) => items.map((message) => message.key === optimisticKey ? { ...message, sendStatus: 'sent' } : message));
                if (optimisticMessage) setSessionActivityPreviews((previous) => mergeUserActivityPreview(previous, requestedSessionId, optimisticMessage!.key, optimisticMessage!.text, 'sent', activityUserName));
                clearAttachments();
            }
            void Promise.all([loadSessions(), loadAgents()]);
            setLoadError(null);
        } catch (error) {
            setCreatingSession(false);
            if (createdAgentId && !sessionPublished) {
                try {
                    await rpc('agent.delete', { agentId: createdAgentId });
                    setAgents((items) => items.filter((agent) => agent.agentId !== createdAgentId));
                } catch { /* A session may have been committed before the request failed. */ }
            }
            if (optimisticKey) {
                setMessages((items) => items.filter((message) => message.key !== optimisticKey || !message.pendingEcho));
                setInput(firstMessage.trim());
            }
            if (optimisticMessage) setSessionActivityPreviews((previous) => mergeUserActivityPreview(previous, requestedSessionId, optimisticMessage!.key, optimisticMessage!.text, 'failed', activityUserName));
            if (!sessionPublished) {
                setDetailsOpen(Boolean(existingSession));
                setNewSessionConfigOpen(!existingSession);
            }
            const message = error instanceof Error ? error.message : String(error);
            setLoadError(message);
        } finally {
            setCreatingSession(false);
            setSending(false);
        }
    }, [activityUserName, agents, createAgentRecord, draftAgentId, groupId, agentPresetChoice, attachments, clearAttachments, draftBaseId, draftModelSelection, draftTeamId, loadSessions, rootTeamId, rpc, saveAgentSettings]);

    const updateAgentForSession = useCallback(async (sessionId: string, patch: AgentSettingsPatch) => {
        const session = sessionsWithAgentSettings.find((item) => item.sessionId === sessionId);
        if (!session?.agentId) throw new Error(i18n('This session is not linked to an Agent'));
        await saveAgentSettings(session.agentId, patch);
    }, [saveAgentSettings, sessionsWithAgentSettings]);

    const selectedDraftModel = draftModelSelection ?? (composerModels?.current?.provider && composerModels.current.model
        ? { provider: composerModels.current.provider, model: composerModels.current.model }
        : undefined);

    const confirmNewSession = useCallback(async (title: string) => {
        await startSession(input, agentPresetChoice, draftBaseId, title, selectedDraftModel, undefined, draftAgentId);
    }, [agentPresetChoice, draftAgentId, draftBaseId, input, selectedDraftModel, startSession]);

    const selectDraftTeam = useCallback((teamId: string | undefined) => {
        setDraftTeamId(teamId);
        setDraftAgentId(undefined);
    }, []);

    const selectDraftAgent = useCallback((agentId: string | undefined) => {
        setDraftAgentId(agentId);
        const agent = agentId ? agentById.get(agentId) : undefined;
        if (!agent) return;
        setDraftTeamId(agent.teamId);
        setDraftBaseId(agent.settings.baseDocId ? Number(agent.settings.baseDocId) : undefined);
        setDraftModelSelection(agent.settings.model);
        setDraftHostId(agent.settings.runtimeId ?? '');
        setAgentPresetChoice(agent.settings.agentPreset ?? '');
    }, [agentById]);

    const createSessionOnly = useCallback(async (title: string) => {
        setNewSessionConfigLoading(true);
        try {
            if (draftAgentId) {
                await startSession('', agentPresetChoice, draftBaseId, title, selectedDraftModel, undefined, draftAgentId);
                return;
            }
            const teamId = draftTeamId ?? rootTeamId ?? undefined;
            const agent = await createAgentRecord(title, teamId, {
                ...(draftHostId === '' ? {} : { runtimeId: draftHostId }),
                ...(draftBaseId === undefined ? {} : { baseDocId: String(draftBaseId) }),
                ...(agentPresetChoice === '' ? {} : { agentPreset: agentPresetChoice }),
                ...(selectedDraftModel === undefined ? {} : { model: selectedDraftModel }),
            });
            setAgents((items) => [agent, ...items.filter((item) => item.agentId !== agent.agentId)]);
            setNewSessionConfigOpen(false);
            setSelectedAgentSettingsId(agent.agentId);
            setAgentSettingsSection('context');
            setAgentContextEditing(false);
            setActiveTreeTeamId(agent.teamId);
            await Promise.all([loadAgents(), loadTeams()]);
            await Notification.success(i18n('Agent created successfully'));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLoadError(message);
            void Notification.error(message);
        } finally {
            setNewSessionConfigLoading(false);
        }
    }, [agentPresetChoice, createAgentRecord, draftAgentId, draftBaseId, draftHostId, draftTeamId, loadAgents, loadTeams, rootTeamId, selectedDraftModel, startSession]);

    const prepareNewSession = useCallback(async (baseId?: number, agentId?: string, requireTeamTarget = agentId === undefined, quickOnly = false) => {
        const loadId = ++newSessionLoadRef.current;
        setCurrent(null);
        setDetailsOpen(false);
        setSelectedTool(null);
        setSelectedAgentSettingsId(null);
        const selectedAgent = agentId ? agentById.get(agentId) : undefined;
        const selectedTeamId = selectedAgent?.teamId ?? (teams.some((team) => team.teamId === activeTreeTeamId) ? activeTreeTeamId : rootTeamId);
        setActiveTreeTeamId(selectedTeamId);
        updateAgentSelectionUrl({ teamId: selectedTeamId, agentId: agentId ?? null, sessionId: null });
        setNewSessionConfigOpen(true);
        setNewAgentTargetRequired(requireTeamTarget);
        setQuickSessionOnly(quickOnly);
        setNewSessionConfigLoading(!quickOnly);
        setModelCatalog(null);
        setInput('');
        clearAttachments();
        setDraftAgentId(agentId);
        setDraftBaseId(baseId ?? (selectedAgent?.settings.baseDocId ? Number(selectedAgent.settings.baseDocId) : undefined));
        setDraftTeamId(requireTeamTarget ? undefined : selectedTeamId ?? undefined);
        setDraftModelSelection(selectedAgent?.settings.model);
        setAgentPresetChoice(selectedAgent?.settings.agentPreset ?? '');
        // Keep the Agent's host default, falling back to an online host.
        setDraftHostId(selectedAgent
            ? selectedAgent.settings.runtimeId ?? ''
            : fallbackHostId !== '' ? fallbackHostId : hosts.find((host) => host.online !== false)?.runtimeId ?? '');
        if (!quickOnly) await loadModelCatalog();
        if (newSessionLoadRef.current === loadId) setNewSessionConfigLoading(false);
    }, [activeTreeTeamId, agentById, fallbackHostId, hosts, loadModelCatalog, teams, rootTeamId]);

    /**
     * Move the open session to another host.
     *
     * The session moves on this server's record, so the next message reaches the
     * chosen host; the page states the choice before that message, and a refusal
     * leaves the session where it was.
     */
    const switchHost = useCallback(async (runtimeId: string) => {
        if (!current) return;
        const sessionId = current;
        try {
            if (sessionsRef.current.find((session) => session.sessionId === sessionId)?.started === false) {
                await updateAgentForSession(sessionId, { runtimeId });
                await Notification.success(i18n('Host saved'));
                return;
            }
            const value = await rpc('session.setHost', { sessionId, runtimeId }) as { runtimeId?: string };
            setSessions((items) => items.map((session) => session.sessionId === sessionId ? { ...session, activeRuntimeId: value.runtimeId ?? runtimeId } : session));
            void loadAgents();
            setSessionErrors((previous) => {
                if (previous[sessionId] === undefined) return previous;
                const next = { ...previous };
                delete next[sessionId];
                return next;
            });
            await Notification.success(i18n('Host switched. It will handle the next message.'));
        } catch (error) {
            setSessionErrors((previous) => ({ ...previous, [sessionId]: error instanceof Error ? error.message : String(error) }));
            throw error;
        }
    }, [current, loadAgents, rpc, updateAgentForSession]);

    const saveBaseSetting = useCallback(async (baseId: number | undefined) => {
        if (!current) {
            setDraftBaseId(baseId);
            await Notification.success(i18n('Context saved'));
            return;
        }
        if (currentSession?.started === false) {
            await updateAgentForSession(current, { baseDocId: baseId ?? null });
            await Notification.success(i18n('Context saved'));
            return;
        }
        await rpc('session.context.save', { sessionId: current, baseDocId: baseId ?? null });
        setDraftBaseId(undefined);
        void Promise.all([loadSessions(), loadAgents()]);
        await Notification.success(i18n('Context saved'));
    }, [current, currentSession?.started, loadSessions, rpc, updateAgentForSession]);

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
            await Notification.success(i18n('Display settings saved'));
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
        if (currentSession?.started === false) {
            try {
                await updateAgentForSession(current, { agentPreset: id });
            } catch (caught) {
                setAgentPresetError(caught instanceof Error ? caught.message : String(caught));
            }
            return;
        }
        try {
            const value = await rpc('agentPreset.select', { sessionId: current, agentPreset: id }) as { agentPreset?: string };
            const applied = value.agentPreset ?? id;
            await updateAgentForSession(current, { agentPreset: applied });
            setAgentPresetChoice(applied);
        } catch (caught) {
            setAgentPresetError(caught instanceof Error ? caught.message : String(caught));
        }
    }, [current, currentSession?.blank, currentSession?.started, rpc, updateAgentForSession]);

    const send = useCallback(async (mode: 'queue' | 'steer' = 'queue') => {
        const text = input.trim();
        const effective = !running ? 'queue' : mode === 'steer' ? 'steer' : busyEnter;
        const files = readyFiles(attachments);
        if (attachments.some((attachment) => attachment.meta === undefined && attachment.error === undefined)) {
            setLoadError(i18n('File upload is still in progress. Please wait.'));
            return;
        }
        if ((!text && !files.length) || !current || sending) return;
        const selectedSession = sessionsRef.current.find((session) => session.sessionId === current);
        if (selectedSession?.started === false) {
            await startSession(
                text,
                selectedSession.agentSettings?.agentPreset,
                selectedSession.agentSettings?.baseDocId === undefined ? undefined : Number(selectedSession.agentSettings.baseDocId),
                sessionTitle(selectedSession),
                selectedSession.agentSettings?.model,
                selectedSession,
            );
            return;
        }
        setSessionErrors((previous) => {
            if (previous[current] === undefined) return previous;
            const next = { ...previous };
            delete next[current];
            return next;
        });
        setSending(true);
        setInput('');
        if (selectedSession?.blank) {
            setSessions((items) => items.map((session) => session.sessionId === current ? { ...session, blank: false, updatedAt: Date.now() } : session));
        }
        const optimistic = optimisticUserMessage(text, files.length, current);
        setMessages((items) => [...items, optimistic]);
        setSessionActivityPreviews((previous) => mergeUserActivityPreview(previous, current, optimistic.key, optimistic.text, 'sending', activityUserName));
        try {
            const sessionId = current;
            await injectDraftFiles(rpc, sessionId, files);
            await rpc('session.prompt', {
                sessionId,
                mode: effective,
                content: promptParts(text, files.length),
                clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
            setMessages((items) => items.map((message) => message.key === optimistic.key ? { ...message, sendStatus: 'sent' } : message));
            setSessionActivityPreviews((previous) => mergeUserActivityPreview(previous, sessionId, optimistic.key, optimistic.text, 'sent', activityUserName));
            clearAttachments();
            setSessions((items) => items.map((session) => session.sessionId === sessionId ? { ...session, blank: false, updatedAt: Date.now() } : session));
            setLoadError(null);
        } catch (error) {
            setMessages((items) => items.filter((message) => message.key !== optimistic.key || !message.pendingEcho));
            setSessionActivityPreviews((previous) => mergeUserActivityPreview(previous, current, optimistic.key, optimistic.text, 'failed', activityUserName));
            setInput(text);
            const message = error instanceof Error ? error.message : String(error);
            setLoadError(message);
            void Notification.error(message);
        } finally {
            setSending(false);
        }
    }, [activityUserName, attachments, busyEnter, clearAttachments, current, input, rpc, running, sending, startSession]);

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
            body: JSON.stringify({ type: 'client-response', rpcId, result: { ok: true, value }, groupId: groupId }),
        });
        if (response.redirected) {
            window.location.href = response.url;
            throw new Error(i18n('Redirecting to sign in'));
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
        if (sessionsRef.current.find((session) => session.sessionId === sessionId)?.started === false) {
            try {
                await updateAgentForSession(sessionId, { model: { provider, model } });
                setModelMenuOpen(false);
            } catch (error) {
                setLoadError(error instanceof Error ? error.message : String(error));
            }
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
            void loadAgents();
            setModelMenuOpen(false);
            setLoadError(null);
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        }
    }, [current, loadAgents, rpc, updateAgentForSession]);

    const saveSessionModel = useCallback(async (provider: string, model: string) => {
        const sessionId = current;
        if (!sessionId) throw new Error(i18n('No current session'));
        if (sessionsRef.current.find((session) => session.sessionId === sessionId)?.started === false) {
            await updateAgentForSession(sessionId, { model: { provider, model } });
            setModelMenuOpen(false);
            await Notification.success(i18n('Model saved'));
            return;
        }
        await rpc('session.selectModel', { sessionId, provider, model });
        void loadAgents();
        setModels((value) => {
            if (!value) return value;
            const next = { ...value, current: { ...value.current, provider, model } };
            modelsCacheRef.current.set(sessionId, next);
            return next;
        });
        setModelMenuOpen(false);
        setLoadError(null);
        await Notification.success(i18n('Model saved'));
    }, [current, loadAgents, rpc, updateAgentForSession]);

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
        setSelectedAgentIds(new Set());
                setSelectedSessionIds(new Set());
        setSelectedTeamIds(new Set());
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
            setLoadError(i18n('Session name cannot be empty'));
            return;
        }
        if (changes.length === 0) {
            setEditMode(false);
            setSessionTitleDrafts({});
                setSelectedAgentIds(new Set());
                setSelectedSessionIds(new Set());
            return;
        }
        setSessionTitleSaving(true);
        try {
            await Promise.all(changes.map(async (change) => {
                const value = await rpc('session.rename', { sessionId: change.sessionId, title: change.title }) as { title?: string };
                if (value.title !== change.title) throw new Error(i18n('Failed to save session name'));
            }));
            const titles = new Map(changes.map((change) => [change.sessionId, change.title]));
            setSessions((items) => items.map((session) => {
                const title = titles.get(session.sessionId);
                return title === undefined ? session : { ...session, projections: { values: { ...(session.projections?.values ?? {}), title } } };
            }));
            setEditMode(false);
            setSessionTitleDrafts({});
                setSelectedAgentIds(new Set());
                setSelectedSessionIds(new Set());
            setLoadError(null);
            await Notification.success(i18n('Session name saved'));
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
            void Promise.all([loadSessions(), loadAgents()]);
        } finally {
            setSessionTitleSaving(false);
        }
    }, [loadSessions, rpc, sessionTitleDrafts, sessionTitleSaving, sessions]);

    const forkSession = useCallback(async (sessionId = current ?? '') => {
        if (!sessionId || sessionsRef.current.find((session) => session.sessionId === sessionId)?.started === false) return;
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
            updateAgentSelectionUrl({ sessionId: null });
            setDetailsOpen(false);
            setSelectedTool(null);
            setMessages([]);
            setHistory([]);
            setQueue([]);
            setPendingApproval(null);
            setPendingQuestion(null);
        }
        await Notification.success(i18n('Session deleted'));
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
            updateAgentSelectionUrl({ sessionId: null });
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
        if (!dialog || (('value' in dialog) && !dialog.value.trim())
            || (dialog.kind === 'create-team' && !dialog.parentTeamId)) return;
        const active = dialog;
        setDialogBusy(true);
        setDialogError(null);
        try {
            if (active.kind === 'rename-session') {
                const title = active.value.trim();
                const value = await rpc('session.rename', { sessionId: active.id, title }) as { title?: string };
                if (value.title) setSessions((items) => items.map((session) => session.sessionId === active.id ? { ...session, projections: { values: { ...(session.projections?.values ?? {}), title: value.title } } } : session));
            } else if (active.kind === 'create-team') {
                const parentTeamId = active.parentTeamId;
                if (!parentTeamId || !teams.some((team) => team.teamId === parentTeamId)) {
                    throw new Error(i18n('Please choose an existing team as the parent team.'));
                }
                const value = await rpc('team.create', { text: active.value.trim(), parentTeamId }) as { team?: AgentTeam };
                if (!value.team) throw new Error(i18n('Team creation failed'));
                setTeams((items) => [...items, value.team!]);
                setActiveTreeTeamId(value.team.teamId);
                updateAgentSelectionUrl({ teamId: value.team.teamId, agentId: null, sessionId: null });
                await Notification.success(i18n('Team created successfully'));
            } else if (active.kind === 'rename-team') {
                const value = await rpc('team.rename', { teamId: active.id, text: active.value.trim() }) as { team?: AgentTeam };
                if (!value.team) throw new Error(i18n('Team rename failed'));
                setTeams((items) => items.map((team) => team.teamId === active.id ? value.team! : team));
                await Notification.success(i18n('Team renamed'));
            } else if (active.kind === 'delete-selected') {
                const selectedAgentSet = new Set(active.agentIds);
                const standaloneSessionIds = active.sessionIds.filter((sessionId) => {
                    const session = sessions.find((item) => item.sessionId === sessionId);
                    return !session?.agentId || !selectedAgentSet.has(session.agentId);
                });
                const deletedSessionIds = new Set(standaloneSessionIds);
                if (standaloneSessionIds.length > 0) await performHardDeleteMany(standaloneSessionIds);
                for (const agentId of active.agentIds) {
                    const result = await rpc('agent.delete', { agentId, deleteSessions: true }) as { sessionIds?: string[] };
                    result.sessionIds?.forEach((sessionId) => deletedSessionIds.add(sessionId));
                    setAgents((items) => items.filter((agent) => agent.agentId !== agentId));
                }
                const cascadedSessionIds = [...deletedSessionIds].filter((sessionId) => !standaloneSessionIds.includes(sessionId));
                cascadedSessionIds.forEach((sessionId) => {
                    historyCacheRef.current.delete(sessionId);
                    historyPreviewAttemptedRef.current.delete(sessionId);
                    historyPreviewRef.current.delete(sessionId);
                    modelsCacheRef.current.delete(sessionId);
                });
                if (cascadedSessionIds.length > 0) {
                    setSessions((items) => items.filter((session) => !deletedSessionIds.has(session.sessionId)));
                    if (current && deletedSessionIds.has(current)) {
                        setCurrent(null);
                        currentRef.current = null;
                        setDetailsOpen(false);
                        setSelectedTool(null);
                        setMessages([]);
                        setHistory([]);
                        setQueue([]);
                        setPendingApproval(null);
                        setPendingQuestion(null);
                    }
                }
                const removedTeams = teams.filter((team) => active.teamIds.includes(team.teamId));
                const failedSessionIds = new Set<string>();
                for (const teamId of active.teamIds) {
                    const result = await rpc('team.delete', { teamId }) as { failedSessionIds?: string[] };
                    result.failedSessionIds?.forEach((sessionId) => failedSessionIds.add(sessionId));
                }
                const removedTeamIds = new Set(active.teamIds);
                const finalParentFor = (teamId: string): string | undefined => {
                    const seen = new Set<string>([teamId]);
                    let parentTeamId = removedTeams.find((team) => team.teamId === teamId)?.parentTeamId;
                    while (parentTeamId && removedTeamIds.has(parentTeamId) && !seen.has(parentTeamId)) {
                        seen.add(parentTeamId);
                        parentTeamId = teams.find((team) => team.teamId === parentTeamId)?.parentTeamId;
                    }
                    return parentTeamId ?? rootTeamId ?? undefined;
                };
                const nextActiveTeamId = activeTreeTeamId && removedTeamIds.has(activeTreeTeamId)
                    ? finalParentFor(activeTreeTeamId)
                    : activeTreeTeamId;
                setSessions((items) => items.map((session) => session.teamId && removedTeamIds.has(session.teamId)
                    ? { ...session, teamId: finalParentFor(session.teamId) }
                    : session));
                setTeams((items) => items.filter((team) => !removedTeamIds.has(team.teamId)));
                setActiveTreeTeamId(nextActiveTeamId ?? null);
                const survivingSessionId = current && !deletedSessionIds.has(current) ? current : null;
                const survivingAgentId = survivingSessionId ? sessions.find((session) => session.sessionId === survivingSessionId)?.agentId ?? null : null;
                updateAgentSelectionUrl({ teamId: nextActiveTeamId, agentId: survivingAgentId, sessionId: survivingSessionId });
                setSelectedAgentIds(new Set());
                setSelectedSessionIds(new Set());
                setSelectedTeamIds(new Set());
                setSessionTitleDrafts({});
                setEditMode(false);
                void Promise.all([loadAgents(), loadSessions()]);
                const deletedCount = deletedSessionIds.size + active.agentIds.length + active.teamIds.length;
                if (failedSessionIds.size > 0) {
                    await Notification.error(i18n('Deleted {0} items, but could not sync Addon settings for {1} sessions. Check the host and retry.', deletedCount, failedSessionIds.size));
                } else {
                    await Notification.success(i18n('Deleted {0} items', deletedCount));
                }
            } else {
                await performHardDelete(active.id);
            }
            setDialog(null);
        } catch (error) {
            setDialogError(error instanceof Error ? error.message : String(error));
        } finally {
            setDialogBusy(false);
        }
    }, [activeTreeTeamId, current, dialog, loadAgents, loadSessions, sessions, teams, performHardDelete, performHardDeleteMany, rootTeamId, rpc]);

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
    const toggleAgentSelection = useCallback((agentId: string) => {
        const deselect = selectedAgentIds.has(agentId);
        const sessionIds = sessionsWithAgentSettings.filter((session) => session.agentId === agentId).map((session) => session.sessionId);
        setSelectedAgentIds((currentIds) => {
            const next = new Set(currentIds);
            if (deselect) next.delete(agentId); else next.add(agentId);
            return next;
        });
        setSelectedSessionIds((currentIds) => {
            const next = new Set(currentIds);
            sessionIds.forEach((sessionId) => { if (deselect) next.delete(sessionId); else next.add(sessionId); });
            return next;
        });
    }, [selectedAgentIds, sessionsWithAgentSettings]);
    const toggleSessionSelection = useCallback((sessionId: string) => {
        const ownerAgentId = sessionsWithAgentSettings.find((session) => session.sessionId === sessionId)?.agentId;
        if (ownerAgentId && selectedAgentIds.has(ownerAgentId)) {
            setSelectedAgentIds((currentIds) => {
                const next = new Set(currentIds);
                next.delete(ownerAgentId);
                return next;
            });
        }
        setSelectedSessionIds((currentIds) => {
            const next = new Set(currentIds);
            if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
            return next;
        });
    }, [selectedAgentIds, sessionsWithAgentSettings]);
    const toggleTeamSelection = useCallback((teamIds: readonly string[], agentIds: readonly string[], sessionIds: readonly string[], ancestorIds: readonly string[]) => {
        const deselect = teamIds.every((teamId) => selectedTeamIds.has(teamId))
            && agentIds.every((agentId) => selectedAgentIds.has(agentId))
            && sessionIds.every((sessionId) => selectedSessionIds.has(sessionId));
        setSelectedTeamIds((currentIds) => {
            const next = new Set(currentIds);
            teamIds.forEach((teamId) => { if (deselect) next.delete(teamId); else next.add(teamId); });
            if (deselect) ancestorIds.forEach((teamId) => next.delete(teamId));
            return next;
        });
        setSelectedAgentIds((currentIds) => {
            const next = new Set(currentIds);
            agentIds.forEach((agentId) => { if (deselect) next.delete(agentId); else next.add(agentId); });
            return next;
        });
        setSelectedSessionIds((currentIds) => {
            const next = new Set(currentIds);
            sessionIds.forEach((sessionId) => { if (deselect) next.delete(sessionId); else next.add(sessionId); });
            return next;
        });
    }, [selectedAgentIds, selectedSessionIds, selectedTeamIds]);
    const requestCreateTeam = useCallback(() => {
        setDialogError(null);
        setDialog({ kind: 'create-team', value: '' });
    }, []);
    const requestRenameTeam = useCallback((teamId: string) => {
        const team = teams.find((item) => item.teamId === teamId);
        if (!team || team.isRootTeam) return;
        setDialogError(null);
        setDialog({ kind: 'rename-team', id: teamId, value: team.text });
    }, [teams]);
    const requestDeleteSelected = useCallback(() => {
        const agentIds = [...selectedAgentIds];
        const sessionIds = [...selectedSessionIds];
        const teamIds = teams.filter((team) => selectedTeamIds.has(team.teamId)).map((team) => team.teamId);
        if (agentIds.length === 0 && sessionIds.length === 0 && teamIds.length === 0) return;
        setDialogError(null);
        setDialog({ kind: 'delete-selected', agentIds, sessionIds, teamIds });
    }, [teams, selectedAgentIds, selectedSessionIds, selectedTeamIds]);
    const selectTreeTeam = useCallback((teamId: string) => {
        setSelectedAgentSettingsId(null);
        setActiveTreeTeamId(teamId);
        setCurrent(null);
        setDetailsOpen(false);
        setSelectedTool(null);
        const selectedTeam = teams.find((team) => team.teamId === teamId);
        setTeamSettingsId(selectedTeam ? teamId : null);
        setTeamSettingsTab('context');
        setTeamContextEditing(false);
        updateAgentSelectionUrl({ teamId, agentId: null });
    }, [teams]);
    const selectSession = useCallback((sessionId: string) => {
        setSelectedAgentSettingsId(null);
        setTeamSettingsId(null);
        const session = sessions.find((item) => item.sessionId === sessionId);
        const selectedTeamId = session?.teamId && teams.some((team) => team.teamId === session.teamId)
            ? session.teamId
            : rootTeamId;
        if (selectedTeamId) setActiveTreeTeamId(selectedTeamId);
        setDetailsOpen(true);
        setSelectedTool(null);
        if (current !== sessionId) {
            setHistoryLoading(!historyCacheRef.current.has(sessionId));
            setCurrent(sessionId);
        }
        updateAgentSelectionUrl({ ...(selectedTeamId ? { teamId: selectedTeamId } : {}), agentId: sessionId });
    }, [current, teams, rootTeamId, sessions]);
    if (guest) return null;
    if (booting) {
        return <div className="eza-app" data-ds-dark-theme={dark || undefined}><div className="eza-boot"><div className="eza-bootCard"><EjunzLogo size={40} className="eza-heroLogo" /><div className="eza-bootSpinner" /><div className="eza-bootHint">{i18n('Connecting to Ejunz Agent...')}</div></div></div></div>;
    }

    return (
        <div className="eza-app" data-ds-dark-theme={dark || undefined}>
            <DeepSeekOnboarding rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} />
            {newSessionConfigOpen && <InputConfigDialog
                hosts={hosts}
                selectedHostId={draftHostId}
                onPickHost={setDraftHostId}
                bases={bases}
                selectedBaseId={draftBaseId}
                onPickBase={setDraftBaseId}
                teams={teams}
                agents={agents}
                selectedAgentId={draftAgentId}
                onPickAgent={selectDraftAgent}
                selectedTeamId={draftTeamId}
                onPickTeam={selectDraftTeam}
                requireTeamSelection={newAgentTargetRequired}
                quickSessionOnly={quickSessionOnly}
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
                onCreateOnly={(name) => { void createSessionOnly(name); }}
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
                    { id: 'general', label: i18n('General settings'), render: () => <div className="eza-settingsColumn">
                    <AgentPresetRow rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} />
                    <LanguageRow rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} />
                    <GeneralSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} onThemeChange={applyTheme} />
                    <EnterBehaviorRow rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} onBehaviorChange={setBusyEnter} />
                </div> },
                    { id: 'models', label: i18n('Models'), render: () => <ModelsSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} /> },
                    { id: 'agent-presets', label: i18n('Agent presets'), render: () => <AgentPresetSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} onCreatorDraft={startCreatorDraft} /> },
                    { id: 'tools', label: i18n('Tools'), render: () => <ToolsSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} sessionId={isUnstartedCurrent ? undefined : current ?? undefined} refreshKey={currentSession?.agentSettings?.agentPreset} /> },
                    { id: 'plugins', label: i18n('Plugins'), render: () => <PluginsSection rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>} /> },
                    { id: 'agent-addons', label: i18n('Agent add-ons'), render: () => <AgentAddonsSection
                        rpc={rpc as <T>(method: string, payload: unknown) => Promise<T>}
                        marketHref={`${domainPrefix(String(domainId || 'system'))}/market`}
                        onAddonChange={(addonId, enabled, installed) => {
                            const nextIds = new Set(enabledAgentAddonIds);
                            if (enabled) nextIds.add(addonId);
                            else nextIds.delete(addonId);
                            setEnabledAgentAddonIds(nextIds);
                            setAgentAddons((items) => items.map((addon) => addon.addonId === addonId ? { ...addon, enabled, installed } : addon));
                            void setEnabledAgentPluginSlots(nextIds);
                            if (addonId === 'base') {
                                void loadBases();
                                if (!enabled) void notifyAgentPluginDisabled(addonId, {
                                    currentSession,
                                    clearDraftContext: () => setDraftBaseId(undefined),
                                    clearCurrentContext: async () => {
                                        if (!current) return;
                                        try {
                                            await saveBaseSetting(undefined);
                                        } catch (error) {
                                            setLoadError(error instanceof Error ? error.message : String(error));
                                        }
                                    },
                                });
                            }
                        }}
                    /> },
                ]}
            />}
            {dialog && <ActionDialog
                open
                title={dialog.kind === 'rename-session' ? i18n('Rename session') : dialog.kind === 'create-team' ? i18n('New team') : dialog.kind === 'rename-team' ? i18n('Rename team') : dialog.kind === 'delete-selected' ? i18n('Delete selected items?') : i18n('Permanently delete session?')}
                description={dialog.kind === 'create-team' ? i18n('Choose an existing team as the parent for the new team.') : dialog.kind === 'delete-selected' ? [
                    dialog.teamIds.length > 0 ? i18n('Delete {0} teams; move their agents to the parent team.', dialog.teamIds.length) : '',
                    dialog.agentIds.length > 0 ? i18n('Delete {0} agents and their linked sessions and messages.', dialog.agentIds.length) : '',
                    dialog.sessionIds.length > 0 ? i18n('Permanently delete {0} sessions, including history and tool calls. This cannot be undone.', dialog.sessionIds.length) : '',
                ].filter(Boolean).join('; ') + '.' : dialog.kind === 'delete-session' ? i18n('Permanently delete "{0}" and its history and tool calls. This cannot be undone.', dialog.title) : undefined}
                selectLabel={dialog.kind === 'create-team' ? i18n('Parent team') : undefined}
                selectValue={dialog.kind === 'create-team' ? dialog.parentTeamId ?? '' : ''}
                selectPlaceholder={i18n('Choose an existing team')}
                selectTreeOptions={dialog.kind === 'create-team' ? teamParentTree : []}
                inputLabel={dialog.kind === 'create-team' ? i18n('Team name') : dialog.kind === 'rename-session' || dialog.kind === 'rename-team' ? i18n('Name') : undefined}
                inputValue={'value' in dialog ? dialog.value : ''}
                inputPlaceholder={i18n('Please enter a name')}
                confirmLabel={dialog.kind === 'create-team' ? i18n('Create') : dialog.kind === 'rename-session' || dialog.kind === 'rename-team' ? i18n('Save') : i18n('Delete')}
                danger={dialog.kind === 'delete-selected' || dialog.kind === 'delete-session'}
                busy={dialogBusy}
                error={dialogError}
                onSelectChange={(parentTeamId) => setDialog((previous) => previous?.kind === 'create-team' ? { ...previous, parentTeamId } : previous)}
                onInputChange={(value) => setDialog((previous) => previous && 'value' in previous ? { ...previous, value } : previous)}
                onClose={() => { if (!dialogBusy) setDialog(null); }}
                onConfirm={() => { void submitDialog(); }}
            />}
            <div className="eza-pageShell bd-page">
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
                            setSelectedAgentIds(new Set());
                setSelectedSessionIds(new Set());
                            setSelectedTeamIds(new Set());
                            return;
                        }
                        startSessionTitleEdit();
                    }}
                    editActive={editMode}
                />
                <div className="eza-pageBody">
                    <main className="eza-mainSurface">
                        <TeamTree
                            sessions={sessionsWithAgentSettings}
                            agents={agents}
                            teams={teams}
                            treeOpen={treeOpen}
                            activeTeamId={activeTreeTeamId}
                            onSelectTeam={selectTreeTeam}
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
                            selectedAgentIds={selectedAgentIds}
                            selectedSessionIds={selectedSessionIds}
                            selectedTeamIds={selectedTeamIds}
                            sessionTitleDrafts={sessionTitleDrafts}
                            onToggleAgentSelection={toggleAgentSelection}
                            onToggleSessionSelection={toggleSessionSelection}
                            onToggleTeamSelection={toggleTeamSelection}
                            onCreateAgent={() => { void prepareNewSession(undefined, undefined, true); }}
                            onCreateTeam={requestCreateTeam}
                            onRenameTeam={requestRenameTeam}
                            onSessionTitleChange={updateSessionTitleDraft}
                            onSaveSessionTitles={saveSessionTitleEdits}
                            sessionTitleSaving={sessionTitleSaving}
                            onQuery={setQuery}
                            onSelect={selectSession}
                            onSelectAgent={openAgentSettings}
                            onStartSession={(agentId) => { void prepareNewSession(undefined, agentId, false, true); }}
                            onDeleteSelected={requestDeleteSelected}
                            onExitEdit={() => { setEditMode(false); setSessionTitleDrafts({}); setSelectedAgentIds(new Set());
                setSelectedSessionIds(new Set()); setSelectedTeamIds(new Set()); }}
                        />
                    </main>
                </div>
                {teamSettingsTeam && <SessionDrawer
                    loading={false}
                    drawerWidth={sessionDrawerWidth}
                    view="model"
                    title={teamSettingsTeam.text}
                    headerTabs={[
                        { id: 'context', label: i18n('Context'), active: teamSettingsTab === 'context', onSelect: () => { setTeamSettingsTab('context'); setTeamContextEditing(false); } },
                        ...(teamSettingsTeam.isRootTeam ? [
                            { id: 'role', label: i18n('Role'), active: teamSettingsTab === 'role', onSelect: () => { setTeamSettingsTab('role'); setTeamContextEditing(false); } },
                            { id: 'permissions', label: i18n('Permissions'), active: teamSettingsTab === 'permissions', onSelect: () => { setTeamSettingsTab('permissions'); setTeamContextEditing(false); } },
                        ] : []),
                        { id: 'addons', label: i18n('Add-ons'), active: teamSettingsTab === 'addons', onSelect: () => { setTeamSettingsTab('addons'); setTeamContextEditing(false); } },
                    ]}
                    headerActions={teamSettingsTab === 'context' ? <button type="button" className="bd-drawer__edit" onClick={() => setTeamContextEditing(true)} disabled={teamConfigSaving}>{i18n('Edit')}</button> : undefined}
                    onViewChange={() => {}}
                    onResize={(delta) => setSessionDrawerWidth((width) => Math.max(SESSION_DRAWER_MIN, width + delta))}
                    onClose={() => { setTeamSettingsId(null); setTeamContextEditing(false); }}
                >
                    {teamSettingsTab === 'context'
                        ? <TeamContextSettingsPanel
                            team={teamSettingsTeam}
                            editing={teamContextEditing}
                            saving={teamConfigSaving}
                            onCloseEdit={() => setTeamContextEditing(false)}
                            onSave={async (context) => {
                                await saveTeamConfig(teamSettingsTeam.teamId, { context });
                                await Notification.success(i18n('Team context saved. Existing agents will receive it in the background.'));
                            }}
                        />
                        : teamSettingsTab === 'addons'
                            ? <TeamAddonSettingsPanel
                                team={teamSettingsTeam}
                                addons={agentAddons}
                                saving={teamConfigSaving}
                                onSave={async (addonIds) => {
                                    await saveTeamConfig(teamSettingsTeam.teamId, { addonIds });
                                    await Notification.success(i18n('Team add-on settings saved. Existing agents will sync in the background.'));
                                }}
                            />
                            : <TeamPermissionsPanel
                                team={teamSettingsTeam}
                                teams={teams}
                                addons={agentAddons}
                                section={teamSettingsTab === 'role' ? 'roles' : 'permissions'}
                                saving={teamConfigSaving}
                                onSave={async (acl: AgentTeamAcl) => {
                                    await saveTeamConfig(teamSettingsTeam.teamId, { acl });
                                    await Notification.success(i18n('Agent role permissions saved.'));
                                }}
                            />}
                </SessionDrawer>}
                {selectedAgentSettings && <SessionDrawer
                    loading={false}
                    drawerWidth={sessionDrawerWidth}
                    view={agentSettingsSection}
                    title={selectedAgentSettings.title}
                    headerTabs={[
                        { id: 'context', label: i18n('Context'), active: agentSettingsSection === 'context', onSelect: () => setAgentSettingsSection('context') },
                        { id: 'model', label: i18n('Model'), active: agentSettingsSection === 'model', onSelect: () => { setAgentSettingsSection('model'); setAgentContextEditing(false); } },
                        { id: 'host', label: i18n('Host'), active: agentSettingsSection === 'host', onSelect: () => { setAgentSettingsSection('host'); setAgentContextEditing(false); } },
                    ]}
                    headerActions={agentSettingsSection === 'context' ? <button type="button" className="bd-drawer__edit" onClick={() => setAgentContextEditing(true)} disabled={agentContextSaving}>{i18n('Edit')}</button> : undefined}
                    onViewChange={(view) => { if (view === 'model' || view === 'context' || view === 'host') setAgentSettingsSection(view); }}
                    onResize={(delta) => setSessionDrawerWidth((width) => Math.max(SESSION_DRAWER_MIN, width + delta))}
                    onClose={() => { setSelectedAgentSettingsId(null); setAgentContextEditing(false); }}
                >
                    <div className="eza-agentSettingsPanel">
                        {agentSettingsSection === 'context' && <AgentContextSettingsPanel
                            context={selectedAgentSettings.config?.context}
                            editing={agentContextEditing}
                            saving={agentContextSaving}
                            onCloseEdit={() => setAgentContextEditing(false)}
                            onSave={(context) => saveAgentContext(selectedAgentSettings.agentId, context)}
                        />}
                        <AgentSettingsPanel
                            section={agentSettingsSection}
                            models={selectedAgentModels}
                            modelActions={<AgentPresetSeat
                                options={agentPresetOptions}
                                selectedId={selectedAgentSettings.settings.agentPreset ?? ''}
                                error={agentPresetError}
                                onSelect={(agentPreset) => { void saveAgentSettings(selectedAgentSettings.agentId, { agentPreset }).catch((error) => setLoadError(error instanceof Error ? error.message : String(error))); }}
                            />}
                            onModel={(provider, model) => saveAgentSettings(selectedAgentSettings.agentId, { model: { provider, model } })}
                            bases={bases}
                            selectedBaseId={selectedAgentSettings.settings.baseDocId ? Number(selectedAgentSettings.settings.baseDocId) : undefined}
                            hosts={hosts}
                            selectedHostId={selectedAgentSettings.settings.runtimeId ?? fallbackHostId}
                            onBase={(baseDocId) => saveAgentSettings(selectedAgentSettings.agentId, { baseDocId: baseDocId ?? null })}
                            onHost={(runtimeId) => saveAgentSettings(selectedAgentSettings.agentId, { runtimeId })}
                        />
                    </div>
                </SessionDrawer>}
                {detailsOpen && (currentSession || creatingSession) && <SessionDrawer
                            loading={creatingSession || (historyLoading && !pendingSendVisible)}
                            loadingLabel={creatingSession ? i18n('Creating session...') : historyLoadingLabel}
                            drawerWidth={sessionDrawerWidth}
                            view={view}
                            onViewChange={setView}
                            onResize={(delta) => setSessionDrawerWidth((width) => Math.max(SESSION_DRAWER_MIN, width + delta))}
                            onClose={() => { setDetailsOpen(false); setSelectedTool(null); setCurrent(null); updateAgentSelectionUrl({ sessionId: null }); }}
                            overlay={selectedTool && currentSession && <DetailsPanel title={sessionTitle(currentSession)} agentPreset={currentSession.agentSettings?.agentPreset} running={running} models={models} tool={selectedTool} onClose={() => setSelectedTool(null)} />}
                        >
                            {creatingSession || !currentSession
                                ? null
                                : view === 'context'
                                ? <div className="eza-sessionAgentSettingsNotice">
                                    <p>{i18n('Runtime settings are managed by the Agent. Sessions no longer store their own model, Base, host, or preset.')}</p>
                                    {currentSession.agentId && <button type="button" onClick={() => openAgentSettings(currentSession.agentId!)}>{i18n('Open Agent settings')}</button>}
                                </div>
                                : <ConversationRoot
                                    blank={false}
                                    title={sessionTitle(currentSession)}
                                    renaming={renaming}
                                    titleEditor={<input className="eza-titleEditor" autoFocus value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(false); if (event.key === 'Enter') void renameSession(); }} />}
                                    actions={<AgentPresetLabel preset={currentSession.agentSettings?.agentPreset} options={agentPresetOptions} />}
                                    view={view === 'trajectory' ? 'trajectory' : 'chat'}
                                    onViewChange={setView}
                                    hideHeader
                                    chat={<ChatView messages={messages} addons={agentAddons} running={running} runningTurnStartTime={runningTurnStart} historyHasMore={historyHasMore} loadingOlder={loadingOlder} loadedMessages={loadedHistoryMessages} totalMessages={historyTotalMessages} historyPageSize={HISTORY_PAGE_SIZE} onLoadOlder={() => void loadOlder()} onOpenFile={openFile} onOpenDetails={(tool) => { setSelectedTool(tool); }} />}
                                    trajectory={<TrajectoryView messages={messages} history={history} session={currentSession} historyHasMore={historyHasMore} loadingOlder={loadingOlder} onLoadOlder={loadOlder} />}
                                    composer={<div className="eza-composerLayer">
                                        <InputBar input={input} setInput={setInput} send={send} cancel={cancel} running={running} sending={sending} attachments={attachments} onAddFiles={addAttachments} onRemoveAttachment={removeAttachment} models={composerModels} showModelPicker={false} projections={currentSession.projections?.values} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} selectModel={selectModel} notice={currentSessionError ?? loadError} placeholder={i18n('Type a message. Press Shift+Enter for a new line.')}>
                                            <TodoPanel value={currentSession.projections?.values?.todos} />
                                            {pendingQuestion && <QuestionPanel question={pendingQuestion} onAnswer={answerQuestion} />}
                                            {queue.length > 0 && <QueueDock items={queue} running={running} onAction={updateQueue} />}
                                        </InputBar>
                                        {pendingApproval && <div className="eza-approvalOverlay"><ApprovalPanel approval={pendingApproval} onAnswer={answerApproval} /></div>}
                                    </div>}
                                />}
                        </SessionDrawer>}
            </div>
        </div>
    );
}
