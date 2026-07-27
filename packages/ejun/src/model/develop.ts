import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import DomainModel from './domain';
import SessionModel, {
    type SessionDoc,
    deriveSessionLearnStatus,
    formatSessionProgressDisplay,
    isDevelopSessionPastDeadline,
    isDevelopSessionRow,
    isDevelopSessionSettled,
    isSessionStalePastUtcCalendarDay,
    sessionUtcYmd,
    YMD_RE,
} from './session';
import RecordModel, { type SessionRecordDoc } from './record';
import bus from '../service/bus';
import db from '../service/db';

const coll = db.collection('develop_branch_daily');

export type DevelopBranchDailyDoc = {
    domainId: string;
    uid: number;
    date: string;
    baseDocId: number;
    nodes?: number;
    cards?: number;
    problems?: number;
    createAt?: Date;
    updateAt?: Date;
};

export function developTodayUtcYmd(): string {
    return sessionUtcYmd();
}

export function developBaseKey(baseDocId: number): string {
    return String(Number(baseDocId));
}

export async function incDevelopDaily(
    domainId: string,
    uid: number,
    baseDocId: number,
    inc: { nodes: number; cards: number; problems: number },
): Promise<void> {
    const n = inc.nodes || 0;
    const c = inc.cards || 0;
    const p = inc.problems || 0;
    if (!n && !c && !p) return;
    const date = developTodayUtcYmd();
    const bid = Number(baseDocId);
    await coll.updateOne(
        { domainId, uid, date, baseDocId: bid },
        {
            $inc: { nodes: n, cards: c, problems: p },
            $set: { updateAt: new Date() },
            $setOnInsert: {
                domainId,
                uid,
                date,
                baseDocId: bid,
                createAt: new Date(),
            },
        },
        { upsert: true },
    );
}

export async function getDevelopDailyMany(
    domainId: string,
    uid: number,
    date: string,
    baseDocIds: number[],
): Promise<Map<string, { nodes: number; cards: number; problems: number }>> {
    const m = new Map<string, { nodes: number; cards: number; problems: number }>();
    const ids = [...new Set(baseDocIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length) return m;
    const docs = await coll.find({
        domainId,
        uid,
        date,
        baseDocId: { $in: ids },
    }).toArray();
    for (const d of docs) {
        const key = developBaseKey(Number(d.baseDocId));
        const current = m.get(key) || { nodes: 0, cards: 0, problems: 0 };
        current.nodes += Number(d.nodes) || 0;
        current.cards += Number(d.cards) || 0;
        current.problems += Number(d.problems) || 0;
        m.set(key, current);
    }
    return m;
}


export const DEVELOP_POOL_MAX = 24;

export type DevelopPoolEntryWire = {
    baseDocId: number;
    dailyNodeGoal: number;
    dailyCardGoal: number;
    dailyProblemGoal: number;
    /** Lower value = earlier in the develop-start queue and editor ordering. */
    sortOrder: number;
};

export function normalizeDevelopPool(raw: unknown): DevelopPoolEntryWire[] {
    if (!Array.isArray(raw)) return [];
    const acc: DevelopPoolEntryWire[] = [];
    const seen = new Set<number>();
    let inputIndex = 0;
    for (const row of raw) {
        if (!row || typeof row !== 'object') continue;
        const baseDocId = parseInt(String((row as any).baseDocId ?? ''), 10);
        if (!Number.isFinite(baseDocId) || baseDocId <= 0 || seen.has(baseDocId)) continue;
        seen.add(baseDocId);
        const dailyNodeGoal = Math.max(0, parseInt(String((row as any).dailyNodeGoal ?? 0), 10) || 0);
        const dailyCardGoal = Math.max(0, parseInt(String((row as any).dailyCardGoal ?? 0), 10) || 0);
        const dailyProblemGoal = Math.max(0, parseInt(String((row as any).dailyProblemGoal ?? 0), 10) || 0);
        const soRaw = (row as any).sortOrder;
        const sortOrder = Number.isFinite(Number(soRaw)) ? Number(soRaw) : inputIndex * 1000;
        inputIndex++;
        acc.push({ baseDocId, dailyNodeGoal, dailyCardGoal, dailyProblemGoal, sortOrder });
        if (acc.length >= DEVELOP_POOL_MAX) break;
    }
    acc.sort((a, b) => a.sortOrder - b.sortOrder || a.baseDocId - b.baseDocId);
    return acc.map((e, i) => ({ ...e, sortOrder: i }));
}

export type DevelopPoolRowWithStats = DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
    baseTitle: string;
    editorUrl: string;
};

