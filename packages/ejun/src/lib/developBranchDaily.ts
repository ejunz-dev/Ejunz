import moment from 'moment-timezone';

export function developTodayUtcYmd(): string {
    return moment.utc().format('YYYY-MM-DD');
}

export function developBaseKey(baseDocId: number): string {
    return String(Number(baseDocId));
}

export async function incDevelopDaily(
    db: { collection: (n: string) => { updateOne: (...a: any[]) => Promise<any> } },
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
    await db.collection('develop_branch_daily').updateOne(
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
    db: { collection: (n: string) => { find: (q: any) => { toArray: () => Promise<any[]> } } },
    domainId: string,
    uid: number,
    date: string,
    baseDocIds: number[],
): Promise<Map<string, { nodes: number; cards: number; problems: number }>> {
    const m = new Map<string, { nodes: number; cards: number; problems: number }>();
    const ids = [...new Set(baseDocIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
    if (!ids.length) return m;
    const docs = await db.collection('develop_branch_daily').find({
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
