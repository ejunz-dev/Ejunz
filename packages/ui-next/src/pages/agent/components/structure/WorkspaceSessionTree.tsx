import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BaseDetailTree, defaultBaseDetailDisplaySettings, type BaseDetailCard, type BaseDetailEdge, type BaseDetailNode } from '@ejunz/ui-next';
import { StateDot, type StateDotState } from '../primitives/StateDot';
import { MarkdownText } from '../primitives/markdown/MarkdownText';
import type { SessionSummary, BaseView, WorkspaceView } from '../../runtime/session';
import type { SessionModels } from '../types';
import type { AgentDisplaySettings } from './AgentDisplaySettingsDialog';
import { deriveGroups, sessionTitle } from '../sidebar/tree';

interface WorkspaceSessionTreeProps {
    sessions: SessionSummary[];
    workspaces: WorkspaceView[];
    bases: BaseView[];
    current: string | null;
    pendingQuestionSessionIds: ReadonlySet<string>;
    sessionErrors: ReadonlyMap<string, string>;
    sessionActivityPreviews: ReadonlyMap<string, { index: number; text: string }>;
    modelGroups?: SessionModels['groups'];
    displaySettings: AgentDisplaySettings;
    query: string;
    searchMatches: ReadonlySet<string> | null;
    searchSnippets: ReadonlyMap<string, string>;
    searchHasMore: boolean;
    archivedSessionIds: ReadonlySet<string>;
    collapsedWorkspaces: Record<string, boolean>;
    editMode: boolean;
    selectedNodeIds: ReadonlySet<string>;
    selectedCardIds: ReadonlySet<string>;
    sessionTitleDrafts: Readonly<Record<string, string>>;
    onToggleNodeSelection: (nodeId: string, cardIds: string[]) => void;
    onToggleCardSelection: (cardId: string) => void;
    onSessionTitleChange: (sessionId: string, title: string) => void;
    onSaveSessionTitles: () => void | Promise<void>;
    sessionTitleSaving: boolean;
    onQuery: (value: string) => void;
    onSelect: (sessionId: string) => void;
    onRenameSession: (sessionId: string, title: string) => void;
    onForkSession: (sessionId: string) => void;
    onArchiveSession: (sessionId: string) => void;
    onHardDeleteSession: (sessionId: string) => void;
    onRenameWorkspace: (workspaceId: string, title: string) => void;
    onDeleteWorkspace: (workspaceId: string, title: string) => void;
    onCreateWorkspace: () => void;
    onMoveWorkspace: (workspaceId: string, beforeWorkspaceId?: string) => void;
    onMoveSession: (workspaceId: string, sessionId: string, beforeSessionId?: string) => void;
    onToggleWorkspace: (workspaceId: string) => void;
    onStartSession: (workspaceId?: string) => void;
    onDeleteSelected: () => void;
    onExitEdit: () => void;
}

