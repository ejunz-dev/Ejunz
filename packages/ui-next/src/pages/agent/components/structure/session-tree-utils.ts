import { i18n } from '@/i18n';
import type { SessionSummary } from '../../runtime/session';

function preparedSession(session: SessionSummary): boolean {
    const title = session.projections?.values?.title;
    return typeof title === 'string' && title.trim().length > 0;
}

export function filterSessions(sessions: readonly SessionSummary[], current: string | null, query: string, searchMatches: ReadonlySet<string> | null): SessionSummary[] {
    const visible = sessions.filter((session) => session.sessionId === current || !session.blank || preparedSession(session));
    const normalized = query.trim().toLowerCase();
    if (!normalized) return visible;
    return visible.filter((session) => {
        const title = session.projections?.values?.title;
        const sessionTitle = typeof title === 'string' && title.trim() ? title : session.blank ? i18n('New session') : i18n('Session {0}', session.sessionId.slice(8, 16));
        return sessionTitle.toLowerCase().includes(normalized)
            || session.sessionId.toLowerCase().includes(normalized)
            || searchMatches?.has(session.sessionId) === true;
    });
}
