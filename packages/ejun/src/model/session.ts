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
import type { AgentChatSessionDoc, BaseDoc, SessionDoc, SessionPatch } from '../interface';
import { NotFoundError } from '../error';
import db from '../service/db';
import bus from '../service/bus';
import { Logger } from '../logger';
import { MaybeArray, NumberKeys } from '../typeutils';
import { deriveSessionLearnStatus, isDevelopSessionSettled } from '../lib/sessionListDisplay';
import { BaseModel } from './base';

const logger = new Logger('model/session');

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
    expectedBranch: string,
): Promise<boolean> {
    const loc = locationUrl.trim().slice(0, 2048);
    if (!loc || !sessionHex || !ObjectId.isValid(sessionHex)) return false;
    if (validateDevelopEditorEntryLocation(domainId, loc, sessionHex)) return true;
    const m = /^\/d\/([^/]+)\/base\/([^/]+)\/branch\/([^/]+)\/editor(?:\/)?(?:\?|$)/.exec(loc);
    if (!m) return false;
    if (m[1] !== domainId) return false;
    const br = m[3] && String(m[3]).trim() ? String(m[3]).trim() : 'main';
    if (br !== (expectedBranch && String(expectedBranch).trim() ? String(expectedBranch).trim() : 'main')) return false;
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
            expectedBranch: string;
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
            input.expectedBranch,
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
