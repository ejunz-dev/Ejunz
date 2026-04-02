import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import db from '../service/db';
import bus from '../service/bus';

export type LessonMode = 'today' | 'node' | 'allDomains' | null;

/** Frozen lesson order for the current session (base/training changes do not mutate until a new queue is started). */
export interface LessonCardQueueItem {
    domainId: string;
    nodeId: string;
    cardId: string;
    nodeTitle?: string;
    cardTitle?: string;
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
    /** Entry domain for learn allDomains mode (usually equals domainId on that row). */
    allDomainsEntryDomainId?: string;
    /** Ordered cards for the active lesson run; set once per \"start\" until cleared or mode change. */
    lessonCardQueue?: LessonCardQueueItem[];
    /** For `node` mode: subtree root the queue was generated from. */
    lessonQueueAnchorNodeId?: string | null;
    lessonQueueBaseDocId?: number | null;
    lessonQueueTrainingDocId?: string | null;
    state?: 'idle' | 'active';
    progress?: Record<string, unknown>;
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
    | 'allDomainsEntryDomainId'
    | 'lessonCardQueue'
    | 'lessonQueueAnchorNodeId'
    | 'lessonQueueBaseDocId'
    | 'lessonQueueTrainingDocId'
    | 'state'
    | 'progress'
>>;

function stripPatch(patch: SessionPatch): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined) out[k] = v;
    }
    return out;
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

    static async get(domainId: string, uid: number): Promise<SessionDoc | null> {
        return this.coll.findOne({ domainId, uid });
    }

    /**
     * Upsert progress and bump lastActivityAt.
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
        await this.coll.updateOne(
            { domainId, uid },
            { $set: $set as any, $setOnInsert: $setOnInsert as any },
            { upsert: true },
        );
        const doc = await this.get(domainId, uid);
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
        minutes: number,
        uid: number | undefined,
        page: number,
        pageSize: number,
    ) {
        const filter = SessionModel.activeQuery(domainId, minutes, uid);
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
        await this.coll.deleteOne({ domainId, uid });
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => SessionModel.coll.deleteMany({ domainId }));
    await db.ensureIndexes(
        SessionModel.coll,
        { key: { domainId: 1, uid: 1 }, name: 'domain_uid', unique: true },
        { key: { domainId: 1, lastActivityAt: -1 }, name: 'domain_activity' },
    );
    (global.Ejunz.model as any).session = SessionModel;
}
