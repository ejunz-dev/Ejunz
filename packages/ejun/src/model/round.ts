import moment from 'moment-timezone';
import {
    Filter, FindOptions, MatchKeysAndValues,
    ObjectId, OnlyFieldsOfType, PushOperator, UpdateFilter,
} from 'mongodb';
import { Context } from '../context';
import { RoundDoc } from '../interface';
import db from '../service/db';
import { MaybeArray, NumberKeys } from '../typeutils';
import { ArgMethod, buildProjection, Time } from '../utils';
import { STATUS } from './builtin';
import bus from '../service/bus';
import { Logger } from '../logger';

const logger = new Logger('model/round');

export default class RoundModel {
    static coll = db.collection('record');
    static collHistory = db.collection('record_history');
    
    static PROJECTION_LIST: (keyof RoundDoc)[] = [
        '_id', 'status', 'score', 'time', 'domainId',
        'uid', 'agentId',
        'agentMessages', 'agentToolCallCount', 'agentTotalToolCalls', 'agentError',
    ];

    static async get(_id: ObjectId): Promise<RoundDoc | null>;
    static async get(domainId: string, _id: ObjectId): Promise<RoundDoc | null>;
    static async get(arg0: string | ObjectId, arg1?: any) {
        const _id = arg1 || arg0;
        const domainId = arg1 ? arg0 : null;
        const res = await RoundModel.coll.findOne({ _id });
        if (!res) return null;
        if (res.domainId === (domainId || res.domainId)) return res;
        return null;
    }

