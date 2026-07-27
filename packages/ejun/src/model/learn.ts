import { ObjectId } from 'mongodb';
import { normalizeProblemTagInput } from './problem';
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

/** Learn: knowledge base selection and daily goals (domain user document). */

/** Which cards may appear in the ordered learn queue (domain.user). */
export type LearnSessionCardFilterMode = 'all' | 'with_problems';

/** Filter problems by taxonomy tag (`Problem.tags`) in session queue + practise. */
export type LearnSessionProblemTagMode = 'off' | 'include' | 'exclude';

/** Order in which today's **new**-segment cards are merged (`today` session only; stored on domain.user). */
export type LearnSessionMode = 'deep' | 'breadth' | 'random';

/** How **new** vs **review** arms are sequenced in the frozen daily queue (after counts are chosen). */
export type LearnNewReviewOrder = 'new_first' | 'old_first' | 'shuffle';

function hashStringToSeed32(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Deterministic Fisher–Yates shuffle (stable per `seedStr` for the same list length + content order). */
export function seededShuffle<T>(items: T[], seedStr: string): T[] {
    const a = [...items];
    let state = hashStringToSeed32(seedStr);
    const rnd = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
    }
    return a;
}

const LEARN_NEW_REVIEW_ORDER_CHOICES = new Set<LearnNewReviewOrder>(['new_first', 'old_first', 'shuffle']);

export function normalizeLearnNewReviewOrder(raw: unknown): LearnNewReviewOrder {
    const s = String(raw ?? '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
    if (s === 'old_first' || s === 'shuffle') return s;
    return 'new_first';
}

export function getLearnNewReviewOrder(dudoc: Record<string, unknown> | null | undefined): LearnNewReviewOrder {
    const n = normalizeLearnNewReviewOrder(dudoc?.learnNewReviewOrder);
    return LEARN_NEW_REVIEW_ORDER_CHOICES.has(n) ? n : 'new_first';
}

/**
 * Merge tagged new vs review slices into the frozen daily queue order.
 * `shuffleSeed` should stay stable for the calendar day (e.g. domainId:uid:YYYY-MM-DD).
 */
export function mergeDailyNewReviewArms<
    TNew extends { todayQueueRole: 'new' },
    TRev extends { todayQueueRole: 'review' },
>(newArm: TNew[], reviewArm: TRev[], order: LearnNewReviewOrder, shuffleSeed: string): (TNew | TRev)[] {
    if (order === 'old_first') return [...reviewArm, ...newArm];
    if (order === 'shuffle') return seededShuffle([...newArm, ...reviewArm], shuffleSeed);
    return [...newArm, ...reviewArm];
}

/** 1:0 = new only; 0:1 = review only (count = daily goal); 1:N = mixed (review ≈ new×N). */
const LEARN_NEW_REVIEW_RATIO_VALUES = new Set([-1, 0, 1, 2, 3, 4, 5]);

/** Old-segment cards appended after daily **new** slice: count = newCount × N; pool cycles when shorter. */
export function getLearnNewReviewRatio(dudoc: Record<string, unknown> | null | undefined): number {
    const n = parseInt(String(dudoc?.learnNewReviewRatio ?? '1'), 10);
    return LEARN_NEW_REVIEW_RATIO_VALUES.has(n) ? n : 1;
}

export function normalizeLearnSessionMode(raw: unknown): LearnSessionMode {
    const s = String(raw ?? '').trim().toLowerCase();
    if (s === 'breadth' || s === 'random') return s;
    return 'deep';
}

/** Default: deep learning (section-by-section depth-first card order). */
export function getLearnSessionMode(dudoc: Record<string, unknown> | null | undefined): LearnSessionMode {
    return normalizeLearnSessionMode(dudoc?.learnSessionMode);
}

export function normalizeLearnSessionCardFilter(raw: unknown): LearnSessionCardFilterMode {
    const s = String(raw ?? '').trim().toLowerCase().replace(/-/g, '_');
    if (s === 'with_problems') return 'with_problems';
    return 'all';
}

export function getLearnSessionCardFilter(dudoc: Record<string, unknown> | null | undefined): LearnSessionCardFilterMode {
    return normalizeLearnSessionCardFilter(dudoc?.learnSessionCardFilter);
}

export function normalizeLearnSessionProblemTagMode(raw: unknown): LearnSessionProblemTagMode {
    const s = String(raw ?? 'off').trim().toLowerCase().replace(/-/g, '_');
    if (s === 'include' || s === 'exclude') return s;
    return 'off';
}

/** Normalized, deduped, sorted tag list for storage and snapshot compare (max 32). */
export function normalizeLearnSessionProblemTagList(raw: unknown, maxEntries = 32): string[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of raw) {
        const t = normalizeProblemTagInput(x);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= maxEntries) break;
    }
    return out.sort((a, b) => a.localeCompare(b));
}

export function getLearnSessionProblemTagMode(dudoc: Record<string, unknown> | null | undefined): LearnSessionProblemTagMode {
    return normalizeLearnSessionProblemTagMode(dudoc?.learnSessionProblemTagMode);
}

export function getLearnSessionProblemTags(dudoc: Record<string, unknown> | null | undefined): string[] {
    return normalizeLearnSessionProblemTagList(dudoc?.learnSessionProblemTags);
}

/** Compare domain.user tag prefs vs values frozen on a session row (missing session fields ⇒ off / []). */
export function learnSessionProblemTagSettingsMatchDuWithSession(
    du: Record<string, unknown>,
    sessionTagModeRaw: unknown,
    sessionTagsRaw: unknown,
): boolean {
    const wantM = getLearnSessionProblemTagMode(du);
    const wantT = JSON.stringify(getLearnSessionProblemTags(du));
    const snapM = sessionTagModeRaw === undefined || sessionTagModeRaw === null || String(sessionTagModeRaw).trim() === ''
        ? 'off'
        : normalizeLearnSessionProblemTagMode(sessionTagModeRaw);
    const snapT = JSON.stringify(normalizeLearnSessionProblemTagList(
        Array.isArray(sessionTagsRaw) ? sessionTagsRaw : [],
    ));
    return wantM === snapM && wantT === snapT;
}

export function getLearnBaseDocId(dudoc: Record<string, unknown> | null | undefined): number | null {
    const legacyRaw = dudoc?.learnBaseDocId;
    return Number.isFinite(Number(legacyRaw)) && Number(legacyRaw) > 0 ? Number(legacyRaw) : null;
}

export function normalizeLearnMode(_raw: unknown): 'base' {
    return 'base';
}

export function getLearnMode(_dudoc: Record<string, unknown> | null | undefined): 'base' {
    return 'base';
}

/** @deprecated Roadmap mode removed. Always returns null. */
export function getLearnRoadmapDocId(_dudoc: Record<string, unknown> | null | undefined): number | null {
    return null;
}

/** Fall back to dailyGoal when learnDailyGoal was never written. For learn: **new** cards per day when > 0. */
export function getLearnDailyGoal(dudoc: Record<string, unknown> | null | undefined): number {
    const legacy = Number(dudoc?.dailyGoal) || 0;
    const raw = dudoc?.learnDailyGoal;
    if (raw === undefined || raw === null || raw === '') {
        return legacy;
    }
    const n = parseInt(String(raw), 10);
    return !Number.isNaN(n) && n >= 0 ? n : legacy;
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
