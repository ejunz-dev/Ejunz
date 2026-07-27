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
import type { AgentChatSessionDoc, BaseDoc, LessonCardQueueItem, LessonMode, SessionDoc, SessionPatch } from '../interface';
import { NotFoundError } from '../error';
import db from '../service/db';
import bus from '../service/bus';
import { MaybeArray, NumberKeys } from '../typeutils';
import { BaseModel } from './base';
import type { SessionRecordDoc } from './record';
import {
    getLearnNewReviewOrder,
    getLearnNewReviewRatio,
    getLearnSessionCardFilter,
    getLearnSessionMode,
    learnSessionProblemTagSettingsMatchDuWithSession,
    normalizeLearnNewReviewOrder,
    normalizeLearnSessionCardFilter,
    normalizeLearnSessionMode,
} from './learn';

export function agentChatSessionKindFilter(
    kind?: 'chat' | 'client' | { $in: ('chat' | 'client')[] },
): Record<string, unknown> {
    if (kind == null || (typeof kind === 'object' && '$in' in kind)) {
        const inArr = (kind as { $in: ('chat' | 'client')[] } | undefined)?.$in ?? (['chat', 'client'] as const);
        return { agentSessionKind: { $in: inArr } };
    }
    return { agentSessionKind: kind };
}

export type {
    LessonCardQueueItem,
    LessonMode,
    SessionDoc,
    SessionPatch,
} from '../interface';

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

export function readDevelopEditorUrl(sess: SessionDoc | null | undefined): string {
    const p = sess?.progress as Record<string, unknown> | undefined;
    const raw = p?.developEditorUrl;
    return typeof raw === 'string' ? raw.trim().slice(0, 2048) : '';
}

async function resolveBaseFromEditorPathDocSeg(domainId: string, docSeg: string): Promise<BaseDoc | null> {
    const n = Number(docSeg);
    if (Number.isFinite(n) && n > 0) {
        return BaseModel.get(domainId, n);
    }
    return BaseModel.getBybid(domainId, docSeg);
}

function validateDevelopEditorEntryLocation(domainId: string, locationUrl: string, sessionHex: string): boolean {
    const loc = locationUrl.trim().slice(0, 2048);
    const m = /^\/d\/([^/]+)\/develop\/editor(?:\/)?(?:\?|$)/.exec(loc);
    if (!m || m[1] !== domainId) return false;
    const qi = loc.indexOf('?');
    const sp = new URLSearchParams(qi >= 0 ? loc.slice(qi + 1) : '');
    return sp.get('session') === sessionHex;
}

export async function validateDevelopEditorStoredLocation(
    domainId: string,
    locationUrl: string,
    sessionHex: string,
    expectedBaseDocId: number,
): Promise<boolean> {
    const loc = locationUrl.trim().slice(0, 2048);
    if (!loc || !sessionHex || !ObjectId.isValid(sessionHex)) return false;
    if (validateDevelopEditorEntryLocation(domainId, loc, sessionHex)) return true;
    const m = /^\/d\/([^/]+)\/base\/([^/]+)\/editor(?:\/)?(?:\?|$)/.exec(loc);
    if (!m) return false;
    if (m[1] !== domainId) return false;
    const docSeg = decodeURIComponent(String(m[2] || ''));
    if (!docSeg) return false;
    const base = await resolveBaseFromEditorPathDocSeg(domainId, docSeg);
    if (!base || Number(base.docId) !== Number(expectedBaseDocId)) return false;
    const qi = loc.indexOf('?');
    const sp = new URLSearchParams(qi >= 0 ? loc.slice(qi + 1) : '');
    return sp.get('session') === sessionHex;
}

export type DevelopSessionEditTotalsWire = { nodes: number; cards: number; problems: number };

