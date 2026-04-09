import moment from 'moment-timezone';
import SessionModel, { type SessionDoc } from '../model/session';
import RecordModel, { type RecordDoc } from '../model/record';
import { developSaveRecordSummaryLines } from './developRecordSummarize';

type Db = {
    collection: (n: string) => {
        find: (q: unknown) => { toArray: () => Promise<unknown[]> };
    };
};

export type DevelopWallRecordWire = {
    recordId: string;
    baseDocId: number;
    branch: string;
    recordUrl: string;
    /** UTC time of save, e.g. 14:05 */
    timeUtc: string;
    summaryLines: string[];
};

export type DevelopWallDayDetailWire = {
    domainId: string;
    domainName: string;
    nodes: number;
    cards: number;
    problems: number;
    checkedIn: boolean;
    records: DevelopWallRecordWire[];
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

/**
 * Past-year develop activity in one domain: branch-daily counters, check-in days, session touches
 * for the heatmap; per-day detail lists develop_save records with change summaries.
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
            createdAt: { $gte: yearStart },
        })
        .sort({ createdAt: -1 })
        .toArray() as RecordDoc[];

    const recordsByDate = new Map<string, RecordDoc[]>();
    for (const rd of developRecords) {
        const dateStr = ymdUtc(rd.createdAt);
        if (!dateStr || !inRange(dateStr, sinceYmd, untilYmd)) continue;
        if (!recordsByDate.has(dateStr)) recordsByDate.set(dateStr, []);
        recordsByDate.get(dateStr)!.push(rd);
    }
    for (const [, list] of recordsByDate) {
        list.sort((a, b) => {
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            return tb - ta;
        });
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
        ...recordsByDate.keys(),
    ]);

    const developWallContributionDetails: Record<string, DevelopWallDayDetailWire[]> = {};
    for (const date of allDates) {
        if (!inRange(date, sinceYmd, untilYmd)) continue;
        const agg = aggregate.get(date) || { nodes: 0, cards: 0, problems: 0 };
        const dayRecords = recordsByDate.get(date) || [];
        const recordsWire: DevelopWallRecordWire[] = dayRecords.map((rd) => ({
            recordId: rd._id.toHexString(),
            baseDocId: Number(rd.baseDocId) || 0,
            branch: rd.branch && String(rd.branch).trim() ? String(rd.branch).trim() : 'main',
            recordUrl: buildUrl('record_detail', { domainId, rid: rd._id.toHexString() }),
            timeUtc: hmUtc(rd.createdAt),
            summaryLines: developSaveRecordSummaryLines(rd, translate),
        }));
        developWallContributionDetails[date] = [{
            domainId,
            domainName,
            nodes: agg.nodes,
            cards: agg.cards,
            problems: agg.problems,
            checkedIn: checkInSet.has(date),
            records: recordsWire,
        }];
    }

    return { developWallContributions: contributions, developWallContributionDetails };
}
