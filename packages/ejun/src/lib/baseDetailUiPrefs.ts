import type { Db } from 'mongodb';

/** Whitelist detail display prefs from DB or client body. */
export function sanitizeBaseDetailUiPrefs(raw: unknown): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const o = raw as Record<string, unknown>;
    if (typeof o.showProblemCount === 'boolean') out.showProblemCount = o.showProblemCount;
    if (typeof o.showNodeNumber === 'boolean') out.showNodeNumber = o.showNodeNumber;
    if (typeof o.showNodeCardTimestamps === 'boolean') out.showNodeCardTimestamps = o.showNodeCardTimestamps;
    return out;
}

export async function loadBaseDetailUiPrefs(
    db: Db,
    domainId: string,
    baseDocId: number,
    branch: string,
    uid: unknown,
): Promise<Record<string, boolean>> {
    try {
        const coll = db.collection('base.userDetailUi');
        const b = branch && String(branch).trim() ? String(branch).trim() : 'main';
        const doc = await coll.findOne({ domainId, baseDocId, branch: b, uid });
        return sanitizeBaseDetailUiPrefs(doc?.prefs);
    } catch {
        return {};
    }
}

export async function saveBaseDetailUiPrefs(
    db: Db,
    domainId: string,
    baseDocId: number,
    branch: string,
    uid: unknown,
    displayPrefs: unknown,
): Promise<void> {
    const branchNorm = branch && String(branch).trim() ? String(branch).trim() : 'main';
    const sanitized = sanitizeBaseDetailUiPrefs(displayPrefs);
    const coll = db.collection('base.userDetailUi');
    await coll.updateOne(
        { domainId, baseDocId, branch: branchNorm, uid },
        {
            $set: {
                domainId,
                baseDocId,
                branch: branchNorm,
                uid,
                prefs: sanitized,
                updateAt: new Date(),
            },
        },
        { upsert: true },
    );
}
