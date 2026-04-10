import {
    Filter,
    MatchKeysAndValues,
    ObjectId,
    OnlyFieldsOfType,
    PushOperator,
    UpdateFilter,
    type FindOptions,
} from 'mongodb';
import type { Context } from '../context';
import type { AgentChatSessionDoc } from '../interface';
import { NotFoundError } from '../error';
import db from '../service/db';
import bus from '../service/bus';
import { Logger } from '../logger';
import { MaybeArray, NumberKeys } from '../typeutils';
import { deriveSessionLearnStatus, isDevelopSessionSettled } from '../lib/sessionListDisplay';

const logger = new Logger('model/session');

/** Match agent chat rows by `agentSessionKind`. */
export function agentChatSessionKindFilter(
    kind?: 'chat' | 'client' | { $in: ('chat' | 'client')[] },
): Record<string, unknown> {
    if (kind == null || (typeof kind === 'object' && '$in' in kind)) {
        const inArr = (kind as { $in: ('chat' | 'client')[] } | undefined)?.$in ?? (['chat', 'client'] as const);
        return { agentSessionKind: { $in: inArr } };
    }
    return { agentSessionKind: kind };
}

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
    /** Which app owns this row (`learn` | `develop` | `agent`). */
    appRoute?: 'learn' | 'develop' | 'agent';
    /** Agent chat: agent id string (same as Agent doc). */
    agentId?: string;
    /** Agent conversation: `chat` (web) or `client` (Edge). */
    agentSessionKind?: 'chat' | 'client';
    /** Optional title for agent conversation list. */
    title?: string;
    /** Arbitrary JSON context (tools, systemMessage snapshot, etc.). */
    context?: any;
    /** When session kind is `client`, bound Edge client id. */
    clientId?: number;
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
    /**
     * Opaque progress bag. Develop editor may store `developEditorNav`:
     * `{ cardId?, nodeId?, workspace? }` to restore `/develop/editor?session=` URL on next open.
     */
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
    | 'agentId'
    | 'agentSessionKind'
    | 'title'
    | 'context'
    | 'clientId'
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

/** Last editor URL fragment on `session.progress.developEditorNav` (develop editor resume). */
export type DevelopEditorNavWire = { cardId?: string; nodeId?: string; workspace?: string };

export function readDevelopEditorNav(sess: SessionDoc): DevelopEditorNavWire | null {
    const p = sess.progress as Record<string, unknown> | undefined;
    const raw = p?.developEditorNav;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;
    const cardId = typeof o.cardId === 'string' ? o.cardId.trim() : '';
    const nodeId = typeof o.nodeId === 'string' ? o.nodeId.trim() : '';
    const workspace = typeof o.workspace === 'string' ? o.workspace.trim() : '';
    if (!cardId && !nodeId) return null;
    const out: DevelopEditorNavWire = {};
    if (cardId) out.cardId = cardId;
    if (nodeId) out.nodeId = nodeId;
    if (workspace) out.workspace = workspace;
    return out;
}

