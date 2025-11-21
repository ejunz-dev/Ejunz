import moment from 'moment-timezone';
import {
    Filter, FindOptions, MatchKeysAndValues,
    ObjectId, OnlyFieldsOfType, PushOperator, UpdateFilter,
} from 'mongodb';
import { Context } from '../context';
import { SessionDoc } from '../interface';
import db from '../service/db';
import { MaybeArray, NumberKeys } from '../typeutils';
import { ArgMethod, buildProjection, Time } from '../utils';
import bus from '../service/bus';
import { Logger } from '../logger';

const logger = new Logger('model/session');

export default class SessionModel {
    static coll = db.collection('session' as any);
    
    static PROJECTION_LIST: (keyof SessionDoc)[] = [
        '_id', 'domainId', 'agentId', 'uid', 'recordIds', 'type', 'title', 'context',
        'createdAt', 'updatedAt',
    ];

    static async get(_id: ObjectId): Promise<SessionDoc | null>;
    static async get(domainId: string, _id: ObjectId): Promise<SessionDoc | null>;
    static async get(arg0: string | ObjectId, arg1?: any) {
        const _id = arg1 || arg0;
        const domainId = arg1 ? arg0 : null;
        const res = await SessionModel.coll.findOne({ _id });
        if (!res) return null;
        if (res.domainId === (domainId || res.domainId)) return res;
        return null;
    }

    @ArgMethod
    static async stat(domainId?: string) {
        const [d5min, d1h, day, week, month, year, total] = await Promise.all([
            SessionModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-5, 'minutes')) }, ...domainId ? { domainId } : {} }).count(),
            SessionModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'hour')) }, ...domainId ? { domainId } : {} }).count(),
            SessionModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'day')) }, ...domainId ? { domainId } : {} }).count(),
            SessionModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'week')) }, ...domainId ? { domainId } : {} }).count(),
            SessionModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'month')) }, ...domainId ? { domainId } : {} }).count(),
            SessionModel.coll.find({ _id: { $gte: Time.getObjectID(moment().add(-1, 'year')) }, ...domainId ? { domainId } : {} }).count(),
            SessionModel.coll.find(domainId ? { domainId } : {}).count(),
        ]);
        return {
            d5min, d1h, day, week, month, year, total,
        };
    }

    static async add(
        domainId: string,
        agentId: string,
        uid: number,
        type: 'client' | 'chat',
        title?: string,
        context?: any,
        clientId?: number,
    ): Promise<ObjectId> {
        const now = new Date();
        const data: SessionDoc = {
            _id: new ObjectId(),
            domainId,
            agentId,
            uid,
            recordIds: [],
            type,
            title: title || `Session ${new Date().toLocaleString()}`,
            context: context || {},
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
            ...(clientId !== undefined ? { clientId } : {}),
        };
        const res = await SessionModel.coll.insertOne(data);
        (bus as any).broadcast('session/change', data);
        return res.insertedId;
    }

    static async addRecord(
        domainId: string,
        sessionId: ObjectId,
        recordId: ObjectId,
    ): Promise<SessionDoc | null> {
        const updated = await SessionModel.update(domainId, sessionId, {
            updatedAt: new Date(),
        }, {
            recordIds: recordId,
        } as any);
        return updated;
    }

    static getMulti(domainId: string, query: any, options?: FindOptions) {
        if (domainId) query = { domainId, ...query };
        return SessionModel.coll.find(query, options);
    }

    static async update(
        domainId: string, _id: MaybeArray<ObjectId>,
        $set?: MatchKeysAndValues<SessionDoc>,
        $push?: PushOperator<SessionDoc>,
        $unset?: OnlyFieldsOfType<SessionDoc, any, true | '' | 1>,
        $inc?: Partial<Record<NumberKeys<SessionDoc>, number>>,
    ): Promise<SessionDoc | null> {
        const $update: UpdateFilter<SessionDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        if ($inc && Object.keys($inc).length) $update.$inc = $inc;
        if (_id instanceof Array) {
            await SessionModel.coll.updateMany({ _id: { $in: _id }, domainId }, $update);
            return null;
        }
        if (Object.keys($update).length) {
            const updated = await SessionModel.coll.findOneAndUpdate(
                { _id, domainId },
                $update,
                { returnDocument: 'after' },
            );
            if (updated) {
                (bus as any).broadcast('session/change', updated);
            }
            return updated;
        }
        return await SessionModel.coll.findOne({ _id }, { readPreference: 'primary' });
    }

    static async updateMulti(
        domainId: string, $match: Filter<SessionDoc>,
        $set?: MatchKeysAndValues<SessionDoc>,
        $push?: PushOperator<SessionDoc>,
        $unset?: OnlyFieldsOfType<SessionDoc, any, true | '' | 1>,
    ) {
        const $update: UpdateFilter<SessionDoc> = {};
        if ($set && Object.keys($set).length) $update.$set = $set;
        if ($push && Object.keys($push).length) $update.$push = $push;
        if ($unset && Object.keys($unset).length) $update.$unset = $unset;
        const res = await SessionModel.coll.updateMany({ domainId, ...$match }, $update);
        return res.modifiedCount;
    }

    static count(domainId: string, query: any) {
        return SessionModel.coll.countDocuments({ domainId, ...query });
    }

    static async getList(
        domainId: string, sids: ObjectId[], fields?: (keyof SessionDoc)[],
    ): Promise<Record<string, Partial<SessionDoc>>> {
        const r: Record<string, SessionDoc> = {};
        sids = Array.from(new Set(sids));
        let cursor = SessionModel.coll.find({ domainId, _id: { $in: sids } });
        if (fields) cursor = cursor.project(buildProjection(fields));
        const sdocs = await cursor.toArray();
        for (const sdoc of sdocs) r[sdoc._id.toHexString()] = sdoc;
        return r;
    }

    static async delete(domainId: string, _id: ObjectId) {
        return SessionModel.coll.deleteOne({ _id, domainId });
    }
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => SessionModel.coll.deleteMany({ domainId }));
    
    await db.ensureIndexes(
        SessionModel.coll,
        { key: { domainId: 1, _id: -1 }, name: 'basic' },
        { key: { domainId: 1, uid: 1, _id: -1 }, name: 'withUser' },
        { key: { domainId: 1, agentId: 1, _id: -1 }, name: 'withAgent' },
        { key: { domainId: 1, clientId: 1, lastActivityAt: -1 }, name: 'withClient' },
        { key: { lastActivityAt: 1 }, name: 'lastActivityAt' },
    );
    
    // 定期检查超时的session（每30秒检查一次）
    const TIMEOUT_MS = 5 * 60 * 1000; // 5分钟超时
    setInterval(async () => {
        try {
            const timeoutThreshold = new Date(Date.now() - TIMEOUT_MS);
            // 查找超时的client类型session（断开连接超过5分钟）
            const timeoutSessions = await SessionModel.coll.find({
                type: 'client',
                lastActivityAt: { $lt: timeoutThreshold },
            }).toArray();
            
            // 对于超时的session，我们不需要做特殊处理，因为getSessionStatus会自动判断为detached
            // 这里只是记录日志
            if (timeoutSessions.length > 0) {
                logger.debug('Found %d timeout sessions (detached)', timeoutSessions.length);
            }
        } catch (e) {
            logger.error('Error in session timeout check:', e);
        }
    }, 30000); // 每30秒检查一次
}

(global.Ejunz.model as any).session = SessionModel;

