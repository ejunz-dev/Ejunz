import type {
    Filter, FindOptions, MatchKeysAndValues, OnlyFieldsOfType, PushOperator, UpdateFilter,
} from 'mongodb';
import { ObjectId } from 'mongodb';
import moment from 'moment-timezone';
import type { Context } from '../context';
import type { RecordDoc } from '../interface';
import db from '../service/db';
import bus from '../service/bus';
import { Logger } from '../logger';
import { MaybeArray, NumberKeys } from '../typeutils';
import { ArgMethod, buildProjection, Time } from '../utils';
import SessionModel from './session';
import { STATUS } from './builtin';

const logger = new Logger('model/record');

export type RecordProblemState = {
    pid: string;
    status: 'pending' | 'correct' | 'wrong' | 'skipped';
    selected?: number;
    /** Fill-in-the-blank: learner's texts per blank (optional, for review). */
    fillAnswers?: string[];
    attempts?: number;
    timeSpentMs?: number;
    updatedAt?: Date;
};

/** Learn: one row per card attempt (`learn_card` or omitted). Develop: editor save. Agent: chat task. */
export type RecordKind = 'learn_card' | 'develop_save' | 'agent';

export type AgentRecordMessage = {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    timestamp: Date;
    bubbleId?: string;
    toolName?: string;
    toolResult?: any;
    tool_call_id?: string;
    tool_calls?: any[];
    bubbleState?: 'streaming' | 'completed';
    contentHash?: string;
};

export type DevelopSaveChangeOp =
    | 'node_create'
    | 'node_update'
    | 'node_delete'
    | 'card_create'
    | 'card_update'
    | 'card_delete'
    | 'edge_create'
    | 'edge_delete';

export type DevelopSaveChangeLine = { op: DevelopSaveChangeOp; label?: string };

export type DevelopSaveMeta = {
    nodeCreates: number;
    nodeUpdates: number;
    nodeDeletes: number;
    cardCreates: number;
    cardUpdates: number;
    cardDeletes: number;
    edgeCreates: number;
    edgeDeletes: number;
    cardUpdatedIds: string[];
    cardCreatedIds: string[];
    /** Human-readable lines for record detail (capped at insert time). */
    changeLines?: DevelopSaveChangeLine[];
};

export interface SessionRecordDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    sessionId: ObjectId;
    cardId: string;
    nodeId: string;
    baseDocId: number;
    branch: string;
    trainingDocId?: string | null;
    problems: RecordProblemState[];
    recordKind?: RecordKind;
    developMeta?: DevelopSaveMeta;
    /** Agent task (recordKind `agent`) */
    status?: number;
    score?: number;
    time?: number;
    code?: string;
    agentId?: string;
    agentChatSessionId?: ObjectId;
    agentMessages?: AgentRecordMessage[];
    agentToolCallCount?: number;
    agentTotalToolCalls?: number;
    agentError?: { message: string; code?: string; stack?: string };
    createdAt: Date;
    updatedAt: Date;
    lastActivityAt: Date;
}

export const RECORD_PROJECTION_LIST: (keyof SessionRecordDoc)[] = [
    '_id', 'domainId', 'uid', 'sessionId', 'cardId', 'nodeId', 'baseDocId', 'branch',
    'updatedAt', 'lastActivityAt',
];

export const AGENT_RECORD_PROJECTION_LIST: (keyof SessionRecordDoc)[] = [
    '_id', 'status', 'score', 'time', 'domainId', 'uid', 'sessionId',
    'agentId', 'agentChatSessionId', 'recordKind',
    'agentMessages', 'agentToolCallCount', 'agentTotalToolCalls', 'agentError', 'code',
    'lastActivityAt', 'updatedAt',
];

export default class RecordModel {
    static coll = db.collection('session_record');

    /** Judge / worker rows in Mongo `record` (not agent `session_record`). */
    static judgeColl = db.collection('record');
    static judgeHistoryColl = db.collection('record_history');

    static getMulti(domainId: string, query: Filter<SessionRecordDoc> = {}, options?: FindOptions) {
        return RecordModel.coll.find({ domainId, ...query } as Filter<SessionRecordDoc>, options);
    }

    static async get(domainId: string, _id: ObjectId): Promise<SessionRecordDoc | null> {
        const doc = await RecordModel.coll.findOne({ _id, domainId });
        return doc as SessionRecordDoc | null;
    }

