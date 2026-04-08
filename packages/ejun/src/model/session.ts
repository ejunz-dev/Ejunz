import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import db from '../service/db';
import bus from '../service/bus';

export type LessonMode = 'today' | 'node' | 'card' | null;

/** Frozen lesson order for the current session (base/branch changes do not mutate until a new queue is started). */
export interface LessonCardQueueItem {
    domainId: string;
    nodeId: string;
    cardId: string;
    nodeTitle?: string;
    cardTitle?: string;
    /** Base doc id for the card (learn queue items). */
    baseDocId?: number;
    /** Slot in `learnSectionOrder` (duplicate sections differ by index, not only by root id). */
    learnSectionOrderIndex?: number;
    /** Daily queue only: whether this item was placed in the **new** arm or **review** arm (may cross geographic slot). */
    todayQueueRole?: 'new' | 'review';
}

/** Per-user live progress in a domain. Mongo collection: session. */
export interface SessionDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    baseDocId?: number;
    branch?: string;
    cardId?: string;
    nodeId?: string;
    cardIndex?: number;
    route?: string;
    /** Which lesson app owns this row (learn / collect / flag). */
    appRoute?: 'learn' | 'collect' | 'flag';
    lessonMode?: LessonMode;
    currentLearnSectionIndex?: number;
    currentLearnSectionId?: string;
    lessonReviewCardIds?: string[];
    lessonCardTimesMs?: number[];
    /** Ordered cards for the active lesson run; set once per \"start\" until cleared or mode change. */
    lessonCardQueue?: LessonCardQueueItem[];
    /** For `node` mode: subtree root the queue was generated from. */
    lessonQueueAnchorNodeId?: string | null;
    lessonQueueBaseDocId?: number | null;
    /** Learn flow: branch used when the daily queue was frozen (invalidates stale queues on change). */
    lessonQueueLearnBranch?: string | null;
    /** UTC YYYY-MM-DD when `lessonCardQueue` was frozen for `today`. */
    lessonQueueDay?: string | null;
    /** Copy of `domain.user.learnSectionOrder` when the daily queue was frozen; used to invalidate stale queues. */
    lessonQueueLearnSectionOrder?: string[];
    /** Copy of `domain.user.currentLearnStartCardId` when the daily queue was frozen (card-granular start within the section). */
    lessonQueueLearnStartCardId?: string | null;
    /** Section slot when starting single-card / node lesson (disambiguates duplicate roots). */
    lessonQueueLearnSectionOrderIndex?: number | null;
    /** `learnSessionMode` from domain.user when the daily queue was frozen (`deep` | `breadth` | `random`). */
    lessonQueueLearnSessionMode?: string | null;
    /** `learnSubMode` when the daily queue was frozen (`new_only` | `review_only` | `mixed`). */
    lessonQueueLearnSubMode?: string | null;
    /** `learnNewReviewRatio` when frozen (0=new only, -1=review only @ daily goal, 1–5=mixed). */
    lessonQueueLearnNewReviewRatio?: number | null;
    /** `learnNewReviewOrder` when frozen (`new_first` | `old_first` | `shuffle`). */
    lessonQueueLearnNewReviewOrder?: string | null;
    /** `learnMixedSchedule` when frozen (`mixed` mode). */
    lessonQueueLearnMixedSchedule?: string | null;
    /** Mixed-mode queue ordering algo revision (`lessonSession.LESSON_QUEUE_MIXED_LAYOUT_VERSION`). */
    lessonQueueMixedLayoutVersion?: number | null;
    /** Set when user changes learn settings (section order / daily goal); row is no longer resumable. */
    lessonAbandonedAt?: Date | null;
    state?: 'idle' | 'active';
    progress?: Record<string, unknown>;
    recordIds?: ObjectId[];
    lastActivityAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

