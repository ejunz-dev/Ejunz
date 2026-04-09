import type { SessionRecordDoc } from '../model/record';
import type { SessionDoc } from '../model/session';
import { isLearnHomePlaceholderSession } from './lessonSession';
import { isSessionStalePastUtcCalendarDay } from './sessionUtcDaily';

export {
    dailyRunAnchorYmd,
    effectiveLessonQueueYmd,
    isSessionStalePastUtcCalendarDay,
    sessionUtcYmd,
} from './sessionUtcDaily';

const ON_LESSON_RECENT_MS = 3 * 60 * 1000;
const LEGACY_ACTIVITY_MS = 5 * 60 * 1000;

export type SessionListRecordType = 'daily' | 'single_card' | 'single_node' | 'develop' | 'agent' | 'other';

export type SessionListStatus =
    | 'in_progress'
    | 'paused'
    | 'finished'
    | 'timed_out'
    | 'abandoned'
    | 'active'
    | 'detached';

export function isLearnSessionRow(doc: SessionDoc): boolean {
    if (doc.appRoute === 'develop' || doc.route === 'develop') return false;
    return doc.appRoute === 'learn'
        || doc.route === 'learn'
        || !!(doc.lessonCardQueue && doc.lessonCardQueue.length)
        || doc.lessonMode != null;
}

export function isDevelopSessionRow(doc: SessionDoc): boolean {
    return doc.appRoute === 'develop' || doc.route === 'develop';
}

export function isAgentSessionRow(doc: SessionDoc): boolean {
    return doc.appRoute === 'agent' || doc.route === 'agent';
}

export function getDevelopSessionSettledAt(doc: SessionDoc | null | undefined): Date | null {
    const p = doc?.progress as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return null;
    const v = p.developSettledAt;
    if (v instanceof Date) return v;
    if (typeof v === 'string') {
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
}

export function isDevelopSessionSettled(doc: SessionDoc | null | undefined): boolean {
    return getDevelopSessionSettledAt(doc) != null;
}

export function deriveSessionRecordType(doc: SessionDoc): SessionListRecordType {
    if (isDevelopSessionRow(doc)) return 'develop';
    if (isAgentSessionRow(doc)) return 'agent';
    if (!isLearnSessionRow(doc)) return 'other';
    if (isLearnHomePlaceholderSession(doc)) return 'other';
    const mode = doc.lessonMode ?? null;
    if (mode === 'node') return 'single_node';
    if (mode === 'today') return 'daily';
    return 'single_card';
}

/** Display string `current/total` (1-based) for live list rows; null when no frozen card queue. */
export function formatSessionCardProgress(doc: SessionDoc): string | null {
    const q = doc.lessonCardQueue ?? [];
    const qLen = q.length;
    if (qLen <= 0) return null;
    const idx = typeof doc.cardIndex === 'number' ? doc.cardIndex : 0;
    const current = idx >= qLen ? qLen : idx + 1;
    return `${current}/${qLen}`;
}

/** Session list progress column: develop run queue (completed/total); learn = card queue progress. */
export function formatSessionProgressDisplay(doc: SessionDoc): string | null {
    if (isDevelopSessionRow(doc)) {
        const dr = doc.progress?.developRun as { completed?: unknown; total?: unknown } | undefined;
        const total = Number(dr?.total);
        const completed = Number(dr?.completed);
        if (Number.isFinite(total) && total > 0 && Number.isFinite(completed) && completed >= 0 && completed <= total) {
            return `${completed}/${total}`;
        }
        return null;
    }
    return formatSessionCardProgress(doc);
}

export type SessionKindUi = 'learn' | 'develop' | 'agent';

export function deriveSessionKind(doc: SessionDoc): SessionKindUi {
    if (isDevelopSessionRow(doc)) return 'develop';
    if (isAgentSessionRow(doc)) return 'agent';
    return 'learn';
}

/**
 * Slot of this answer record in its learn session: card index in `lessonCardQueue`, else order in `recordIds`.
 * Example: third card in a six-card run → `3/6`.
 */
export function formatRecordProgressInSession(rd: SessionRecordDoc, sess: SessionDoc | null): string | null {
    if (!sess) return null;
    const q = sess.lessonCardQueue ?? [];
    const cardId = String(rd.cardId);
    const nodeId = String(rd.nodeId || '');
    const dom = rd.domainId;
    if (q.length > 0) {
        const idx = q.findIndex(
            (it) => String(it.cardId) === cardId
                && String(it.nodeId || '') === nodeId
                && (!it.domainId || it.domainId === dom),
        );
        if (idx >= 0) return `${idx + 1}/${q.length}`;
    }
    const rids = sess.recordIds ?? [];
    if (rids.length > 0) {
        const myHex = rd._id.toHexString();
        const pos = rids.findIndex((id) => id.toHexString() === myHex);
        if (pos >= 0) return `${pos + 1}/${rids.length}`;
    }
    return null;
}

export function deriveSessionLearnStatus(doc: SessionDoc, now = Date.now()): SessionListStatus {
    if (isDevelopSessionRow(doc)) {
        if ((doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) return 'abandoned';
        if (isDevelopSessionSettled(doc)) return 'finished';
        if (isSessionStalePastUtcCalendarDay(doc, now)) return 'timed_out';
        const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
        if (now - t < ON_LESSON_RECENT_MS) return 'in_progress';
        return 'paused';
    }
    if ((doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) {
        return 'abandoned';
    }
    if (!isLearnSessionRow(doc)) {
        const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
        return now - t < LEGACY_ACTIVITY_MS ? 'active' : 'detached';
    }

    if (isLearnHomePlaceholderSession(doc)) {
        const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
        return now - t < LEGACY_ACTIVITY_MS ? 'active' : 'detached';
    }

    const q = doc.lessonCardQueue ?? [];
    const qLen = q.length;
    const idx = typeof doc.cardIndex === 'number' ? doc.cardIndex : 0;
    const last = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    const onLearn = doc.route === 'learn';
    const recentOnLesson = onLearn && now - last < ON_LESSON_RECENT_MS;

    if (doc.lessonMode === 'card' && idx >= 1) return 'finished';

    if (qLen > 0 && idx >= qLen) return 'finished';

    const daily = doc.lessonMode === 'today';
    if (daily && isSessionStalePastUtcCalendarDay(doc, now)) return 'timed_out';

    if (recentOnLesson) return 'in_progress';

    if (qLen > 0 && idx < qLen) return 'paused';

    if (doc.appRoute === 'learn' || doc.route === 'learn' || doc.lessonMode != null) {
        return 'paused';
    }

    const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    return now - t < LEGACY_ACTIVITY_MS ? 'active' : 'detached';
}