export function readDevelopSessionEditTotals(sess: SessionDoc | null | undefined): DevelopSessionEditTotalsWire {
    const p = sess?.progress as Record<string, unknown> | undefined;
    const raw = p?.developSessionEditTotals;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { nodes: 0, cards: 0, problems: 0 };
    }
    const o = raw as Record<string, unknown>;
    return {
        nodes: Number(o.nodes) || 0,
        cards: Number(o.cards) || 0,
        problems: Number(o.problems) || 0,
    };
}

export async function settleStaleDailyLessonSessionsUtc(): Promise<number> {
    const now = Date.now();
    const DomainModel = require('./domain').default;
    const { deleteUserCache } = require('./user');
    let cleared = 0;
    const cursor = SessionModel.coll.find({
        lessonMode: 'today',
        'lessonCardQueue.0': { $exists: true },
    });
    const nowDate = new Date();
    for await (const raw of cursor) {
        const doc = raw as SessionDoc;
        const q = doc.lessonCardQueue ?? [];
        const idx = typeof doc.cardIndex === 'number' ? doc.cardIndex : 0;
        if (idx >= q.length) continue;
        if (!isSessionStalePastUtcCalendarDay(doc, now)) continue;
        const sidHex = doc._id.toHexString();
        await SessionModel.coll.updateOne(
            { _id: doc._id },
            {
                $set: {
                    lessonMode: null,
                    lessonCardQueue: [],
                    cardIndex: null,
                    lessonQueueDay: null,
                    updatedAt: nowDate,
                    lastActivityAt: nowDate,
                },
            },
        );
        await DomainModel.collUser.updateMany(
            {
                domainId: doc.domainId,
                uid: doc.uid,
                learnDailySessionId: sidHex,
            },
            {
                $set: {
                    learnDailySessionId: null,
                    learnDailySessionDay: null,
                },
            },
        );
        deleteUserCache(doc.domainId);
        const updated = await SessionModel.coll.findOne({ _id: doc._id });
        if (updated) {
            bus.broadcast('session/change', updated as SessionDoc);
            cleared += 1;
        }
    }
    return cleared;
}

export default class SessionModel {
    static settleStaleDailyLessonSessionsUtc = settleStaleDailyLessonSessionsUtc;

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
        return this.coll.findOne({ domainId, uid }, { sort: { lastActivityAt: -1 } });
    }

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

    static MCP_IDLE_MINUTES = 5;

    /**
     * Resolve the active MCP session for a client. Reuses the most recent session of this
     * (domainId, uid, mcpId) that has had activity within the idle window; otherwise starts a
     * new one. A gap longer than the idle window ends the previous session and opens a new one.
     */
    static async getOrCreateMcpSession(
        domainId: string,
        uid: number,
        mcpId: number,
        baseDocId: number,
        opts?: { idleMinutes?: number },
    ): Promise<SessionDoc> {
        const idle = opts?.idleMinutes ?? SessionModel.MCP_IDLE_MINUTES;
        const existing = await this.coll.findOne(
            {
                domainId,
                uid,
                appRoute: 'mcp',
                mcpId,
                lastActivityAt: { $gte: SessionModel.activeCutoff(idle) },
            },
            { sort: { lastActivityAt: -1 } },
        );
        if (existing) return existing as SessionDoc;
        const now = new Date();
        const doc = {
            _id: new ObjectId(),
            domainId,
            uid,
            appRoute: 'mcp' as const,
            route: 'mcp',
            mcpId,
            baseDocId,
            title: `MCP base ${baseDocId} · ${now.toLocaleString()}`,
            recordIds: [] as ObjectId[],
            state: 'active' as const,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
        } as SessionDoc;
        await this.coll.insertOne(doc as any);
        bus.broadcast('session/change', doc);
        return doc;
    }

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
            appRoute: 'agent' as const,
            ...agentChatSessionKindFilter(),
        } as Filter<SessionDoc>;
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

    static async persistDevelopEditorUrl(
        domainId: string,
        uid: number,
        input: {
            sessionHex: string;
            locationUrl: string;
            expectedBaseDocId: number;
        },
    ): Promise<void> {
        const sessionHex = (input.sessionHex || '').trim();
        if (!sessionHex || !ObjectId.isValid(sessionHex)) return;
        const loc = (input.locationUrl || '').trim().slice(0, 2048);
        if (!loc) return;
        const ok = await validateDevelopEditorStoredLocation(
            domainId,
            loc,
            sessionHex,
            input.expectedBaseDocId,
        );
        if (!ok) return;

        const sess = await this.coll.findOne({
            _id: new ObjectId(sessionHex),
            domainId,
            uid,
            appRoute: 'develop',
        }) as SessionDoc | null;
        if (!sess) return;
        if (isDevelopSessionSettled(sess)) return;
        const histSt = deriveSessionLearnStatus(sess);
        if (histSt === 'timed_out' || histSt === 'finished' || histSt === 'abandoned') return;

        const prevRaw = sess.progress;
        const prev = prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
            ? { ...(prevRaw as Record<string, unknown>) }
            : {};
        prev.developEditorUrl = loc;
        await this.touchById(
            domainId,
            uid,
            sess._id,
            { progress: prev as SessionDoc['progress'] } as any,
            { silent: true },
        );
    }
}

