import { ObjectId } from 'mongodb';
import DomainModel from '../model/domain';
import SessionModel, { type SessionDoc } from '../model/session';
import bus from '../service/bus';
import { developTodayUtcYmd } from './developBranchDaily';
import {
    loadDevelopRunQueuePool,
    loadUserDevelopPoolByMode,
    type DevelopPoolEntryWire,
} from './developPoolShared';
import { getDevelopMode } from './developModePrefs';
import {
    deriveSessionLearnStatus,
    isDevelopSessionRow,
    isDevelopSessionSettled,
} from './sessionListDisplay';
import { isDevelopSessionPastDeadline, isSessionStalePastUtcCalendarDay } from './sessionUtcDaily';

type DevelopDailyDb = Parameters<typeof loadDevelopRunQueuePool>[0];

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

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    db: DevelopDailyDb,
    domainId: string,
    uid: number,
    priv: number,
): Promise<string | null> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    const developMode = getDevelopMode(dudoc as Record<string, unknown> | null);
    const pendingPool = await loadDevelopRunQueuePool(db, domainId, uid, priv, developMode);
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
    db: DevelopDailyDb,
    domainId: string,
    uid: number,
    priv: number,
    makeResumeUrl: (sessionHex: string) => string,
): Promise<DevelopResumeFields> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    const developMode = getDevelopMode(dudoc as Record<string, unknown> | null);
    const pendingPool = await loadDevelopRunQueuePool(db, domainId, uid, priv, developMode);
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
