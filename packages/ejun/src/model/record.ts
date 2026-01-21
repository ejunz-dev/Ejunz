// import { pick, sum } from 'lodash'; // 已移除 judge 相关功能，不再需要
import moment from 'moment-timezone';
import {
    Filter, FindOptions, MatchKeysAndValues,
    ObjectId, OnlyFieldsOfType, PushOperator, UpdateFilter,
} from 'mongodb';
import { Context } from '../context';
import { RecordDoc } from '../interface';
import db from '../service/db';
import { MaybeArray, NumberKeys } from '../typeutils';
import { ArgMethod, buildProjection, Time } from '../utils';
import { STATUS } from './builtin';
import bus from '../service/bus';
import { Logger } from '../logger';

const logger = new Logger('model/record');

export default class RecordModel {
    static coll = db.collection('record');
    
    static PROJECTION_LIST: (keyof RecordDoc)[] = [
        '_id', 'status', 'score', 'time', 'domainId',
        'uid', 'agentId',
        'agentMessages', 'agentToolCallCount', 'agentTotalToolCalls', 'agentError',
    ];

    static async get(_id: ObjectId): Promise<RecordDoc | null>;
    static async get(domainId: string, _id: ObjectId): Promise<RecordDoc | null>;
    static async get(arg0: string | ObjectId, arg1?: any) {
        const _id = arg1 || arg0;
        const domainId = arg1 ? arg0 : null;
        const res = await RecordModel.coll.findOne({ _id });
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
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-5, 'minutes')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'hour')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'day')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'week')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'month')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'year')) }, ...domainId ? { domainId } : {} }).count(),
            RecordModel.coll.find(domainId ? { domainId } : {}).count(),
        ]);
        return {
            d5min, d1h, day, week, month, year, total,
        };
    }

    // worker 和 add 方法已移除（judge 相关功能已删除，只保留 task 相关方法）

    static async addTask(
        domainId: string,
        agentId: string,
        uid: number,
        initialMessage: string,
        sessionId: ObjectId, // sessionId 现在是必需的
        messageId?: string, // Optional messageId for user message
    ): Promise<ObjectId> {
        const data: RecordDoc = {
            status: STATUS.STATUS_TASK_WAITING,
            _id: new ObjectId(),
            uid,
            code: initialMessage,
            domainId,
            agentId,
            sessionId, // 关联到 session
            score: 100, // 初始分数100分，根据错误扣分
            time: 0, // 用时（毫秒）
            agentMessages: [{
                role: 'user',
                content: initialMessage,
                timestamp: new Date(),
                ...(messageId ? { messageId } : {}), // Include messageId if provided
            }] as any,
            agentToolCallCount: 0,
            agentTotalToolCalls: 0,
        } as any;
        const res = await RecordModel.coll.insertOne(data);
        bus.broadcast('record/change', data);
        return res.insertedId;
    }

    static async updateTask(
        domainId: string,
        recordId: ObjectId,
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
                messageId?: string; // Unique message ID for deduplication
                toolName?: string;
                toolResult?: any;
                tool_call_id?: string;
                tool_calls?: any[];
            }>;
        },
    ): Promise<RecordDoc | null> {
        const $set: any = {};
        if (update.status !== undefined) $set.status = update.status;
        if (update.score !== undefined) $set.score = update.score;
        if (update.time !== undefined) $set.time = update.time;
        if (update.agentToolCallCount !== undefined) $set.agentToolCallCount = update.agentToolCallCount;
        if (update.agentError !== undefined) $set.agentError = update.agentError;
        let updated: RecordDoc | null = null;
        if (update.agentMessages) {
            // Push new messages
            updated = await RecordModel.update(domainId, recordId, $set, {
                agentMessages: { $each: update.agentMessages },
            } as any);
        } else {
            updated = await RecordModel.update(domainId, recordId, $set);
        }
        // 广播 record/change 事件，通知 WebSocket 连接更新
        if (updated) {
            (bus as any).broadcast('record/change', updated);
        }
        return updated;
    }

    static getMulti(domainId: string, query: any, options?: FindOptions) {
        if (domainId) query = { domainId, ...query };
        return RecordModel.coll.find(query, options);
    }

    static async update(
        domainId: string, _id: MaybeArray<ObjectId>,
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
            await RecordModel.coll.updateMany({ _id: { $in: _id }, domainId }, $update);
            return null;
        }
        if (Object.keys($update).length) {
            const updated = await RecordModel.coll.findOneAndUpdate(
                { _id, domainId },
                $update,
                { returnDocument: 'after' },
            );
            // 如果更新了 agentMessages，广播事件
            if (updated && ($set && Object.keys($set).some(k => k.startsWith('agentMessages')) || $push && ($push as any).agentMessages)) {
                (bus as any).broadcast('record/change', updated);
            }
            return updated;
        }
        return await RecordModel.coll.findOne({ _id }, { readPreference: 'primary' });
    }

    static async updateMulti(
        domainId: string, $match: Filter<RecordDoc>,
        $set?: MatchKeysAndValues<RecordDoc>,
        $push?: PushOperator<RecordDoc>,
        $unset?: OnlyFieldsOfType<RecordDoc, any, true | '' | 1>,
    ) {
        const $update: UpdateFilter<RecordDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        const res = await RecordModel.coll.updateMany({ domainId, ...$match }, $update);
        return res.modifiedCount;
    }

    static count(domainId: string, query: any) {
        return RecordModel.coll.countDocuments({ domainId, ...query });
    }

    static async getList(
        domainId: string, rids: ObjectId[], fields?: (keyof RecordDoc)[],
    ): Promise<Record<string, Partial<RecordDoc>>> {
        const r: Record<string, RecordDoc> = {};
        rids = Array.from(new Set(rids));
        let cursor = RecordModel.coll.find({ domainId, _id: { $in: rids } });
        if (fields) cursor = cursor.project(buildProjection(fields));
        const rdocs = await cursor.toArray();
        for (const rdoc of rdocs) r[rdoc._id.toHexString()] = rdoc;
        return r;
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => RecordModel.coll.deleteMany({ domainId }));
    
    // 监听 agent 完成事件
    ctx.on('task/agent-completed', async (payload: { recordId: string; domainId: string; taskId?: string }) => {
        try {
            const recordId = new ObjectId(payload.recordId);
            const rdoc = await RecordModel.get(payload.domainId, recordId);
            if (rdoc && rdoc.agentId) {
                // 标记任务已完成，清除超时定时器
                // 这里可以添加额外的处理逻辑
                logger.info('Agent completed for record: %s', recordId.toString());
            }
        } catch (e) {
            logger.error('Error handling task/agent-completed event:', e);
        }
    });
    
    // 超时检查：定期检查working/pending状态的任务，如果超过一定时间没有完成，设置为0分
    const TIMEOUT_MS = 2 * 60 * 1000; // 2分钟超时
    setInterval(async () => {
        try {
            const timeoutThreshold = new Date(Date.now() - TIMEOUT_MS);
            // 查找processing或pending状态且创建时间超过阈值的记录
            const timeoutRecords = await RecordModel.coll.find({
                status: { $in: [STATUS.STATUS_TASK_PROCESSING, STATUS.STATUS_TASK_PENDING] },
                agentId: { $exists: true, $ne: null },
                _id: { $lte: Time.getObjectID(timeoutThreshold) },
            }).toArray();
            
            for (const rdoc of timeoutRecords) {
                const elapsedTime = Date.now() - rdoc._id.getTimestamp().getTime();
                // 根据超时原因设置不同的错误状态（基于2分钟超时阈值）
                let errorStatus = STATUS.STATUS_TASK_ERROR_TIMEOUT;
                if (elapsedTime > 2.5 * 60 * 1000) {
                    // 超过2.5分钟，可能是系统问题
                    errorStatus = STATUS.STATUS_TASK_ERROR_SYSTEM;
                } else if (elapsedTime > 2.2 * 60 * 1000) {
                    // 超过2.2分钟，可能是网络问题
                    errorStatus = STATUS.STATUS_TASK_ERROR_NETWORK;
                }
                
                await RecordModel.updateTask(rdoc.domainId, rdoc._id, {
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
            logger.error('Error in timeout check:', e);
        }
    }, 30000); // 每30秒检查一次，更及时地检测超时
    
    await Promise.all([
        db.ensureIndexes(
            RecordModel.coll,
            { key: { domainId: 1, _id: -1 }, name: 'basic' },
            { key: { domainId: 1, uid: 1, _id: -1 }, name: 'withUser' },
            { key: { domainId: 1, status: 1, _id: -1 }, name: 'withStatus' },
            { key: { domainId: 1, agentId: 1, _id: -1 }, name: 'withAgent' },
        ),
    ]);
}
global.Ejunz.model.record = RecordModel;