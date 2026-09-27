import type { SessionSummary, WorkspaceView } from '../../runtime/session';

export const UNGROUPED_KEY = '__ungrouped__';
export const COLLAPSED_SESSION_LIMIT = 5;

export interface WorkspaceTreeGroup {
    workspace: WorkspaceView;
    sessions: SessionSummary[];
}

export function sessionTitle(session: SessionSummary): string {
    const title = session.projections?.values?.title;
    if (typeof title === 'string' && title.trim()) return title;
    return session.blank ? '新会话' : `会话 ${session.sessionId.slice(8, 16)}`;
}

export function visibleSession(session: SessionSummary, current: string | null, archived: ReadonlySet<string>): boolean {
    return !archived.has(session.sessionId) && (!session.blank || session.sessionId === current);
}

export function filterSessions(sessions: readonly SessionSummary[], current: string | null, query: string, searchMatches: ReadonlySet<string> | null, archived: ReadonlySet<string>): SessionSummary[] {
    const visible = sessions.filter((session) => visibleSession(session, current, archived));
    const normalized = query.trim().toLowerCase();
    if (!normalized) return visible;
    return visible.filter((session) => sessionTitle(session).toLowerCase().includes(normalized)
        || session.sessionId.toLowerCase().includes(normalized)
        || session.cwd?.toLowerCase().includes(normalized) === true
        || searchMatches?.has(session.sessionId) === true);
}

export function deriveGroups(workspaces: readonly WorkspaceView[], sessions: readonly SessionSummary[], current: string | null, query: string, searchMatches: ReadonlySet<string> | null, archived: ReadonlySet<string>): WorkspaceTreeGroup[] {
    const filtered = filterSessions(sessions, current, query, searchMatches, archived);
    const sessionMap = new Map(filtered.map((session) => [session.sessionId, session]));
    const claimed = new Set<string>();
    const groups = workspaces.map((workspace) => {
        const groupSessions = workspace.sessionIds.map((id) => sessionMap.get(id)).filter((session): session is SessionSummary => session !== undefined);
        groupSessions.forEach((session) => claimed.add(session.sessionId));
        return { workspace, sessions: groupSessions };
    });
    const ungrouped = filtered.filter((session) => !claimed.has(session.sessionId));
    if (ungrouped.length) groups.push({ workspace: { workspaceId: UNGROUPED_KEY, title: '未分组', path: '', sessionIds: [] }, sessions: ungrouped });
    return groups.filter((group) => group.sessions.length > 0 || group.workspace.workspaceId !== UNGROUPED_KEY);
}

export function deriveFlat(sessions: readonly SessionSummary[], current: string | null, query: string, searchMatches: ReadonlySet<string> | null, archived: ReadonlySet<string>): SessionSummary[] {
    return filterSessions(sessions, current, query, searchMatches, archived).filter((session) => !session.blank);
}