export type SessionPatch = Partial<Pick<
    SessionDoc,
    | 'baseDocId'
    | 'branch'
    | 'cardId'
    | 'nodeId'
    | 'cardIndex'
    | 'route'
    | 'appRoute'
    | 'lessonMode'
    | 'currentLearnSectionIndex'
    | 'currentLearnSectionId'
    | 'lessonReviewCardIds'
    | 'lessonCardTimesMs'
    | 'lessonCardQueue'
    | 'lessonQueueAnchorNodeId'
    | 'lessonQueueBaseDocId'
    | 'lessonQueueLearnBranch'
    | 'lessonQueueDay'
    | 'lessonQueueLearnSectionOrder'
    | 'lessonQueueLearnStartCardId'
    | 'lessonQueueLearnSectionOrderIndex'
    | 'lessonQueueLearnSessionMode'
    | 'lessonQueueLearnSubMode'
    | 'lessonQueueLearnNewReviewRatio'
    | 'lessonQueueLearnNewReviewOrder'
    | 'lessonQueueLearnMixedSchedule'
    | 'lessonQueueMixedLayoutVersion'
    | 'lessonAbandonedAt'
    | 'state'
    | 'progress'
>>;

/**
 * Matches learn-home shell rows (`isLearnHomePlaceholderSession` in lessonSession.ts): learn route, no mode,
 * no card, empty queue, not abandoned. Used to hide them from the domain session admin list — they are not
 * “practice sessions” (legacy shells from older flows or first lesson start before mode is set).
 */
export const MONGO_MATCH_LEARN_HOME_PLACEHOLDER_SHELL: Record<string, unknown> = {
    $and: [
        { $or: [{ appRoute: 'learn' }, { route: 'learn' }] },
        { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
        { $or: [{ lessonMode: null }, { lessonMode: { $exists: false } }] },
        {
            $or: [
                { lessonCardQueue: { $exists: false } },
                { lessonCardQueue: null },
                { lessonCardQueue: { $size: 0 } },
            ],
        },
        {
            $or: [
                { cardId: { $exists: false } },
                { cardId: null },
                { cardId: '' },
            ],
        },
    ],
};

function stripPatch(patch: SessionPatch): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
}

function unwrapFindOneSession(updated: unknown): SessionDoc | null {
    if (updated == null) return null;
    if (typeof updated === 'object' && updated !== null && 'value' in updated) {
        return (updated as { value: SessionDoc | null }).value ?? null;
    }
    return updated as SessionDoc;
}

export default class SessionModel {
    static coll = db.collection('session');

    static activeCutoff(minutes: number) {
        return new Date(Date.now() - minutes * 60 * 1000);
    }

    static activeQuery(domainId: string, minutes: number, uid?: number) {
        const q: Record<string, unknown> = {
            domainId,
            lastActivityAt: { $gte: SessionModel.activeCutoff(minutes) },
        };
        if (uid != null) (q as any).uid = uid;
        return q;
    }

    /** Most recently active row for this user in the domain (may be one of several session documents). */
    static async get(domainId: string, uid: number): Promise<SessionDoc | null> {
        return this.coll.findOne({ domainId, uid }, { sort: { lastActivityAt: -1 } });
    }

    /** New session row (does not merge into an existing domain+uid document). */
    static async insertSession(
        domainId: string,
        uid: number,
        patch: SessionPatch = {},
        opts?: { silent?: boolean },
    ): Promise<SessionDoc> {
        const now = new Date();
        const doc = {
            _id: new ObjectId(),
            domainId,
            uid,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
            state: 'active' as const,
            ...stripPatch(patch),
        } as SessionDoc;
        await this.coll.insertOne(doc as any);
        if (!opts?.silent) bus.broadcast('session/change', doc);
        return doc;
    }

