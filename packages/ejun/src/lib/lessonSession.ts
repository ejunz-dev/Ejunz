import { ObjectId } from 'mongodb';
import type { LessonCardQueueItem, LessonMode, SessionDoc, SessionPatch } from '../model/session';
import SessionModel from '../model/session';
import { deriveSessionLearnStatus, sessionUtcYmd } from './sessionListDisplay';

/** Merged lesson resume fields: session row overrides legacy domain user fields when present. */
export interface MergedLessonState {
    lessonMode: LessonMode;
    lessonCardIndex: number;
    /** From session.cardId when lessonMode is `card`. */
    lessonCardId: string | undefined;
    lessonNodeId: string | undefined;
    currentLearnSectionIndex: number | undefined;
    currentLearnSectionId: string | undefined;
    lessonReviewCardIds: string[];
    lessonCardTimesMs: number[];
    lessonCardQueue: LessonCardQueueItem[];
    lessonQueueAnchorNodeId: string | undefined;
    lessonQueueBaseDocId: number | undefined;
    lessonQueueTrainingDocId: string | undefined;
}

export function mergeDomainLessonState(dudoc: any, sdoc: SessionDoc | null): MergedLessonState {
    const d = dudoc || {};
    if (!sdoc) {
        return {
            lessonMode: d.lessonMode ?? null,
            lessonCardIndex: typeof d.lessonCardIndex === 'number' ? d.lessonCardIndex : 0,
            lessonCardId: typeof d.lessonCardId === 'string' && d.lessonCardId ? d.lessonCardId : undefined,
            lessonNodeId: d.lessonNodeId as string | undefined,
            currentLearnSectionIndex: typeof d.currentLearnSectionIndex === 'number' ? d.currentLearnSectionIndex : undefined,
            currentLearnSectionId: d.currentLearnSectionId as string | undefined,
            lessonReviewCardIds: Array.isArray(d.lessonReviewCardIds) ? [...d.lessonReviewCardIds] : [],
            lessonCardTimesMs: Array.isArray(d.lessonCardTimesMs) ? [...d.lessonCardTimesMs] : [],
            lessonCardQueue: [],
            lessonQueueAnchorNodeId: undefined,
            lessonQueueBaseDocId: undefined,
            lessonQueueTrainingDocId: undefined,
        };
    }
    return {
        lessonMode: sdoc.lessonMode !== undefined ? sdoc.lessonMode : (d.lessonMode ?? null),
        lessonCardIndex: typeof sdoc.cardIndex === 'number'
            ? sdoc.cardIndex
            : (typeof d.lessonCardIndex === 'number' ? d.lessonCardIndex : 0),
        lessonCardId: (typeof sdoc.cardId === 'string' && sdoc.cardId.trim())
            ? sdoc.cardId.trim()
            : (typeof d.lessonCardId === 'string' && d.lessonCardId ? d.lessonCardId : undefined),
        lessonNodeId: (typeof sdoc.nodeId === 'string' && sdoc.nodeId !== '')
            ? sdoc.nodeId
            : d.lessonNodeId as string | undefined,
        currentLearnSectionIndex: typeof sdoc.currentLearnSectionIndex === 'number'
            ? sdoc.currentLearnSectionIndex
            : (typeof d.currentLearnSectionIndex === 'number' ? d.currentLearnSectionIndex : undefined),
        currentLearnSectionId: sdoc.currentLearnSectionId ?? d.currentLearnSectionId as string | undefined,
        lessonReviewCardIds: Array.isArray(sdoc.lessonReviewCardIds)
            ? [...sdoc.lessonReviewCardIds]
            : (Array.isArray(d.lessonReviewCardIds) ? [...d.lessonReviewCardIds] : []),
        lessonCardTimesMs: Array.isArray(sdoc.lessonCardTimesMs)
            ? [...sdoc.lessonCardTimesMs]
            : (Array.isArray(d.lessonCardTimesMs) ? [...d.lessonCardTimesMs] : []),
        lessonCardQueue: Array.isArray(sdoc.lessonCardQueue) ? [...sdoc.lessonCardQueue] : [],
        lessonQueueAnchorNodeId: (sdoc.lessonQueueAnchorNodeId !== undefined && sdoc.lessonQueueAnchorNodeId !== '')
            ? (sdoc.lessonQueueAnchorNodeId as string)
            : undefined,
        lessonQueueBaseDocId: typeof sdoc.lessonQueueBaseDocId === 'number' ? sdoc.lessonQueueBaseDocId : undefined,
        lessonQueueTrainingDocId: sdoc.lessonQueueTrainingDocId ?? undefined,
    };
}

