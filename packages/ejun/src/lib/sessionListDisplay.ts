import type { SessionDoc } from '../model/session';

const ON_LESSON_RECENT_MS = 3 * 60 * 1000;
const LEGACY_ACTIVITY_MS = 5 * 60 * 1000;

export type SessionListRecordType = 'daily' | 'single_card' | 'single_node' | 'other';

export type SessionListStatus =
    | 'in_progress'
    | 'paused'
    | 'finished'
    | 'timed_out'
    | 'active'
    | 'detached';

export function isLearnSessionRow(doc: SessionDoc): boolean {
    return doc.appRoute === 'learn'
        || doc.route === 'learn'
        || !!(doc.lessonCardQueue && doc.lessonCardQueue.length)
        || doc.lessonMode != null;
}

export function deriveSessionRecordType(doc: SessionDoc): SessionListRecordType {
    if (!isLearnSessionRow(doc)) return 'other';
    const mode = doc.lessonMode ?? null;
    if (mode === 'node') return 'single_node';
    if (mode === 'today') return 'daily';
    return 'single_card';
}

/** UTC calendar day `YYYY-MM-DD` for a timestamp (default: now). */
export function sessionUtcYmd(ts: number = Date.now()): string {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Effective UTC day for a daily-lesson queue (explicit `lessonQueueDay` or row `createdAt`). */
export function effectiveLessonQueueYmd(doc: SessionDoc): string | null {
    const raw = doc.lessonQueueDay;
    if (typeof raw === 'string' && YMD_RE.test(raw.trim())) return raw.trim();
    if (doc.createdAt) return sessionUtcYmd(new Date(doc.createdAt).getTime());
    return null;
}

/** Earliest UTC YYYY-MM-DD among lessonQueueDay, createdAt, and ObjectId timestamp (daily learn run anchor). */
export function dailyRunAnchorYmd(doc: SessionDoc): string | null {
    const parts: string[] = [];
    const raw = doc.lessonQueueDay;
    if (typeof raw === 'string' && YMD_RE.test(raw.trim())) parts.push(raw.trim());
    if (doc.createdAt) parts.push(sessionUtcYmd(new Date(doc.createdAt).getTime()));
    try {
        parts.push(sessionUtcYmd(doc._id.getTimestamp().getTime()));
    } catch {
        /* ignore */
    }
    if (!parts.length) return null;
    return parts.reduce((a, b) => (a < b ? a : b));
}

export function deriveSessionLearnStatus(doc: SessionDoc, now = Date.now()): SessionListStatus {
    if (!isLearnSessionRow(doc)) {
        const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
        return now - t < LEGACY_ACTIVITY_MS ? 'active' : 'detached';
    }

    const q = doc.lessonCardQueue ?? [];
    const qLen = q.length;
    const idx = typeof doc.cardIndex === 'number' ? doc.cardIndex : 0;
    const last = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    const onLearn = doc.route === 'learn';
    const recentOnLesson = onLearn && now - last < ON_LESSON_RECENT_MS;

    if (qLen > 0 && idx >= qLen) return 'finished';

    const daily = doc.lessonMode === 'today';
    const todayYmd = sessionUtcYmd(now);
    if (daily) {
        const anchor = dailyRunAnchorYmd(doc);
        if (anchor && anchor < todayYmd) return 'timed_out';
    }

    if (recentOnLesson) return 'in_progress';

    if (qLen > 0 && idx < qLen) return 'paused';

    if (doc.appRoute === 'learn' || doc.route === 'learn' || doc.lessonMode != null) {
        return 'paused';
    }

    const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    return now - t < LEGACY_ACTIVITY_MS ? 'active' : 'detached';
}