    static async getList(
        domainId: string,
        rids: ObjectId[],
        fields?: (keyof SessionRecordDoc)[],
    ): Promise<Record<string, Partial<SessionRecordDoc>>> {
        const r: Record<string, Partial<SessionRecordDoc>> = {};
        rids = Array.from(new Set(rids));
        if (!rids.length) return r;
        let cursor = RecordModel.coll.find({ domainId, _id: { $in: rids } });
        if (fields?.length) cursor = cursor.project(buildProjection(fields));
        const rdocs = await cursor.toArray();
        for (const rdoc of rdocs) r[rdoc._id.toHexString()] = rdoc as SessionRecordDoc;
        return r;
    }

    static async ensureForCard(
        domainId: string,
        uid: number,
        sessionMongoId: ObjectId,
        cardId: string,
        nodeId: string,
        baseDocId: number,
        branch: string,
        problemIds: string[],
        trainingDocId?: string | null,
    ): Promise<SessionRecordDoc> {
        const existing = await RecordModel.coll.findOne({
            domainId,
            uid,
            sessionId: sessionMongoId,
            cardId,
            $or: [{ recordKind: { $exists: false } }, { recordKind: 'learn_card' }],
        });
        if (existing) {
            const ex = existing as SessionRecordDoc;
            const tid = trainingDocId && String(trainingDocId).trim() ? String(trainingDocId).trim() : '';
            if (tid && !ex.trainingDocId) {
                const now = new Date();
                await RecordModel.coll.updateOne(
                    { _id: ex._id, domainId },
                    { $set: { trainingDocId: tid, updatedAt: now } },
                );
                const refreshed = await RecordModel.get(domainId, ex._id);
                if (refreshed) {
                    bus.broadcast('record/change', refreshed);
                    return refreshed;
                }
            }
            return ex;
        }
        const now = new Date();
        const problems: RecordProblemState[] = problemIds.map((pid) => ({
            pid,
            status: 'pending' as const,
        }));
        const tid = trainingDocId && String(trainingDocId).trim() ? String(trainingDocId).trim() : '';
        const doc: SessionRecordDoc = {
            _id: new ObjectId(),
            domainId,
            uid,
            sessionId: sessionMongoId,
            cardId,
            nodeId,
            baseDocId,
            branch,
            ...(tid ? { trainingDocId: tid } : {}),
            recordKind: 'learn_card',
            problems,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
        };
        await RecordModel.coll.insertOne(doc as any);
        await SessionModel.addRecord(domainId, uid, sessionMongoId, doc._id);
        bus.broadcast('record/change', doc);
        return doc;
    }

    /** One audit row per editor save; uses a synthetic `cardId` so it does not collide with learn_card uniqueness. */
    static async insertDevelopSaveRecord(
        domainId: string,
        uid: number,
        sessionMongoId: ObjectId,
        baseDocId: number,
        branch: string,
        meta: DevelopSaveMeta,
    ): Promise<SessionRecordDoc> {
        const now = new Date();
        const syntheticCardId = new ObjectId().toHexString();
        const doc: SessionRecordDoc = {
            _id: new ObjectId(),
            domainId,
            uid,
            sessionId: sessionMongoId,
            cardId: syntheticCardId,
            nodeId: '',
            baseDocId,
            branch,
            problems: [],
            recordKind: 'develop_save',
            developMeta: meta,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
        };
        await RecordModel.coll.insertOne(doc as any);
        await SessionModel.addRecord(domainId, uid, sessionMongoId, doc._id);
        bus.broadcast('record/change', doc);
        return doc;
    }

    static async patchProblem(
        domainId: string,
        recordId: ObjectId,
        problemId: string,
        patch: Partial<Pick<RecordProblemState, 'status' | 'selected' | 'fillAnswers' | 'attempts' | 'timeSpentMs'>>,
    ): Promise<SessionRecordDoc | null> {
        const doc = await RecordModel.get(domainId, recordId);
        if (!doc) return null;
        const now = new Date();
        const problems = doc.problems.map((p) => {
            if (p.pid !== problemId) return p;
            return {
                ...p,
                ...patch,
                updatedAt: now,
            };
        });
        await RecordModel.coll.updateOne(
            { _id: recordId, domainId },
            {
                $set: {
                    problems,
                    updatedAt: now,
                    lastActivityAt: now,
                },
            },
        );
        const out = await RecordModel.get(domainId, recordId);
        if (out) bus.broadcast('record/change', out);
        return out;
    }

