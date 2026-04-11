import { ObjectId } from 'mongodb';
import DomainModel from '../model/domain';
import SessionModel, { type SessionDoc } from '../model/session';
import bus from '../service/bus';
import { developBranchKey, developTodayUtcYmd } from './developBranchDaily';
import { loadDevelopRunQueuePool, type DevelopPoolEntryWire } from './developPoolShared';
import { deriveSessionLearnStatus, isDevelopSessionRow, isDevelopSessionSettled } from './sessionListDisplay';
import { isSessionStalePastUtcCalendarDay } from './sessionUtcDaily';

/** Same window as `DevelopSessionStartHandler` session reuse. */
export const DEVELOP_SESSION_REUSE_MS = 8 * 3600 * 1000;

/** Exclude sessions that have been settled for today’s develop run. */
export const developSessionNotSettledMongoFilter = {
    $or: [
        { 'progress.developSettledAt': { $exists: false } },
        { 'progress.developSettledAt': null },
    ],
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function clearDevelopDailySessionPointer(domainId: string, uid: number): Promise<void> {
    await DomainModel.setUserInDomain(domainId, uid, {
        developDailySessionId: null,
        developDailySessionDay: null,
    });
}

export async function setDevelopDailySessionPointer(domainId: string, uid: number, sessionHex: string): Promise<void> {
    await DomainModel.setUserInDomain(domainId, uid, {
        developDailySessionId: sessionHex,
        developDailySessionDay: developTodayUtcYmd(),
    });
}

function poolKeySet(pool: DevelopPoolEntryWire[]): Set<string> {
    return new Set(pool.map((e) => developBranchKey(e.baseDocId, e.branch)));
}

function developSessionInPool(doc: SessionDoc, poolKeys: Set<string>): boolean {
    const bid = Number(doc.baseDocId);
    if (!Number.isFinite(bid) || bid <= 0) return false;
    const br = doc.branch && String(doc.branch).trim() ? String(doc.branch).trim() : 'main';
    return poolKeys.has(developBranchKey(bid, br));
}

function isDevelopSessionResumable(
    doc: SessionDoc | null | undefined,
    poolKeys: Set<string>,
    now = Date.now(),
): doc is SessionDoc {
    if (!doc || !isDevelopSessionRow(doc)) return false;
    if (isDevelopSessionSettled(doc)) return false;
    if ((doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) return false;
    if (!developSessionInPool(doc, poolKeys)) return false;
    if (isSessionStalePastUtcCalendarDay(doc, now)) return false;
    const last = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    if (last < now - DEVELOP_SESSION_REUSE_MS) return false;
    return true;
}

/**
 * Pointer on `domain.user` for “today’s” develop editor session (UTC calendar day), mirroring learn daily.
 */
export async function resolveDevelopDailySessionDoc(domainId: string, uid: number, dudoc: any): Promise<SessionDoc | null> {
    const todayYmd = developTodayUtcYmd();
    const ptrId = typeof dudoc?.developDailySessionId === 'string' ? dudoc.developDailySessionId.trim() : '';
    const ptrDay = typeof dudoc?.developDailySessionDay === 'string' ? dudoc.developDailySessionDay.trim() : '';

    if (ptrDay && (!YMD_RE.test(ptrDay) || ptrDay !== todayYmd)) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    if (!ptrId || !ObjectId.isValid(ptrId)) {
        if (ptrId) await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    if (ptrDay !== todayYmd) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }

    const doc = await SessionModel.coll.findOne({ _id: new ObjectId(ptrId), domainId, uid }) as SessionDoc | null;
    if (!doc) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    if ((doc as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    if (isDevelopSessionSettled(doc)) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    if (isSessionStalePastUtcCalendarDay(doc, Date.now())) {
        await clearDevelopDailySessionPointer(domainId, uid);
        return null;
    }
    return doc;
}

/**
 * Most recent develop editor session that is still valid for reuse (time window), not abandoned.
 * `pendingPool` = bases still in today’s develop run (excludes rows that already met daily goals).
 */
export async function findResumableDevelopSessionDoc(
    domainId: string,
    uid: number,
    dudoc: any,
    pendingPool: DevelopPoolEntryWire[],
): Promise<SessionDoc | null> {
    const poolKeys = poolKeySet(pendingPool);

    const ptrRaw = await resolveDevelopDailySessionDoc(domainId, uid, dudoc);
    const fromPointer = isDevelopSessionResumable(ptrRaw, poolKeys) ? ptrRaw : null;
    if (ptrRaw && !fromPointer) {
        await clearDevelopDailySessionPointer(domainId, uid);
    }
    if (fromPointer) return fromPointer;

    const cutoff = new Date(Date.now() - DEVELOP_SESSION_REUSE_MS);
    const candidates = await SessionModel.coll
        .find({
            domainId,
            uid,
            appRoute: 'develop',
            lastActivityAt: { $gte: cutoff },
            $and: [
                { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
                developSessionNotSettledMongoFilter,
            ],
        })
        .sort({ lastActivityAt: -1 })
        .limit(20)
        .toArray() as SessionDoc[];

    for (const doc of candidates) {
        if (isDevelopSessionResumable(doc, poolKeys)) return doc;
    }
    return null;
}

export type DevelopResumeFields = {
    todayDevelopResumableSessionId: string | null;
    todayDevelopResumeUrl: string | null;
};

type DevelopBranchDailyDb = Parameters<typeof loadDevelopRunQueuePool>[0];

export async function buildTodayDevelopResumeFields(
    db: DevelopBranchDailyDb,
    domainId: string,
    uid: number,
    priv: number,
    makeResumeUrl: (sessionHex: string) => string,
): Promise<DevelopResumeFields> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    const pendingPool = await loadDevelopRunQueuePool(db, domainId, uid, priv);
    const s = await findResumableDevelopSessionDoc(domainId, uid, dudoc, pendingPool);
    if (!s) {
        return {
            todayDevelopResumableSessionId: null,
            todayDevelopResumeUrl: null,
        };
    }
    const sid = s._id.toString();
    await setDevelopDailySessionPointer(domainId, uid, sid);
    return {
        todayDevelopResumableSessionId: sid,
        todayDevelopResumeUrl: makeResumeUrl(sid),
    };
}

/**
 * Whether the user has any open develop session today (in progress or paused per
 * {@link deriveSessionLearnStatus}; excludes settled, abandoned, timed out).
 */
export async function hasDevelopSessionInProgressOrPaused(
    domainId: string,
    uid: number,
    now = Date.now(),
): Promise<boolean> {
    const docs = await SessionModel.coll
        .find({
            domainId,
            uid,
            appRoute: 'develop',
            $and: [
                { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
                developSessionNotSettledMongoFilter,
            ],
        })
        .sort({ lastActivityAt: -1 })
        .limit(40)
        .toArray() as SessionDoc[];

    for (const doc of docs) {
        if (!isDevelopSessionRow(doc)) continue;
        const st = deriveSessionLearnStatus(doc, now);
        if (st === 'in_progress' || st === 'paused') return true;
    }
    return false;
}

export async function clearDevelopSessionsAfterPoolChange(domainId: string, uid: number): Promise<void> {
    await clearDevelopDailySessionPointer(domainId, uid);
    const now = new Date();
    const abandonFilter = {
        domainId,
        uid,
        appRoute: 'develop' as const,
        $and: [
            { $or: [{ lessonAbandonedAt: { $exists: false } }, { lessonAbandonedAt: null }] },
            developSessionNotSettledMongoFilter,
        ],
    };
    const toAbandon = await SessionModel.coll.find(abandonFilter).project({ _id: 1 }).toArray();
    if (!toAbandon.length) return;
    await SessionModel.coll.updateMany(
        { _id: { $in: toAbandon.map((d) => d._id) } },
        { $set: { lessonAbandonedAt: now, lastActivityAt: now } },
    );
    for (const row of toAbandon) {
        const fresh = await SessionModel.coll.findOne({ _id: row._id, domainId, uid }) as SessionDoc | null;
        if (fresh) bus.broadcast('session/change', fresh);
    }
}
