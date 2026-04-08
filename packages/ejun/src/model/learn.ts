import { ObjectId } from 'mongodb';
import db from '../service/db';
import domain from './domain';

const collDAG = db.collection('learn_dag');
const collProgress = db.collection('learn_progress');
const collResult = db.collection('learn_result');
const collConsumptionStats = db.collection('learn_consumption_stats');

export const LEARN_PROGRESS_SLOT_OUTSIDE_SECTION_ORDER = -1;

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

    static async getPassedCardIds(domainId: string, userId: number): Promise<Set<string>> {
        const list = await collProgress
            .find({ domainId, userId, passed: true })
            .toArray();
        return new Set(list.map((p) => p.cardId.toString()));
    }

    /**
     * 每条 `learn_progress` 必须带 `learnSectionOrderIndex`：学习路径为节序槽位 0..n；collect/flag 使用 `LEARN_PROGRESS_SLOT_OUTSIDE_SECTION_ORDER`。
     */
    static async setCardPassed(
        domainId: string,
        userId: number,
        cardId: ObjectId,
        nodeId: string,
        learnSectionOrderIndex: number,
    ) {
        const doc = {
            domainId,
            userId,
            cardId,
            nodeId,
            passed: true,
            passedAt: new Date(),
            learnSectionOrderIndex,
        };
        return collProgress.updateOne(
            { domainId, userId, cardId, learnSectionOrderIndex },
            { $set: doc },
            { upsert: true },
        );
    }

    static async listPassedProgressDocs(domainId: string, userId: number) {
        return collProgress
            .find({ domainId, userId, passed: true })
            .project({ cardId: 1, learnSectionOrderIndex: 1 })
            .toArray();
    }

    static async deleteLearnProgressForSlotCards(domainId: string, userId: number, slot: number, cardObjectIds: ObjectId[]) {
        if (!cardObjectIds.length) return;
        await collProgress.deleteMany({ domainId, userId, learnSectionOrderIndex: slot, cardId: { $in: cardObjectIds } });
    }

    /** Remove learn_progress rows for the given cards (clears passed and any stored progress for those cards). */
    static async clearPassedProgressForUserCards(domainId: string, userId: number, cardIdStrings: string[]) {
        if (!cardIdStrings.length) return;
        const oids: ObjectId[] = [];
        for (const id of cardIdStrings) {
            try {
                oids.push(new ObjectId(id));
            } catch {
                /* skip invalid */
            }
        }
        if (!oids.length) return;
        await collProgress.deleteMany({ domainId, userId, cardId: { $in: oids } });
    }

    static async getResults(
        domainId: string,
        userId: number,
        filter: { createdAt?: { $gte?: Date; $lte?: Date; $lt?: Date } } = {},
    ) {
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

    /** 学习路径槽位+卡片维度的练习次数（与 `learn_progress` 的 slot 语义一致），用于路径展示与复习优先级。 */
    static async incPathCardPractiseCount(domainId: string, userId: number, sectionSlot: number, cardId: string) {
        const slot = Math.max(0, sectionSlot);
        const cid = String(cardId);
        const path = `learnPathCardPractiseCounts.${slot}:${cid}`;
        return domain.updateUserInDomain(domainId, userId, { $inc: { [path]: 1 } });
    }

    /**
     * 移除路径练习次数（`slot:cardId` 与 `learnPassPlacementKey` / pass 槽位一致）。
     * 学习起点后移等与 `deleteLearnProgressForSlotCards` 同范围时调用。
     */
    static async unsetPathCardPractiseCountKeys(domainId: string, userId: number, placementKeys: string[]) {
        const uniq = [...new Set(placementKeys.map((k) => String(k)))];
        if (!uniq.length) return;
        const chunkSize = 500;
        for (let i = 0; i < uniq.length; i += chunkSize) {
            const part = uniq.slice(i, i + chunkSize);
            const $unset: Record<string, string> = {};
            for (const k of part) {
                $unset[`learnPathCardPractiseCounts.${k}`] = '';
            }
            await domain.updateUserInDomain(domainId, userId, { $unset });
        }
    }

    static async getUserLearnState(domainId: string, udoc: { _id: number; priv: number }) {
        return domain.getDomainUser(domainId, udoc);
    }
}

export default LearnModel;
