import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { EjunzLogo, IconCloseFill14, IconFolderClose16, IconFolderOpen16, IconNewChatOutline16, IconPanelLeftOutline16, IconProjectAddOutline16, IconSearchOutline16, IconSettingsOutline14, IconSettingsOutline16, IconPersonalizationOutline16, IconTriangleRightFill14 } from '../../icons';
import type { SessionSummary, WorkspaceView } from '../../runtime/session';
import { Menu } from '../primitives/Menu';
import { COLLAPSED_SESSION_LIMIT, deriveFlat, deriveGroups } from './tree';
import { ProjectRowItem, SearchResultItem, SessionNodeItem } from './rows/Rows';
import css from './SidebarRoot.module.css';

function ViewOptionsMenu({ flat, orderBy, onGroupChange, onOrderChange }: { flat: boolean; orderBy: 'manual' | 'updated'; onGroupChange: () => void; onOrderChange: () => void }) {
    const [open, setOpen] = useState(false);
    return <Menu
        open={open}
        onClose={() => setOpen(false)}
        items={[{ id: 'workspace', label: flat ? '按工作区分组' : '平铺会话' }, { id: 'order', label: orderBy === 'updated' ? '按手动顺序排列' : '按最近更新排列' }]}
        onSelect={(id) => { setOpen(false); if (id === 'workspace') onGroupChange(); else onOrderChange(); }}
        align="end"
        dense
        portal
        anchor={<button type="button" aria-label="视图选项" className="eja-viewOptionsButton" aria-expanded={open} onClick={() => setOpen((value) => !value)}><IconPersonalizationOutline16 size={16} /></button>}
    />;
}

export interface WorkspaceBrowserProps {
    collapsed: boolean;
    narrow: boolean;
    sessions: SessionSummary[];
    workspaces: WorkspaceView[];
    current: string | null;
    query: string;
    searchMatches: ReadonlySet<string> | null;
    searchSnippets: ReadonlyMap<string, string>;
    searchHasMore: boolean;
    archivedSessionIds: ReadonlySet<string>;
    collapsedWorkspaces: Record<string, boolean>;
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
    onToggle: () => void;
    onOpenSettings: () => void;
}