export function developPoolHasAnyGoal(pool: DevelopPoolEntryWire[]): boolean {
    return pool.some((e) => e.dailyNodeGoal > 0 || e.dailyCardGoal > 0 || e.dailyProblemGoal > 0);
}

export function computeDevelopRunQueueProgress(
    pool: DevelopPoolEntryWire[],
    baseDocId: number,
): { completed: number; total: number } | null {
    const total = pool.length;
    if (total <= 0) return null;
    const idx = pool.findIndex((e) => e.baseDocId === Number(baseDocId));
    return { completed: idx >= 0 ? idx : 0, total };
}

export function developRunTerminalTotals(
    prevProgress: unknown,
    fallbackTotal: number,
): { completed: number; total: number } | null {
    const p = prevProgress && typeof prevProgress === 'object' && !Array.isArray(prevProgress)
        ? (prevProgress as Record<string, unknown>)
        : {};
    const dr = p.developRun as { total?: unknown } | undefined;
    const t = Number(dr?.total);
    if (Number.isFinite(t) && t > 0) return { completed: t, total: t };
    if (fallbackTotal > 0) return { completed: fallbackTotal, total: fallbackTotal };
    return null;
}

export function developRowGoalsMet(row: DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
}): boolean {
    if (row.dailyNodeGoal > 0 && row.todayNodes < row.dailyNodeGoal) return false;
    if (row.dailyCardGoal > 0 && row.todayCards < row.dailyCardGoal) return false;
    if (row.dailyProblemGoal > 0 && row.todayProblems < row.dailyProblemGoal) return false;
    return true;
}

export function developRowHasDailyGoal(row: DevelopPoolEntryWire): boolean {
    return row.dailyNodeGoal > 0 || row.dailyCardGoal > 0 || row.dailyProblemGoal > 0;
}

export function developRowPendingTodayRun(row: DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
}): boolean {
    if (!developRowHasDailyGoal(row)) return true;
    return !developRowGoalsMet(row);
}

export async function loadDevelopRunQueuePool(
    domainId: string,
    uid: number,
    priv: number,
    mode?: 'base',
): Promise<DevelopPoolEntryWire[]> {
    const full = mode
        ? await loadUserDevelopPoolByMode(domainId, uid, priv, mode)
        : await loadUserDevelopPool(domainId, uid, priv);
    if (!full.length) return [];
    const stats = await getDevelopDailyMany(domainId, uid, developTodayUtcYmd(), full.map((e) => e.baseDocId));
    return full.filter((e) => {
        const st = stats.get(developBaseKey(e.baseDocId)) || { nodes: 0, cards: 0, problems: 0 };
        return developRowPendingTodayRun({ ...e, todayNodes: st.nodes, todayCards: st.cards, todayProblems: st.problems });
    });
}

export type DevelopEditorContextWire = {
    dateUtc: string;
    current: {
        baseDocId: number;
        baseTitle: string;
        editorUrl: string;
        dailyNodeGoal: number;
        dailyCardGoal: number;
        dailyProblemGoal: number;
        todayNodes: number;
        todayCards: number;
        todayProblems: number;
        goalsMet: boolean;
    };
    othersIncomplete: DevelopPoolRowWithStats[];
};

export async function loadUserDevelopPool(domainId: string, uid: number, priv: number): Promise<DevelopPoolEntryWire[]> {
    return loadUserDevelopPoolByMode(domainId, uid, priv, 'base');
}

export async function loadUserDevelopPoolByMode(
    domainId: string,
    uid: number,
    priv: number,
    mode: 'base',
): Promise<DevelopPoolEntryWire[]> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    const field = 'developPool';
    return normalizeDevelopPool((dudoc as any)?.[field]);
}

