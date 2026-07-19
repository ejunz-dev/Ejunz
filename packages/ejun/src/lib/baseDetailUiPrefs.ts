import type { Db } from 'mongodb';

/** Whitelist detail display prefs from DB or client body. */
export function sanitizeBaseDetailUiPrefs(raw: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const o = raw as Record<string, unknown>;
    if (typeof o.showProblemCount === 'boolean') out.showProblemCount = o.showProblemCount;
    if (typeof o.showNodeNumber === 'boolean') out.showNodeNumber = o.showNodeNumber;
    if (typeof o.showNodeCardTimestamps === 'boolean') out.showNodeCardTimestamps = o.showNodeCardTimestamps;
    if (typeof o.showProblemTree === 'boolean') out.showProblemTree = o.showProblemTree;
    if (typeof o.showProblemTags === 'boolean') out.showProblemTags = o.showProblemTags;
    if (typeof o.showCardTags === 'boolean') out.showCardTags = o.showCardTags;
    if (typeof o.showAiTutor === 'boolean') out.showAiTutor = o.showAiTutor;
    if (typeof o.showExpandSaveIndicator === 'boolean') out.showExpandSaveIndicator = o.showExpandSaveIndicator;
    if (typeof o.showToolbar === 'boolean') out.showToolbar = o.showToolbar;
    if (typeof o.indicatorX === 'number' && Number.isFinite(o.indicatorX)) out.indicatorX = o.indicatorX;
    if (typeof o.indicatorY === 'number' && Number.isFinite(o.indicatorY)) out.indicatorY = o.indicatorY;
    if (typeof o.toolbarOpen === 'boolean') out.toolbarOpen = o.toolbarOpen;
    if (typeof o.toolbarX === 'number' && Number.isFinite(o.toolbarX)) out.toolbarX = o.toolbarX;
    if (typeof o.toolbarY === 'number' && Number.isFinite(o.toolbarY)) out.toolbarY = o.toolbarY;
    if (typeof o.cardDrawerWidth === 'number' && Number.isFinite(o.cardDrawerWidth)) out.cardDrawerWidth = o.cardDrawerWidth;
    if (typeof o.treeDrawerWidth === 'number' && Number.isFinite(o.treeDrawerWidth)) out.treeDrawerWidth = o.treeDrawerWidth;
    if (typeof o.wsIndicatorX === 'number' && Number.isFinite(o.wsIndicatorX)) out.wsIndicatorX = o.wsIndicatorX;
    if (typeof o.wsIndicatorY === 'number' && Number.isFinite(o.wsIndicatorY)) out.wsIndicatorY = o.wsIndicatorY;
    if (typeof o.wsIndicatorOpen === 'boolean') out.wsIndicatorOpen = o.wsIndicatorOpen;
    return out;
}

export async function loadBaseDetailUiPrefs(
    db: Db,
    domainId: string,
    baseDocId: number,
    branch: string,
    uid: unknown,
): Promise<Record<string, unknown>> {
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