export interface MergedLessonState {
    lessonMode: LessonMode;
    lessonCardIndex: number;
    lessonCardId: string | undefined;
    lessonNodeId: string | undefined;
    currentLearnSectionIndex: number | undefined;
    currentLearnSectionId: string | undefined;
    lessonReviewCardIds: string[];
    lessonCardTimesMs: number[];
    lessonCardQueue: LessonCardQueueItem[];
    lessonQueueAnchorNodeId: string | undefined;
    lessonQueueBaseDocId: number | undefined;
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
        lessonNodeId: (typeof sdoc.nodeId === 'string' && sdoc.nodeId !== '') ? sdoc.nodeId : d.lessonNodeId as string | undefined,
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
            ? sdoc.lessonQueueAnchorNodeId as string
            : undefined,
        lessonQueueBaseDocId: typeof sdoc.lessonQueueBaseDocId === 'number' ? sdoc.lessonQueueBaseDocId : undefined,
        lessonQueueLearnSectionOrderIndex: typeof sdoc.lessonQueueLearnSectionOrderIndex === 'number'
            ? sdoc.lessonQueueLearnSectionOrderIndex
            : undefined,
    };
}

export async function touchLessonSession(domainId: string, uid: number, patch: SessionPatch, opts?: { silent?: boolean }) {
    return SessionModel.touch(domainId, uid, patch, opts);
}

export function isLessonSessionAbandoned(doc: SessionDoc | null | undefined): boolean {
    return !!(doc && (doc as SessionDoc & { lessonAbandonedAt?: Date | null }).lessonAbandonedAt);
}

const normSectionOrder = (arr: unknown): string[] => (Array.isArray(arr) ? arr : []).map((x) => String(x));

export const LESSON_QUEUE_MIXED_LAYOUT_VERSION = 15;