export async function loadUserDevelopPoolForActiveMode(
    domainId: string,
    uid: number,
    priv: number,
): Promise<{ mode: 'base'; pool: DevelopPoolEntryWire[] }> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv }) as Record<string, unknown> | null;
    const mode = 'base' as const;
    const field = 'developPool';
    return { mode, pool: normalizeDevelopPool(dudoc?.[field]) };
}

export async function buildDevelopEditorContextWire(params: {
    domainId: string;
    uid: number;
    pool: DevelopPoolEntryWire[];
    baseDocId: number;
    getBaseTitle: (docId: number) => Promise<string>;
    makeEditorUrl: (docId: number, _legacy?: unknown) => string;
}): Promise<DevelopEditorContextWire | null> {
    const { domainId, uid, pool, baseDocId, getBaseTitle, makeEditorUrl } = params;
    if (!pool.some((e) => e.baseDocId === Number(baseDocId))) return null;
    const stats = await getDevelopDailyMany(domainId, uid, developTodayUtcYmd(), pool.map((e) => e.baseDocId));
    const rows: DevelopPoolRowWithStats[] = [];
    for (const e of pool) {
        const st = stats.get(developBaseKey(e.baseDocId)) || { nodes: 0, cards: 0, problems: 0 };
        rows.push({
            ...e,
            baseTitle: await getBaseTitle(e.baseDocId),
            todayNodes: st.nodes,
            todayCards: st.cards,
            todayProblems: st.problems,
            editorUrl: makeEditorUrl(e.baseDocId),
        });
    }
    const current = rows.find((r) => r.baseDocId === Number(baseDocId));
    if (!current) return null;
    return {
        dateUtc: developTodayUtcYmd(),
        current: {
            baseDocId: current.baseDocId,
            baseTitle: current.baseTitle,
            editorUrl: current.editorUrl,
            dailyNodeGoal: current.dailyNodeGoal,
            dailyCardGoal: current.dailyCardGoal,
            dailyProblemGoal: current.dailyProblemGoal,
            todayNodes: current.todayNodes,
            todayCards: current.todayCards,
            todayProblems: current.todayProblems,
            goalsMet: developRowGoalsMet(current),
        },
        othersIncomplete: rows.filter((r) => r.baseDocId !== Number(baseDocId) && !developRowGoalsMet(r)),
    };
}

export async function resolveDevelopRunProgressForSession(
    domainId: string,
    uid: number,
    priv: number,
    baseDocId: number,
    prevProgress?: unknown,
): Promise<{ completed: number; total: number } | null> {
    const pending = await loadDevelopRunQueuePool(domainId, uid, priv);
    if (pending.length > 0) return computeDevelopRunQueueProgress(pending, baseDocId);
    const full = await loadUserDevelopPool(domainId, uid, priv);
    if (!full.some((e) => e.baseDocId === Number(baseDocId))) return null;
    return developRunTerminalTotals(prevProgress ?? {}, full.length);
}

export async function isEntireDevelopPoolGoalsMetToday(
    domainId: string,
    uid: number,
    priv: number,
): Promise<boolean> {
    const pool = await loadUserDevelopPool(domainId, uid, priv);
    if (!pool.length || !developPoolHasAnyGoal(pool)) return false;
    const stats = await getDevelopDailyMany(domainId, uid, developTodayUtcYmd(), pool.map((e) => e.baseDocId));
    return pool.filter(developRowHasDailyGoal).every((e) => {
        const st = stats.get(developBaseKey(e.baseDocId)) || { nodes: 0, cards: 0, problems: 0 };
        return developRowGoalsMet({ ...e, todayNodes: st.nodes, todayCards: st.cards, todayProblems: st.problems });
    });
}


export const DEVELOP_SESSION_REUSE_MS = 8 * 3600 * 1000;

export const developSessionNotSettledMongoFilter = {
    $or: [
        { 'progress.developSettledAt': { $exists: false } },
        { 'progress.developSettledAt': null },
    ],
};