    static async insertAgentTask(
        domainId: string,
        agentId: string,
        uid: number,
        initialMessage: string,
        chatSessionId: ObjectId,
        bubbleId?: string,
    ): Promise<ObjectId> {
        const session = await SessionModel.ensureAgentChatSession(domainId, uid, chatSessionId, agentId);
        const now = new Date();
        const syntheticCardId = new ObjectId().toHexString();
        const doc: SessionRecordDoc = {
            _id: new ObjectId(),
            domainId,
            uid,
            sessionId: session._id,
            cardId: syntheticCardId,
            nodeId: '',
            baseDocId: 0,
            branch: '',
            problems: [],
            recordKind: 'agent',
            status: STATUS.STATUS_TASK_WAITING,
            code: initialMessage,
            agentId,
            agentChatSessionId: chatSessionId,
            score: 100,
            time: 0,
            agentMessages: [{
                role: 'user',
                content: initialMessage,
                timestamp: new Date(),
                ...(bubbleId ? { bubbleId } : {}),
            }],
            agentToolCallCount: 0,
            agentTotalToolCalls: 0,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
        };
        await RecordModel.coll.insertOne(doc as any);
        await SessionModel.addRecord(domainId, uid, session._id, doc._id);
        bus.broadcast('record/change', doc);
        return doc._id;
    }

    static async updateAgentTask(
        domainId: string,
        recordId: ObjectId,
        update: {
            status?: number;
            score?: number;
            time?: number;
            agentToolCallCount?: number;
            agentError?: { message: string; code?: string; stack?: string };
            agentMessages?: AgentRecordMessage[];
        },
    ): Promise<SessionRecordDoc | null> {
        const cur = await RecordModel.get(domainId, recordId);
        if (!cur || cur.recordKind !== 'agent') return cur;
        const $set: Record<string, unknown> = {};
        if (update.status !== undefined) $set.status = update.status;
        if (update.score !== undefined) $set.score = update.score;
        if (update.time !== undefined) $set.time = update.time;
        if (update.agentToolCallCount !== undefined) $set.agentToolCallCount = update.agentToolCallCount;
        if (update.agentError !== undefined) $set.agentError = update.agentError;
        let updated: SessionRecordDoc | null = null;
        if (update.agentMessages) {
            const existing = cur;
            if (existing) {
                const { createHash } = require('crypto');
                const existingMessages = existing.agentMessages || [];
                const newMessages = update.agentMessages;
                const existingHash = existingMessages
                    .map((m: AgentRecordMessage) => {
                        const contentHash = m.contentHash
                            || (m.content ? createHash('md5').update(m.content || '').digest('hex').substring(0, 16) : '');
                        return `${m.role}:${m.bubbleId || ''}:${contentHash}:${m.bubbleState || ''}`;
                    })
                    .join('|');
                const newHash = newMessages
                    .map((m: AgentRecordMessage) => {
                        const contentHash = m.contentHash
                            || (m.content ? createHash('md5').update(m.content || '').digest('hex').substring(0, 16) : '');
                        return `${m.role}:${m.bubbleId || ''}:${contentHash}:${m.bubbleState || ''}`;
                    })
                    .join('|');
                const lastExisting = existingMessages[existingMessages.length - 1];
                const firstNew = newMessages[0];
                if (lastExisting && firstNew
                    && lastExisting.role === firstNew.role
                    && lastExisting.bubbleId === firstNew.bubbleId
                    && (lastExisting.contentHash || (lastExisting.content
                        ? createHash('md5').update(lastExisting.content || '').digest('hex').substring(0, 16) : ''))
                    === (firstNew.contentHash || (firstNew.content
                        ? createHash('md5').update(firstNew.content || '').digest('hex').substring(0, 16) : ''))) {
                    logger.debug('Skipping agent record update (content unchanged)', {
                        recordId: recordId.toString(),
                        bubbleId: firstNew.bubbleId,
                    });
                    return existing;
                }
            }
            updated = await RecordModel.rawAgentUpdate(
                domainId,
                recordId,
                $set as any,
                { agentMessages: { $each: update.agentMessages } } as any,
            );
        } else {
            updated = await RecordModel.rawAgentUpdate(domainId, recordId, $set as any);
        }
        return updated;
    }