export function frozenTodayQueueMatchesLearnSettings(dudoc: any, s: SessionDoc): boolean {
    const du = dudoc || {};
    const ordDu = normSectionOrder(du.learnSectionOrder);
    const rawSnap = (s as SessionDoc & { lessonQueueLearnSectionOrder?: string[] }).lessonQueueLearnSectionOrder;
    const hasSnap = Array.isArray(rawSnap);
    const ordS = hasSnap ? normSectionOrder(rawSnap) : null;
    if (hasSnap) {
        if (JSON.stringify(ordDu) !== JSON.stringify(ordS)) return false;
    } else if (ordDu.length > 0) return false;

    const di = typeof du.currentLearnSectionIndex === 'number' ? du.currentLearnSectionIndex : undefined;
    const si = typeof s.currentLearnSectionIndex === 'number' ? s.currentLearnSectionIndex : undefined;
    if (di !== undefined && (si === undefined || si !== di)) return false;
    const did = typeof du.currentLearnSectionId === 'string' && du.currentLearnSectionId.trim()
        ? du.currentLearnSectionId.trim() : undefined;
    const sid = typeof s.currentLearnSectionId === 'string' && s.currentLearnSectionId.trim()
        ? s.currentLearnSectionId.trim() : undefined;
    if (did !== undefined && sid !== undefined && did !== sid) return false;

    const dCard = typeof (du as { currentLearnStartCardId?: unknown }).currentLearnStartCardId === 'string'
        && String((du as { currentLearnStartCardId: string }).currentLearnStartCardId).trim()
        ? String((du as { currentLearnStartCardId: string }).currentLearnStartCardId).trim() : null;
    const sCardRaw = (s as SessionDoc & { lessonQueueLearnStartCardId?: string | null }).lessonQueueLearnStartCardId;
    const sCard = typeof sCardRaw === 'string' && sCardRaw.trim() ? sCardRaw.trim() : null;
    if (dCard !== sCard) return false;

    if (getLearnSessionMode(du) !== normalizeLearnSessionMode((s as any).lessonQueueLearnSessionMode)) return false;
    const cardFilterDu = getLearnSessionCardFilter(du);
    const rawCf = (s as any).lessonQueueLearnSessionCardFilter;
    const cardFilterSnap = rawCf == null || String(rawCf).trim() === '' ? 'all' : normalizeLearnSessionCardFilter(rawCf);
    if (cardFilterSnap !== cardFilterDu) return false;
    if (!learnSessionProblemTagSettingsMatchDuWithSession(du, (s as any).lessonQueueLearnSessionProblemTagMode, (s as any).lessonQueueLearnSessionProblemTags)) return false;

    const rDu = getLearnNewReviewRatio(du);
    const rawR = (s as any).lessonQueueLearnNewReviewRatio;
    if (typeof rawR !== 'number' || ![-1, 0, 1, 2, 3, 4, 5].includes(rawR) || rDu !== rawR) return false;
    const oDu = getLearnNewReviewOrder(du);
    const rawOrd = (s as any).lessonQueueLearnNewReviewOrder;
    if (typeof rawOrd !== 'string' || !rawOrd.trim() || normalizeLearnNewReviewOrder(rawOrd) !== oDu) return false;
    return (s as any).lessonQueueMixedLayoutVersion === LESSON_QUEUE_MIXED_LAYOUT_VERSION;
}

export function isLearnHomePlaceholderSession(doc: SessionDoc | null | undefined): boolean {
    if (!doc || (doc.appRoute !== 'learn' && doc.route !== 'learn') || isLessonSessionAbandoned(doc)) return false;
    if (doc.lessonMode != null) return false;
    if (Array.isArray(doc.lessonCardQueue) && doc.lessonCardQueue.length > 0) return false;
    return !(typeof doc.cardId === 'string' && doc.cardId.trim());
}

export async function resolveLessonSessionDoc(domainId: string, uid: number, querySessionId?: string | null): Promise<SessionDoc | null> {
    const q = typeof querySessionId === 'string' ? querySessionId.trim() : '';
    if (q && ObjectId.isValid(q)) {
        const doc = await SessionModel.coll.findOne({ _id: new ObjectId(q), domainId, uid });
        if (doc) return isLessonSessionAbandoned(doc as SessionDoc) ? null : doc as SessionDoc;
    }
    const fallback = await SessionModel.get(domainId, uid);
    return isLessonSessionAbandoned(fallback) ? null : fallback;
}

export function lessonSessionIdFromDoc(doc: SessionDoc | null | undefined): string {
    return doc?._id?.toString() ?? '';
}

