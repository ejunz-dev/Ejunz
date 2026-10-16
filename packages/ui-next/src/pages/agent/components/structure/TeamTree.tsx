import { createPortal } from 'react-dom';
import { i18n } from '@/i18n';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { StateDot, type StateDotState } from '../primitives/StateDot';
import { MarkdownText } from '../primitives/markdown/MarkdownText';
import type { AgentSummary, AgentTeam, SessionSummary, BaseView } from '../../runtime/session';
import type { SessionModels } from '../types';
import type { AgentDisplaySettings } from './AgentDisplaySettingsDialog';
import { filterSessions } from './session-tree-utils';

interface TeamTreeProps {
    sessions: SessionSummary[];
    agents: AgentSummary[];
    teams: AgentTeam[];
    treeOpen: boolean;
    activeTeamId: string | null;
    onSelectTeam: (teamId: string) => void;
    onCloseTree: () => void;
    bases: BaseView[];
    current: string | null;
    pendingQuestionSessionIds: ReadonlySet<string>;
    sessionErrors: ReadonlyMap<string, string>;
    sessionActivityPreviews: ReadonlyMap<string, { index: number; text: string; sendStatus?: 'sending' | 'sent' | 'failed' }>;
    modelGroups?: SessionModels['groups'];
    displaySettings: AgentDisplaySettings;
    query: string;
    searchMatches: ReadonlySet<string> | null;
    searchSnippets: ReadonlyMap<string, string>;
    searchHasMore: boolean;
    editMode: boolean;
    selectedAgentIds: ReadonlySet<string>;
    selectedSessionIds: ReadonlySet<string>;
    selectedTeamIds: ReadonlySet<string>;
    sessionTitleDrafts: Readonly<Record<string, string>>;
    onToggleAgentSelection: (agentId: string) => void;
    onToggleSessionSelection: (sessionId: string) => void;
    onToggleTeamSelection: (teamIds: readonly string[], agentIds: readonly string[], sessionIds: readonly string[], ancestorIds: readonly string[]) => void;
    onCreateAgent: () => void;
    onCreateTeam: () => void;
    onRenameTeam: (teamId: string) => void;
    onSessionTitleChange: (sessionId: string, title: string) => void;
    onSaveSessionTitles: () => void | Promise<void>;
    sessionTitleSaving: boolean;
    onQuery: (value: string) => void;
    onSelect: (sessionId: string) => void;
    onSelectAgent: (agentId: string) => void;
    onStartSession: (agentId?: string) => void;
    onDeleteSelected: () => void;
    onExitEdit: () => void;
}

const SESSION_GROUP_ID = 'agent-sessions';

function TeamPeopleIcon() {
    return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="4" r="1.55" fill="var(--bd-surface)" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="3.55" cy="5.4" r="1.25" fill="var(--bd-surface)" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="12.45" cy="5.4" r="1.25" fill="var(--bd-surface)" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4.6 13.6c.18-2.5 1.32-3.8 3.4-3.8s3.22 1.3 3.4 3.8M1.65 13.4c.1-1.95.85-2.95 2.25-2.95.62 0 1.13.18 1.53.54m8.92 2.41c-.1-1.95-.85-2.95-2.25-2.95-.62 0-1.13.18-1.53.54" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>;
}

function AgentPortraitIcon() {
    return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="5.8" cy="5.3" r="2.1" stroke="currentColor" strokeWidth="1.25" />
        <path d="M1.8 13.6c.3-2.4 1.7-3.6 4-3.6 1.7 0 2.9.7 3.5 2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        <path d="M12.1 2l.65 1.55 1.55.65-1.55.65-.65 1.55-.65-1.55-1.55-.65 1.55-.65L12.1 2z" fill="currentColor" />
    </svg>;
}

function SessionBubbleIcon() {
    return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M2 3.25c0-.69.56-1.25 1.25-1.25h9.5c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H7l-3.7 2.2c-.55.33-1.3-.07-1.3-.71V3.25z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" />
        <path d="M5 6.5h.01M8 6.5h.01M11 6.5h.01" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
    return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={expanded ? 'eza-teamTreeChevron is-expanded' : 'eza-teamTreeChevron'} />
    </svg>;
}

