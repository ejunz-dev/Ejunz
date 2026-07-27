import { ObjectId } from 'mongodb';
import { normalizeProblemTagInput } from './problem';
import moment from 'moment-timezone';
import type { SessionRecordDoc } from './record';
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

type LearnResultRow = {
    _id: ObjectId;
    cardId: ObjectId;
    nodeId: string | null;
    answerHistory?: unknown[];
    score?: number;
    totalTime?: number;
    createdAt?: Date;
};

type ConsumptionRow = {
    date?: string;
    nodes?: unknown;
    cards?: unknown;
    problems?: unknown;
};

export type LearnWallSessionWire = {
    sessionId: string;
    sessionHistoryUrl: string;
    timeUtc: string;
    recordCount: number;
    statusLabel: string;
    progressText: string | null;
    baseDocId: number;
};

export type LearnWallDayDetailWire = {
    domainId: string;
    domainName: string;
    nodes: number;
    cards: number;
    problems: number;
    checkedIn: boolean;
    sessions: LearnWallSessionWire[];
};

function ymdUtc(d: Date | undefined | null): string | null {
    if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return null;
    return moment.utc(d).format('YYYY-MM-DD');
}

function hmUtc(d: Date | undefined | null): string {
    if (!d || !(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    return moment.utc(d).format('HH:mm');
}

function inRange(ymd: string, since: string, until: string): boolean {
    return ymd >= since && ymd <= until;
}

function hasAggregateTotals(
    aggregate: Map<string, { nodes: number; cards: number; problems: number }>,
    date: string,
): boolean {
    const v = aggregate.get(date);
    return !!v && v.nodes + v.cards + v.problems > 0;
}

function problemCountFromHistory(answerHistory: unknown): number {
    if (!Array.isArray(answerHistory)) return 0;
    let n = 0;
    for (const h of answerHistory) {
        if (h && typeof h === 'object' && String((h as { problemId?: string }).problemId || '').trim()) n++;
    }
    return n;
}

function learnLessonSessionUrl(
    buildUrl: (routeName: string, kwargs?: Record<string, unknown>) => string,
    domainId: string,
    sessionHex: string,
): string {
    const base = buildUrl('learn_lesson', { domainId });
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}session=${encodeURIComponent(sessionHex)}`;
}

/**
 * Past-year learn activity in one domain: consumption stats, check-in days, session touches,
 * and per-day learn sessions with learn_card record counts (learn wall).
 */
export async function buildLearnDomainWallPayload(
    domainId: string,
    domainName: string,
    uid: number,
    learnActivityDates: string[],
    sinceYmd: string,
    untilYmd: string,
    buildUrl: (routeName: string, kwargs?: Record<string, unknown>) => string,
    translate: (key: string) => string,
): Promise<{
    learnWallContributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }>;
    learnWallContributionDetails: Record<string, LearnWallDayDetailWire[]>;
}> {
    const {
        default: SessionModel,
        deriveSessionLearnStatus,
        formatSessionProgressDisplay,
    } = require('./session');
    const RecordModel = require('./record').default;
    const consumptionDocs = await collConsumptionStats.find({
        domainId,
        userId: uid,
        date: { $gte: sinceYmd, $lte: untilYmd },
    }).toArray() as ConsumptionRow[];

    const aggregate = new Map<string, { nodes: number; cards: number; problems: number }>();
    for (const d of consumptionDocs) {
        const date = String(d.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const prev = aggregate.get(date) || { nodes: 0, cards: 0, problems: 0 };
        aggregate.set(date, {
            nodes: prev.nodes + (Number(d.nodes) || 0),
            cards: prev.cards + (Number(d.cards) || 0),
            problems: prev.problems + (Number(d.problems) || 0),
        });
    }

    const yearStart = moment.utc(sinceYmd, 'YYYY-MM-DD').startOf('day').toDate();
    const resultsRaw = await LearnModel.getResults(domainId, uid, {
        createdAt: { $gte: yearStart },
    }) as LearnResultRow[];

    const resultsByDate = new Map<string, LearnResultRow[]>();
    for (const res of resultsRaw) {
        const dateStr = ymdUtc(res.createdAt);
        if (!dateStr || !inRange(dateStr, sinceYmd, untilYmd)) continue;
        if (!resultsByDate.has(dateStr)) resultsByDate.set(dateStr, []);
        resultsByDate.get(dateStr)!.push(res);
    }
    for (const [, list] of resultsByDate) {
        list.sort((a, b) => {
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            return tb - ta;
        });
    }

    for (const [date, list] of resultsByDate) {
        const prev = aggregate.get(date) || { nodes: 0, cards: 0, problems: 0 };
        let rc = 0;
        let rp = 0;
        for (const res of list) {
            rc++;
            rp += problemCountFromHistory(res.answerHistory);
        }
        aggregate.set(date, {
            nodes: prev.nodes,
            cards: Math.max(prev.cards, rc),
            problems: Math.max(prev.problems, rp),
        });
    }

    const checkInSet = new Set(
        learnActivityDates.filter((x) => typeof x === 'string' && inRange(x, sinceYmd, untilYmd)),
    );

    const sessions = await SessionModel.coll
        .find({
            domainId,
            uid,
            $and: [
                { $or: [{ appRoute: 'learn' }, { route: 'learn' }] },
                { $or: [{ createdAt: { $gte: yearStart } }, { lastActivityAt: { $gte: yearStart } }] },
            ],
        })
        .sort({ lastActivityAt: -1 })
        .toArray() as SessionDoc[];

    const sessionByHex = new Map<string, SessionDoc>();
    for (const s of sessions) sessionByHex.set(s._id.toHexString(), s);

    const sessionsByDate = new Map<string, Map<string, SessionDoc>>();
    const addSessionToDate = (dateStr: string | null, sess: SessionDoc) => {
        if (!dateStr || !inRange(dateStr, sinceYmd, untilYmd)) return;
        if (!sessionsByDate.has(dateStr)) sessionsByDate.set(dateStr, new Map());
        sessionsByDate.get(dateStr)!.set(sess._id.toHexString(), sess);
    };
    for (const sess of sessions) {
        addSessionToDate(ymdUtc(sess.createdAt as Date), sess);
        const last = ymdUtc(sess.lastActivityAt as Date);
        const cr = ymdUtc(sess.createdAt as Date);
        if (last && last !== cr) addSessionToDate(last, sess);
    }

    /** Per UTC day, learn_card record count per session (activity on that day). */
    const recordCountByDaySession = new Map<string, Map<string, number>>();
    const bumpRecord = (dayYmd: string | null, sessionHex: string) => {
        if (!dayYmd || !inRange(dayYmd, sinceYmd, untilYmd) || !sessionHex) return;
        if (!recordCountByDaySession.has(dayYmd)) recordCountByDaySession.set(dayYmd, new Map());
        const m = recordCountByDaySession.get(dayYmd)!;
        m.set(sessionHex, (m.get(sessionHex) || 0) + 1);
    };

    const learnCardRecords = await RecordModel.coll
        .find({
            domainId,
            uid,
            recordKind: { $ne: 'develop_save' },
            $or: [{ lastActivityAt: { $gte: yearStart } }, { createdAt: { $gte: yearStart } }],
        })
        .toArray() as SessionRecordDoc[];

    for (const rd of learnCardRecords) {
        const sid = rd.sessionId ? rd.sessionId.toHexString() : '';
        if (!sid) continue;
        const days = new Set<string>();
        const la = ymdUtc(rd.lastActivityAt);
        const cr = ymdUtc(rd.createdAt);
        if (la && inRange(la, sinceYmd, untilYmd)) days.add(la);
        if (cr && inRange(cr, sinceYmd, untilYmd)) days.add(cr);
        for (const d of days) bumpRecord(d, sid);
    }

    const contributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }> = [];
    for (const [date, { nodes, cards, problems }] of aggregate) {
        if (nodes > 0) contributions.push({ date, type: 'node', count: nodes });
        if (cards > 0) contributions.push({ date, type: 'card', count: cards });
        if (problems > 0) contributions.push({ date, type: 'problem', count: problems });
    }

    const markerDays = new Set<string>();
    for (const d of checkInSet) {
        if (!hasAggregateTotals(aggregate, d)) {
            contributions.push({ date: d, type: 'node', count: 1 });
            markerDays.add(d);
        }
    }
    for (const d of sessionsByDate.keys()) {
        if (hasAggregateTotals(aggregate, d) || markerDays.has(d) || checkInSet.has(d)) continue;
        const m = sessionsByDate.get(d);
        if (m && m.size > 0) contributions.push({ date: d, type: 'node', count: 1 });
    }

    const allDates = new Set<string>([
        ...aggregate.keys(),
        ...checkInSet,
        ...sessionsByDate.keys(),
        ...resultsByDate.keys(),
        ...recordCountByDaySession.keys(),
    ]);

    const learnWallContributionDetails: Record<string, LearnWallDayDetailWire[]> = {};
    for (const date of allDates) {
        if (!inRange(date, sinceYmd, untilYmd)) continue;
        const agg = aggregate.get(date) || { nodes: 0, cards: 0, problems: 0 };
        const countMap = recordCountByDaySession.get(date) || new Map<string, number>();
        const sessionHexes = [...new Set([
            ...countMap.keys(),
            ...(sessionsByDate.get(date) ? [...sessionsByDate.get(date)!.keys()] : []),
        ])];

        const rows: Array<{ hex: string; count: number; sess: SessionDoc | null; sortTs: number }> = [];
        for (const hex of sessionHexes) {
            let sess = sessionByHex.get(hex) || null;
            if (!sess) {
                try {
                    const one = await SessionModel.coll.findOne({
                        _id: new ObjectId(hex),
                        domainId,
                        uid,
                    }) as SessionDoc | null;
                    sess = one;
                } catch {
                    sess = null;
                }
            }
            const cnt = countMap.get(hex) || 0;
            const sortTs = sess?.lastActivityAt
                ? new Date(sess.lastActivityAt).getTime()
                : 0;
            rows.push({ hex, count: cnt, sess, sortTs });
        }
        rows.sort((a, b) => b.sortTs - a.sortTs);

        const sessionsWire: LearnWallSessionWire[] = [];
        for (const { hex, count, sess } of rows) {
            if (!sess) continue;
            const st = deriveSessionLearnStatus(sess);
            sessionsWire.push({
                sessionId: hex,
                sessionHistoryUrl: learnLessonSessionUrl(buildUrl, domainId, hex),
                timeUtc: hmUtc(sess.lastActivityAt),
                recordCount: count,
                statusLabel: translate(`session_status_${st}`),
                progressText: formatSessionProgressDisplay(sess),
                baseDocId: Number(sess.baseDocId) || 0,
            });
        }

        learnWallContributionDetails[date] = [{
            domainId,
            domainName,
            nodes: agg.nodes,
            cards: agg.cards,
            problems: agg.problems,
            checkedIn: checkInSet.has(date),
            sessions: sessionsWire,
        }];
    }

    return { learnWallContributions: contributions, learnWallContributionDetails };
}


class LearnModel {
    static buildLearnDomainWallPayload = buildLearnDomainWallPayload;

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
