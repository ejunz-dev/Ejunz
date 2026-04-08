import moment from 'moment-timezone';

export function developTodayUtcYmd(): string {
    return moment.utc().format('YYYY-MM-DD');
}

export function developBranchKey(baseDocId: number, branch: string): string {
    const br = typeof branch === 'string' && branch.trim() ? branch.trim() : 'main';
    return `${Number(baseDocId)}::${br}`;
}

export async function incDevelopBranchDaily(
    db: { collection: (n: string) => { updateOne: (...a: any[]) => Promise<any> } },
    domainId: string,
    uid: number,
    branch: string,
    baseDocId: number,
    inc: { nodes: number; cards: number; problems: number },
): Promise<void> {
    const n = inc.nodes || 0;
    const c = inc.cards || 0;
    const p = inc.problems || 0;
    if (!n && !c && !p) return;
    const date = developTodayUtcYmd();
    const br = typeof branch === 'string' && branch.trim() ? branch.trim() : 'main';
    const bid = Number(baseDocId);
    await db.collection('develop_branch_daily').updateOne(
        { domainId, uid, date, baseDocId: bid, branch: br },
        {
            $inc: { nodes: n, cards: c, problems: p },
            $set: { updateAt: new Date() },
            $setOnInsert: {
                domainId,
                uid,
                date,
                baseDocId: bid,
                branch: br,
                createAt: new Date(),
            },
        },
        { upsert: true },
    );
}

export async function getDevelopBranchDailyMany(
    db: { collection: (n: string) => { find: (q: any) => { toArray: () => Promise<any[]> } } },
    domainId: string,
    uid: number,
    date: string,
    keys: Array<{ baseDocId: number; branch: string }>,
): Promise<Map<string, { nodes: number; cards: number; problems: number }>> {
    const m = new Map<string, { nodes: number; cards: number; problems: number }>();
    if (!keys.length) return m;
    const norm = keys.map((k) => ({
        baseDocId: Number(k.baseDocId),
        branch: typeof k.branch === 'string' && k.branch.trim() ? k.branch.trim() : 'main',
    }));
    const docs = await db.collection('develop_branch_daily').find({
        domainId,
        uid,
        date,
        $or: norm.map((k) => ({ baseDocId: k.baseDocId, branch: k.branch })),
    }).toArray();
    for (const d of docs) {
        const key = developBranchKey(Number(d.baseDocId), String(d.branch ?? 'main'));
        m.set(key, {
            nodes: Number(d.nodes) || 0,
            cards: Number(d.cards) || 0,
            problems: Number(d.problems) || 0,
        });
    }
    return m;
}