    /** Update a specific session by id (must belong to domain + uid). */
    static async touchById(
        domainId: string,
        uid: number,
        sessionId: ObjectId,
        patch: SessionPatch = {},
        opts?: { silent?: boolean },
    ): Promise<SessionDoc | null> {
        const now = new Date();
        const $set = {
            ...stripPatch(patch),
            updatedAt: now,
            lastActivityAt: now,
        };
        const updated = await this.coll.findOneAndUpdate(
            { _id: sessionId, domainId, uid },
            { $set: $set as any },
            { returnDocument: 'after' },
        );
        const doc = unwrapFindOneSession(updated);
        if (doc && !opts?.silent) bus.broadcast('session/change', doc);
        return doc;
    }

    /**
     * Upsert progress on the latest session row for (domainId, uid), bump lastActivityAt.
     * Uses findOneAndUpdate + sort so multiple rows per user do not pick an arbitrary document.
     * @param opts.silent — skip bus broadcast (high-frequency lesson steps).
     */
    static async touch(
        domainId: string,
        uid: number,
        patch: SessionPatch = {},
        opts?: { silent?: boolean },
    ): Promise<SessionDoc | null> {
        const now = new Date();
        const $set = {
            ...stripPatch(patch),
            updatedAt: now,
            lastActivityAt: now,
        };
        const $setOnInsert: Partial<SessionDoc> = {
            _id: new ObjectId(),
            domainId,
            uid,
            createdAt: now,
            state: 'active',
        };
        const updated = await this.coll.findOneAndUpdate(
            { domainId, uid },
            { $set: $set as any, $setOnInsert: $setOnInsert as any },
            { sort: { lastActivityAt: -1 }, upsert: true, returnDocument: 'after' } as any,
        );
        const doc = unwrapFindOneSession(updated);
        if (doc && !opts?.silent) bus.broadcast('session/change', doc);
        return doc;
    }

    static async listActive(domainId: string, sinceMinutes = 120): Promise<SessionDoc[]> {
        const cutoff = SessionModel.activeCutoff(sinceMinutes);
        return this.coll
            .find({ domainId, lastActivityAt: { $gte: cutoff } })
            .sort({ lastActivityAt: -1 })
            .toArray();
    }

    static async listPage(
        domainId: string,
        uid: number | undefined,
        page: number,
        pageSize: number,
        opts?: { hideLearnHomePlaceholderShells?: boolean },
    ) {
        const filter: Record<string, unknown> = { domainId };
        if (uid != null) (filter as any).uid = uid;
        if (opts?.hideLearnHomePlaceholderShells) {
            (filter as any).$nor = [MONGO_MATCH_LEARN_HOME_PLACEHOLDER_SHELL];
        }
        const [rows, count] = await Promise.all([
            this.coll
                .find(filter)
                .sort({ lastActivityAt: -1 })
                .skip((page - 1) * pageSize)
                .limit(pageSize)
                .toArray(),
            this.coll.countDocuments(filter),
        ]);
        return { rows, count };
    }

    static async deleteForUser(domainId: string, uid: number) {
        await this.coll.deleteMany({ domainId, uid });
    }

    static async addRecord(
        domainId: string,
        uid: number,
        sessionObjectId: ObjectId,
        recordId: ObjectId,
    ): Promise<SessionDoc | null> {
        const now = new Date();
        await this.coll.updateOne(
            { _id: sessionObjectId, domainId, uid },
            {
                $addToSet: { recordIds: recordId },
                $set: { updatedAt: now, lastActivityAt: now },
            },
        );
        const doc = await this.coll.findOne({ _id: sessionObjectId, domainId, uid });
        if (doc) bus.broadcast('session/change', doc);
        return doc as SessionDoc | null;
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => SessionModel.coll.deleteMany({ domainId }));
    await db.ensureIndexes(
        SessionModel.coll,
        { key: { domainId: 1, uid: 1, lastActivityAt: -1 }, name: 'domain_uid' },
        { key: { domainId: 1, lastActivityAt: -1 }, name: 'domain_activity' },
    );
    (global.Ejunz.model as any).session = SessionModel;
}