export const developDailySessionKindMongo = {
    $or: [
        { developSessionKind: 'daily' as const },
        {
            $and: [
                { developSessionKind: { $exists: false } },
                { $or: [{ nodeId: { $exists: false } }, { nodeId: null }, { nodeId: '' }] },
            ],
        },
    ],
};

export async function clearDevelopDailySessionPointer(domainId: string, uid: number): Promise<void> {
    await DomainModel.setUserInDomain(domainId, uid, { developDailySessionId: null, developDailySessionDay: null });
}

export async function setDevelopDailySessionPointer(domainId: string, uid: number, sessionHex: string): Promise<void> {
    await DomainModel.setUserInDomain(domainId, uid, {
        developDailySessionId: sessionHex,
        developDailySessionDay: developTodayUtcYmd(),
    });
}

function poolKeySet(pool: DevelopPoolEntryWire[]): Set<number> {
    return new Set(pool.map((e) => e.baseDocId));
}

function developSessionInPool(doc: SessionDoc, poolKeys: Set<number>): boolean {
    const bid = Number(doc.baseDocId);
    return Number.isFinite(bid) && bid > 0 && poolKeys.has(bid);
}

function isDevelopSessionResumable(
    doc: SessionDoc | null | undefined,
    poolKeys: Set<number>,
    now = Date.now(),
): doc is SessionDoc {
    if (!doc || !isDevelopSessionRow(doc)) return false;
    if (isDevelopSessionPastDeadline(doc, now) || isDevelopSessionSettled(doc)) return false;
    if ((doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) return false;
    if (!developSessionInPool(doc, poolKeys) || isSessionStalePastUtcCalendarDay(doc, now)) return false;
    const last = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    return last >= now - DEVELOP_SESSION_REUSE_MS;
}

export async function resolveDevelopDailySessionDoc(domainId: string, uid: number, dudoc: any): Promise<SessionDoc | null> {
    const todayYmd = developTodayUtcYmd();
    const ptrId = typeof dudoc?.developDailySessionId === 'string' ? dudoc.developDailySessionId.trim() : '';
    const ptrDay = typeof dudoc?.developDailySessionDay === 'string' ? dudoc.developDailySessionDay.trim() : '';
    if (ptrDay && (!YMD_RE.test(ptrDay) || ptrDay !== todayYmd)) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    if (!ptrId || !ObjectId.isValid(ptrId) || ptrDay !== todayYmd) {
        if (ptrId) await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    const doc = await SessionModel.coll.findOne({ _id: new ObjectId(ptrId), domainId, uid }) as SessionDoc | null;
    if (!doc || (doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt || isDevelopSessionSettled(doc)
        || isSessionStalePastUtcCalendarDay(doc) || isDevelopSessionPastDeadline(doc)) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    return doc;
}

export async function findResumableDevelopSessionDoc(
    domainId: string,
    uid: number,
    dudoc: any,
    pendingPool: DevelopPoolEntryWire[],
): Promise<SessionDoc | null> {
    const poolKeys = poolKeySet(pendingPool);
    const ptrRaw = await resolveDevelopDailySessionDoc(domainId, uid, dudoc);
    const fromPointer = isDevelopSessionResumable(ptrRaw, poolKeys) ? ptrRaw : null;
    if (ptrRaw && !fromPointer) await clearDevelopDailySessionPointer(domainId, uid);
    if (fromPointer) return fromPointer;

    const cutoff = new Date(Date.now() - DEVELOP_SESSION_REUSE_MS);
    const candidates = await SessionModel.coll.find({
        domainId,
        uid,
        appRoute: 'develop',
        lastActivityAt: { $gte: cutoff },
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            developSessionNotSettledMongoFilter,
            developDailySessionKindMongo,
        ],
    }).sort({ lastActivityAt: -1 }).limit(20).toArray() as SessionDoc[];
    return candidates.find((doc) => isDevelopSessionResumable(doc, poolKeys)) || null;
}

export async function peekResumableDevelopDailySessionIdReadOnly(
    domainId: string,
    uid: number,
    priv: number,
): Promise<string | null> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    const developMode = 'base' as const;
    const pendingPool = await loadDevelopRunQueuePool(domainId, uid, priv, developMode);
    const poolKeys = poolKeySet(pendingPool);
    const todayYmd = developTodayUtcYmd();
    const ptrId = typeof dudoc?.developDailySessionId === 'string' ? dudoc.developDailySessionId.trim() : '';
    const ptrDay = typeof dudoc?.developDailySessionDay === 'string' ? dudoc.developDailySessionDay.trim() : '';
    if (ptrId && ObjectId.isValid(ptrId) && YMD_RE.test(ptrDay) && ptrDay === todayYmd) {
        const doc = await SessionModel.coll.findOne({ _id: new ObjectId(ptrId), domainId, uid }) as SessionDoc | null;
        if (doc && isDevelopSessionResumable(doc, poolKeys)) return doc._id.toString();
    }
    const cutoff = new Date(Date.now() - DEVELOP_SESSION_REUSE_MS);
    const candidates = await SessionModel.coll.find({
        domainId,
        uid,
        appRoute: 'develop',
        lastActivityAt: { $gte: cutoff },
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            developSessionNotSettledMongoFilter,
            developDailySessionKindMongo,
        ],
    }).sort({ lastActivityAt: -1 }).limit(20).toArray() as SessionDoc[];
    return candidates.find((doc) => isDevelopSessionResumable(doc, poolKeys))?._id.toString() || null;
}

