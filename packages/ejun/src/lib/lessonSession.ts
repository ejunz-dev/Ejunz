import { ObjectId } from 'mongodb';
import type { LessonCardQueueItem, LessonMode, SessionDoc, SessionPatch } from '../model/session';
import SessionModel from '../model/session';

/** Merged lesson resume fields: session row overrides legacy domain user fields when present. */
export interface MergedLessonState {
    lessonMode: LessonMode;
    lessonCardIndex: number;
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
        lessonNodeId: (sdoc.nodeId !== undefined && sdoc.nodeId !== '')
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

/** Load session row by `?session=<_id>` (must match domain + uid) or fall back to domain+uid row. */
export async function resolveLessonSessionDoc(
    domainId: string,
    uid: number,
    querySessionId?: string | null,
): Promise<SessionDoc | null> {
    const q = typeof querySessionId === 'string' ? querySessionId.trim() : '';
    if (q && ObjectId.isValid(q)) {
        const doc = await SessionModel.coll.findOne({ _id: new ObjectId(q), domainId, uid });
        if (doc) return doc as SessionDoc;
    }
    return SessionModel.get(domainId, uid);
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
