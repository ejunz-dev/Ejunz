import type { SessionSummary } from '../../runtime/session';

export function filterSessions(sessions: readonly SessionSummary[], current: string | null, query: string, searchMatches: ReadonlySet<string> | null): SessionSummary[] {
    const visible = sessions.filter((session) => !session.blank || session.sessionId === current);
    const normalized = query.trim().toLowerCase();
    if (!normalized) return visible;
    return visible.filter((session) => {
        const title = session.projections?.values?.title;
        const sessionTitle = typeof title === 'string' && title.trim() ? title : session.blank ? '新会话' : `会话 ${session.sessionId.slice(8, 16)}`;
        return sessionTitle.toLowerCase().includes(normalized)
            || session.sessionId.toLowerCase().includes(normalized)
            || session.cwd?.toLowerCase().includes(normalized) === true
            || searchMatches?.has(session.sessionId) === true;
    });
}
