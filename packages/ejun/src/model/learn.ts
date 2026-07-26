import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import type { AgentChatSessionDoc, BaseDoc, SessionDoc, SessionPatch } from '../interface';
import db from '../service/db';
import DomainModel from './domain';

const collDAG = db.collection('learn_dag');
const collProgress = db.collection('learn_progress');
const collResult = db.collection('learn_result');
const collConsumptionStats = db.collection('learn_consumption_stats');

export const LEARN_PROGRESS_SLOT_OUTSIDE_SECTION_ORDER = -1;

export interface LearnDAGNode {
    _id: string;
    title: string;
    requireNids: string[];
    cards: Array<{ cardId: string; title: string; order?: number }>;
    content?: string;
    order?: number;
}

export interface LearnDAGDoc {
    domainId: string;
    baseDocId?: number | ObjectId;
    trainingDocId?: ObjectId;
    sections: LearnDAGNode[];
    dag: LearnDAGNode[];
    version: number;
    updateAt: Date;
}

class LearnModel {
    static collDAG = collDAG;
    static collProgress = collProgress;
    static collResult = collResult;
    static collConsumptionStats = collConsumptionStats;

    static async getDAG(domainId: string, baseDocId: number | ObjectId): Promise<LearnDAGDoc | null> {
        return collDAG.findOne(
            { domainId, baseDocId },
            { sort: { updateAt: -1, _id: -1 } },
        ) as Promise<LearnDAGDoc | null>;
    }

    static async setDAG(
        domainId: string,
        baseDocId: number | ObjectId,
        data: { sections: LearnDAGNode[]; dag: LearnDAGNode[]; version: number; updateAt: Date },
        extra?: Record<string, unknown>,
    ) {
        const $set: Record<string, unknown> = { domainId, baseDocId, ...data };
        if (extra) Object.assign($set, extra);
        return collDAG.updateOne(
            { domainId, baseDocId },
            { $set },
            { upsert: true },
        );
    }

    static async deleteDAG(domainId: string, baseDocId: number | ObjectId) {
        await collDAG.deleteMany({ domainId, baseDocId });
    }

    static async getPassedCardIds(domainId: string, userId: number): Promise<Set<string>> {
        const list = await collProgress.find({ domainId, userId, passed: true }).toArray();
        return new Set(list.map((p) => p.cardId.toString()));
    }

    static async setCardPassed(domainId: string, userId: number, cardId: ObjectId, nodeId: string, learnSectionOrderIndex: number) {
        const doc = { domainId, userId, cardId, nodeId, passed: true, passedAt: new Date(), learnSectionOrderIndex };
        return collProgress.updateOne({ domainId, userId, cardId, learnSectionOrderIndex }, { $set: doc }, { upsert: true });
    }

    static async listPassedProgressDocs(domainId: string, userId: number) {
        return collProgress.find({ domainId, userId, passed: true }).project({ cardId: 1, learnSectionOrderIndex: 1 }).toArray();
    }

    static async deleteLearnProgressForSlotCards(domainId: string, userId: number, slot: number, cardObjectIds: ObjectId[]) {
        if (cardObjectIds.length) await collProgress.deleteMany({ domainId, userId, learnSectionOrderIndex: slot, cardId: { $in: cardObjectIds } });
    }

    static async clearPassedProgressForUserCards(domainId: string, userId: number, cardIdStrings: string[]) {
        if (!cardIdStrings.length) return;
        const oids: ObjectId[] = [];
        for (const id of cardIdStrings) {
            try { oids.push(new ObjectId(id)); } catch { /* skip invalid */ }
        }
        if (oids.length) await collProgress.deleteMany({ domainId, userId, cardId: { $in: oids } });
    }

    static async deleteAllPassedProgressForUser(domainId: string, userId: number) {
        await collProgress.deleteMany({ domainId, userId });
    }

    static async clearLearnPathPractiseCounts(domainId: string, userId: number) {
        return DomainModel.updateUserInDomain(domainId, userId, { $unset: { learnPathCardPractiseCounts: '' } });
    }

    static async getResults(domainId: string, userId: number, filter: { createdAt?: { $gte?: Date; $lte?: Date; $lt?: Date } } = {}) {
        return collResult.find({ domainId, userId, ...filter }).toArray();
    }

    static async getResultById(domainId: string, userId: number, resultId: ObjectId) {
        return collResult.findOne({ _id: resultId, domainId, userId });
    }

    static async addResult(domainId: string, userId: number, doc: {
        _id?: ObjectId;
        cardId: ObjectId;
        nodeId: string | null;
        answerHistory: unknown[];
        totalTime: number;
        score: number;
        createdAt: Date;
    }) {
        const id = doc._id || new ObjectId();
        await collResult.insertOne({ _id: id, domainId, userId, cardId: doc.cardId, nodeId: doc.nodeId, answerHistory: doc.answerHistory, totalTime: doc.totalTime, score: doc.score, createdAt: doc.createdAt });
        return id;
    }

    static async incConsumptionStats(domainId: string, userId: number, date: string, inc: { nodes?: number; cards?: number; problems?: number; practices?: number; totalTime?: number }) {
        return collConsumptionStats.updateOne({ domainId, userId, date }, { $set: { updateAt: new Date() }, $inc: { ...inc } }, { upsert: true });
    }

    static async setUserLearnState(domainId: string, uid: number, update: Record<string, unknown>) {
        return DomainModel.setUserInDomain(domainId, uid, update);
    }

    static async incPathCardPractiseCount(domainId: string, userId: number, sectionSlot: number, cardId: string) {
        const slot = Math.max(0, sectionSlot);
        const path = `learnPathCardPractiseCounts.${slot}:${String(cardId)}`;
        return DomainModel.updateUserInDomain(domainId, userId, { $inc: { [path]: 1 } });
    }

    static async unsetPathCardPractiseCountKeys(domainId: string, userId: number, placementKeys: string[]) {
        const uniq = [...new Set(placementKeys.map(String))];
        for (let i = 0; i < uniq.length; i += 500) {
            const $unset: Record<string, string> = {};
            for (const key of uniq.slice(i, i + 500)) $unset[`learnPathCardPractiseCounts.${key}`] = '';
            if (Object.keys($unset).length) await DomainModel.updateUserInDomain(domainId, userId, { $unset });
        }
    }

    static async getUserLearnState(domainId: string, udoc: { _id: number; priv: number }) {
        return DomainModel.getDomainUser(domainId, udoc);
    }
}

export default LearnModel;

export async function apply(_ctx: Context) {
    (global.Ejunz.model as any).learn = LearnModel;
}