export type PersistDevelopEditorNavInput = {
    sessionHex: string;
    cardId?: string;
    nodeId?: string;
    workspace?: string;
    /** When set (e.g. base `/base/ws` docId), session must belong to this base. */
    expectedBaseDocId?: number;
};

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

    /** Mongo filter for domain session admin list (live list + filters). */
    static buildSessionListMongoFilter(
        domainId: string,
        uid: number | undefined,
        opts?: { hideLearnHomePlaceholderShells?: boolean; sessionKind?: 'learn' | 'develop' | 'agent' },
    ): Record<string, unknown> {
        const filter: Record<string, unknown> = { domainId };
        if (uid != null) (filter as any).uid = uid;
        const kind = opts?.sessionKind;
        const hide = !!opts?.hideLearnHomePlaceholderShells;

        if (kind === 'agent') {
            (filter as any).appRoute = 'agent';
            Object.assign(filter, agentChatSessionKindFilter());
            return filter;
        }

        if (hide) {
            (filter as any).$nor = [MONGO_MATCH_LEARN_HOME_PLACEHOLDER_SHELL];
        }

        if (kind === 'develop') {
            (filter as any).$or = [{ appRoute: 'develop' }, { route: 'develop' }];
            return filter;
        }

        if (kind === 'learn') {
            (filter as any).$and = [
                {
                    $nor: [
                        { appRoute: 'agent' },
                        { route: 'agent' },
                        { appRoute: 'develop' },
                        { route: 'develop' },
                    ],
                },
                {
                    $or: [
                        { appRoute: 'learn' },
                        { route: 'learn' },
                        { lessonMode: { $exists: true, $ne: null } },
                        { 'lessonCardQueue.0': { $exists: true } },
                    ],
                },
            ];
            return filter;
        }

        return filter;
    }

    static async findSortedForSessionList(
        domainId: string,
        uid: number | undefined,
        opts?: { hideLearnHomePlaceholderShells?: boolean; sessionKind?: 'learn' | 'develop' | 'agent' },
    ): Promise<SessionDoc[]> {
        const filter = this.buildSessionListMongoFilter(domainId, uid, opts);
        return this.coll
            .find(filter as Filter<SessionDoc>)
            .sort({ lastActivityAt: -1 })
            .toArray();
    }

    static async listPage(
        domainId: string,
        uid: number | undefined,
        page: number,
        pageSize: number,
        opts?: { hideLearnHomePlaceholderShells?: boolean; sessionKind?: 'learn' | 'develop' | 'agent' },
    ) {
        const filter = this.buildSessionListMongoFilter(domainId, uid, opts);
        const [rows, count] = await Promise.all([
            this.coll
                .find(filter as Filter<SessionDoc>)
                .sort({ lastActivityAt: -1 })
                .skip((page - 1) * pageSize)
                .limit(pageSize)
                .toArray(),
            this.coll.countDocuments(filter as Filter<SessionDoc>),
        ]);
        return { rows, count };
    }

    static async deleteForUser(domainId: string, uid: number) {
        await this.coll.deleteMany({ domainId, uid });
    }

    /**
     * Session row whose `_id` is the agent conversation id (`session_record.sessionId` after insert).
     */
    static async ensureAgentChatSession(
        domainId: string,
        uid: number,
        chatSessionId: ObjectId,
        agentId: string,
    ): Promise<SessionDoc> {
        const doc = await this.coll.findOne({
            _id: chatSessionId,
            domainId,
            uid,
            appRoute: 'agent',
            ...agentChatSessionKindFilter(),
        });
        if (!doc) {
            throw new NotFoundError('Agent conversation not found');
        }
        const now = new Date();
        await this.coll.updateOne(
            { _id: doc._id, domainId, uid },
            { $set: { lastActivityAt: now, updatedAt: now, agentId } },
        );
        const out = await this.coll.findOne({ _id: doc._id, domainId, uid });
        if (out) bus.broadcast('session/change', out as SessionDoc);
        return out as SessionDoc;
    }

    /** Map agent conversation session → template / WS view. */
    static toAgentChatSessionView(doc: SessionDoc | null): AgentChatSessionDoc | null {
        const kind = doc?.agentSessionKind;
        if (!doc || !kind) return null;
        const ids = doc.recordIds || [];
        return {
            _id: doc._id,
            domainId: doc.domainId,
            agentId: doc.agentId!,
            uid: doc.uid,
            recordIds: ids,
            type: kind,
            title: doc.title,
            context: doc.context ?? {},
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
            lastActivityAt: doc.lastActivityAt,
            ...(doc.clientId !== undefined ? { clientId: doc.clientId } : {}),
        };
    }

    private static normalizeAgentChatSessionQuery(domainId: string, query: Record<string, unknown>): Record<string, unknown> {
        const q = { ...query };
        const t = q.type as 'chat' | 'client' | undefined;
        delete q.type;
        return {
            domainId,
            appRoute: 'agent',
            ...(t ? agentChatSessionKindFilter(t) : agentChatSessionKindFilter()),
            ...q,
        };
    }

    static async getAgentChatSession(domainId: string, _id: ObjectId): Promise<AgentChatSessionDoc | null> {
        const doc = await this.coll.findOne({
            _id,
            domainId,
            appRoute: 'agent',
            ...agentChatSessionKindFilter(),
        });
        return SessionModel.toAgentChatSessionView(doc as SessionDoc);
    }

    static async addAgentChatSession(
        domainId: string,
        agentId: string,
        uid: number,
        kind: 'chat' | 'client',
        title?: string,
        context?: any,
        clientId?: number,
    ): Promise<ObjectId> {
        const now = new Date();
        const doc = {
            _id: new ObjectId(),
            domainId,
            uid,
            appRoute: 'agent' as const,
            route: 'agent',
            agentSessionKind: kind,
            agentId,
            recordIds: [] as ObjectId[],
            title: title ?? `Chat ${now.toLocaleString()}`,
            context: context ?? {},
            state: 'active' as const,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
            ...(clientId !== undefined ? { clientId } : {}),
        } as SessionDoc;
        await this.coll.insertOne(doc as any);
        bus.broadcast('session/change', doc);
        const v = SessionModel.toAgentChatSessionView(doc);
        if (v) (bus as any).broadcast('agent_chat_session/change', v);
        return doc._id;
    }

    static async appendAgentChatSessionRecord(
        domainId: string,
        chatSessionId: ObjectId,
        recordId: ObjectId,
    ): Promise<AgentChatSessionDoc | null> {
        const now = new Date();
        const updated = await this.coll.findOneAndUpdate(
            {
                _id: chatSessionId,
                domainId,
                appRoute: 'agent',
                ...agentChatSessionKindFilter(),
            },
            {
                $addToSet: { recordIds: recordId },
                $set: { updatedAt: now, lastActivityAt: now },
            },
            { returnDocument: 'after' },
        );
        const raw = unwrapFindOneSession(updated);
        if (raw) {
            bus.broadcast('session/change', raw);
            const v = SessionModel.toAgentChatSessionView(raw);
            if (v) (bus as any).broadcast('agent_chat_session/change', v);
            return v;
        }
        return null;
    }

    static findAgentChatSessions(domainId: string, query: Record<string, unknown>, options?: FindOptions) {
        const q = SessionModel.normalizeAgentChatSessionQuery(domainId, query);
        return this.coll.find(q as Filter<SessionDoc>, options);
    }

    static countAgentChatSessions(domainId: string, query: Record<string, unknown>) {
        const q = SessionModel.normalizeAgentChatSessionQuery(domainId, query);
        return this.coll.countDocuments(q as Filter<SessionDoc>);
    }

    static async updateAgentChatSession(
        domainId: string,
        _id: MaybeArray<ObjectId>,
        $set?: MatchKeysAndValues<AgentChatSessionDoc>,
        $push?: PushOperator<AgentChatSessionDoc>,
        $unset?: OnlyFieldsOfType<AgentChatSessionDoc, any, true | '' | 1>,
        $inc?: Partial<Record<NumberKeys<AgentChatSessionDoc>, number>>,
    ): Promise<AgentChatSessionDoc | null> {
        const mappedSet = $set ? { ...($set as Record<string, unknown>) } : undefined;
        if (mappedSet?.type !== undefined) {
            mappedSet.agentSessionKind = mappedSet.type;
            delete mappedSet.type;
        }
        const $update: UpdateFilter<SessionDoc> = {};
        if (mappedSet && Object.keys(mappedSet).length) $update.$set = mappedSet as any;
        if ($push && Object.keys($push).length) $update.$push = $push as any;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset as any;
        if ($inc && Object.keys($inc).length) $update.$inc = $inc as any;
        const base = {
            domainId,
            appRoute: 'agent',
            ...agentChatSessionKindFilter(),
        };
        if (_id instanceof Array) {
            await this.coll.updateMany({ _id: { $in: _id }, ...base }, $update);
            return null;
        }
        if (Object.keys($update).length) {
            const updated = await this.coll.findOneAndUpdate(
                { _id, ...base },
                $update,
                { returnDocument: 'after' },
            );
            const raw = unwrapFindOneSession(updated);
            if (raw) {
                bus.broadcast('session/change', raw);
                const v = SessionModel.toAgentChatSessionView(raw);
                if (v) (bus as any).broadcast('agent_chat_session/change', v);
                return v;
            }
            return null;
        }
        const doc = await this.coll.findOne({ _id, ...base }, { readPreference: 'primary' });
        return SessionModel.toAgentChatSessionView(doc as SessionDoc);
    }

    static async deleteAgentChatSession(domainId: string, _id: ObjectId) {
        return this.coll.deleteOne({
            _id,
            domainId,
            appRoute: 'agent',
            ...agentChatSessionKindFilter(),
        });
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

    /**
     * Persist develop editor URL state on the session document (via POST /base/save or /base/batch-save `developEditorNav`).
     */
    static async persistDevelopEditorNav(
        domainId: string,
        uid: number,
        input: PersistDevelopEditorNavInput,
    ): Promise<void> {
        const sessionHex = (input.sessionHex || '').trim();
        if (!sessionHex || !ObjectId.isValid(sessionHex)) return;

        const trimCap = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
        const cardId = trimCap(input.cardId, 64);
        const nodeId = trimCap(input.nodeId, 256);
        const workspace = trimCap(input.workspace, 512);
        if (!cardId && !nodeId) return;

        const sess = await this.coll.findOne({
            _id: new ObjectId(sessionHex),
            domainId,
            uid,
            appRoute: 'develop',
        }) as SessionDoc | null;
        if (!sess) return;

        if (input.expectedBaseDocId != null) {
            const bid = Number(sess.baseDocId);
            if (!Number.isFinite(bid) || bid !== input.expectedBaseDocId) return;
        }

        if (isDevelopSessionSettled(sess)) return;
        const histSt = deriveSessionLearnStatus(sess);
        if (histSt === 'timed_out' || histSt === 'finished' || histSt === 'abandoned') return;

        const prevRaw = sess.progress;
        const prev = prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
            ? { ...(prevRaw as Record<string, unknown>) }
            : {};
        const prevNavRaw = prev.developEditorNav;
        const prevNav = prevNavRaw && typeof prevNavRaw === 'object' && !Array.isArray(prevNavRaw)
            ? (prevNavRaw as Record<string, unknown>)
            : {};
        const developEditorNav: Record<string, string> = {};
        if (cardId) {
            developEditorNav.cardId = cardId;
            if (nodeId) developEditorNav.nodeId = nodeId;
        } else if (nodeId) {
            developEditorNav.nodeId = nodeId;
        }
        const wsMerged = workspace || (typeof prevNav.workspace === 'string' ? prevNav.workspace.trim() : '');
        if (wsMerged) developEditorNav.workspace = wsMerged;
        if (Object.keys(developEditorNav).length === 0) {
            delete prev.developEditorNav;
        } else {
            prev.developEditorNav = developEditorNav;
        }
        await this.touchById(
            domainId,
            uid,
            sess._id,
            { progress: prev as SessionDoc['progress'] } as any,
            { silent: true },
        );
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => SessionModel.coll.deleteMany({ domainId }));
    await db.ensureIndexes(
        SessionModel.coll,
        { key: { domainId: 1, uid: 1, lastActivityAt: -1 }, name: 'domain_uid' },
        { key: { domainId: 1, lastActivityAt: -1 }, name: 'domain_activity' },
        { key: { domainId: 1, appRoute: 1, agentSessionKind: 1, uid: 1, _id: -1 }, name: 'agent_chat_sessions' },
        { key: { domainId: 1, appRoute: 1, agentId: 1, uid: 1, _id: -1 }, name: 'agent_chat_by_agent' },
        { key: { domainId: 1, appRoute: 1, clientId: 1, lastActivityAt: -1 }, name: 'agent_chat_client_activity' },
    );

    const TIMEOUT_MS = 5 * 60 * 1000;
    setInterval(async () => {
        try {
            const timeoutThreshold = new Date(Date.now() - TIMEOUT_MS);
            const n = await SessionModel.coll.countDocuments({
                appRoute: 'agent',
                ...agentChatSessionKindFilter('client'),
                lastActivityAt: { $lt: timeoutThreshold },
            });
            if (n > 0) logger.debug('Found %d stale client agent sessions (detached heuristic)', n);
        } catch (e) {
            logger.error('Agent session timeout check: %O', e);
        }
    }, 30000);

    (global.Ejunz.model as any).session = SessionModel;
}
