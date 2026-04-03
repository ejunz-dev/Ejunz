import type { SessionDoc } from '../model/session';
import SessionModel from '../model/session';
import bus from '../service/bus';
import { dailyRunAnchorYmd, sessionUtcYmd } from './sessionListDisplay';

/** Clear stale in-progress daily learn sessions after UTC day rollover (same UTC day as homepage stats). */
export async function settleStaleDailyLessonSessionsUtc(): Promise<number> {
    const today = sessionUtcYmd();
    let cleared = 0;
    const cursor = SessionModel.coll.find({
        lessonMode: 'today',
        'lessonCardQueue.0': { $exists: true },
    });
    const now = new Date();
    for await (const raw of cursor) {
        const doc = raw as SessionDoc;
        const q = doc.lessonCardQueue ?? [];
        const idx = typeof doc.cardIndex === 'number' ? doc.cardIndex : 0;
        if (idx >= q.length) continue;
        const anchor = dailyRunAnchorYmd(doc);
        if (!anchor || anchor >= today) continue;
        await SessionModel.coll.updateOne(
            { _id: doc._id },
            {
                $set: {
                    lessonMode: null,
                    lessonCardQueue: [],
                    cardIndex: null,
                    lessonQueueDay: null,
                    updatedAt: now,
                    lastActivityAt: now,
                },
            },
        );
        const updated = await SessionModel.coll.findOne({ _id: doc._id });
        if (updated) {
            bus.broadcast('session/change', updated as SessionDoc);
            cleared += 1;
        }
    }
    return cleared;
}