export async function touchLessonSession(
    domainId: string,
    uid: number,
    patch: SessionPatch,
    opts?: { silent?: boolean },
) {
    return SessionModel.touch(domainId, uid, patch, opts);
}

export function isLessonSessionAbandoned(doc: SessionDoc | null | undefined): boolean {
    return !!(doc && (doc as SessionDoc & { lessonAbandonedAt?: Date | null }).lessonAbandonedAt);
}

/**
 * Learn home row created by `ensureLearnPageSessionId` (appRoute learn, no mode yet).
 * Starting daily practice should upgrade this row instead of inserting a second document.
 */
export function isLearnHomePlaceholderSession(doc: SessionDoc | null | undefined): boolean {
    if (!doc) return false;
    if (doc.appRoute !== 'learn' && doc.route !== 'learn') return false;
    if (isLessonSessionAbandoned(doc)) return false;
    if (doc.lessonMode != null) return false;
    const q = doc.lessonCardQueue;
    if (Array.isArray(q) && q.length > 0) return false;
    if (typeof doc.cardId === 'string' && doc.cardId.trim()) return false;
    return true;
}

/**
 * After learn settings change (section order / daily goal): abandon only this user's **today** daily-lesson
 * session (`lessonMode: 'today'`, UTC calendar day). Node/card sessions and learn placeholder rows are untouched.
 *
 * Only sets `lessonAbandonedAt` and `lastActivityAt` to the abandon time; does not clear queue, lessonMode,
 * or card fields (keeps list display accurate; resumption still blocked via resolve / deriveStatus).
 */
export async function abandonLearnSessionsAfterSettingsChange(domainId: string, uid: number): Promise<void> {
    const now = new Date();
    const ymd = sessionUtcYmd();
    const dayStart = new Date(`${ymd}T00:00:00.000Z`);
    const dayEnd = new Date(`${ymd}T23:59:59.999Z`);
    await SessionModel.coll.updateMany(
        {
            domainId,
            uid,
            lessonMode: 'today',
            $and: [
                {
                    $or: [
                        { lessonAbandonedAt: { $exists: false } },
                        { lessonAbandonedAt: null },
                    ],
                },
                {
                    $or: [
                        { lessonQueueDay: ymd },
                        {
                            $and: [
                                {
                                    $or: [
                                        { lessonQueueDay: { $exists: false } },
                                        { lessonQueueDay: null },
                                        { lessonQueueDay: '' },
                                    ],
                                },
                                {
                                    $or: [
                                        { 'lessonCardQueue.0': { $exists: true } },
                                        { lastActivityAt: { $gte: dayStart, $lte: dayEnd } },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            $set: {
                lessonAbandonedAt: now,
                lastActivityAt: now,
            },
        },
    );
}

/**
 * Latest daily (`today`) learn session that may be resumed from the learn home "start" action.
 * Skips timed_out / finished / detached; only paused or in_progress.
 */
export async function findResumableDailyLearnSession(
    domainId: string,
    uid: number,
): Promise<SessionDoc | null> {
    const rows = await SessionModel.coll
        .find({ domainId, uid, lessonMode: 'today' })
        .sort({ lastActivityAt: -1 })
        .limit(30)
        .toArray();
    const now = Date.now();
    for (const row of rows) {
        const doc = row as SessionDoc;
        const st = deriveSessionLearnStatus(doc, now);
        if (st === 'paused' || st === 'in_progress') return doc;
    }
    return null;
}

/** Load session row by `?session=<_id>` (must match domain + uid) or fall back to domain+uid row. */
export async function resolveLessonSessionDoc(
    domainId: string,
    uid: number,
    querySessionId?: string | null,
): Promise<SessionDoc | null> {
    const q = typeof querySessionId === 'string' ? querySessionId.trim() : '';
    if (q && ObjectId.isValid(q)) {
        const doc = await SessionModel.coll.findOne({ _id: new ObjectId(q), domainId, uid });
        if (doc) {
            if (isLessonSessionAbandoned(doc as SessionDoc)) return null;
            return doc as SessionDoc;
        }
    }
    const fallback = await SessionModel.get(domainId, uid);
    if (isLessonSessionAbandoned(fallback)) return null;
    return fallback;
}

export function lessonSessionIdFromDoc(doc: SessionDoc | null | undefined): string {
    return doc?._id?.toString() ?? '';
}

/** Append `session=<id>` so lesson URLs can resume the same Mongo session row. */
export function appendLessonSessionToUrl(url: string, sessionId?: string | null): string {
    if (!sessionId) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}session=${encodeURIComponent(sessionId)}`;
}
