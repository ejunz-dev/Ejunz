import type { SessionDoc } from '../model/session';

/** UTC calendar day `YYYY-MM-DD` for a timestamp (default: now). */
export function sessionUtcYmd(ts: number = Date.now()): string {
    const d = new Date(ts);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

export const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Effective UTC day for a daily-lesson queue (explicit `lessonQueueDay` or row `createdAt`). */
export function effectiveLessonQueueYmd(doc: SessionDoc): string | null {
    const raw = doc.lessonQueueDay;
    if (typeof raw === 'string' && YMD_RE.test(raw.trim())) return raw.trim();
    if (doc.createdAt) return sessionUtcYmd(new Date(doc.createdAt).getTime());
    return null;
}

/**
 * UTC day for learn daily frozen queue staleness.
 * Prefer explicit `lessonQueueDay` only (do not mix with ObjectId day): the same Mongo session row is reused
 * across days, so `_id` creation date would falsely keep `timed_out` after "Start" clears the queue.
 * If `lessonQueueDay` is missing, fall back to min(createdAt, ObjectId) for legacy rows that still have a queue.
 */
export function dailyRunAnchorYmd(doc: SessionDoc): string | null {
    const raw = doc.lessonQueueDay;
    if (typeof raw === 'string' && YMD_RE.test(raw.trim())) return raw.trim();
    const parts: string[] = [];
    if (doc.createdAt) parts.push(sessionUtcYmd(new Date(doc.createdAt).getTime()));
    try {
        parts.push(sessionUtcYmd(doc._id.getTimestamp().getTime()));
    } catch {
        /* ignore */
    }
    if (!parts.length) return null;
    return parts.reduce((a, b) => (a < b ? a : b));
}

/**
 * UTC anchor day for a session row from creation only (min of `createdAt` and ObjectId time).
 * Used for develop pool sessions (no `lessonQueueDay`).
 */
export function sessionRowCreatedAnchorYmd(doc: SessionDoc): string | null {
    const parts: string[] = [];
    if (doc.createdAt) parts.push(sessionUtcYmd(new Date(doc.createdAt).getTime()));
    try {
        parts.push(sessionUtcYmd(doc._id.getTimestamp().getTime()));
    } catch {
        /* ignore */
    }
    if (!parts.length) return null;
    return parts.reduce((a, b) => (a < b ? a : b));
}

function isDevelopRoute(doc: SessionDoc): boolean {
    return doc.appRoute === 'develop' || doc.route === 'develop';
}

/** Wall-clock end of develop editor session (aligned with login cookie `saved_expire_seconds`). */
export function readDevelopSessionDeadlineMs(doc: SessionDoc | null | undefined): number | null {
    if (!doc) return null;
    const p = doc.progress as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return null;
    const v = p.developSessionDeadlineAt;
    if (v instanceof Date) {
        const t = v.getTime();
        return Number.isNaN(t) ? null : t;
    }
    if (typeof v === 'string' && v.trim()) {
        const t = new Date(v.trim()).getTime();
        return Number.isNaN(t) ? null : t;
    }
    return null;
}

/** Persisted UTC-day timeout for daily develop sessions (written by {@link markStaleDailyDevelopSessionsTimedOutUtc}). */
export function readDevelopDailyTimedOutMs(doc: SessionDoc | null | undefined): number | null {
    if (!doc) return null;
    const p = doc.progress as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return null;
    const v = p.developDailyTimedOutAt;
    if (v instanceof Date) {
        const t = v.getTime();
        return Number.isNaN(t) ? null : t;
    }
    if (typeof v === 'string' && v.trim()) {
        const t = new Date(v.trim()).getTime();
        return Number.isNaN(t) ? null : t;
    }
    return null;
}

export function isDevelopSessionPastDeadline(doc: SessionDoc | null | undefined, now: number = Date.now()): boolean {
    const t = readDevelopSessionDeadlineMs(doc);
    return t != null && now > t;
}

/**
 * Shared rule for learn daily + develop: the session is tied to a UTC calendar day and that day is strictly
 * before `now`’s UTC date.
 *
 * - **Develop** (`appRoute`/`route` develop): anchor = {@link sessionRowCreatedAnchorYmd} (same idea as learn
 *   legacy fallback when `lessonQueueDay` is absent).
 * - **Learn daily** (`lessonMode === 'today'`): non-empty queue → {@link dailyRunAnchorYmd}; empty queue but
 *   explicit `lessonQueueDay` → compare that string to today.
 *
 * Does not inspect abandoned / settled / finished; callers gate those first.
 */
export function isSessionStalePastUtcCalendarDay(doc: SessionDoc, now: number = Date.now()): boolean {
    const todayYmd = sessionUtcYmd(now);
    if (isDevelopRoute(doc)) {
        const anchor = sessionRowCreatedAnchorYmd(doc);
        return !!(anchor && anchor < todayYmd);
    }
    if (doc.lessonMode !== 'today') return false;
    const q = doc.lessonCardQueue ?? [];
    const qLen = q.length;
    const rawDay = doc.lessonQueueDay;
    const explicitQueueDay = typeof rawDay === 'string' && YMD_RE.test(rawDay.trim()) ? rawDay.trim() : null;
    if (qLen > 0) {
        const anchor = dailyRunAnchorYmd(doc);
        return !!(anchor && anchor < todayYmd);
    }
    if (explicitQueueDay && explicitQueueDay < todayYmd) return true;
    return false;
}
