import { ObjectId } from 'mongodb';
import db from '../service/db';

const coll = db.collection('learn_problem_note');

export type LearnProblemNoteDoc = {
    _id: ObjectId;
    domainId: string;
    cardId: string;
    pid: string;
    uid: number;
    uname: string;
    content: string;
    createdAt: Date;
    /** Set when content was last modified (not set on initial insert). */
    updatedAt?: Date;
};

export default class LearnProblemNoteModel {
    static async ensureIndexes(): Promise<void> {
        try {
            await coll.createIndex(
                { domainId: 1, cardId: 1, pid: 1, createdAt: -1 },
                { name: 'learn_problem_note_lookup', background: true },
            );
        } catch {
            /* ignore duplicate */
        }
    }

    static async listForProblem(domainId: string, cardId: string, pid: string, limit: number): Promise<LearnProblemNoteDoc[]> {
        const rows = await coll
            .find({ domainId, cardId, pid })
            .sort({ createdAt: -1 })
            .limit(Math.max(1, Math.min(limit, 500)))
            .toArray();
        return rows as LearnProblemNoteDoc[];
    }

    static async getById(id: ObjectId): Promise<LearnProblemNoteDoc | null> {
        const row = await coll.findOne({ _id: id });
        return (row as LearnProblemNoteDoc | null) ?? null;
    }

    static async updateContent(_id: ObjectId, content: string): Promise<boolean> {
        const text = String(content ?? '').slice(0, 4000);
        const r = await coll.updateOne({ _id }, { $set: { content: text, updatedAt: new Date() } });
        return r.modifiedCount > 0;
    }

    static async deleteById(_id: ObjectId): Promise<boolean> {
        const r = await coll.deleteOne({ _id });
        return r.deletedCount > 0;
    }

    static async add(
        payload: Omit<LearnProblemNoteDoc, '_id' | 'createdAt'> & { createdAt?: Date },
    ): Promise<LearnProblemNoteDoc> {
        const row: LearnProblemNoteDoc = {
            _id: new ObjectId(),
            domainId: payload.domainId,
            cardId: payload.cardId,
            pid: payload.pid,
            uid: payload.uid,
            uname: String(payload.uname || '').slice(0, 128),
            content: String(payload.content || '').slice(0, 4000),
            createdAt: payload.createdAt ?? new Date(),
        };
        await coll.insertOne(row as never);
        return row;
    }

    static toWire(d: LearnProblemNoteDoc) {
        const upd = d.updatedAt;
        const wire: Record<string, unknown> = {
            id: d._id.toString(),
            uid: d.uid,
            uname: d.uname,
            content: d.content,
            createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : String(d.createdAt ?? ''),
        };
        if (upd instanceof Date && !Number.isNaN(upd.getTime())) {
            wire.updatedAt = upd.toISOString();
        }
        return wire;
    }
}
