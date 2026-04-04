import { ObjectId } from 'mongodb';
import db from '../service/db';
import domain from './domain';

const collDAG = db.collection('learn_dag');
const collProgress = db.collection('learn_progress');
const collResult = db.collection('learn_result');
const collConsumptionStats = db.collection('learn_consumption_stats');

export interface LearnDAGNode {
    _id: string;
    title: string;
    requireNids: string[];
    cards: Array<{
        cardId: string;
        title: string;
        order?: number;
    }>;
    content?: string;
    order?: number;
}

export interface LearnDAGDoc {
    domainId: string;
    baseDocId?: number | ObjectId;
    branch: string;
    trainingDocId?: ObjectId;
    sections: LearnDAGNode[];
    dag: LearnDAGNode[];
    version: number;
    updateAt: Date;
}

/** Learn-page DAG merged from the selected training (same merged graph as the editor); not cached per single base only. */
export const TRAINING_LEARN_DAG_BRANCH = 'training_merged';

class LearnModel {
    static collDAG = collDAG;
    static collProgress = collProgress;
    static collResult = collResult;
    static collConsumptionStats = collConsumptionStats;

    static async getDAG(domainId: string, baseDocId: number | ObjectId, branch: string): Promise<LearnDAGDoc | null> {
        const doc = await collDAG.findOne({
            domainId,
            baseDocId,
            branch,
        });
        return doc as LearnDAGDoc | null;
    }

    static async getTrainingLearnDAG(domainId: string, trainingDocId: ObjectId): Promise<LearnDAGDoc | null> {
        const doc = await collDAG.findOne({
            domainId,
            trainingDocId,
            branch: TRAINING_LEARN_DAG_BRANCH,
        });
        return doc as LearnDAGDoc | null;
    }

    static async setDAG(
        domainId: string,
        baseDocId: number | ObjectId,
        branch: string,
        data: { sections: LearnDAGNode[]; dag: LearnDAGNode[]; version: number; updateAt: Date },
        extra?: Record<string, unknown>
    ) {
        const $set: Record<string, unknown> = {
            domainId,
            baseDocId,
            branch,
            sections: data.sections,
            dag: data.dag,
            version: data.version,
            updateAt: data.updateAt,
        };
        if (extra) Object.assign($set, extra);
        return collDAG.updateOne(
            { domainId, baseDocId, branch },
            { $set },
            { upsert: true }
        );
    }

    static async setTrainingLearnDAG(
        domainId: string,
        trainingDocId: ObjectId,
        data: { sections: LearnDAGNode[]; dag: LearnDAGNode[]; version: number; updateAt: Date },
    ) {
        const $set: Record<string, unknown> = {
            domainId,
            trainingDocId,
            branch: TRAINING_LEARN_DAG_BRANCH,
            baseDocId: 0,
            sections: data.sections,
            dag: data.dag,
            version: data.version,
            updateAt: data.updateAt,
        };
        return collDAG.updateOne(
            { domainId, trainingDocId, branch: TRAINING_LEARN_DAG_BRANCH },
            { $set },
            { upsert: true },
        );
    }

    static async getPassedCardIds(domainId: string, userId: number): Promise<Set<string>> {
        const list = await collProgress
            .find({ domainId, userId, passed: true })
            .toArray();
        return new Set(list.map((p) => p.cardId.toString()));
    }

    static async setCardPassed(domainId: string, userId: number, cardId: ObjectId, nodeId: string) {
        return collProgress.updateOne(
            { domainId, userId, cardId },
            {
                $set: {
                    domainId,
                    userId,
                    cardId,
                    nodeId,
                    passed: true,
                    passedAt: new Date(),
                },
            },
            { upsert: true }
        );
    }

    static async getResults(domainId: string, userId: number, filter: { createdAt?: { $gte: Date; $lte: Date } } = {}) {
        return collResult.find({ domainId, userId, ...filter }).toArray();
    }

    static async getResultById(domainId: string, userId: number, resultId: ObjectId) {
        return collResult.findOne({ _id: resultId, domainId, userId });
    }

    static async addResult(
        domainId: string,
        userId: number,
        doc: {
            _id?: ObjectId;
            cardId: ObjectId;
            nodeId: string | null;
            answerHistory: unknown[];
            totalTime: number;
            score: number;
            createdAt: Date;
        }
    ) {
        const id = doc._id || new ObjectId();
        await collResult.insertOne({
            _id: id,
            domainId,
            userId,
            cardId: doc.cardId,
            nodeId: doc.nodeId,
            answerHistory: doc.answerHistory,
            totalTime: doc.totalTime,
            score: doc.score,
            createdAt: doc.createdAt,
        });
        return id;
    }

    static async incConsumptionStats(
        domainId: string,
        userId: number,
        date: string,
        inc: { nodes?: number; cards?: number; problems?: number; practices?: number; totalTime?: number }
    ) {
        const updateData: Record<string, unknown> = {
            $set: { updateAt: new Date() },
            $inc: { ...inc },
        };
        return collConsumptionStats.updateOne(
            { domainId, userId, date },
            updateData,
            { upsert: true }
        );
    }

    static async setUserLearnState(domainId: string, uid: number, update: Record<string, unknown>) {
        return domain.setUserInDomain(domainId, uid, update);
    }

    static async getUserLearnState(domainId: string, udoc: { _id: number; priv: number }) {
        return domain.getDomainUser(domainId, udoc);
    }
}

export default LearnModel;