export function WorkspaceBrowser({
    collapsed, narrow, sessions, workspaces, current, query, searchMatches, searchSnippets, searchHasMore, archivedSessionIds,
    collapsedWorkspaces, onQuery, onSelect, onRenameSession, onForkSession, onArchiveSession, onHardDeleteSession, onRenameWorkspace, onDeleteWorkspace, onCreateWorkspace, onMoveWorkspace, onMoveSession,
    onToggleWorkspace, onStartSession, onToggle, onOpenSettings,
}: WorkspaceBrowserProps) {
    const [flat, setFlat] = useState(() => window.localStorage.getItem('eja.workspace.view') === 'flat');
    const [orderBy, setOrderBy] = useState<'manual' | 'updated'>(() => window.localStorage.getItem('eja.workspace.order') === 'updated' ? 'updated' : 'manual');
    const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
    const [dragging, setDragging] = useState<{ kind: 'workspace' | 'session'; id: string; workspaceId?: string } | null>(null);
    const [dragOver, setDragOver] = useState<string | null>(null);
    const [searchExpanded, setSearchExpanded] = useState(false);
    const [searchOnExpand, setSearchOnExpand] = useState(false);
    const searchRoot = useRef<HTMLDivElement | null>(null);
    const searchInput = useRef<HTMLInputElement | null>(null);
    useEffect(() => { window.localStorage.setItem('eja.workspace.view', flat ? 'flat' : 'workspace'); }, [flat]);
    useEffect(() => { window.localStorage.setItem('eja.workspace.order', orderBy); }, [orderBy]);
    useEffect(() => {
        if (!searchExpanded) return undefined;
        const onPointerDown = (event: PointerEvent) => {
            if (searchRoot.current?.contains(event.target as Node)) return;
            if (query.trim() === '') setSearchExpanded(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [query, searchExpanded]);
    useEffect(() => {
        if (!searchExpanded || searchOnExpand) return;
        searchInput.current?.focus({ preventScroll: true });
    }, [searchExpanded, searchOnExpand]);
    useEffect(() => {
        if (collapsed || !searchOnExpand) return;
        const timer = window.setTimeout(() => {
            setSearchExpanded(true);
            searchInput.current?.focus({ preventScroll: true });
            setSearchOnExpand(false);
        }, 180);
        return () => window.clearTimeout(timer);
    }, [collapsed, searchOnExpand]);
    const ordered = (items: SessionSummary[]) => orderBy === 'updated' ? [...items].sort((a, b) => b.updatedAt - a.updatedAt) : items;
    const startDrag = (kind: 'workspace' | 'session', id: string, workspaceId?: string) => {
        setDragging({ kind, id, ...(workspaceId === undefined ? {} : { workspaceId }) });
        setDragOver(null);
    };
    const dragOverItem = (event: DragEvent<HTMLDivElement>, key: string) => {
        event.preventDefault();
        setDragOver(key);
    };
    const dropItem = (event: DragEvent<HTMLDivElement>, kind: 'workspace' | 'session', id: string, workspaceId?: string) => {
        event.preventDefault();
        if (dragging?.kind === 'workspace' && kind === 'workspace' && dragging.id !== id) onMoveWorkspace(dragging.id, id);
        if (dragging?.kind === 'session' && kind === 'session' && dragging.workspaceId === workspaceId && dragging.id !== id && workspaceId !== undefined) onMoveSession(workspaceId, dragging.id, id);
        setDragging(null);
        setDragOver(null);
    };
    const groups = useMemo(() => deriveGroups(workspaces, sessions, current, query, searchMatches, archivedSessionIds).map((group) => ({ ...group, sessions: ordered(group.sessions) })), [archivedSessionIds, current, orderBy, query, searchMatches, sessions, workspaces]);
    const flatSessions = useMemo(() => ordered(deriveFlat(sessions, current, query, searchMatches, archivedSessionIds)), [archivedSessionIds, current, orderBy, query, searchMatches, sessions]);
    const searching = query.trim().length > 0;
    const toggleGroup = (id: string) => {
        onToggleWorkspace(id);
        setExpandedGroups((value) => ({ ...value, [id]: !value[id] }));
    };
    const showMore = (id: string, count: number) => {
        setExpandedGroups((value) => ({ ...value, [id]: count > 0 }));
    };

    return <div className={`${css.root}${collapsed ? ` ${css.collapsed}` : ''}`}>
        <div className={css.logoRow}>
            {(!collapsed || narrow) && <button type="button" className={`${css.brand} ${css.wide}`} aria-label="新会话" onClick={() => onStartSession()}><EjunzLogo size={32} className={css.brandLogo} /><span className={css.brandText}>Ejunz agent</span></button>}
            <button type="button" className={`${css.iconButton} ${css.toggle}`} aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'} onClick={onToggle}>
                {collapsed ? <EjunzLogo className={css.railLogo} size={24} /> : <IconPanelLeftOutline16 className={css.panelIcon} size={16} />}
            </button>
        </div>
        <button type="button" className={css.newSession} aria-label="新会话" onClick={() => onStartSession()}><IconNewChatOutline16 size={collapsed ? 18 : 16} /><span className={css.newSessionLabel}>新会话</span></button>
        <div className={css.regionArea}>
            {collapsed ? <div className="eja-railActions">
                <button type="button" aria-label="搜索会话" onClick={() => { setSearchOnExpand(true); onToggle(); }}><IconSearchOutline16 size={18} /></button>
                <button type="button" aria-label="添加工作区" onClick={onCreateWorkspace}><IconProjectAddOutline16 size={18} /></button>
            </div> : <>
                <div className={`eja-workspaceBrowserHeader${searchExpanded ? ' is-searching' : ''}`}>
                    {!searchExpanded && <span>工作区</span>}
                    <div ref={searchRoot} className={`eja-sidebarSearch${searchExpanded ? ' is-expanded' : ''}`} onClick={() => { setSearchExpanded(true); }}>
                        <button type="button" aria-label="搜索会话" aria-expanded={searchExpanded} onClick={() => { setSearchExpanded(true); }}><IconSearchOutline16 size={searchExpanded ? 11 : 14} /></button>
                        <input ref={searchInput} value={query} tabIndex={searchExpanded ? 0 : -1} placeholder="搜索会话" onChange={(event) => onQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { onQuery(''); setSearchExpanded(false); } }} />
                        {searchExpanded && <button type="button" aria-label="清除搜索" onClick={(event) => { event.stopPropagation(); onQuery(''); setSearchExpanded(false); }}><IconCloseFill14 size={14} /></button>}
                    </div>
                    <div className={`eja-workspaceBrowserActions${searchExpanded ? ' is-hidden' : ''}`}>
                        <ViewOptionsMenu flat={flat} orderBy={orderBy} onGroupChange={() => setFlat((value) => !value)} onOrderChange={() => { setOrderBy((value) => value === 'updated' ? 'manual' : 'updated'); }} />
                        <button type="button" aria-label="添加工作区" onClick={onCreateWorkspace}><IconProjectAddOutline16 size={16} /></button>
                    </div>
                </div>
                <div className="eja-sessionList">
                    {searching ? flatSessions.map((session) => <SearchResultItem key={session.sessionId} session={session} selected={session.sessionId === current} snippet={searchSnippets.get(session.sessionId)} onOpen={() => onSelect(session.sessionId)} />)
                        : flat ? flatSessions.map((session) => <SessionNodeItem key={session.sessionId} session={session} selected={session.sessionId === current} onOpen={() => onSelect(session.sessionId)} onRename={() => onRenameSession(session.sessionId, sessionTitleFallback(session))} onFork={() => onForkSession(session.sessionId)} onArchive={() => onArchiveSession(session.sessionId)} onHardDelete={() => onHardDeleteSession(session.sessionId)} />)
                            : groups.map(({ workspace, sessions: groupSessions }) => {
                                const currentGroup = groups.find((candidate) => candidate.sessions.some((session) => session.sessionId === current))?.workspace.workspaceId;
                                const collapsedGroup = collapsedWorkspaces[workspace.workspaceId] ?? (groups.length > 1 && workspace.workspaceId !== currentGroup);
                                const expanded = expandedGroups[workspace.workspaceId] === true;
                                const shown = expanded ? groupSessions : groupSessions.slice(0, COLLAPSED_SESSION_LIMIT);
                                return <div key={workspace.workspaceId} className="eja-workspaceGroup">
                                    <ProjectRowItem workspace={workspace} collapsed={collapsedGroup} onToggle={() => toggleGroup(workspace.workspaceId)} onStartSession={() => onStartSession(workspace.workspaceId === '__ungrouped__' ? undefined : workspace.workspaceId)} onRename={() => onRenameWorkspace(workspace.workspaceId, workspace.title)} onDelete={() => onDeleteWorkspace(workspace.workspaceId, workspace.title)} draggable={workspace.workspaceId !== '__ungrouped__'} dropTarget={dragOver === `workspace:${workspace.workspaceId}`} onDragStart={() => startDrag('workspace', workspace.workspaceId)} onDragOver={(event) => dragOverItem(event, `workspace:${workspace.workspaceId}`)} onDrop={(event) => dropItem(event, 'workspace', workspace.workspaceId)} />
                                    {!collapsedGroup && shown.map((session) => <SessionNodeItem key={session.sessionId} session={session} selected={session.sessionId === current} onOpen={() => onSelect(session.sessionId)} onRename={() => onRenameSession(session.sessionId, sessionTitleFallback(session))} onFork={() => onForkSession(session.sessionId)} onArchive={() => onArchiveSession(session.sessionId)} onHardDelete={() => onHardDeleteSession(session.sessionId)} draggable={!session.blank} dropTarget={dragOver === `session:${session.sessionId}`} onDragStart={() => startDrag('session', session.sessionId, workspace.workspaceId)} onDragOver={(event) => dragOverItem(event, `session:${session.sessionId}`)} onDrop={(event) => dropItem(event, 'session', session.sessionId, workspace.workspaceId)} />)}
                                    {!collapsedGroup && groupSessions.length > COLLAPSED_SESSION_LIMIT && <button type="button" className="eja-sessionOverflowButton" onClick={() => showMore(workspace.workspaceId, expanded ? 0 : groupSessions.length - COLLAPSED_SESSION_LIMIT)}>{expanded ? '收起' : `展开其余 ${groupSessions.length - COLLAPSED_SESSION_LIMIT} 个会话`}</button>}
                                </div>;
                            })}
                    {!searching && !flat && groups.length === 0 && <div className="eja-hint" style={{ padding: '12px 10px' }}>暂无会话</div>}
                    {searching && searchHasMore && <div className="eja-hint" style={{ padding: '8px 10px' }}>仅显示部分结果，请缩小搜索范围</div>}
                    {searching && flatSessions.length === 0 && <div className="eja-hint" style={{ padding: '12px 10px' }}>无匹配会话</div>}
                </div>
            </>}
        </div>
        <div className={css.footArea}><button type="button" className={css.iconButton} title="设置" onClick={onOpenSettings}>{collapsed ? <IconSettingsOutline14 size={18} /> : <IconSettingsOutline16 size={16} />}</button></div>
    </div>;
}

function sessionTitleFallback(session: SessionSummary): string {
    const title = session.projections?.values?.title;
    if (typeof title === 'string' && title.trim()) return title;
    return session.blank ? '新会话' : `会话 ${session.sessionId.slice(8, 16)}`;
}