export type DevelopResumeFields = {
    todayDevelopResumableSessionId: string | null;
    todayDevelopResumeUrl: string | null;
};

export async function buildTodayDevelopResumeFields(
    domainId: string,
    uid: number,
    priv: number,
    makeResumeUrl: (sessionHex: string) => string,
): Promise<DevelopResumeFields> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    const developMode = 'base' as const;
    const pendingPool = await loadDevelopRunQueuePool(domainId, uid, priv, developMode);
    const s = await findResumableDevelopSessionDoc(domainId, uid, dudoc, pendingPool);
    if (!s) return { todayDevelopResumableSessionId: null, todayDevelopResumeUrl: null };
    const sid = s._id.toString();
    await setDevelopDailySessionPointer(domainId, uid, sid);
    return { todayDevelopResumableSessionId: sid, todayDevelopResumeUrl: makeResumeUrl(sid) };
}

export async function hasDevelopSessionInProgressOrPaused(domainId: string, uid: number, now = Date.now()): Promise<boolean> {
    const docs = await SessionModel.coll.find({
        domainId,
        uid,
        appRoute: 'develop',
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            developSessionNotSettledMongoFilter,
            developDailySessionKindMongo,
        ],
    }).sort({ lastActivityAt: -1 }).limit(40).toArray() as SessionDoc[];
    return docs.some((doc) => {
        if (!isDevelopSessionRow(doc)) return false;
        const st = deriveSessionLearnStatus(doc, now);
        return st === 'in_progress' || st === 'paused';
    });
}

export async function clearDevelopSessionsAfterPoolChange(domainId: string, uid: number): Promise<void> {
    await clearDevelopDailySessionPointer(domainId, uid);
    const now = new Date();
    const filter = {
        domainId,
        uid,
        appRoute: 'develop' as const,
        $and: [
            { $or: [{ lessonAbandonedAt: { $exists: false } }, { lessonAbandonedAt: null }] },
            developSessionNotSettledMongoFilter,
            developDailySessionKindMongo,
        ],
    };
    const toAbandon = await SessionModel.coll.find(filter).project({ _id: 1 }).toArray();
    if (!toAbandon.length) return;
    await SessionModel.coll.updateMany({ _id: { $in: toAbandon.map((d) => d._id) } }, { $set: { lessonAbandonedAt: now, lastActivityAt: now } });
    for (const row of toAbandon) {
        const fresh = await SessionModel.coll.findOne({ _id: row._id, domainId, uid }) as SessionDoc | null;
        if (fresh) bus.broadcast('session/change', fresh);
    }
}


export type DevelopWallBaseRecordCountWire = {
    baseDocId: number;
    recordCount: number;
};