    static async rawAgentUpdate(
        domainId: string,
        _id: MaybeArray<ObjectId>,
        $set?: MatchKeysAndValues<SessionRecordDoc>,
        $push?: PushOperator<SessionRecordDoc>,
        $unset?: OnlyFieldsOfType<SessionRecordDoc, any, true | '' | 1>,
        $inc?: Partial<Record<NumberKeys<SessionRecordDoc>, number>>,
    ): Promise<SessionRecordDoc | null> {
        const $update: UpdateFilter<SessionRecordDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        if ($inc && Object.keys($inc).length) $update.$inc = $inc;
        if (_id instanceof Array) {
            await RecordModel.coll.updateMany(
                { _id: { $in: _id }, domainId, recordKind: 'agent' },
                $update,
            );
            return null;
        }
        if (Object.keys($update).length) {
            let shouldBroadcast = true;
            const isUpdatingAgentMessages = ($set && Object.keys($set).some((k) => k.startsWith('agentMessages')))
                || ($push && ($push as any).agentMessages);
            if (isUpdatingAgentMessages) {
                const existingRow = await RecordModel.coll.findOne({ _id, domainId, recordKind: 'agent' });
                if (existingRow) {
                    const { createHash } = require('crypto');
                    const existingMessages = (existingRow as SessionRecordDoc).agentMessages || [];
                    const agentMessageKeys = $set ? Object.keys($set).filter((k) => k.startsWith('agentMessages.')) : [];
                    const hasToolCallsUpdate = agentMessageKeys.some((k: string) => k.includes('.tool_calls'));
                    if (agentMessageKeys.length > 0 && !hasToolCallsUpdate) {
                        const messageIndexMatch = agentMessageKeys[0].match(/agentMessages\.(\d+)\./);
                        if (messageIndexMatch) {
                            const index = parseInt(messageIndexMatch[1], 10);
                            const existingMsg = existingMessages[index];
                            if (existingMsg) {
                                const existingContentHash = existingMsg.contentHash
                                    || (existingMsg.content
                                        ? createHash('md5').update(existingMsg.content || '').digest('hex').substring(0, 16)
                                        : '');
                                const newContentHash = ($set as any)[`agentMessages.${index}.contentHash`]
                                    || (($set as any)[`agentMessages.${index}.content`]
                                        ? createHash('md5').update(($set as any)[`agentMessages.${index}.content`] || '')
                                            .digest('hex').substring(0, 16)
                                        : '');
                                if (existingContentHash === newContentHash && existingContentHash) {
                                    shouldBroadcast = false;
                                }
                            }
                        }
                    }
                }
            }
            const updated = await RecordModel.coll.findOneAndUpdate(
                { _id, domainId, recordKind: 'agent' },
                $update,
                { returnDocument: 'after' },
            );
            const val = updated && typeof updated === 'object' && 'value' in updated
                ? (updated as { value: SessionRecordDoc | null }).value
                : (updated as SessionRecordDoc | null);
            if (val && (isUpdatingAgentMessages ? shouldBroadcast : true)) {
                bus.broadcast('record/change', val);
            }
            return val;
        }
        return await RecordModel.coll.findOne({ _id, domainId, recordKind: 'agent' });
    }

    static async judgeGet(_id: ObjectId): Promise<RecordDoc | null>;
    static async judgeGet(domainId: string, _id: ObjectId): Promise<RecordDoc | null>;
    static async judgeGet(arg0: string | ObjectId, arg1?: any): Promise<RecordDoc | null> {
        const _id = arg1 || arg0;
        const domainId = arg1 ? arg0 : null;
        const res = await RecordModel.judgeColl.findOne({ _id });
        if (!res) return null;
        if (res.domainId === (domainId || res.domainId)) return res as RecordDoc;
        return null;
    }