function sessionTitle(session: SessionSummary): string {
    const title = session.projections?.values?.title;
    if (typeof title === 'string' && title.trim()) return title;
    return session.blank ? i18n('New session') : i18n('Session {0}', session.sessionId.slice(8, 16));
}

function agentModelLabel(agent: AgentSummary, modelGroups?: SessionModels['groups']): string {
    const selectedModel = agent.settings.model;
    if (!selectedModel?.provider || !selectedModel.model) return i18n('Not selected');
    const group = modelGroups?.find((item) => item.id === selectedModel.provider);
    const selected = group?.models.find((item) => item.id === selectedModel.model);
    return `${group?.name || selectedModel.provider} / ${selected?.name || selectedModel.model}`;
}

function relativeTimeLabel(raw?: string | number): string {
    if (raw === undefined) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60_000));
    if (minutes < 1) return i18n('Just now');
    if (minutes < 60) return i18n('{0} minutes ago', minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return i18n('{0} hours ago', hours);
    const days = Math.floor(hours / 24);
    if (days < 30) return i18n('{0} days ago', days);
    return date.toLocaleDateString();
}

function sessionState(session: SessionSummary, waitingForAnswer: boolean, error?: string): StateDotState {
    if (error) return 'error';
    if (waitingForAnswer) return 'warning';
    return session.running ? 'ongoing' : 'done';
}

