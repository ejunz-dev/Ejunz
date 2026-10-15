import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BaseDetailTree, BaseDetailTreeDrawer, defaultBaseDetailDisplaySettings, type BaseDetailCard, type BaseDetailNode } from '@ejunz/ui-next';
import { BaseDetailConfirmDialog } from '../../../../components/base-detail/BaseDetailConfirmDialog';
import { StateDot, type StateDotState } from '../primitives/StateDot';
import { MarkdownText } from '../primitives/markdown/MarkdownText';
import type { AgentTeam, SessionSummary, BaseView } from '../../runtime/session';
import type { SessionModels } from '../types';
import type { AgentDisplaySettings } from './AgentDisplaySettingsDialog';
import { getAgentPluginSessionAgentTags, hasAgentPluginSessionAgentTags } from '../../runtime/agent-plugin-slots';
import { filterSessions } from './session-tree-utils';
import '../../../../components/base-detail/base-detail.css';

interface TeamTreeProps {
    sessions: SessionSummary[];
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
    activeAgentPluginIds: ReadonlySet<string>;
    displaySettings: AgentDisplaySettings;
    query: string;
    searchMatches: ReadonlySet<string> | null;
    searchSnippets: ReadonlyMap<string, string>;
    searchHasMore: boolean;
    editMode: boolean;
    selectedAgentIds: ReadonlySet<string>;
    selectedTeamIds: ReadonlySet<string>;
    sessionTitleDrafts: Readonly<Record<string, string>>;
    onToggleAgentSelection: (agentId: string) => void;
    onToggleTeamSelection: (teamIds: readonly string[], agentIds: readonly string[], ancestorIds: readonly string[]) => void;
    onCreateTeam: () => void;
    onRenameTeam: (teamId: string) => void;
    onSessionTitleChange: (sessionId: string, title: string) => void;
    onSaveSessionTitles: () => void | Promise<void>;
    sessionTitleSaving: boolean;
    onQuery: (value: string) => void;
    onSelect: (sessionId: string) => void;
    onStartSession: () => void;
    onDeleteSelected: () => void;
    onExitEdit: () => void;
}

const SESSION_GROUP_ID = 'agent-sessions';

function sessionTitle(session: SessionSummary): string {
    const title = session.projections?.values?.title;
    if (typeof title === 'string' && title.trim()) return title;
    return session.blank ? '新会话' : `会话 ${session.sessionId.slice(8, 16)}`;
}

function sessionModelLabel(session: SessionSummary, modelGroups?: SessionModels['groups']): string {
    const selectedModel = session.model;
    if (!selectedModel?.provider || !selectedModel.model) return '未选择';
    const group = modelGroups?.find((item) => item.id === selectedModel.provider);
    const selected = group?.models.find((item) => item.id === selectedModel.model);
    return `${group?.name || selectedModel.provider} / ${selected?.name || selectedModel.model}`;
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
    const statusLabel = sendStatus === 'sending' ? '发送中' : sendStatus === 'sent' ? '发送成功' : '发送失败';
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
    const stateLabel = error ? '运行失败' : waitingForAnswer ? '等待回答' : session.running ? '运行中' : '已完成';
    const activity = error ? `Error · ${flatLine(error)}` : activityPreview;
    if (editMode) {
        return <>
            {showStatus && <StateDot state={state} size={10} className="eza-sessionStateDot" />}
            <span className="eza-sessionCardTitleText">
                <input
                    className="eza-sessionTitleEditor"
                    aria-label="会话名称"
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
            <span className="bd-tree__label">{title}</span>
            <SessionActivityRow activity={activity} index={activityIndex ?? 1} error={Boolean(error)} active={state === 'ongoing'} sendStatus={error ? undefined : activityStatus} />
        </span>
    </button>;
});