    @ArgMethod
    static async stat(domainId?: string) {
        // INFO:
        // using .count() for a much better performace
        // @see https://www.mongodb.com/docs/manual/reference/command/count/
        const [d5min, d1h, day, week, month, year, total] = await Promise.all([
            RoundModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-5, 'minutes')) }, ...domainId ? { domainId } : {} }).count(),
            RoundModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'hour')) }, ...domainId ? { domainId } : {} }).count(),
            RoundModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'day')) }, ...domainId ? { domainId } : {} }).count(),
            RoundModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'week')) }, ...domainId ? { domainId } : {} }).count(),
            RoundModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'month')) }, ...domainId ? { domainId } : {} }).count(),
            RoundModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'year')) }, ...domainId ? { domainId } : {} }).count(),
            RoundModel.coll.find(domainId ? { domainId } : {}).count(),
        ]);
        return {
            d5min, d1h, day, week, month, year, total,
        };
    }

    static async addTask(
        domainId: string,
        agentId: string,
        uid: number,
        initialMessage: string,
        roomId: ObjectId,
        bubbleId?: string,
    ): Promise<ObjectId> {
        const data: RoundDoc = {
            status: STATUS.STATUS_TASK_WAITING,
            _id: new ObjectId(),
            uid,
            code: initialMessage,
            domainId,
            agentId,
            roomId,
            score: 100,
            time: 0,
            agentMessages: [{
                role: 'user',
                content: initialMessage,
                timestamp: new Date(),
                ...(bubbleId ? { bubbleId } : {}), // Include bubbleId if provided
            }] as any,
            agentToolCallCount: 0,
            agentTotalToolCalls: 0,
        } as any;
        const res = await RoundModel.coll.insertOne(data);
        bus.broadcast('round/change', data);
        return res.insertedId;
    }

    static async updateTask(
        domainId: string,
        roundId: ObjectId,
        update: {
            status?: number;
            score?: number;
            time?: number;
            agentToolCallCount?: number;
            agentError?: { message: string; code?: string; stack?: string };
            agentMessages?: Array<{
                role: 'user' | 'assistant' | 'tool';
                content: string;
                timestamp: Date;
                bubbleId?: string; // Unique message ID for deduplication
                toolName?: string;
                toolResult?: any;
                tool_call_id?: string;
                tool_calls?: any[];
                bubbleState?: 'streaming' | 'completed'; // Bubble state: streaming or completed
                contentHash?: string; // Content hash to detect changes and prevent duplicate processing
            }>;
        },
    ): Promise<RoundDoc | null> {
        const $set: any = {};
        if (update.status !== undefined) $set.status = update.status;
        if (update.score !== undefined) $set.score = update.score;
        if (update.time !== undefined) $set.time = update.time;
        if (update.agentToolCallCount !== undefined) $set.agentToolCallCount = update.agentToolCallCount;
        if (update.agentError !== undefined) $set.agentError = update.agentError;
        let updated: RoundDoc | null = null;
        if (update.agentMessages) {
            const existingRound = await RoundModel.get(domainId, roundId);
            if (existingRound) {
                const { createHash } = require('crypto');
                const existingMessages = (existingRound as any).agentMessages || [];
                const newMessages = update.agentMessages;
                
                const existingHash = existingMessages
                    .map((m: any) => {
                        const contentHash = m.contentHash || (m.content ? createHash('md5').update(m.content || '').digest('hex').substring(0, 16) : '');
                        return `${m.role}:${m.bubbleId || ''}:${contentHash}:${m.bubbleState || ''}`;
                    })
                    .join('|');
                
                const newHash = newMessages
                    .map((m: any) => {
                        const contentHash = m.contentHash || (m.content ? createHash('md5').update(m.content || '').digest('hex').substring(0, 16) : '');
                        return `${m.role}:${m.bubbleId || ''}:${contentHash}:${m.bubbleState || ''}`;
                    })
                    .join('|');
                
                const lastExisting = existingMessages[existingMessages.length - 1];
                const firstNew = newMessages[0];
                
                if (lastExisting && firstNew && 
                    lastExisting.role === firstNew.role &&
                    lastExisting.bubbleId === firstNew.bubbleId &&
                    (lastExisting.contentHash || (lastExisting.content ? createHash('md5').update(lastExisting.content || '').digest('hex').substring(0, 16) : '')) === 
                     (firstNew.contentHash || (firstNew.content ? createHash('md5').update(firstNew.content || '').digest('hex').substring(0, 16) : ''))) {
                    logger.debug('Skipping round update (content unchanged)', { 
                        roundId: roundId.toString(), 
                        bubbleId: firstNew.bubbleId 
                    });
                    return existingRound as RoundDoc;
                }
            }
            
            updated = await RoundModel.update(domainId, roundId, $set, {
                agentMessages: { $each: update.agentMessages },
            } as any);
        } else {
            updated = await RoundModel.update(domainId, roundId, $set);
        }
        if (updated) {
            (bus as any).broadcast('round/change', updated);
        }
        return updated;
    }

    static getMulti(domainId: string, query: any, options?: FindOptions) {
        if (domainId) query = { domainId, ...query };
        return RoundModel.coll.find(query, options);
    }

    static async update(
        domainId: string, _id: MaybeArray<ObjectId>,
        $set?: MatchKeysAndValues<RoundDoc>,
        $push?: PushOperator<RoundDoc>,
        $unset?: OnlyFieldsOfType<RoundDoc, any, true | '' | 1>,
        $inc?: Partial<Record<NumberKeys<RoundDoc>, number>>,
    ): Promise<RoundDoc | null> {
        const $update: UpdateFilter<RoundDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        if ($inc && Object.keys($inc).length) $update.$inc = $inc;
        if (_id instanceof Array) {
            await RoundModel.coll.updateMany({ _id: { $in: _id }, domainId }, $update);
            return null;
        }
        if (Object.keys($update).length) {
            let shouldBroadcast = true;
            const isUpdatingAgentMessages = ($set && Object.keys($set).some(k => k.startsWith('agentMessages')) || $push && ($push as any).agentMessages);
            
            if (isUpdatingAgentMessages) {
                const existingRound = await RoundModel.coll.findOne({ _id, domainId });
                if (existingRound) {
                    const { createHash } = require('crypto');
                    const existingMessages = (existingRound as any).agentMessages || [];
                    
                    const agentMessageKeys = $set ? Object.keys($set).filter(k => k.startsWith('agentMessages.')) : [];
                    const hasToolCallsUpdate = agentMessageKeys.some((k: string) => k.includes('.tool_calls'));
                    if (agentMessageKeys.length > 0 && !hasToolCallsUpdate) {
                        const messageIndexMatch = agentMessageKeys[0].match(/agentMessages\.(\d+)\./);
                        if (messageIndexMatch) {
                            const index = parseInt(messageIndexMatch[1], 10);
                            const existingMsg = existingMessages[index];
                            if (existingMsg) {
                                const existingContentHash = existingMsg.contentHash || 
                                    (existingMsg.content ? createHash('md5').update(existingMsg.content || '').digest('hex').substring(0, 16) : '');
                                const newContentHash = $set[`agentMessages.${index}.contentHash`] || 
                                    ($set[`agentMessages.${index}.content`] ? createHash('md5').update($set[`agentMessages.${index}.content`] || '').digest('hex').substring(0, 16) : '');
                                
                                if (existingContentHash === newContentHash && existingContentHash) {
                                    shouldBroadcast = false;
                                    logger.debug('Skipping round/change broadcast (content hash unchanged)', { 
                                        roundId: _id.toString(), 
                                        messageIndex: index 
                                    });
                                }
                            }
                        }
                    }
                }
            }
            
            const updated = await RoundModel.coll.findOneAndUpdate(
                { _id, domainId },
                $update,
                { returnDocument: 'after' },
            );
            if (updated && shouldBroadcast && isUpdatingAgentMessages) {
                (bus as any).broadcast('round/change', updated);
            }
            return updated;
        }
        return await RoundModel.coll.findOne({ _id }, { readPreference: 'primary' });
    }

    static async updateMulti(
        domainId: string, $match: Filter<RoundDoc>,
        $set?: MatchKeysAndValues<RoundDoc>,
        $push?: PushOperator<RoundDoc>,
        $unset?: OnlyFieldsOfType<RoundDoc, any, true | '' | 1>,
    ) {
        const $update: UpdateFilter<RoundDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        const res = await RoundModel.coll.updateMany({ domainId, ...$match }, $update);
        return res.modifiedCount;
    }

    static count(domainId: string, query: any) {
        return RoundModel.coll.countDocuments({ domainId, ...query });
    }

    static async getList(
        domainId: string, rids: ObjectId[], fields?: (keyof RoundDoc)[],
    ): Promise<Record<string, Partial<RoundDoc>>> {
        const r: Record<string, RoundDoc> = {};
        rids = Array.from(new Set(rids));
        let cursor = RoundModel.coll.find({ domainId, _id: { $in: rids } });
        if (fields) cursor = cursor.project(buildProjection(fields));
        const rdocs = await cursor.toArray();
        for (const rdoc of rdocs) r[rdoc._id.toHexString()] = rdoc;
        return r;
    }

    static async reset(domainId: string, rid: string | ObjectId, _full = false): Promise<RoundDoc | null> {
        const _id = typeof rid === 'string' ? new ObjectId(rid) : rid;
        return RoundModel.get(domainId, _id);
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => RoundModel.coll.deleteMany({ domainId }));
    
    ctx.on('task/agent-completed', async (payload: { roundId?: string; recordId?: string; domainId: string; taskId?: string }) => {
        try {
            const rid = payload.roundId ?? payload.recordId;
            if (!rid) return;
            const roundOid = new ObjectId(rid);
            const rdoc = await RoundModel.get(payload.domainId, roundOid);
            if (rdoc && rdoc.agentId) {
                logger.info('Agent completed for round: %s', roundOid.toString());
            }
        } catch (e) {
            logger.error('Error handling task/agent-completed event:', e);
        }
    });
    
    const TIMEOUT_MS = 2 * 60 * 1000;
    setInterval(async () => {
        try {
            const timeoutThreshold = new Date(Date.now() - TIMEOUT_MS);
            const timeoutRounds = await RoundModel.coll.find({
                status: { $in: [STATUS.STATUS_TASK_PROCESSING, STATUS.STATUS_TASK_PENDING] },
                agentId: { $exists: true, $ne: null },
                _id: { $lte: Time.getObjectID(timeoutThreshold) },
            }).toArray();
            
            for (const rdoc of timeoutRounds) {
                const TaskModel = require('./task').default;
                const hasAssociatedTask = await TaskModel.count({
                    type: 'task',
                    $or: [{ roundId: rdoc._id }, { recordId: rdoc._id }],
                });
                if (hasAssociatedTask > 0) {
                    logger.debug('Skipping timeout check for round with associated task: roundId=%s', rdoc._id.toString());
                    continue;
                }
                
                const elapsedTime = Date.now() - rdoc._id.getTimestamp().getTime();
                let errorStatus = STATUS.STATUS_TASK_ERROR_TIMEOUT;
                if (elapsedTime > 2.5 * 60 * 1000) {
                    errorStatus = STATUS.STATUS_TASK_ERROR_SYSTEM;
                } else if (elapsedTime > 2.2 * 60 * 1000) {
                    errorStatus = STATUS.STATUS_TASK_ERROR_NETWORK;
                }
                
                await RoundModel.updateTask(rdoc.domainId, rdoc._id, {
                    status: errorStatus,
                    score: 0,
                    time: elapsedTime,
                    agentError: {
                        message: 'Agent did not complete within timeout period',
                        code: 'TIMEOUT',
                    },
                });
                
                logger.warn('Task timeout: roundId=%s, elapsedTime=%dms', rdoc._id.toString(), elapsedTime);
            }
        } catch (e) {
            logger.error('Error in timeout check:', e);
        }
    }, 30000);
    
    await Promise.all([
        db.ensureIndexes(
            RoundModel.coll,
            { key: { domainId: 1, _id: -1 }, name: 'basic' },
            { key: { domainId: 1, uid: 1, _id: -1 }, name: 'withUser' },
            { key: { domainId: 1, status: 1, _id: -1 }, name: 'withStatus' },
            { key: { domainId: 1, agentId: 1, _id: -1 }, name: 'withAgent' },
        ),
    ]);
}
global.Ejunz.model.round = RoundModel;