import type { Db } from 'mongodb';

/** Whitelist display prefs from DB or client body. */
export function sanitizeRoadmapDetailUiPrefs(raw: unknown): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const o = raw as Record<string, unknown>;
    if (typeof o.showProblemCount === 'boolean') out.showProblemCount = o.showProblemCount;
    return out;
}

export async function loadRoadmapDetailUiPrefs(
    db: Db,
    domainId: string,
    roadmapDocId: number,
    branch: string,
    uid: unknown,
): Promise<Record<string, boolean>> {
    try {
        const coll = db.collection('roadmap.userDetailUi');
        const b = branch && String(branch).trim() ? String(branch).trim() : 'main';
        const doc = await coll.findOne({ domainId, roadmapDocId, branch: b, uid });
        return sanitizeRoadmapDetailUiPrefs(doc?.prefs);
    } catch {
        return {};
    }
}