export function appendLessonSessionToUrl(url: string, sessionId?: string | null): string {
    if (!sessionId) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}session=${encodeURIComponent(sessionId)}`;
}


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


const ON_LESSON_RECENT_MS = 3 * 60 * 1000;
const LEGACY_ACTIVITY_MS = 5 * 60 * 1000;

export type SessionListRecordType = 'daily' | 'single_card' | 'single_node' | 'develop' | 'agent' | 'schedule' | 'mcp' | 'other';

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

/** Develop editor: daily run-queue session. */
export type DevelopSessionKind = 'daily';

export function inferDevelopSessionKind(doc: SessionDoc): DevelopSessionKind {
    return 'daily';
}

/** i18n key for session list / history label (not `session_record_type_daily` / learn wording). */
export function developSessionRecordTypeLabelKey(doc: SessionDoc): string | null {
    if (!isDevelopSessionRow(doc)) return null;
    return 'session_record_type_develop_daily';
}

export function isAgentSessionRow(doc: SessionDoc): boolean {
    return doc.appRoute === 'agent' || doc.route === 'agent';
}

export function isMcpSessionRow(doc: SessionDoc): boolean {
    return doc.appRoute === 'mcp' || doc.route === 'mcp';
}

export function isScheduleAgentSessionRow(doc: SessionDoc): boolean {
    return isAgentSessionRow(doc) && (
        doc.context?.source === 'schedule'
        || !!doc.context?.scheduleId
        || !!doc.context?.scheduleRunId
    );
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
    if (isDevelopSessionRow(doc)) {
        return 'daily';
    }
    if (isScheduleAgentSessionRow(doc)) return 'schedule';
    if (isAgentSessionRow(doc)) return 'agent';
    if (isMcpSessionRow(doc)) return 'mcp';
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
        // only show progress for daily sessions
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

export type SessionKindUi = 'learn' | 'develop' | 'agent' | 'mcp';

export function deriveSessionKind(doc: SessionDoc): SessionKindUi {
    if (isDevelopSessionRow(doc)) return 'develop';
    if (isAgentSessionRow(doc)) return 'agent';
    if (isMcpSessionRow(doc)) return 'mcp';
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
        if (isDevelopSessionSettled(doc)) return 'finished';
        if ((doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) return 'abandoned';
        // 定时任务已写入 DB：每日开发 UTC 跨日超时
        if (
            inferDevelopSessionKind(doc) === 'daily'
            && readDevelopDailyTimedOutMs(doc) != null
        ) {
            return 'timed_out';
        }
        // 推导规则（任务未跑或与 DB 一致）：每日开发锚定 UTC 日历日
        if (inferDevelopSessionKind(doc) === 'daily' && isSessionStalePastUtcCalendarDay(doc, now)) {
            return 'timed_out';
        }
        if (isDevelopSessionPastDeadline(doc, now)) return 'timed_out';
        if (!readDevelopSessionDeadlineMs(doc) && isSessionStalePastUtcCalendarDay(doc, now)) return 'timed_out';
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

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => SessionModel.coll.deleteMany({ domainId }));
    await db.ensureIndexes(
        SessionModel.coll,
        { key: { domainId: 1, uid: 1, lastActivityAt: -1 }, name: 'domain_uid' },
        { key: { domainId: 1, lastActivityAt: -1 }, name: 'domain_activity' },
        { key: { domainId: 1, appRoute: 1, agentSessionKind: 1, uid: 1, _id: -1 }, name: 'agent_chat_sessions' },
        { key: { domainId: 1, appRoute: 1, agentId: 1, uid: 1, _id: -1 }, name: 'agent_chat_by_agent' },
        { key: { domainId: 1, appRoute: 1, clientId: 1, lastActivityAt: -1 }, name: 'agent_chat_client_activity' },
        { key: { domainId: 1, appRoute: 1, mcpId: 1, uid: 1, lastActivityAt: -1 }, name: 'mcp_sessions' },
    );

    (global.Ejunz.model as any).session = SessionModel;
}