function flatLine(value: string): string {
    return value.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

const SessionActivityRow = memo(function SessionActivityRow({ activity, index, error, active, sendStatus }: { activity?: string; index: number; error: boolean; active: boolean; sendStatus?: 'sending' | 'sent' | 'failed' }) {
    if (!activity) return <div className="eza-sessionCardActivity eza-sessionCardActivityEmpty" aria-hidden="true" />;
    const separator = activity.indexOf(' · ');
    const title = separator < 0 ? activity : activity.slice(0, separator);
    const output = separator < 0 ? '' : activity.slice(separator + 3);
    const isUserActivity = sendStatus !== undefined;
    const titleClass = title === 'Inject' ? 'eza-sessionCardActivityTitle--inject'
        : title === 'Think' ? 'eza-sessionCardActivityTitle--think'
            : title === 'Tool' ? 'eza-sessionCardActivityTitle--tool'
                : title === 'Error' ? 'eza-sessionCardActivityTitle--error'
                    : isUserActivity ? 'eza-sessionCardActivityTitle--user' : 'eza-sessionCardActivityTitle--agent';
    const statusLabel = sendStatus === 'sending' ? i18n('Sending') : sendStatus === 'sent' ? i18n('Sent') : i18n('Send failed');
    const statusIcon = sendStatus && <span className={`eza-sessionCardActivitySendState eza-sessionCardActivitySendState--${sendStatus}`} role="status" aria-label={statusLabel} title={statusLabel}>{sendStatus === 'sending' ? <span className="eza-sessionCardActivitySendSpinner" /> : sendStatus === 'sent' ? '✓' : '!'}</span>;
    return <div className="eza-sessionCardActivity" data-active={active || undefined} title={activity}>
        <span className="eza-sessionCardActivityIndex">{isUserActivity ? statusIcon : `#${index}`}</span>
        <span className={`eza-sessionCardActivityTitle ${titleClass}`}>{title}</span>
        {output && <div className={error ? 'eza-sessionCardActivityOutput eza-sessionCardActivityError' : 'eza-sessionCardActivityOutput'} data-active={active || undefined}><MarkdownText text={output} /></div>}
        {!isUserActivity && sendStatus && statusIcon}
    </div>;
});

const SessionAgentTitle = memo(function SessionAgentTitle({ session, error, waitingForAnswer, activityPreview, activityIndex, activityStatus, showStatus, editMode, draftTitle, onTitleChange, onSelect }: {
    session: SessionSummary;
    error?: string;
    waitingForAnswer: boolean;
    activityPreview?: string;
    activityIndex?: number;
    activityStatus?: 'sending' | 'sent' | 'failed';
    showStatus: boolean;
    editMode: boolean;
    draftTitle?: string;
    onTitleChange: (sessionId: string, title: string) => void;
    onSelect: (sessionId: string) => void;
}) {
    const title = sessionTitle(session);
    const state = sessionState(session, waitingForAnswer, error);
    const stateLabel = error ? i18n('Failed') : waitingForAnswer ? i18n('Waiting for answer') : session.running ? i18n('Running') : i18n('Completed');
    const activity = error ? `Error · ${flatLine(error)}` : activityPreview;
    if (editMode) {
        return <>
            {showStatus && <StateDot state={state} size={10} className="eza-sessionStateDot" />}
            <span className="eza-sessionCardTitleText">
                <input
                    className="eza-sessionTitleEditor"
                    aria-label={i18n('Session name')}
                    value={draftTitle ?? title}
                    onChange={(event) => onTitleChange(session.sessionId, event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                />
                <SessionActivityRow activity={activity} index={activityIndex ?? 1} error={Boolean(error)} active={state === 'ongoing'} sendStatus={error ? undefined : activityStatus} />
            </span>
        </>;
    }
    return <button
        type="button"
        className="eza-sessionCardTitle"
        title={error ? `${stateLabel}：${error}` : `${stateLabel}：${title}`}
        aria-label={error ? `${stateLabel}：${title}：${error}` : `${stateLabel}：${title}`}
        onClick={() => onSelect(session.sessionId)}
    >
        <StateDot state={state} size={10} className="eza-sessionStateDot" />
        <span className="eza-sessionCardTitleText">
            <span className="eza-teamTreeLabel">{title}</span>
            <SessionActivityRow activity={activity} index={activityIndex ?? 1} error={Boolean(error)} active={state === 'ongoing'} sendStatus={error ? undefined : activityStatus} />
        </span>
    </button>;
});

export function TeamTree({
    sessions, agents, teams: teams, treeOpen, activeTeamId, onSelectTeam, onCloseTree, bases, current, pendingQuestionSessionIds, sessionErrors, sessionActivityPreviews, modelGroups, displaySettings, query, searchMatches, searchSnippets, searchHasMore,
    editMode, selectedAgentIds, selectedSessionIds, selectedTeamIds, sessionTitleDrafts, onToggleAgentSelection, onToggleSessionSelection, onToggleTeamSelection, onCreateAgent, onCreateTeam, onRenameTeam, onSessionTitleChange, onSaveSessionTitles, sessionTitleSaving,
    onQuery, onSelect, onSelectAgent, onStartSession, onDeleteSelected, onExitEdit,
}: TeamTreeProps) {
    const toolsRef = useRef<HTMLDivElement>(null);
    const drawerResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
    const [toolbarTop, setToolbarTop] = useState<number | null>(null);
    const [drawerWidth, setDrawerWidth] = useState(420);
    const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set([SESSION_GROUP_ID]));
    const [collapsedAgentIds, setCollapsedAgentIds] = useState<Set<string>>(() => new Set());
    const [pendingTeamId, setPendingTeamId] = useState<string | null>(null);
    const visibleSessions = useMemo(() => filterSessions(sessions, current, query, searchMatches), [current, query, searchMatches, sessions]);
    const agentRootTeam = useMemo(() => teams.find((team) => team.isRootTeam), [teams]);
    const fallbackTeamId = agentRootTeam?.teamId ?? SESSION_GROUP_ID;
    const sessionsByAgent = useMemo(() => {
        const groups = new Map<string, SessionSummary[]>();
        visibleSessions.forEach((session) => {
            if (!session.agentId) return;
            const group = groups.get(session.agentId) || [];
            group.push(session);
            groups.set(session.agentId, group);
        });
        return groups;
    }, [visibleSessions]);
    const agentsByTeam = useMemo(() => {
        const validTeamIds = new Set(teams.map((team) => team.teamId));
        const groups = new Map<string, AgentSummary[]>();
        agents.forEach((agent) => {
            const teamId = validTeamIds.has(agent.teamId) ? agent.teamId : fallbackTeamId;
            const group = groups.get(teamId) || [];
            group.push(agent);
            groups.set(teamId, group);
        });
        groups.forEach((group) => group.sort((a, b) => a.order - b.order));
        return groups;
    }, [agents, teams, fallbackTeamId]);
    const sessionsByTeam = useMemo(() => {
        const validTeamIds = new Set(teams.map((team) => team.teamId));
        const groups = new Map<string, SessionSummary[]>();
        visibleSessions.forEach((session) => {
            if (session.agentId) return;
            const teamId = session.teamId && validTeamIds.has(session.teamId) ? session.teamId : fallbackTeamId;
            const group = groups.get(teamId) || [];
            group.push(session);
            groups.set(teamId, group);
        });
        return groups;
    }, [teams, fallbackTeamId, visibleSessions]);
    const ungroupedSessions = sessionsByTeam.get(SESSION_GROUP_ID) || [];
    const visibleSelectedTeamId = activeTeamId ?? (ungroupedSessions.length > 0 ? SESSION_GROUP_ID : agentRootTeam?.teamId ?? null);
    useEffect(() => {
        if (!agentRootTeam) return;
        setExpandedTeams((current) => current.has(agentRootTeam.teamId) ? current : new Set([...current, agentRootTeam.teamId]));
    }, [agentRootTeam]);
    const toggleTeamExpansion = useCallback((teamId: string) => {
        setExpandedTeams((current) => {
            const next = new Set(current);
            if (next.has(teamId)) next.delete(teamId); else next.add(teamId);
            return next;
        });
    }, []);
    const teamById = useMemo(() => new Map<string, AgentTeam>(teams.map((team) => [team.teamId, team])), [teams]);
    const childTeamsByParent = useMemo(() => {
        const children = new Map<string, AgentTeam[]>();
        teams.forEach((team) => {
            if (!team.parentTeamId) return;
            const siblings = children.get(team.parentTeamId) || [];
            siblings.push(team);
            children.set(team.parentTeamId, siblings);
        });
        children.forEach((siblings) => siblings.sort((a, b) => a.order - b.order));
        return children;
    }, [teams]);
    const rootTeamIds = useMemo(() => {
        if (agentRootTeam) return [agentRootTeam.teamId];
        return [
            ...(ungroupedSessions.length > 0 || (agentsByTeam.get(SESSION_GROUP_ID)?.length ?? 0) > 0 ? [SESSION_GROUP_ID] : []),
            ...teams.filter((team) => !team.parentTeamId).map((team) => team.teamId),
        ];
    }, [teams, agentRootTeam, agentsByTeam, ungroupedSessions.length]);
    const renderedRootTeamIds = activeTeamId && rootTeamIds.includes(activeTeamId) ? [activeTeamId] : rootTeamIds;
    const requestTeamSwitch = useCallback((teamId: string) => {
        if (teamId !== visibleSelectedTeamId) setPendingTeamId(teamId);
        else onSelectTeam(teamId);
    }, [onSelectTeam, visibleSelectedTeamId]);
    const confirmTeamSwitch = useCallback(() => {
        if (pendingTeamId) onSelectTeam(pendingTeamId);
        setPendingTeamId(null);
    }, [onSelectTeam, pendingTeamId]);
    const cancelTeamSwitch = useCallback(() => setPendingTeamId(null), []);
    const pendingTeamLabel = pendingTeamId === SESSION_GROUP_ID
        ? i18n('Ungrouped')
        : teams.find((team) => team.teamId === pendingTeamId)?.text || '';
    const topSelectedTeamIds = teams
        .filter((team) => !team.isRootTeam && selectedTeamIds.has(team.teamId)
            && !(team.parentTeamId && selectedTeamIds.has(team.parentTeamId)))
        .map((team) => team.teamId);
    const selectedTeamId = selectedTeamIds.has(SESSION_GROUP_ID) ? undefined : topSelectedTeamIds.length === 1 ? topSelectedTeamIds[0] : undefined;
    const canEditTeam = selectedTeamId !== undefined && selectedTeamId !== agentRootTeam?.teamId;
    const selectSessionAgent = useCallback((sessionId: string, switchTeam = false) => {
        const session = visibleSessions.find((item) => item.sessionId === sessionId);
        const teamId = session?.teamId && teamById.has(session.teamId) ? session.teamId : fallbackTeamId;
        if (switchTeam) onSelectTeam(teamId);
        onSelect(sessionId);
    }, [teamById, fallbackTeamId, onSelect, onSelectTeam, visibleSessions]);
    const toggleTeamSelection = useCallback((rootTeamId: string) => {
        if (agentRootTeam?.teamId === rootTeamId) return;
        const branchTeamIds: string[] = [];
        const pending = [rootTeamId];
        const visited = new Set<string>();
        while (pending.length > 0) {
            const teamId = pending.pop()!;
            if (visited.has(teamId)) continue;
            visited.add(teamId);
            branchTeamIds.push(teamId);
            (childTeamsByParent.get(teamId) || []).forEach((team) => pending.push(team.teamId));
        }
        const branchAgentIds = branchTeamIds.flatMap((teamId) => (agentsByTeam.get(teamId) || []).map((agent) => agent.agentId));
        const branchSessionIds = branchTeamIds.flatMap((teamId) => [
            ...(sessionsByTeam.get(teamId) || []).map((session) => session.sessionId),
            ...(agentsByTeam.get(teamId) || []).flatMap((agent) => (sessionsByAgent.get(agent.agentId) || []).map((session) => session.sessionId)),
        ]);
        const ancestorIds: string[] = [];
        let ancestorId = rootTeamId;
        while (true) {
            const parent = teamById.get(ancestorId)?.parentTeamId;
            if (!parent || ancestorIds.includes(parent)) break;
            ancestorIds.push(parent);
            ancestorId = parent;
        }
        onToggleTeamSelection(branchTeamIds, branchAgentIds, branchSessionIds, ancestorIds);
    }, [agentRootTeam, agentsByTeam, childTeamsByParent, onToggleTeamSelection, sessionsByAgent, sessionsByTeam, teamById]);
    useLayoutEffect(() => {
        if (!editMode) {
            setToolbarTop(null);
            return undefined;
        }
        const update = () => {
            const top = toolsRef.current?.getBoundingClientRect().top;
            if (top !== undefined) setToolbarTop(top);
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, [editMode]);
    const teamSearchMatches = (teamId: string, needle: string, visited = new Set<string>()): boolean => {
        if (visited.has(teamId)) return false;
        visited.add(teamId);
        const team = teamById.get(teamId);
        const label = team ? team.text : i18n('Ungrouped');
        if (label.toLocaleLowerCase().includes(needle)) return true;
        if ((sessionsByTeam.get(teamId) || []).some((session) => sessionTitle(session).toLocaleLowerCase().includes(needle)
            || (searchSnippets.get(session.sessionId) || '').toLocaleLowerCase().includes(needle))) return true;
        if ((agentsByTeam.get(teamId) || []).some((agent) => agent.title.toLocaleLowerCase().includes(needle)
            || (sessionsByAgent.get(agent.agentId) || []).some((session) => sessionTitle(session).toLocaleLowerCase().includes(needle)
                || (searchSnippets.get(session.sessionId) || '').toLocaleLowerCase().includes(needle)))) return true;
        return (childTeamsByParent.get(teamId) || []).some((child) => teamSearchMatches(child.teamId, needle, visited));
    };
    const renderAgentRow = (session: SessionSummary, level: number, inDrawer: boolean): ReactNode => {
        const activity = sessionActivityPreviews.get(session.sessionId);
        const activityStatus = sessionErrors.has(session.sessionId) ? undefined : activity?.sendStatus;
        return <div
            key={session.sessionId}
            className={`eza-teamTreeRow eza-teamTreeRow--session${current === session.sessionId ? ' is-selected' : ''}`}
            style={{ paddingLeft: `${(level + 1) * 1.1}rem` }}
        >
            {editMode && <input
                type="checkbox"
                className="eza-teamTreeCheckbox"
                checked={selectedSessionIds.has(session.sessionId)}
                onChange={() => onToggleSessionSelection(session.sessionId)}
                onClick={(event) => event.stopPropagation()}
                aria-label={i18n('Select {0}', sessionTitle(session))}
            />}
            <span className="eza-teamTreeSpacer" aria-hidden="true" />
            <span className="eza-teamTreeIcon eza-teamTreeIcon--session" aria-hidden="true"><SessionBubbleIcon /></span>
            <SessionAgentTitle
                session={session}
                error={sessionErrors.get(session.sessionId)}
                waitingForAnswer={pendingQuestionSessionIds.has(session.sessionId)}
                activityPreview={activity?.text}
                activityIndex={activity?.index}
                activityStatus={activityStatus}
                showStatus={displaySettings.showStatus}
                editMode={editMode}
                draftTitle={sessionTitleDrafts[session.sessionId]}
                onTitleChange={onSessionTitleChange}
                onSelect={(sessionId) => {
                    selectSessionAgent(sessionId, inDrawer);
                    if (inDrawer) onCloseTree();
                }}
            />
            {displaySettings.showTimestamps && <time className="eza-teamTreeMeta" title={new Date(session.updatedAt).toLocaleString()}>{relativeTimeLabel(session.updatedAt)}</time>}
        </div>;
    };
    const renderAgentNode = (agent: AgentSummary, level: number, inDrawer: boolean, needle = ''): ReactNode => {
        const childSessions = sessionsByAgent.get(agent.agentId) || [];
        const expanded = !collapsedAgentIds.has(agent.agentId) || (inDrawer && Boolean(needle));
        const matchesAgent = needle && agent.title.toLocaleLowerCase().includes(needle);
        const visibleChildren = matchesAgent ? sessions.filter((session) => session.agentId === agent.agentId) : childSessions;
        if (inDrawer && needle && !matchesAgent && visibleChildren.length === 0) return null;
        const tags = [
            ...(displaySettings.showModel && agent.settings.model ? [i18n('Model: {0}', agentModelLabel(agent, modelGroups))] : []),
            ...(displaySettings.showBase && agent.settings.baseDocId ? [i18n('Base: {0}', bases.find((base) => String(base.docId) === agent.settings.baseDocId)?.title || `#${agent.settings.baseDocId}`)] : []),
        ];
        return <div className="eza-teamTreeBranch" key={agent.agentId}>
            <div className="eza-teamTreeRow eza-teamTreeRow--agent" style={{ paddingLeft: `${level * 1.1}rem` }}>
                {editMode && <input
                    type="checkbox"
                    className="eza-teamTreeCheckbox"
                    checked={selectedAgentIds.has(agent.agentId)}
                    onChange={() => onToggleAgentSelection(agent.agentId)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={i18n('Select agent {0}', agent.title)}
                />}
                {visibleChildren.length > 0
                    ? <button type="button" className="eza-teamTreeToggle" onClick={() => setCollapsedAgentIds((current) => {
                        const next = new Set(current);
                        if (next.has(agent.agentId)) next.delete(agent.agentId); else next.add(agent.agentId);
                        return next;
                    })} aria-expanded={expanded} aria-label={i18n(expanded ? 'Collapse sessions' : 'Expand sessions')}><ChevronIcon expanded={expanded} /></button>
                    : <span className="eza-teamTreeSpacer" aria-hidden="true" />}
                <button type="button" className="eza-teamTreeMain" title={i18n('Open settings for agent {0}', agent.title)} onClick={() => {
                    onSelectAgent(agent.agentId);
                    if (inDrawer) onCloseTree();
                }}>
                    <span className="eza-teamTreeIcon eza-teamTreeIcon--agent" aria-hidden="true"><AgentPortraitIcon /></span>
                    <span className="eza-teamTreeLabel">{agent.title}</span>
                    {displaySettings.showTimestamps && <time className="eza-teamTreeMeta" title={new Date(agent.updatedAt).toLocaleString()}>{relativeTimeLabel(agent.updatedAt)}</time>}
                </button>
                <button type="button" className="eza-teamTreeAddSession" title={i18n('Create a session under {0}', agent.title)} aria-label={i18n('Create a session under {0}', agent.title)} onClick={() => onStartSession(agent.agentId)}>＋</button>
            </div>
            {tags.length > 0 && <div className="eza-teamTreeTags" style={{ marginLeft: `${(level + 1) * 1.1 + 2.1}rem` }}>{tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
            {expanded && visibleChildren.length > 0 && <div className="eza-teamTreeChildren">
                {visibleChildren.map((session) => renderAgentRow(session, level + 1, inDrawer))}
            </div>}
        </div>;
    };
    const renderTeamNode = (teamId: string, level: number, inDrawer: boolean, needle = ''): ReactNode => {
        const team = teamById.get(teamId);
        const ungrouped = teamId === SESSION_GROUP_ID;
        if (!team && !ungrouped) return null;
        if (inDrawer && needle && !teamSearchMatches(teamId, needle)) return null;
        const label = team?.text || i18n('Ungrouped');
        const childTeams = childTeamsByParent.get(teamId) || [];
        const childAgents = agentsByTeam.get(teamId) || [];
        const childSessions = sessionsByTeam.get(teamId) || [];
        const hasChildren = childTeams.length > 0 || childAgents.length > 0 || childSessions.length > 0;
        const expanded = expandedTeams.has(teamId) || (inDrawer && Boolean(needle));
        const selected = visibleSelectedTeamId === teamId;
        const items = [
            ...childTeams.map((child) => ({ kind: 'team' as const, id: child.teamId, order: child.order })),
            ...childAgents.map((agent) => ({ kind: 'agentContainer' as const, agent, order: agent.order })),
            ...childSessions.map((session, index) => ({ kind: 'session' as const, session, order: childAgents.length + index })),
        ].sort((a, b) => a.order - b.order);
        return <div className="eza-teamTreeBranch" key={teamId}>
            <div className={`eza-teamTreeRow eza-teamTreeRow--team${selected ? ' is-selected' : ''}`} style={{ paddingLeft: `${level * 1.1}rem` }}>
                {editMode && <input
                    type="checkbox"
                    className="eza-teamTreeCheckbox"
                    checked={selectedTeamIds.has(teamId)}
                    disabled={team?.isRootTeam === true}
                    onChange={() => toggleTeamSelection(teamId)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={i18n('Select team {0}', label)}
                />}
                {hasChildren
                    ? <button type="button" className="eza-teamTreeToggle" onClick={() => toggleTeamExpansion(teamId)} aria-expanded={expanded} aria-label={i18n(expanded ? 'Collapse' : 'Expand')}><ChevronIcon expanded={expanded} /></button>
                    : <span className="eza-teamTreeSpacer" aria-hidden="true" />}
                <button
                    type="button"
                    className="eza-teamTreeMain"
                    title={label}
                    onClick={() => {
                        if (inDrawer) { onSelectTeam(teamId); onCloseTree(); }
                        else requestTeamSwitch(teamId);
                    }}
                >
                    <span className="eza-teamTreeIcon eza-teamTreeIcon--team" aria-hidden="true"><TeamPeopleIcon /></span>
                    <span className="eza-teamTreeLabel">{label}</span>
                    {displaySettings.showTimestamps && team && <time className="eza-teamTreeMeta" title={new Date(team.updatedAt).toLocaleString()}>{relativeTimeLabel(team.updatedAt)}</time>}
                </button>
            </div>
            {expanded && hasChildren && <div className="eza-teamTreeChildren">
                {items.map((item) => item.kind === 'team'
                    ? renderTeamNode(item.id, level + 1, inDrawer, needle)
                    : item.kind === 'agentContainer'
                        ? renderAgentNode(item.agent, level + 1, inDrawer, needle)
                        : renderAgentRow(item.session, level + 1, inDrawer))}
            </div>}
        </div>;
    };
    const renderTree = (rootIds: string[], inDrawer = false): ReactNode => {
        const needle = inDrawer ? query.trim().toLocaleLowerCase() : '';
        const roots = rootIds.map((teamId) => renderTeamNode(teamId, 0, inDrawer, needle)).filter(Boolean);
        return roots.length > 0 ? roots : <p className="eza-teamTreeEmpty">{i18n('No sessions')}</p>;
    };
    useEffect(() => {
        if (!treeOpen && !pendingTeamId) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            if (pendingTeamId) cancelTeamSwitch();
            else onCloseTree();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [treeOpen, pendingTeamId, cancelTeamSwitch, onCloseTree]);
    const startDrawerResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drawerResizeRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: drawerWidth };
    }, [drawerWidth]);
    const moveDrawerResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        const resize = drawerResizeRef.current;
        if (!resize || resize.pointerId !== event.pointerId) return;
        setDrawerWidth(Math.min(720, Math.max(320, resize.startWidth + event.clientX - resize.startX)));
    }, []);
    const endDrawerResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (drawerResizeRef.current?.pointerId === event.pointerId) drawerResizeRef.current = null;
    }, []);
    return <section className="eza-agentStructure" aria-label={i18n('Team, Agent, and Session tree')}>
        <div ref={toolsRef} className="eza-agentStructure__tools">
            <input value={query} placeholder={i18n('Search teams, agents, or sessions')} aria-label={i18n('Search teams, agents, or sessions')} onChange={(event) => onQuery(event.target.value)} />
            <button type="button" onClick={onCreateAgent}>{i18n('New smart agent')}</button>
            <button type="button" onClick={onCreateTeam}>{i18n('New team')}</button>
        </div>
        {editMode && <div className="eza-selectionToolbar" style={toolbarTop === null ? undefined : { top: `${toolbarTop}px` }} role="toolbar" aria-label={i18n('Editing actions')}>
            <span>{i18n('{0} agents · {1} sessions · {2} teams', selectedAgentIds.size, selectedSessionIds.size, selectedTeamIds.size)}</span>
            <button type="button" disabled={sessionTitleSaving || !canEditTeam} onClick={() => { if (selectedTeamId) onRenameTeam(selectedTeamId); }}>{i18n('Rename team')}</button>
            <button type="button" className="eza-selectionToolbarSave" disabled={sessionTitleSaving} onClick={() => { void onSaveSessionTitles(); }}>{sessionTitleSaving ? i18n('Saving...') : i18n('Save session names')}</button>
            <button type="button" className="eza-selectionToolbarDelete" disabled={sessionTitleSaving || (selectedAgentIds.size === 0 && selectedSessionIds.size === 0 && selectedTeamIds.size === 0)} onClick={onDeleteSelected}>{i18n('Delete')}</button>
            <button type="button" className="eza-selectionToolbarExit" disabled={sessionTitleSaving} onClick={onExitEdit}>{i18n('Exit edit mode')}</button>
        </div>}
        <div className="eza-agentStructure__tree eza-teamTree">{renderTree(renderedRootTeamIds)}</div>
        {treeOpen && createPortal(<>
            <button type="button" className="eza-teamTreeBackdrop" aria-label={i18n('Close team structure')} onClick={onCloseTree} />
            <aside className="eza-teamTreeDrawer" style={{ width: `min(${drawerWidth}px, calc(100vw - 1rem))` }} role="dialog" aria-modal="true" aria-label={i18n('Team structure')}>
                <header className="eza-teamTreeDrawerHeader">
                    <strong>{i18n('Team structure')}</strong>
                    <span>{teams.length + agents.length + sessions.length}</span>
                    <button type="button" onClick={onCloseTree} aria-label={i18n('Close')}>×</button>
                </header>
                <div className="eza-teamTreeDrawerBody eza-teamTree">{renderTree(rootTeamIds, true)}</div>
            </aside>
            <div
                className="eza-teamTreeResize"
                style={{ left: `min(${drawerWidth}px, calc(100vw - 1rem))` }}
                role="separator"
                aria-orientation="vertical"
                aria-label={i18n('Resize team panel')}
                onPointerDown={startDrawerResize}
                onPointerMove={moveDrawerResize}
                onPointerUp={endDrawerResize}
                onPointerCancel={endDrawerResize}
                onLostPointerCapture={endDrawerResize}
            />
        </>, document.body)}
        {pendingTeamId && createPortal(<div className="eza-teamSwitchConfirmBackdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) cancelTeamSwitch(); }}>
            <section className="eza-teamSwitchConfirm" role="alertdialog" aria-modal="true" aria-labelledby="eza-teamSwitchConfirm-title">
                <h2 id="eza-teamSwitchConfirm-title">{i18n('Switch team?')}</h2>
                <p>{pendingTeamLabel ? i18n('Switch to "{0}"?', pendingTeamLabel) : i18n('Switch the current team?')}</p>
                <div className="eza-teamSwitchConfirmActions">
                    <button type="button" onClick={cancelTeamSwitch}>{i18n('Cancel')}</button>
                    <button type="button" className="is-primary" onClick={confirmTeamSwitch}>{i18n('Switch')}</button>
                </div>
            </section>
        </div>, document.body)}
        {searchHasMore && <p className="eza-teamTreeHint">{i18n('Only part of the search results are shown. Narrow your search.')}</p>}
    </section>;
}