function sessionBaseLabel(session: SessionSummary, bases: readonly BaseView[]): string {
    const rawId = session.baseDocId;
    const baseId = rawId === undefined || rawId === null || rawId === '' ? NaN : Number(rawId);
    const base = Number.isSafeInteger(baseId) ? bases.find((item) => item.docId === baseId) : undefined;
    return base?.title || (Number.isSafeInteger(baseId) ? `Base #${baseId}` : '未选择');
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

const SessionActivityRow = memo(function SessionActivityRow({ activity, index, error, active }: { activity?: string; index: number; error: boolean; active: boolean }) {
    if (!activity) return <div className="eja-sessionCardActivity eja-sessionCardActivityEmpty" aria-hidden="true" />;
    const separator = activity.indexOf(' · ');
    const title = separator < 0 ? activity : activity.slice(0, separator);
    const output = separator < 0 ? '' : activity.slice(separator + 3);
    const titleClass = title === 'Inject' ? 'eja-sessionCardActivityTitle--inject'
        : title === 'Think' ? 'eja-sessionCardActivityTitle--think'
            : title === 'Tool' ? 'eja-sessionCardActivityTitle--tool'
                : title === 'Error' ? 'eja-sessionCardActivityTitle--error' : 'eja-sessionCardActivityTitle--agent';
    return <div className="eja-sessionCardActivity" data-active={active || undefined} title={activity}>
        <span className="eja-sessionCardActivityIndex">#{index}</span>
        <span className={`eja-sessionCardActivityTitle ${titleClass}`}>{title}</span>
        {output && <div className={error ? 'eja-sessionCardActivityOutput eja-sessionCardActivityError' : 'eja-sessionCardActivityOutput'} data-active={active || undefined}><MarkdownText text={output} /></div>}
    </div>;
});

const SessionCardTitle = memo(function SessionCardTitle({ session, error, waitingForAnswer, activityPreview, activityIndex, showStatus, editMode, draftTitle, onTitleChange, onSelect }: {
    session: SessionSummary;
    error?: string;
    waitingForAnswer: boolean;
    activityPreview?: string;
    activityIndex?: number;
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
            {showStatus && <StateDot state={state} size={10} className="eja-sessionStateDot" />}
            <span className="eja-sessionCardTitleText">
                <input
                    className="eja-sessionTitleEditor"
                    aria-label="会话名称"
                    value={draftTitle ?? title}
                    onChange={(event) => onTitleChange(session.sessionId, event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                />
                <SessionActivityRow activity={activity} index={activityIndex ?? 1} error={Boolean(error)} active={state === 'ongoing'} />
            </span>
        </>;
    }
    return <button
        type="button"
        className="eja-sessionCardTitle"
        title={error ? `${stateLabel}：${error}` : `${stateLabel}：${title}`}
        aria-label={error ? `${stateLabel}：${title}：${error}` : `${stateLabel}：${title}`}
        onClick={() => onSelect(session.sessionId)}
    >
        <StateDot state={state} size={10} className="eja-sessionStateDot" />
        <span className="eja-sessionCardTitleText">
            <span className="bd-tree__label">{title}</span>
            <SessionActivityRow activity={activity} index={activityIndex ?? 1} error={Boolean(error)} active={state === 'ongoing'} />
        </span>
    </button>;
});

export function WorkspaceSessionTree({
    sessions, workspaces, bases, current, pendingQuestionSessionIds, sessionErrors, sessionActivityPreviews, modelGroups, displaySettings, query, searchMatches, searchSnippets, searchHasMore, archivedSessionIds, collapsedWorkspaces,
    editMode, selectedNodeIds, selectedCardIds, sessionTitleDrafts, onToggleNodeSelection, onToggleCardSelection, onSessionTitleChange, onSaveSessionTitles, sessionTitleSaving,
    onQuery, onSelect, onCreateWorkspace, onToggleWorkspace, onStartSession, onDeleteSelected, onExitEdit,
}: WorkspaceSessionTreeProps) {
    const toolsRef = useRef<HTMLDivElement>(null);
    const [toolbarTop, setToolbarTop] = useState<number | null>(null);
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
    const groups = useMemo(() => deriveGroups(workspaces, sessions, current, query, searchMatches, archivedSessionIds), [archivedSessionIds, current, query, searchMatches, sessions, workspaces]);
    const nodes = useMemo<BaseDetailNode[]>(() => groups.map(({ workspace }, index) => ({
        id: workspace.workspaceId,
        text: workspace.title,
        type: 'workspace',
        order: index,
        expanded: collapsedWorkspaces[workspace.workspaceId] !== true,
        ...(workspace.createdAt === undefined ? {} : { createdAt: workspace.createdAt }),
        ...(workspace.updatedAt === undefined ? {} : { updateAt: workspace.updatedAt }),
    })), [collapsedWorkspaces, groups]);
    const edges = useMemo<BaseDetailEdge[]>(() => [], []);
    const nodeCardsMap = useMemo<Record<string, BaseDetailCard[]>>(
        () => Object.fromEntries(groups.map(({ workspace, sessions: groupSessions }) => [
            workspace.workspaceId,
            groupSessions.map((session, index) => {
                const tags: string[] = [];
                if (displaySettings.showModel) tags.push(`模型: ${sessionModelLabel(session, modelGroups)}`);
                if (displaySettings.showBase) tags.push(`知识库: ${sessionBaseLabel(session, bases)}`);
                if (displaySettings.showWorkspace) tags.push(`工作区: ${workspace.title}`);
                return {
                    docId: session.sessionId,
                    title: sessionTitle(session),
                    content: searchSnippets.get(session.sessionId) || session.cwd || '',
                    cardType: 'session',
                    nodeId: workspace.workspaceId,
                    order: index,
                    ...(session.createdAt === undefined ? {} : { createdAt: new Date(session.createdAt) }),
                    updateAt: new Date(session.updatedAt),
                    tags,
                };
            }),
        ])),
        [bases, displaySettings, groups, modelGroups, searchSnippets],
    );
    const expandedNodes = useMemo(() => new Set(nodes.filter((node) => node.expanded !== false).map((node) => String(node.id))), [nodes]);
    const selectedNodeId = useMemo(() => groups.find(({ sessions: groupSessions }) => groupSessions.some((session) => session.sessionId === current))?.workspace.workspaceId || null, [current, groups]);
    const treeDisplaySettings = useMemo(() => ({
        ...defaultBaseDetailDisplaySettings(),
        showProblemCount: false,
        showNodeNumber: false,
        showNodeCardTimestamps: displaySettings.showTimestamps,
        showProblemTree: false,
        showProblemTags: false,
        showCardTags: displaySettings.showModel || displaySettings.showBase || displaySettings.showWorkspace,
    }), [displaySettings]);
    const renderCardTitle = useMemo(() => {
        if (!displaySettings.showStatus && !editMode) return undefined;
        return (card: BaseDetailCard) => {
            const session = sessions.find((item) => item.sessionId === card.docId);
            if (!session) return <span className="bd-tree__label">{String(card.title ?? '')}</span>;
            const activity = sessionActivityPreviews.get(session.sessionId);
            return <SessionCardTitle
                session={session}
                error={sessionErrors.get(session.sessionId)}
                waitingForAnswer={pendingQuestionSessionIds.has(session.sessionId)}
                activityPreview={activity?.text}
                activityIndex={activity?.index}
                showStatus={displaySettings.showStatus}
                editMode={editMode}
                draftTitle={sessionTitleDrafts[session.sessionId]}
                onTitleChange={onSessionTitleChange}
                onSelect={onSelect}
            />;
        };
    }, [displaySettings.showStatus, editMode, onSelect, onSessionTitleChange, pendingQuestionSessionIds, sessionErrors, sessionActivityPreviews, sessionTitleDrafts, sessions]);

    return <section className="eja-agentStructure" aria-label="工作区和会话">
        <div ref={toolsRef} className="eja-agentStructure__tools">
            <input value={query} placeholder="搜索会话" aria-label="搜索会话" onChange={(event) => onQuery(event.target.value)} />
            <button type="button" onClick={() => onStartSession()}>新会话</button>
            <button type="button" onClick={onCreateWorkspace}>新建工作区</button>
        </div>
        {editMode && <div className="eja-selectionToolbar" style={toolbarTop === null ? undefined : { top: `${toolbarTop}px` }} role="toolbar" aria-label="编辑操作">
            <span>已选 {selectedNodeIds.size + selectedCardIds.size} 项</span>
            <button type="button" className="eja-selectionToolbarSave" disabled={sessionTitleSaving} onClick={() => { void onSaveSessionTitles(); }}>{sessionTitleSaving ? '保存中…' : '保存'}</button>
            <button type="button" className="eja-selectionToolbarDelete" disabled={sessionTitleSaving || (selectedNodeIds.size === 0 && selectedCardIds.size === 0)} onClick={onDeleteSelected}>删除</button>
            <button type="button" className="eja-selectionToolbarExit" disabled={sessionTitleSaving} onClick={onExitEdit}>退出编辑</button>
        </div>}
        <div className="bd-content bd-content--tree eja-agentStructure__tree">
            <BaseDetailTree
                rootNodeIds={nodes.map((node) => String(node.id))}
                nodes={nodes}
                edges={edges}
                nodeCardsMap={nodeCardsMap}
                expandedNodes={expandedNodes}
                onToggle={onToggleWorkspace}
                selectedNodeId={selectedNodeId}
                selectedCardId={current}
                onSelectNode={onToggleWorkspace}
                onSelectCard={(card) => onSelect(card.docId)}
                filter=""
                displaySettings={treeDisplaySettings}
                renderCardTitle={renderCardTitle}
                editMode={editMode}
                selectedNodeIds={selectedNodeIds}
                selectedCardIds={selectedCardIds}
                onToggleNodeSelection={(nodeId) => onToggleNodeSelection(nodeId, groups.find(({ workspace }) => workspace.workspaceId === nodeId)?.sessions.map((session) => session.sessionId) || [])}
                onToggleCardSelection={onToggleCardSelection}
                emptyMessage="暂无工作区或会话"
            />
        </div>
        {searchHasMore && <p className="bd-muted eja-agentStructure__hint">仅显示部分搜索结果，请缩小搜索范围。</p>}
    </section>;
}
