import DomainModel from '../model/domain';
import type { SessionDoc } from '../model/session';
import SessionModel from '../model/session';
import bus from '../service/bus';
import { deleteUserCache } from '../model/user';
import { developSessionNotSettledMongoFilter } from './developSessionResume';
import { isSessionStalePastUtcCalendarDay } from './sessionUtcDaily';

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
 * Clear `domain.user` develop daily pointers that still reference a develop session whose UTC anchor day has passed.
 * Session documents are not mutated (status remains `timed_out` via {@link isSessionStalePastUtcCalendarDay} on read).
 */
export async function settleStaleDevelopSessionPointersUtc(): Promise<number> {
    const now = Date.now();
    let cleared = 0;
    const cursor = SessionModel.coll.find({
        appRoute: 'develop',
        $and: [
            { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
            developSessionNotSettledMongoFilter,
        ],
    });
    for await (const raw of cursor) {
        const doc = raw as SessionDoc;
        if (!isSessionStalePastUtcCalendarDay(doc, now)) continue;
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

/** UTC midnight housekeeping: learn queue cleanup + develop pointer cleanup (shared calendar-day rule). */
export async function settleStaleSessionsAtUtc0(): Promise<{ learn: number; develop: number }> {
    const learn = await settleStaleDailyLessonSessionsUtc();
    const develop = await settleStaleDevelopSessionPointersUtc();
    return { learn, develop };
}
