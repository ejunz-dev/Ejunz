import { useState } from 'react';
import type { DragEvent } from 'react';
import { IconArchiveOutline20, IconBranchOutline16, IconEditOutline16, IconEllipsisOutline16, IconFolderClose16, IconFolderOpen16, IconPlusOutline16, IconTrashOutline16, IconTriangleRightFill14 } from '../../../icons';
import type { SessionSummary, WorkspaceView } from '../../../runtime/session';
import { HoverCard } from '../../primitives/HoverCard';
import { Menu } from '../../primitives/Menu';
import { sessionTitle } from '../tree';
import css from './Rows.module.css';

export interface ProjectRowItemProps {
    workspace: WorkspaceView;
    collapsed: boolean;
    onToggle: () => void;
    onStartSession: () => void;
    onRename: () => void;
    onDelete: () => void;
    draggable?: boolean;
    dropTarget?: boolean;
    onDragStart?: () => void;
    onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
    onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}

export function ProjectRowItem({ workspace, collapsed, onToggle, onStartSession, onRename, onDelete, draggable, dropTarget, onDragStart, onDragOver, onDrop }: ProjectRowItemProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const row = <div className={`${css.projectRow}${menuOpen ? ` ${css.menuOpen}` : ''}${dropTarget ? ` ${css.dropBefore}` : ''}`} role="treeitem" aria-expanded={!collapsed} title={workspace.path || workspace.title} draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onClick={onToggle}>
        <span className={css.folder}>{collapsed ? <IconFolderClose16 size={16} /> : <IconFolderOpen16 size={16} />}</span>
        <span className={collapsed ? css.chevronCollapsed : css.chevron}><IconTriangleRightFill14 size={14} /></span>
        <span className={css.projectTitle}>{workspace.title}</span>
        <span className={css.projectActions} onClick={(event) => { event.stopPropagation(); }}>
            {workspace.workspaceId !== '__ungrouped__' && <Menu
                open={menuOpen}
                onClose={() => setMenuOpen(false)}
                items={[{ id: 'rename', label: '重命名', icon: <IconEditOutline16 /> }, { id: 'delete', label: '删除工作区', icon: <IconTrashOutline16 />, danger: true }]}
                onSelect={(id) => { setMenuOpen(false); if (id === 'rename') onRename(); else if (id === 'delete') onDelete(); }}
                portal
                closeOnPointerLeave
                anchor={<button type="button" className={css.projectMenuButton} aria-label={`工作区操作：${workspace.title}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><IconEllipsisOutline16 size={16} /></button>}
            />}
            <button type="button" className={css.projectAdd} aria-label={`在“${workspace.title}”中新建会话`} onClick={onStartSession}><IconPlusOutline16 size={16} /></button>
        </span>
    </div>;
    if (workspace.workspaceId === '__ungrouped__') return row;
    return <HoverCard anchor={row} content={<div className={css.hoverContent}><span className={css.hoverTitle}>{workspace.title}</span><span className={css.hoverPath}>{workspace.path}</span></div>} copyText={workspace.path} copyLabel="复制工作区路径" copiedLabel="已复制" disabled={menuOpen} />;
}

export interface SessionNodeItemProps {
    session: SessionSummary;
    selected: boolean;
    onOpen: () => void;
    onRename: () => void;
    onFork: () => void;
    onArchive: () => void;
    onHardDelete: () => void;
    draggable?: boolean;
    dropTarget?: boolean;
    onDragStart?: () => void;
    onDragOver?: (event: DragEvent<HTMLDivElement>) => void;
    onDrop?: (event: DragEvent<HTMLDivElement>) => void;
}

export function SessionNodeItem({ session, selected, onOpen, onRename, onFork, onArchive, onHardDelete, draggable, dropTarget, onDragStart, onDragOver, onDrop }: SessionNodeItemProps) {
    const [menuOpen, setMenuOpen] = useState(false);
    const title = sessionTitle(session);
    const row = <div className={`${css.sessionRow}${selected ? ` ${css.selected}` : ''}${menuOpen ? ` ${css.menuOpen}` : ''}${dropTarget ? ` ${css.dropBefore}` : ''}`} role="treeitem" aria-selected={selected} title={title} draggable={draggable} onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onClick={onOpen}>
        <span className={css.status} data-running={session.running || undefined} />
        <span className={css.sessionTitle}>{title}</span>
        {!session.blank && <span className={css.sessionTime}>{formatTime(session.updatedAt)}</span>}
        {!session.blank && <span className={css.sessionActions} onClick={(event) => { event.stopPropagation(); }}><Menu
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            items={[{ id: 'rename', label: '重命名', icon: <IconEditOutline16 /> }, { id: 'fork', label: '分叉会话', icon: <IconBranchOutline16 /> }, { id: 'archive', label: '归档会话', icon: <IconArchiveOutline20 size={16} /> }, { id: 'delete', label: '永久删除', icon: <IconTrashOutline16 />, danger: true }]}
            onSelect={(id) => { setMenuOpen(false); if (id === 'rename') onRename(); else if (id === 'fork') onFork(); else if (id === 'archive') onArchive(); else if (id === 'delete') onHardDelete(); }}
            portal
            closeOnPointerLeave
            anchor={<button type="button" className={css.menuButton} aria-label={`会话操作：${title}`} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><IconEllipsisOutline16 size={16} /></button>}
        /></span>}
    </div>;
    return <HoverCard anchor={row} content={<div className={css.hoverContent}><span className={css.hoverTitle}>{title}</span>{!session.blank && <span className={css.hoverTime}>{formatTime(session.updatedAt)}</span>}<span className={css.hoverStatus}><i data-running={session.running || undefined} />{session.running ? '进行中' : '空闲'}</span></div>} copyText={title} copyLabel="复制会话标题" copiedLabel="已复制" disabled={menuOpen} />;
}

export interface SearchResultItemProps {
    session: SessionSummary;
    selected: boolean;
    snippet?: string;
    onOpen: () => void;
}

export function SearchResultItem({ session, selected, snippet, onOpen }: SearchResultItemProps) {
    return <button type="button" className={`${css.searchRow}${selected ? ` ${css.selected}` : ''}`} aria-selected={selected} title={sessionTitle(session)} onClick={onOpen}>
        <span className={css.sessionTitle}>{sessionTitle(session)}</span>
        <span className={css.searchMeta}>{snippet || session.cwd || session.sessionId}</span>
    </button>;
}

function formatTime(time: number): string {
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    return new Date(time).toLocaleDateString();
}