export function TeamTree({
    sessions, teams: teams, treeOpen, activeTeamId, onSelectTeam, onCloseTree, bases, current, pendingQuestionSessionIds, sessionErrors, sessionActivityPreviews, modelGroups, activeAgentPluginIds, displaySettings, query, searchMatches, searchSnippets, searchHasMore,
    editMode, selectedAgentIds, selectedTeamIds, sessionTitleDrafts, onToggleAgentSelection, onToggleTeamSelection, onCreateTeam, onRenameTeam, onSessionTitleChange, onSaveSessionTitles, sessionTitleSaving,
    onQuery, onSelect, onStartSession, onDeleteSelected, onExitEdit,
}: TeamTreeProps) {
    const toolsRef = useRef<HTMLDivElement>(null);
    const [toolbarTop, setToolbarTop] = useState<number | null>(null);
    const [expandedTeams, setExpandedTeams] = useState<Set<string>>(() => new Set([SESSION_GROUP_ID]));
    const [pendingTeamId, setPendingTeamId] = useState<string | null>(null);
    const visibleSessions = useMemo(() => filterSessions(sessions, current, query, searchMatches), [current, query, searchMatches, sessions]);
    const agentRootTeam = useMemo(() => teams.find((team) => team.isRootTeam), [teams]);
    const fallbackTeamId = agentRootTeam?.teamId ?? SESSION_GROUP_ID;
    const sessionsByTeam = useMemo(() => {
        const validTeamIds = new Set(teams.map((team) => team.teamId));
        const groups = new Map<string, SessionSummary[]>();
        visibleSessions.forEach((session) => {
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
    const treeNodes = useMemo<BaseDetailNode[]>(() => [
        ...(!agentRootTeam && ungroupedSessions.length > 0 ? [{ id: SESSION_GROUP_ID, text: '未分组', type: 'session_group', order: 0, expanded: true }] : []),
        ...teams.map((team) => ({ id: team.teamId, text: team.text, type: 'session_group', order: team.order, expanded: true })),
    ], [teams, agentRootTeam, ungroupedSessions.length]);
    const edges = useMemo(() => teams.flatMap((team) => team.parentTeamId ? [{ source: team.parentTeamId, target: team.teamId }] : []), [teams]);
    const rootTeamIds = useMemo(() => {
        if (agentRootTeam) return [agentRootTeam.teamId];
        return [
            ...(ungroupedSessions.length > 0 ? [SESSION_GROUP_ID] : []),
            ...teams.filter((team) => !team.parentTeamId).map((team) => team.teamId),
        ];
    }, [teams, agentRootTeam, ungroupedSessions.length]);
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
        ? '未分组'
        : teams.find((team) => team.teamId === pendingTeamId)?.text || '';
    const topSelectedTeamIds = teams
        .filter((team) => !team.isRootTeam && selectedTeamIds.has(team.teamId)
            && !edges.some((edge) => edge.target === team.teamId && selectedTeamIds.has(edge.source)))
        .map((team) => team.teamId);
    const selectedTeamId = selectedTeamIds.has(SESSION_GROUP_ID) ? undefined : topSelectedTeamIds.length === 1 ? topSelectedTeamIds[0] : undefined;
    const canEditTeam = selectedTeamId !== undefined && selectedTeamId !== agentRootTeam?.teamId;
    const teamAgentsMap = useMemo<Record<string, BaseDetailCard[]>>(() => {
        const agents: Record<string, BaseDetailCard[]> = { [SESSION_GROUP_ID]: [] };
        const toCard = (session: SessionSummary, teamId: string, order: number): BaseDetailCard => {
            const tags: string[] = [];
            if (displaySettings.showModel) tags.push(`模型: ${sessionModelLabel(session, modelGroups)}`);
            tags.push(...getAgentPluginSessionAgentTags(session, bases, displaySettings.showBase));
            return {
                docId: session.sessionId,
                title: sessionTitle(session),
                content: searchSnippets.get(session.sessionId) || session.cwd || '',
                cardType: 'session',
                nodeId: teamId,
                order,
                ...(session.createdAt === undefined ? {} : { createdAt: new Date(session.createdAt) }),
                updateAt: new Date(session.updatedAt),
                tags,
            };
        };
        agents[SESSION_GROUP_ID] = ungroupedSessions.map((session, index) => toCard(session, SESSION_GROUP_ID, index));
        teams.forEach((team) => {
            agents[team.teamId] = (sessionsByTeam.get(team.teamId) || []).map((session, index) => toCard(session, team.teamId, index));
        });
        return agents;
    }, [teams, activeAgentPluginIds, bases, displaySettings, modelGroups, searchSnippets, sessionsByTeam, ungroupedSessions]);
    const selectSessionAgent = useCallback((agentCard: BaseDetailCard, switchTeam = false) => {
        const session = visibleSessions.find((item) => item.sessionId === String(agentCard.docId));
        const teamId = session?.teamId && teams.some((team) => team.teamId === session.teamId) ? session.teamId : fallbackTeamId;
        if (switchTeam) onSelectTeam(teamId);
        onSelect(String(agentCard.docId));
    }, [teams, fallbackTeamId, onSelect, onSelectTeam, visibleSessions]);
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
            edges.forEach((edge) => { if (edge.source === teamId) pending.push(edge.target); });
        }
        const branchAgentIds = branchTeamIds.flatMap((teamId) => (teamAgentsMap[teamId] || []).map((agentCard) => String(agentCard.docId)));
        const ancestorIds: string[] = [];
        let ancestorId = rootTeamId;
        while (true) {
            const parent = edges.find((edge) => edge.target === ancestorId)?.source;
            if (!parent || ancestorIds.includes(parent)) break;
            ancestorIds.push(parent);
            ancestorId = parent;
        }
        onToggleTeamSelection(branchTeamIds, branchAgentIds, ancestorIds);
    }, [agentRootTeam, edges, teamAgentsMap, onToggleTeamSelection]);
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
    const treeDisplaySettings = useMemo(() => ({
        ...defaultBaseDetailDisplaySettings(),
        showProblemCount: false,
        showNodeNumber: false,
        showCardTimestamps: displaySettings.showTimestamps,
        showProblemTree: false,
        showProblemTags: false,
        showCardTags: displaySettings.showModel || (displaySettings.showBase && hasAgentPluginSessionAgentTags()),
    }), [activeAgentPluginIds, displaySettings]);
    const renderCardTitle = useMemo(() => {
        if (!displaySettings.showStatus && !editMode) return undefined;
        return (card: BaseDetailCard) => {
            const session = visibleSessions.find((item) => item.sessionId === card.docId);
            if (!session) return <span className="bd-tree__label">{String(card.title ?? '')}</span>;
            const activity = sessionActivityPreviews.get(session.sessionId);
            return <SessionAgentTitle
                session={session}
                error={sessionErrors.get(session.sessionId)}
                waitingForAnswer={pendingQuestionSessionIds.has(session.sessionId)}
                activityPreview={activity?.text}
                activityIndex={activity?.index}
                activityStatus={activity?.sendStatus}
                showStatus={displaySettings.showStatus}
                editMode={editMode}
                draftTitle={sessionTitleDrafts[session.sessionId]}
                onTitleChange={onSessionTitleChange}
                onSelect={onSelect}
            />;
        };
    }, [displaySettings.showStatus, editMode, onSelect, onSessionTitleChange, pendingQuestionSessionIds, sessionErrors, sessionActivityPreviews, sessionTitleDrafts, visibleSessions]);
    return <section className="eza-agentStructure" aria-label="团队与 Agent">
        <div ref={toolsRef} className="eza-agentStructure__tools">
            <input value={query} placeholder="搜索 Agent" aria-label="搜索 Agent" onChange={(event) => onQuery(event.target.value)} />
            <button type="button" onClick={onStartSession}>新会话</button>
            <button type="button" onClick={onCreateTeam}>新团队</button>
        </div>
        {editMode && <div className="eza-selectionToolbar" style={toolbarTop === null ? undefined : { top: `${toolbarTop}px` }} role="toolbar" aria-label="编辑操作">
            <span>Agent {selectedAgentIds.size} · 团队 {selectedTeamIds.size}</span>
            <button type="button" disabled={sessionTitleSaving || !canEditTeam} onClick={() => { if (selectedTeamId) onRenameTeam(selectedTeamId); }}>重命名团队</button>
            <button type="button" className="eza-selectionToolbarSave" disabled={sessionTitleSaving} onClick={() => { void onSaveSessionTitles(); }}>{sessionTitleSaving ? '保存中…' : '保存会话名'}</button>
            <button type="button" className="eza-selectionToolbarDelete" disabled={sessionTitleSaving || (selectedAgentIds.size === 0 && selectedTeamIds.size === 0)} onClick={onDeleteSelected}>删除</button>
            <button type="button" className="eza-selectionToolbarExit" disabled={sessionTitleSaving} onClick={onExitEdit}>退出编辑</button>
        </div>}
        <div className="bd-content bd-content--tree eza-agentStructure__tree">
            <BaseDetailTree
                rootNodeIds={renderedRootTeamIds}
                nodes={treeNodes}
                edges={edges}
                nodeCardsMap={teamAgentsMap}
                expandedNodes={expandedTeams}
                onToggle={toggleTeamExpansion}
                selectedNodeId={visibleSelectedTeamId}
                selectedCardId={current}
                onSelectNode={requestTeamSwitch}
                onSelectCard={selectSessionAgent}
                filter=""
                displaySettings={treeDisplaySettings}
                renderCardTitle={renderCardTitle}
                editMode={editMode}
                selectedNodeIds={selectedTeamIds}
                selectedCardIds={selectedAgentIds}
                onToggleNodeSelection={toggleTeamSelection}
                onToggleCardSelection={onToggleAgentSelection}
                emptyMessage="暂无会话"
            />
        </div>
        <BaseDetailTreeDrawer
            open={treeOpen}
            nodes={treeNodes}
            edges={edges}
            nodeCardsMap={teamAgentsMap}
            expandedNodes={expandedTeams}
            selectedNodeId={visibleSelectedTeamId}
            selectedCardId={current}
            onToggle={toggleTeamExpansion}
            onSelectNode={(teamId) => { onSelectTeam(teamId); onCloseTree(); }}
            onSelectCard={(agent) => { selectSessionAgent(agent, true); onCloseTree(); }}
            onClose={onCloseTree}
            filter={query}
            displaySettings={treeDisplaySettings}
        />
        {pendingTeamId ? <BaseDetailConfirmDialog
            nodeLabel={`切换到“${pendingTeamLabel}”？`}
            onConfirm={confirmTeamSwitch}
            onCancel={cancelTeamSwitch}
        /> : null}
        {searchHasMore && <p className="bd-muted eza-agentStructure__hint">仅显示部分搜索结果，请缩小搜索范围。</p>}
    </section>;
}
