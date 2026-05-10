import { ObjectId } from 'mongodb';
import {
    getLearnSessionMode,
    getLearnNewReviewRatio,
    getLearnNewReviewOrder,
    getLearnSessionCardFilter,
    learnSessionProblemTagSettingsMatchDuWithSession,
    normalizeLearnNewReviewOrder,
    normalizeLearnSessionCardFilter,
    normalizeLearnSessionMode,
} from './learnModePrefs';
import type { LessonCardQueueItem, LessonMode, SessionDoc, SessionPatch } from '../model/session';
import SessionModel from '../model/session';

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
    lessonQueueLearnBranch: string | undefined;
    lessonQueueLearnSectionOrderIndex: number | undefined;
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
            lessonQueueLearnBranch: undefined,
            lessonQueueLearnSectionOrderIndex: undefined,
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
        lessonQueueLearnBranch:
            typeof sdoc.lessonQueueLearnBranch === 'string' && sdoc.lessonQueueLearnBranch.trim()
                ? sdoc.lessonQueueLearnBranch.trim()
                : undefined,
        lessonQueueLearnSectionOrderIndex: typeof sdoc.lessonQueueLearnSectionOrderIndex === 'number'
            ? sdoc.lessonQueueLearnSectionOrderIndex
            : undefined,
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

const normSectionOrder = (arr: unknown): string[] =>
    (Array.isArray(arr) ? arr : []).map((x) => String(x));

/** Bump when mixed-mode ordering algorithm changes (invalidates frozen today queues). */
export const LESSON_QUEUE_MIXED_LAYOUT_VERSION = 15;

/**
 * Frozen `today` queue must match current domain learn settings; otherwise rebuild (section order / learning start / branch).
 */
export function frozenTodayQueueMatchesLearnSettings(dudoc: any, s: SessionDoc): boolean {
    const du = dudoc || {};
    const ordDu = normSectionOrder(du.learnSectionOrder);
    const rawSnap = (s as SessionDoc & { lessonQueueLearnSectionOrder?: string[] }).lessonQueueLearnSectionOrder;
    const hasSnap = Array.isArray(rawSnap);
    const ordS = hasSnap ? normSectionOrder(rawSnap) : null;
    if (hasSnap) {
        if (JSON.stringify(ordDu) !== JSON.stringify(ordS)) return false;
    } else if (ordDu.length > 0) {
        return false;
    }
    const branchDu =
        typeof du.learnBranch === 'string' && String(du.learnBranch).trim()
            ? String(du.learnBranch).trim()
            : 'main';
    const branchS =
        s.lessonQueueLearnBranch != null && String(s.lessonQueueLearnBranch).trim()
            ? String(s.lessonQueueLearnBranch).trim()
            : null;
    if (branchS !== null) {
        if (branchDu !== branchS) return false;
    } else if (branchDu !== 'main') {
        return false;
    }
    const di = typeof du.currentLearnSectionIndex === 'number' ? du.currentLearnSectionIndex : undefined;
    const si = typeof s.currentLearnSectionIndex === 'number' ? s.currentLearnSectionIndex : undefined;
    if (di !== undefined && (si === undefined || si !== di)) return false;
    const did = typeof du.currentLearnSectionId === 'string' && du.currentLearnSectionId.trim()
        ? du.currentLearnSectionId.trim()
        : undefined;
    const sid = typeof s.currentLearnSectionId === 'string' && s.currentLearnSectionId.trim()
        ? s.currentLearnSectionId.trim()
        : undefined;
    if (did !== undefined && sid !== undefined && did !== sid) return false;
    const dCard =
        typeof (du as { currentLearnStartCardId?: unknown }).currentLearnStartCardId === 'string'
        && String((du as { currentLearnStartCardId: string }).currentLearnStartCardId).trim()
            ? String((du as { currentLearnStartCardId: string }).currentLearnStartCardId).trim()
            : null;
    const sCardRaw = (s as SessionDoc & { lessonQueueLearnStartCardId?: string | null }).lessonQueueLearnStartCardId;
    const sCard =
        typeof sCardRaw === 'string' && sCardRaw.trim() ? sCardRaw.trim() : null;
    /** Must match advancing `domain.user.currentLearnStartCardId` after passes (`postPass` today syncs onto the session row). */
    if (dCard !== sCard) return false;
    const normalizedDu = getLearnSessionMode(du);
    const rawS = (s as SessionDoc & { lessonQueueLearnSessionMode?: string | null }).lessonQueueLearnSessionMode;
    const normalizedS = normalizeLearnSessionMode(rawS);
    if (normalizedDu !== normalizedS) return false;

    const cardFilterDu = getLearnSessionCardFilter(du);
    const rawCf = (s as SessionDoc & { lessonQueueLearnSessionCardFilter?: string | null }).lessonQueueLearnSessionCardFilter;
    const cardFilterSnap =
        rawCf === undefined || rawCf === null || String(rawCf).trim() === ''
            ? 'all'
            : normalizeLearnSessionCardFilter(rawCf);
    if (cardFilterSnap !== cardFilterDu) return false;

    const tagOk = learnSessionProblemTagSettingsMatchDuWithSession(
        du,
        (s as SessionDoc & { lessonQueueLearnSessionProblemTagMode?: unknown }).lessonQueueLearnSessionProblemTagMode,
        (s as SessionDoc & { lessonQueueLearnSessionProblemTags?: unknown }).lessonQueueLearnSessionProblemTags,
    );
    if (!tagOk) return false;

    const rDu = getLearnNewReviewRatio(du);
    const rawR = (s as SessionDoc & { lessonQueueLearnNewReviewRatio?: number | null }).lessonQueueLearnNewReviewRatio;
    if (typeof rawR !== 'number' || ![-1, 0, 1, 2, 3, 4, 5].includes(rawR)) {
        return false;
    }
    if (rDu !== rawR) return false;

    const oDu = getLearnNewReviewOrder(du);
    const rawOrd = (s as SessionDoc & { lessonQueueLearnNewReviewOrder?: string | null }).lessonQueueLearnNewReviewOrder;
    if (typeof rawOrd !== 'string' || !rawOrd.trim()) return false;
    if (normalizeLearnNewReviewOrder(rawOrd) !== oDu) return false;

    const vS = (s as SessionDoc & { lessonQueueMixedLayoutVersion?: number | null }).lessonQueueMixedLayoutVersion;
    if (vS !== LESSON_QUEUE_MIXED_LAYOUT_VERSION) return false;
    return true;
}

/**
 * Learn shell row: `appRoute` learn, no `lessonMode` yet — may be created when user starts a lesson (e.g. `insertOrUpgradeLearnSession`), not on `/learn` GET.
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
