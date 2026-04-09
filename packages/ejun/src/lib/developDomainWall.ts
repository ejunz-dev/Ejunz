import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import SessionModel, { type SessionDoc } from '../model/session';
import RecordModel, { type SessionRecordDoc } from '../model/record';
import { deriveSessionLearnStatus, formatSessionProgressDisplay } from './sessionListDisplay';

type Db = {
    collection: (n: string) => {
        find: (q: unknown) => { toArray: () => Promise<unknown[]> };
    };
};

export type DevelopWallBaseRecordCountWire = {
    baseDocId: number;
    branch: string;
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
    db: Db,
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
    const dailyDocs = await db.collection('develop_branch_daily').find({
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

    /** day -> sessionHex -> "baseDocId\0branch" -> count */
    const recordAggByDaySessionBase = new Map<string, Map<string, Map<string, number>>>();
    const bump = (dayYmd: string, sessionHex: string, baseDocId: number, branch: string) => {
        if (!inRange(dayYmd, sinceYmd, untilYmd) || !sessionHex) return;
        const bKey = `${baseDocId}\0${branch}`;
        if (!recordAggByDaySessionBase.has(dayYmd)) recordAggByDaySessionBase.set(dayYmd, new Map());
        const byS = recordAggByDaySessionBase.get(dayYmd)!;
        if (!byS.has(sessionHex)) byS.set(sessionHex, new Map());
        const byB = byS.get(sessionHex)!;
        byB.set(bKey, (byB.get(bKey) || 0) + 1);
    };

    for (const rd of developRecords) {
        const sid = rd.sessionId ? rd.sessionId.toHexString() : '';
        if (!sid) continue;
        const br = rd.branch && String(rd.branch).trim() ? String(rd.branch).trim() : 'main';
        const bid = Number(rd.baseDocId) || 0;
        const days = new Set<string>();
        const la = ymdUtc(rd.lastActivityAt);
        const cr = ymdUtc(rd.createdAt);
        if (la && inRange(la, sinceYmd, untilYmd)) days.add(la);
        if (cr && inRange(cr, sinceYmd, untilYmd)) days.add(cr);
        for (const d of days) bump(d, sid, bid, br);
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
        const bySession = recordAggByDaySessionBase.get(date) || new Map<string, Map<string, number>>();
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
            const baseMap = bySession.get(hex) || new Map<string, number>();
            const baseBreakdown: DevelopWallBaseRecordCountWire[] = [];
            for (const [bKey, recordCount] of baseMap) {
                const i = bKey.indexOf('\0');
                const bidStr = i >= 0 ? bKey.slice(0, i) : bKey;
                const branch = i >= 0 ? bKey.slice(i + 1) : 'main';
                baseBreakdown.push({
                    baseDocId: Number(bidStr) || 0,
                    branch,
                    recordCount,
                });
            }
            baseBreakdown.sort((a, b) => {
                if (b.recordCount !== a.recordCount) return b.recordCount - a.recordCount;
                if (a.baseDocId !== b.baseDocId) return a.baseDocId - b.baseDocId;
                return a.branch.localeCompare(b.branch);
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
