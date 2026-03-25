import moment from 'moment-timezone';
import learn from '../model/learn';

const CHECKIN_ACTIVITY_DATES_MAX = 500;

export type CheckinActivityField = 'learnActivityDates' | 'collectActivityDates';

/** 与 flag 的 countConsecutiveFlagDays 一致：从今天起连续落在 activityDates 中的 UTC 自然日数 */
export function countConsecutiveCheckinDays(activityDates: string[]): number {
    if (!activityDates.length) return 0;
    const dateSet = new Set(activityDates);
    let n = 0;
    let d = moment.utc();
    for (;;) {
        const key = d.format('YYYY-MM-DD');
        if (!dateSet.has(key)) break;
        n++;
        d = d.clone().subtract(1, 'day');
    }
    return n;
}

/** 域用户文档中追加一条 UTC 打卡日（learn / collect 各自字段，与 flagActivityDates 独立） */
export async function appendUserCheckinDay(
    domainId: string,
    uid: number,
    priv: number,
    field: CheckinActivityField,
): Promise<void> {
    const today = moment.utc().format('YYYY-MM-DD');
    const dudoc = (await learn.getUserLearnState(domainId, { _id: uid, priv })) as Record<string, unknown> | null;
    const existing: string[] = Array.isArray(dudoc?.[field])
        ? (dudoc[field] as unknown[]).map((x) => String(x))
        : [];
    if (existing.includes(today)) return;
    const next = [...existing, today].sort();
    while (next.length > CHECKIN_ACTIVITY_DATES_MAX) next.shift();
    await learn.setUserLearnState(domainId, uid, { [field]: next });
}
