import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BaseDetailTree, BaseDetailTreeDrawer, defaultBaseDetailDisplaySettings, type BaseDetailCard, type BaseDetailNode } from '@ejunz/ui-next';
import { BaseDetailConfirmDialog } from '../../../../components/base-detail/BaseDetailConfirmDialog';
import { StateDot, type StateDotState } from '../primitives/StateDot';
import { MarkdownText } from '../primitives/markdown/MarkdownText';
import type { AgentNode, SessionSummary, BaseView } from '../../runtime/session';
import type { SessionModels } from '../types';
import type { AgentDisplaySettings } from './AgentDisplaySettingsDialog';
import { getAgentPluginSessionCardTags, hasAgentPluginSessionCardTags } from '../../runtime/agent-plugin-slots';
import { filterSessions } from './session-tree-utils';
import '../../../../components/base-detail/base-detail.css';

interface SessionTreeProps {
    sessions: SessionSummary[];
    nodes: AgentNode[];
    treeOpen: boolean;
    activeNodeId: string | null;
    onSelectNode: (nodeId: string) => void;
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
    selectedCardIds: ReadonlySet<string>;
    selectedNodeIds: ReadonlySet<string>;
    sessionTitleDrafts: Readonly<Record<string, string>>;
    onToggleCardSelection: (cardId: string) => void;
    onToggleNodeSelection: (nodeIds: readonly string[], cardIds: readonly string[], ancestorIds: readonly string[]) => void;
    onCreateNode: () => void;
    onRenameNode: (nodeId: string) => void;
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

const SessionCardTitle = memo(function SessionCardTitle({ session, error, waitingForAnswer, activityPreview, activityIndex, activityStatus, showStatus, editMode, draftTitle, onTitleChange, onSelect }: {
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
    const stateLabel = session.isDraftCard ? '待开始' : error ? '运行失败' : waitingForAnswer ? '等待回答' : session.running ? '运行中' : '已完成';
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

export function SessionTree({
    sessions, nodes: agentNodes, treeOpen, activeNodeId, onSelectNode, onCloseTree, bases, current, pendingQuestionSessionIds, sessionErrors, sessionActivityPreviews, modelGroups, activeAgentPluginIds, displaySettings, query, searchMatches, searchSnippets, searchHasMore,
    editMode, selectedCardIds, selectedNodeIds, sessionTitleDrafts, onToggleCardSelection, onToggleNodeSelection, onCreateNode, onRenameNode, onSessionTitleChange, onSaveSessionTitles, sessionTitleSaving,
    onQuery, onSelect, onStartSession, onDeleteSelected, onExitEdit,
}: SessionTreeProps) {
    const toolsRef = useRef<HTMLDivElement>(null);
    const [toolbarTop, setToolbarTop] = useState<number | null>(null);
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(() => new Set([SESSION_GROUP_ID]));
    const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);
    const visibleSessions = useMemo(() => filterSessions(sessions, current, query, searchMatches), [current, query, searchMatches, sessions]);
    const agentRootNode = useMemo(() => agentNodes.find((node) => node.isRoot), [agentNodes]);
    const fallbackNodeId = agentRootNode?.nodeId ?? SESSION_GROUP_ID;
    const sessionsByNode = useMemo(() => {
        const validNodeIds = new Set(agentNodes.map((node) => node.nodeId));
        const groups = new Map<string, SessionSummary[]>();
        visibleSessions.forEach((session) => {
            const nodeId = session.nodeId && validNodeIds.has(session.nodeId) ? session.nodeId : fallbackNodeId;
            const group = groups.get(nodeId) || [];
            group.push(session);
            groups.set(nodeId, group);
        });
        return groups;
    }, [agentNodes, fallbackNodeId, visibleSessions]);
    const ungroupedSessions = sessionsByNode.get(SESSION_GROUP_ID) || [];
    const visibleSelectedNodeId = activeNodeId ?? (ungroupedSessions.length > 0 ? SESSION_GROUP_ID : agentRootNode?.nodeId ?? null);
    useEffect(() => {
        if (!agentRootNode) return;
        setExpandedNodes((current) => current.has(agentRootNode.nodeId) ? current : new Set([...current, agentRootNode.nodeId]));
    }, [agentRootNode]);
    const toggleNodeExpansion = useCallback((nodeId: string) => {
        setExpandedNodes((current) => {
            const next = new Set(current);
            if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId);
            return next;
        });
    }, []);
    const nodes = useMemo<BaseDetailNode[]>(() => [
        ...(!agentRootNode && ungroupedSessions.length > 0 ? [{ id: SESSION_GROUP_ID, text: '未分组', type: 'session_group', order: 0, expanded: true }] : []),
        ...agentNodes.map((node) => ({ id: node.nodeId, text: node.text, type: 'session_group', order: node.order, expanded: true })),
    ], [agentNodes, agentRootNode, ungroupedSessions.length]);
    const edges = useMemo(() => agentNodes.flatMap((node) => node.parentId ? [{ source: node.parentId, target: node.nodeId }] : []), [agentNodes]);
    const rootNodeIds = useMemo(() => {
        if (agentRootNode) return [agentRootNode.nodeId];
        return [
            ...(ungroupedSessions.length > 0 ? [SESSION_GROUP_ID] : []),
            ...agentNodes.filter((node) => !node.parentId).map((node) => node.nodeId),
        ];
    }, [agentNodes, agentRootNode, ungroupedSessions.length]);
    const renderedRootNodeIds = activeNodeId && rootNodeIds.includes(activeNodeId) ? [activeNodeId] : rootNodeIds;
    const requestNodeSwitch = useCallback((nodeId: string) => {
        if (nodeId !== visibleSelectedNodeId) setPendingNodeId(nodeId);
    }, [visibleSelectedNodeId]);
    const confirmNodeSwitch = useCallback(() => {
        if (pendingNodeId) onSelectNode(pendingNodeId);
        setPendingNodeId(null);
    }, [onSelectNode, pendingNodeId]);
    const cancelNodeSwitch = useCallback(() => setPendingNodeId(null), []);
    const pendingNodeLabel = pendingNodeId === SESSION_GROUP_ID
        ? '未分组'
        : agentNodes.find((node) => node.nodeId === pendingNodeId)?.text || '';
    const topSelectedNodeIds = agentNodes
        .filter((node) => !node.isRoot && selectedNodeIds.has(node.nodeId)
            && !edges.some((edge) => edge.target === node.nodeId && selectedNodeIds.has(edge.source)))
        .map((node) => node.nodeId);
    const selectedNodeId = selectedNodeIds.has(SESSION_GROUP_ID) ? undefined : topSelectedNodeIds.length === 1 ? topSelectedNodeIds[0] : undefined;
    const canEditNode = selectedNodeId !== undefined && selectedNodeId !== agentRootNode?.nodeId;
    const nodeCardsMap = useMemo<Record<string, BaseDetailCard[]>>(() => {
        const cards: Record<string, BaseDetailCard[]> = { [SESSION_GROUP_ID]: [] };
        const toCard = (session: SessionSummary, nodeId: string, order: number): BaseDetailCard => {
            const tags: string[] = [];
            if (displaySettings.showModel) tags.push(`模型: ${sessionModelLabel(session, modelGroups)}`);
            tags.push(...getAgentPluginSessionCardTags(session, bases, displaySettings.showBase));
            return {
                docId: session.sessionId,
                title: sessionTitle(session),
                content: searchSnippets.get(session.sessionId) || session.cwd || '',
                cardType: 'session',
                nodeId,
                order,
                ...(session.createdAt === undefined ? {} : { createdAt: new Date(session.createdAt) }),
                updateAt: new Date(session.updatedAt),
                tags,
            };
        };
        cards[SESSION_GROUP_ID] = ungroupedSessions.map((session, index) => toCard(session, SESSION_GROUP_ID, index));
        agentNodes.forEach((node) => {
            cards[node.nodeId] = (sessionsByNode.get(node.nodeId) || []).map((session, index) => toCard(session, node.nodeId, index));
        });
        return cards;
    }, [agentNodes, activeAgentPluginIds, bases, displaySettings, modelGroups, searchSnippets, sessionsByNode, ungroupedSessions]);
    const selectSessionCard = useCallback((card: BaseDetailCard, switchNode = false) => {
        const session = visibleSessions.find((item) => item.sessionId === String(card.docId));
        const nodeId = session?.nodeId && agentNodes.some((node) => node.nodeId === session.nodeId) ? session.nodeId : fallbackNodeId;
        if (switchNode) onSelectNode(nodeId);
        onSelect(String(card.docId));
    }, [agentNodes, fallbackNodeId, onSelect, onSelectNode, visibleSessions]);
    const toggleNodeSelection = useCallback((rootNodeId: string) => {
        if (agentRootNode?.nodeId === rootNodeId) return;
        const branchNodeIds: string[] = [];
        const pending = [rootNodeId];
        const visited = new Set<string>();
        while (pending.length > 0) {
            const nodeId = pending.pop()!;
            if (visited.has(nodeId)) continue;
            visited.add(nodeId);
            branchNodeIds.push(nodeId);
            edges.forEach((edge) => { if (edge.source === nodeId) pending.push(edge.target); });
        }
        const branchCardIds = branchNodeIds.flatMap((nodeId) => (nodeCardsMap[nodeId] || []).map((card) => String(card.docId)));
        const ancestorIds: string[] = [];
        let ancestorId = rootNodeId;
        while (true) {
            const parent = edges.find((edge) => edge.target === ancestorId)?.source;
            if (!parent || ancestorIds.includes(parent)) break;
            ancestorIds.push(parent);
            ancestorId = parent;
        }
        onToggleNodeSelection(branchNodeIds, branchCardIds, ancestorIds);
    }, [agentRootNode, edges, nodeCardsMap, onToggleNodeSelection]);
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
        showNodeCardTimestamps: displaySettings.showTimestamps,
        showProblemTree: false,
        showProblemTags: false,
        showCardTags: displaySettings.showModel || (displaySettings.showBase && hasAgentPluginSessionCardTags()),
    }), [activeAgentPluginIds, displaySettings]);
    const renderCardTitle = useMemo(() => {
        if (!displaySettings.showStatus && !editMode) return undefined;
        return (card: BaseDetailCard) => {
            const session = visibleSessions.find((item) => item.sessionId === card.docId);
            if (!session) return <span className="bd-tree__label">{String(card.title ?? '')}</span>;
            const activity = sessionActivityPreviews.get(session.sessionId);
            return <SessionCardTitle
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
    return <section className="eza-agentStructure" aria-label="会话">
        <div ref={toolsRef} className="eza-agentStructure__tools">
            <input value={query} placeholder="搜索会话" aria-label="搜索会话" onChange={(event) => onQuery(event.target.value)} />
            <button type="button" onClick={onStartSession}>新会话</button>
            <button type="button" onClick={onCreateNode}>新节点</button>
        </div>
        {editMode && <div className="eza-selectionToolbar" style={toolbarTop === null ? undefined : { top: `${toolbarTop}px` }} role="toolbar" aria-label="编辑操作">
            <span>会话 {selectedCardIds.size} · 文件夹 {selectedNodeIds.size}</span>
            <button type="button" disabled={sessionTitleSaving || !canEditNode} onClick={() => { if (selectedNodeId) onRenameNode(selectedNodeId); }}>重命名文件夹</button>
            <button type="button" className="eza-selectionToolbarSave" disabled={sessionTitleSaving} onClick={() => { void onSaveSessionTitles(); }}>{sessionTitleSaving ? '保存中…' : '保存会话名'}</button>
            <button type="button" className="eza-selectionToolbarDelete" disabled={sessionTitleSaving || (selectedCardIds.size === 0 && selectedNodeIds.size === 0)} onClick={onDeleteSelected}>删除</button>
            <button type="button" className="eza-selectionToolbarExit" disabled={sessionTitleSaving} onClick={onExitEdit}>退出编辑</button>
        </div>}
        <div className="bd-content bd-content--tree eza-agentStructure__tree">
            <BaseDetailTree
                rootNodeIds={renderedRootNodeIds}
                nodes={nodes}
                edges={edges}
                nodeCardsMap={nodeCardsMap}
                expandedNodes={expandedNodes}
                onToggle={toggleNodeExpansion}
                selectedNodeId={visibleSelectedNodeId}
                selectedCardId={current}
                onSelectNode={requestNodeSwitch}
                onSelectCard={selectSessionCard}
                filter=""
                displaySettings={treeDisplaySettings}
                renderCardTitle={renderCardTitle}
                editMode={editMode}
                selectedNodeIds={selectedNodeIds}
                selectedCardIds={selectedCardIds}
                onToggleNodeSelection={toggleNodeSelection}
                onToggleCardSelection={onToggleCardSelection}
                emptyMessage="暂无会话"
            />
        </div>
        <BaseDetailTreeDrawer
            open={treeOpen}
            nodes={nodes}
            edges={edges}
            nodeCardsMap={nodeCardsMap}
            expandedNodes={expandedNodes}
            selectedNodeId={visibleSelectedNodeId}
            selectedCardId={current}
            onToggle={toggleNodeExpansion}
            onSelectNode={(nodeId) => { onSelectNode(nodeId); onCloseTree(); }}
            onSelectCard={(card) => { selectSessionCard(card, true); onCloseTree(); }}
            onClose={onCloseTree}
            filter={query}
            displaySettings={treeDisplaySettings}
        />
        {pendingNodeId ? <BaseDetailConfirmDialog
            nodeLabel={`切换到“${pendingNodeLabel}”？`}
            onConfirm={confirmNodeSwitch}
            onCancel={cancelNodeSwitch}
        /> : null}
        {searchHasMore && <p className="bd-muted eza-agentStructure__hint">仅显示部分搜索结果，请缩小搜索范围。</p>}
    </section>;
}