export type DevelopWallSessionWire = {
    sessionId: string;
    sessionHistoryUrl: string;
    timeUtc: string;
    statusLabel: string;
    progressText: string | null;
    baseBreakdown: DevelopWallBaseRecordCountWire[];
};

export type DevelopWallDayDetailWire = {
    domainId: string;
    domainName: string;
    nodes: number;
    cards: number;
    problems: number;
    checkedIn: boolean;
    sessions: DevelopWallSessionWire[];
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

function developSessionWallUrl(
    buildUrl: (routeName: string, kwargs?: Record<string, unknown>) => string,
    domainId: string,
    sessionHex: string,
    status: ReturnType<typeof deriveSessionLearnStatus>,
): string {
    const toHistory = status === 'finished' || status === 'timed_out' || status === 'abandoned';
    const route = toHistory ? 'develop_session_history' : 'develop_editor';
    const base = buildUrl(route, { domainId });
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}session=${encodeURIComponent(sessionHex)}`;
}

/**
 * Past-year develop activity in one domain: branch-daily counters, check-in days, session touches
 * for the heatmap; per-day detail lists develop sessions with per-base save counts.
 */
export async function buildDevelopDomainWallPayload(
    domainId: string,
    domainName: string,
    uid: number,
    developActivityDates: string[],
    sinceYmd: string,
    untilYmd: string,
    buildUrl: (routeName: string, kwargs?: Record<string, unknown>) => string,
    translate: (key: string) => string,
): Promise<{
    developWallContributions: Array<{ date: string; type: 'node' | 'card' | 'problem'; count: number }>;
    developWallContributionDetails: Record<string, DevelopWallDayDetailWire[]>;
}> {
    const dailyDocs = await coll.find({
        domainId,
        uid,
        date: { $gte: sinceYmd, $lte: untilYmd },
    }).toArray() as Array<{ date?: string; nodes?: unknown; cards?: unknown; problems?: unknown }>;

    const aggregate = new Map<string, { nodes: number; cards: number; problems: number }>();
    for (const d of dailyDocs) {
        const date = String(d.date || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const prev = aggregate.get(date) || { nodes: 0, cards: 0, problems: 0 };
        aggregate.set(date, {
            nodes: prev.nodes + (Number(d.nodes) || 0),
            cards: prev.cards + (Number(d.cards) || 0),
            problems: prev.problems + (Number(d.problems) || 0),
        });
    }

    const checkInSet = new Set(
        developActivityDates.filter((x) => typeof x === 'string' && inRange(x, sinceYmd, untilYmd)),
    );

    const yearStart = moment.utc(sinceYmd, 'YYYY-MM-DD').startOf('day').toDate();
    const sessions = await SessionModel.coll
        .find({
            domainId,
            uid,
            appRoute: 'develop',
            $or: [{ createdAt: { $gte: yearStart } }, { lastActivityAt: { $gte: yearStart } }],
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

    const developRecords = await RecordModel.coll
        .find({
            domainId,
            uid,
            recordKind: 'develop_save',
            $or: [{ createdAt: { $gte: yearStart } }, { lastActivityAt: { $gte: yearStart } }],
        })
        .toArray() as SessionRecordDoc[];

    /** day -> sessionHex -> baseDocId -> count */
    const recordAggByDaySessionBase = new Map<string, Map<string, Map<number, number>>>();
    const bump = (dayYmd: string, sessionHex: string, baseDocId: number) => {
        if (!inRange(dayYmd, sinceYmd, untilYmd) || !sessionHex) return;
        if (!recordAggByDaySessionBase.has(dayYmd)) recordAggByDaySessionBase.set(dayYmd, new Map());
        const byS = recordAggByDaySessionBase.get(dayYmd)!;
        if (!byS.has(sessionHex)) byS.set(sessionHex, new Map());
        const byB = byS.get(sessionHex)!;
        byB.set(baseDocId, (byB.get(baseDocId) || 0) + 1);
    };

    for (const rd of developRecords) {
        const sid = rd.sessionId ? rd.sessionId.toHexString() : '';
        if (!sid) continue;
        const bid = Number(rd.baseDocId) || 0;
        const days = new Set<string>();
        const la = ymdUtc(rd.lastActivityAt);
        const cr = ymdUtc(rd.createdAt);
        if (la && inRange(la, sinceYmd, untilYmd)) days.add(la);
        if (cr && inRange(cr, sinceYmd, untilYmd)) days.add(cr);
        for (const d of days) bump(d, sid, bid);
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
        ...recordAggByDaySessionBase.keys(),
    ]);

    const developWallContributionDetails: Record<string, DevelopWallDayDetailWire[]> = {};
    for (const date of allDates) {
        if (!inRange(date, sinceYmd, untilYmd)) continue;
        const agg = aggregate.get(date) || { nodes: 0, cards: 0, problems: 0 };
        const bySession = recordAggByDaySessionBase.get(date) || new Map<string, Map<number, number>>();
        const sessionHexes = [...new Set([
            ...bySession.keys(),
            ...(sessionsByDate.get(date) ? [...sessionsByDate.get(date)!.keys()] : []),
        ])];

        const rows: Array<{ hex: string; sess: SessionDoc | null; sortTs: number; baseBreakdown: DevelopWallBaseRecordCountWire[] }> = [];
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
            const baseMap = bySession.get(hex) || new Map<number, number>();
            const baseBreakdown: DevelopWallBaseRecordCountWire[] = [];
            for (const [baseDocId, recordCount] of baseMap) {
                baseBreakdown.push({ baseDocId, recordCount });
            }
            baseBreakdown.sort((a, b) => {
                if (b.recordCount !== a.recordCount) return b.recordCount - a.recordCount;
                return a.baseDocId - b.baseDocId;
            });
            const sortTs = sess?.lastActivityAt
                ? new Date(sess.lastActivityAt).getTime()
                : 0;
            rows.push({ hex, sess, sortTs, baseBreakdown });
        }
        rows.sort((a, b) => b.sortTs - a.sortTs);

        const sessionsWire: DevelopWallSessionWire[] = [];
        for (const { hex, sess, baseBreakdown } of rows) {
            if (!sess) continue;
            const st = deriveSessionLearnStatus(sess);
            sessionsWire.push({
                sessionId: hex,
                sessionHistoryUrl: developSessionWallUrl(buildUrl, domainId, hex, st),
                timeUtc: hmUtc(sess.lastActivityAt),
                statusLabel: translate(`session_status_${st}`),
                progressText: formatSessionProgressDisplay(sess),
                baseBreakdown,
            });
        }

        developWallContributionDetails[date] = [{
            domainId,
            domainName,
            nodes: agg.nodes,
            cards: agg.cards,
            problems: agg.problems,
            checkedIn: checkInSet.has(date),
            sessions: sessionsWire,
        }];
    }

    return { developWallContributions: contributions, developWallContributionDetails };
}


export async function markStaleDailyDevelopSessionsTimedOutUtc(): Promise<number> {
    const now = Date.now();
    const nowDate = new Date();
    const { deleteUserCache } = require('./user');
    let count = 0;
    const cursor = SessionModel.coll.find({
        appRoute: 'develop',
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            DevelopModel.developSessionNotSettledMongoFilter,
            DevelopModel.developDailySessionKindMongo,
            {
                $or: [
                    { 'progress.developDailyTimedOutAt': { $exists: false } },
                    { 'progress.developDailyTimedOutAt': null },
                ],
            },
        ],
    });
    for await (const raw of cursor) {
        const doc = raw as SessionDoc;
        const staleByDay = isSessionStalePastUtcCalendarDay(doc, now);
        const pastDeadline = isDevelopSessionPastDeadline(doc, now);
        if (!staleByDay && !pastDeadline) continue;

        const prevRaw = doc.progress;
        const prev =
            prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
                ? { ...(prevRaw as Record<string, unknown>) }
                : {};
        if (prev.developDailyTimedOutAt != null) continue;

        prev.developDailyTimedOutAt = nowDate;
        await SessionModel.coll.updateOne(
            { _id: doc._id },
            {
                $set: {
                    progress: prev as SessionDoc['progress'],
                    updatedAt: nowDate,
                    lastActivityAt: nowDate,
                },
            },
        );
        deleteUserCache(doc.domainId);
        const updated = await SessionModel.coll.findOne({ _id: doc._id });
        if (updated) {
            bus.broadcast('session/change', updated as SessionDoc);
            count += 1;
        }
    }
    return count;
}

export async function settleStaleDevelopSessionPointersUtc(): Promise<number> {
    const now = Date.now();
    const { deleteUserCache } = require('./user');
    let cleared = 0;
    const cursor = SessionModel.coll.find({
        appRoute: 'develop',
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            DevelopModel.developSessionNotSettledMongoFilter,
            DevelopModel.developDailySessionKindMongo,
        ],
    });
    for await (const raw of cursor) {
        const doc = raw as SessionDoc;
        if (!isSessionStalePastUtcCalendarDay(doc, now) && !isDevelopSessionPastDeadline(doc, now)) continue;
        const sidHex = doc._id.toHexString();
        const r = await DomainModel.collUser.updateMany(
            {
                domainId: doc.domainId,
                uid: doc.uid,
                developDailySessionId: sidHex,
            },
            {
                $set: {
                    developDailySessionId: null,
                    developDailySessionDay: null,
                },
            },
        );
        const n = Number((r as { modifiedCount?: number }).modifiedCount ?? 0);
        if (n > 0) {
            deleteUserCache(doc.domainId);
            cleared += n;
        }
    }
    return cleared;
}

class DevelopModel {
    static coll = coll;

    static incDevelopDaily = incDevelopDaily;
    static getDevelopDailyMany = getDevelopDailyMany;

    static loadDevelopRunQueuePool = loadDevelopRunQueuePool;
    static computeDevelopRunQueueProgress = computeDevelopRunQueueProgress;
    static developRunTerminalTotals = developRunTerminalTotals;
    static loadUserDevelopPool = loadUserDevelopPool;
    static loadUserDevelopPoolByMode = loadUserDevelopPoolByMode;
    static loadUserDevelopPoolForActiveMode = loadUserDevelopPoolForActiveMode;
    static buildDevelopEditorContextWire = buildDevelopEditorContextWire;
    static resolveDevelopRunProgressForSession = resolveDevelopRunProgressForSession;
    static isEntireDevelopPoolGoalsMetToday = isEntireDevelopPoolGoalsMetToday;

    static clearDevelopDailySessionPointer = clearDevelopDailySessionPointer;
    static setDevelopDailySessionPointer = setDevelopDailySessionPointer;
    static resolveDevelopDailySessionDoc = resolveDevelopDailySessionDoc;
    static findResumableDevelopSessionDoc = findResumableDevelopSessionDoc;
    static peekResumableDevelopDailySessionIdReadOnly = peekResumableDevelopDailySessionIdReadOnly;
    static buildTodayDevelopResumeFields = buildTodayDevelopResumeFields;
    static hasDevelopSessionInProgressOrPaused = hasDevelopSessionInProgressOrPaused;
    static clearDevelopSessionsAfterPoolChange = clearDevelopSessionsAfterPoolChange;

    static buildDevelopDomainWallPayload = buildDevelopDomainWallPayload;
    static markStaleDailyDevelopSessionsTimedOutUtc = markStaleDailyDevelopSessionsTimedOutUtc;
    static settleStaleDevelopSessionPointersUtc = settleStaleDevelopSessionPointersUtc;

    static DEVELOP_POOL_MAX = DEVELOP_POOL_MAX;
    static DEVELOP_SESSION_REUSE_MS = DEVELOP_SESSION_REUSE_MS;
    static developSessionNotSettledMongoFilter = developSessionNotSettledMongoFilter;
    static developDailySessionKindMongo = developDailySessionKindMongo;
}

export async function apply(ctx: Context) {
    ctx.on('domain/delete', (domainId) => coll.deleteMany({ domainId }));
    await db.ensureIndexes(
        coll,
        { key: { domainId: 1, uid: 1, date: 1, baseDocId: 1 }, name: 'domain_uid_date_base' },
    );
    (global.Ejunz.model as any).develop = DevelopModel;
}

export default DevelopModel;
