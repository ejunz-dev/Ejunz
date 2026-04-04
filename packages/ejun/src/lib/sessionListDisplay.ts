import type { RecordDoc } from '../model/record';
import type { SessionDoc } from '../model/session';

const ON_LESSON_RECENT_MS = 3 * 60 * 1000;
const LEGACY_ACTIVITY_MS = 5 * 60 * 1000;

export type SessionListRecordType = 'daily' | 'single_card' | 'single_node' | 'other';

export type SessionListStatus =
    | 'in_progress'
    | 'paused'
    | 'finished'
    | 'timed_out'
    | 'abandoned'
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

/**
 * UTC day used to decide if a daily frozen queue is stale.
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

/** Display string `current/total` (1-based) for live list rows; null when no frozen card queue. */
export function formatSessionCardProgress(doc: SessionDoc): string | null {
    const q = doc.lessonCardQueue ?? [];
    const qLen = q.length;
    if (qLen <= 0) return null;
    const idx = typeof doc.cardIndex === 'number' ? doc.cardIndex : 0;
    const current = idx >= qLen ? qLen : idx + 1;
    return `${current}/${qLen}`;
}

/**
 * Slot of this answer record in its learn session: card index in `lessonCardQueue`, else order in `recordIds`.
 * Example: third card in a six-card run → `3/6`.
 */
export function formatRecordProgressInSession(rd: RecordDoc, sess: SessionDoc | null): string | null {
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
    if ((doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) {
        return 'abandoned';
    }
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

    if (doc.lessonMode === 'card' && idx >= 1) return 'finished';

    if (qLen > 0 && idx >= qLen) return 'finished';

    const daily = doc.lessonMode === 'today';
    const todayYmd = sessionUtcYmd(now);
    if (daily) {
        const rawDay = doc.lessonQueueDay;
        const explicitQueueDay = typeof rawDay === 'string' && YMD_RE.test(rawDay.trim()) ? rawDay.trim() : null;
        if (qLen > 0) {
            const anchor = dailyRunAnchorYmd(doc);
            if (anchor && anchor < todayYmd) return 'timed_out';
        } else if (explicitQueueDay && explicitQueueDay < todayYmd) {
            return 'timed_out';
        }
    }

    if (recentOnLesson) return 'in_progress';

    if (qLen > 0 && idx < qLen) return 'paused';

    if (doc.appRoute === 'learn' || doc.route === 'learn' || doc.lessonMode != null) {
        return 'paused';
    }

    const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    return now - t < LEGACY_ACTIVITY_MS ? 'active' : 'detached';
}