    @ArgMethod
    static async judgeStat(domainId?: string) {
        const [d5min, d1h, day, week, month, year, total] = await Promise.all([
            RecordModel.judgeColl.find({ _id: { $gte: Time.getObjectID(moment().add(-5, 'minutes')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.judgeColl.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'hour')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.judgeColl.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'day')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.judgeColl.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'week')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.judgeColl.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'month')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.judgeColl.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'year')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.judgeColl.find(domainId ? { domainId } : {}).count(),
        ]);
        return {
            d5min, d1h, day, week, month, year, total,
        };
    }

    static judgeFind(domainId: string, query: Record<string, unknown> = {}, options?: FindOptions) {
        return RecordModel.judgeColl.find({ domainId, ...query }, options);
    }

    static async judgeUpdate(
        domainId: string,
        _id: MaybeArray<ObjectId>,
        $set?: MatchKeysAndValues<RecordDoc>,
        $push?: PushOperator<RecordDoc>,
        $unset?: OnlyFieldsOfType<RecordDoc, any, true | '' | 1>,
        $inc?: Partial<Record<NumberKeys<RecordDoc>, number>>,
    ): Promise<RecordDoc | null> {
        const $update: UpdateFilter<RecordDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        if ($inc && Object.keys($inc).length) $update.$inc = $inc;
        if (_id instanceof Array) {
            await RecordModel.judgeColl.updateMany({ _id: { $in: _id }, domainId }, $update);
            return null;
        }
        if (Object.keys($update).length) {
            const updated = await RecordModel.judgeColl.findOneAndUpdate(
                { _id, domainId },
                $update,
                { returnDocument: 'after' },
            );
            const val = updated && typeof updated === 'object' && 'value' in updated
                ? (updated as { value: RecordDoc | null }).value
                : (updated as RecordDoc | null);
            if (val) (bus as any).broadcast('judge_record/change', val);
            return val;
        }
        return await RecordModel.judgeColl.findOne({ _id, domainId }, { readPreference: 'primary' }) as RecordDoc | null;
    }

    static async judgeReset(domainId: string, rid: string | ObjectId, _full = false): Promise<RecordDoc | null> {
        const oid = typeof rid === 'string' ? new ObjectId(rid) : rid;
        return RecordModel.judgeGet(domainId, oid);
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => {
        RecordModel.coll.deleteMany({ domainId });
        RecordModel.judgeColl.deleteMany({ domainId });
    });

    ctx.on('task/agent-completed', async (payload: { recordId: string; domainId: string; taskId?: string }) => {
        try {
            const rid = payload.recordId;
            if (!rid) return;
            const oid = new ObjectId(rid);
            const rdoc = await RecordModel.get(payload.domainId, oid);
            if (rdoc?.recordKind === 'agent' && rdoc.agentId) {
                logger.info('Agent completed for record: %s', oid.toString());
            }
        } catch (e) {
            logger.error('Error handling task/agent-completed event:', e);
        }
    });

    await db.clearIndexes(RecordModel.coll, ['domain_uid_session_card']);
    if (process.env.NODE_APP_INSTANCE === '0') {
        await RecordModel.coll.updateMany(
            {
                $or: [{ recordKind: { $exists: false } }, { recordKind: null }],
                recordKind: { $nin: ['develop_save', 'agent'] },
            },
            { $set: { recordKind: 'learn_card' } },
        );
    }
    await db.ensureIndexes(
        RecordModel.coll,
        {
            key: { domainId: 1, uid: 1, sessionId: 1, cardId: 1 },
            name: 'domain_uid_session_card_learn',
            unique: true,
            partialFilterExpression: { recordKind: 'learn_card' },
        },
        { key: { domainId: 1, _id: 1 }, name: 'domain_id' },
        { key: { sessionId: 1 }, name: 'sessionId' },
        { key: { domainId: 1, recordKind: 1, status: 1, _id: -1 }, name: 'domain_agent_status' },
    );
    await db.ensureIndexes(
        RecordModel.judgeColl,
        { key: { domainId: 1, _id: -1 }, name: 'judge_basic' },
        { key: { domainId: 1, uid: 1, _id: -1 }, name: 'judge_withUser' },
        { key: { domainId: 1, status: 1, _id: -1 }, name: 'judge_withStatus' },
    );

    const TIMEOUT_MS = 2 * 60 * 1000;
    setInterval(async () => {
        try {
            const timeoutThreshold = new Date(Date.now() - TIMEOUT_MS);
            const timeoutRows = await RecordModel.coll.find({
                recordKind: 'agent',
                status: { $in: [STATUS.STATUS_TASK_PROCESSING, STATUS.STATUS_TASK_PENDING] },
                _id: { $lte: Time.getObjectID(timeoutThreshold) },
            }).toArray();
            for (const rdoc of timeoutRows) {
                const TaskModel = require('./task').default;
                const hasAssociatedTask = await TaskModel.count({
                    type: 'task',
                    recordId: rdoc._id,
                });
                if (hasAssociatedTask > 0) continue;
                const elapsedTime = Date.now() - rdoc._id.getTimestamp().getTime();
                let errorStatus = STATUS.STATUS_TASK_ERROR_TIMEOUT;
                if (elapsedTime > 2.5 * 60 * 1000) {
                    errorStatus = STATUS.STATUS_TASK_ERROR_SYSTEM;
                } else if (elapsedTime > 2.2 * 60 * 1000) {
                    errorStatus = STATUS.STATUS_TASK_ERROR_NETWORK;
                }
                await RecordModel.updateAgentTask(rdoc.domainId, rdoc._id, {
                    status: errorStatus,
                    score: 0,
                    time: elapsedTime,
                    agentError: {
                        message: 'Agent did not complete within timeout period',
                        code: 'TIMEOUT',
                    },
                });
                logger.warn('Task timeout: recordId=%s, elapsedTime=%dms', rdoc._id.toString(), elapsedTime);
            }
        } catch (e) {
            logger.error('Error in agent task timeout check:', e);
        }
    }, 30000);

    (global.Ejunz.model as any).record = RecordModel;
}
