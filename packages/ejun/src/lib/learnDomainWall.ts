import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import learn from '../model/learn';
import RecordModel, { type RecordDoc } from '../model/record';
import SessionModel, { type SessionDoc } from '../model/session';
import { deriveSessionLearnStatus, formatSessionProgressDisplay } from './sessionListDisplay';

type Db = {
    collection: (n: string) => {
        find: (q: unknown) => { toArray: () => Promise<unknown[]> };
    };
};

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
    branch: string;
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
    db: Db,
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
    const consumptionDocs = await db.collection('learn_consumption_stats').find({
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
    const resultsRaw = await learn.getResults(domainId, uid, {
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
        .toArray() as RecordDoc[];

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
                branch: sess.branch && String(sess.branch).trim() ? String(sess.branch).trim() : 'main',
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
