import DomainModel from '../model/domain';
import type { SessionDoc } from '../model/session';
import SessionModel from '../model/session';
import bus from '../service/bus';
import { deleteUserCache } from '../model/user';
import { developDailySessionKindMongo, developSessionNotSettledMongoFilter } from './developSessionResume';
import { isDevelopSessionPastDeadline, isSessionStalePastUtcCalendarDay } from './sessionUtcDaily';

/**
 * Clear stale in-progress daily learn sessions after UTC day rollover (`task.session.utc0`).
 * Uses {@link isSessionStalePastUtcCalendarDay} (same rule as `deriveSessionLearnStatus`).
 * Also clears `domain.user.learnDailySessionId` / `learnDailySessionDay` when that row pointed at the settled session.
 */
export async function settleStaleDailyLessonSessionsUtc(): Promise<number> {
    const now = Date.now();
    let cleared = 0;
    const cursor = SessionModel.coll.find({
        lessonMode: 'today',
        'lessonCardQueue.0': { $exists: true },
    });
    const nowDate = new Date();
    for await (const raw of cursor) {
        const doc = raw as SessionDoc;
        const q = doc.lessonCardQueue ?? [];
        const idx = typeof doc.cardIndex === 'number' ? doc.cardIndex : 0;
        if (idx >= q.length) continue;
        if (!isSessionStalePastUtcCalendarDay(doc, now)) continue;
        const sidHex = doc._id.toHexString();
        await SessionModel.coll.updateOne(
            { _id: doc._id },
            {
                $set: {
                    lessonMode: null,
                    lessonCardQueue: [],
                    cardIndex: null,
                    lessonQueueDay: null,
                    updatedAt: nowDate,
                    lastActivityAt: nowDate,
                },
            },
        );
        await DomainModel.collUser.updateMany(
            {
                domainId: doc.domainId,
                uid: doc.uid,
                learnDailySessionId: sidHex,
            },
            {
                $set: {
                    learnDailySessionId: null,
                    learnDailySessionDay: null,
                },
            },
        );
        deleteUserCache(doc.domainId);
        const updated = await SessionModel.coll.findOne({ _id: doc._id });
        if (updated) {
            bus.broadcast('session/change', updated as SessionDoc);
            cleared += 1;
        }
    }
    return cleared;
}

/**
 * 每日开发会话：将已跨 UTC 日历日（或已超过 developSessionDeadlineAt）且未正常结束的行写入
 * `progress.developDailyTimedOutAt`，与 {@link deriveSessionLearnStatus} 的 `timed_out` 一致。
 */
export async function markStaleDailyDevelopSessionsTimedOutUtc(): Promise<number> {
    const now = Date.now();
    const nowDate = new Date();
    let count = 0;
    const cursor = SessionModel.coll.find({
        appRoute: 'develop',
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            developSessionNotSettledMongoFilter,
            developDailySessionKindMongo,
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

/**
 * Clear `domain.user` develop daily pointers that still reference a develop session whose UTC anchor day has passed
 * (or deadline passed), after {@link markStaleDailyDevelopSessionsTimedOutUtc} may have updated the row.
 */
export async function settleStaleDevelopSessionPointersUtc(): Promise<number> {
    const now = Date.now();
    let cleared = 0;
    const cursor = SessionModel.coll.find({
        appRoute: 'develop',
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            developSessionNotSettledMongoFilter,
            developDailySessionKindMongo,
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

/** UTC midnight housekeeping: learn queue cleanup + develop 超时落库 + develop 指针清理。 */
export async function settleStaleSessionsAtUtc0(): Promise<{
    learn: number;
    develop: number;
    developDailyTimedOut: number;
}> {
    const learn = await settleStaleDailyLessonSessionsUtc();
    const developDailyTimedOut = await markStaleDailyDevelopSessionsTimedOutUtc();
    const develop = await settleStaleDevelopSessionPointersUtc();
    return { learn, develop, developDailyTimedOut };
}
