import type { Filter, FindOptions } from 'mongodb';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import db from '../service/db';
import bus from '../service/bus';
import { buildProjection } from '../utils';
import SessionModel from './session';

export type RecordProblemState = {
    pid: string;
    status: 'pending' | 'correct' | 'wrong' | 'skipped';
    selected?: number;
    attempts?: number;
    timeSpentMs?: number;
    updatedAt?: Date;
};

export interface RecordDoc {
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
    createdAt: Date;
    updatedAt: Date;
    lastActivityAt: Date;
}

export const RECORD_PROJECTION_LIST: (keyof RecordDoc)[] = [
    '_id', 'domainId', 'uid', 'sessionId', 'cardId', 'nodeId', 'baseDocId', 'branch',
    'updatedAt', 'lastActivityAt',
];

export default class RecordModel {
    static coll = db.collection('session_record');

    static getMulti(domainId: string, query: Filter<RecordDoc> = {}, options?: FindOptions) {
        return RecordModel.coll.find({ domainId, ...query } as Filter<RecordDoc>, options);
    }

    static async get(domainId: string, _id: ObjectId): Promise<RecordDoc | null> {
        const doc = await RecordModel.coll.findOne({ _id, domainId });
        return doc as RecordDoc | null;
    }

    static async getList(
        domainId: string,
        rids: ObjectId[],
        fields?: (keyof RecordDoc)[],
    ): Promise<Record<string, Partial<RecordDoc>>> {
        const r: Record<string, Partial<RecordDoc>> = {};
        rids = Array.from(new Set(rids));
        if (!rids.length) return r;
        let cursor = RecordModel.coll.find({ domainId, _id: { $in: rids } });
        if (fields?.length) cursor = cursor.project(buildProjection(fields));
        const rdocs = await cursor.toArray();
        for (const rdoc of rdocs) r[rdoc._id.toHexString()] = rdoc as RecordDoc;
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
    ): Promise<RecordDoc> {
        const existing = await RecordModel.coll.findOne({
            domainId,
            uid,
            sessionId: sessionMongoId,
            cardId,
        });
        if (existing) {
            const ex = existing as RecordDoc;
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
        const doc: RecordDoc = {
            _id: new ObjectId(),
            domainId,
            uid,
            sessionId: sessionMongoId,
            cardId,
            nodeId,
            baseDocId,
            branch,
            ...(tid ? { trainingDocId: tid } : {}),
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

    static async patchProblem(
        domainId: string,
        recordId: ObjectId,
        problemId: string,
        patch: Partial<Pick<RecordProblemState, 'status' | 'selected' | 'attempts' | 'timeSpentMs'>>,
    ): Promise<RecordDoc | null> {
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
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => RecordModel.coll.deleteMany({ domainId }));
    await db.ensureIndexes(
        RecordModel.coll,
        { key: { domainId: 1, uid: 1, sessionId: 1, cardId: 1 }, name: 'domain_uid_session_card', unique: true },
        { key: { domainId: 1, _id: 1 }, name: 'domain_id' },
        { key: { sessionId: 1 }, name: 'sessionId' },
    );
    (global.Ejunz.model as any).record = RecordModel;
}
