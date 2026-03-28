import type { Db } from 'mongodb';

const EXPLORER_MODES = new Set(['tree', 'pending', 'branches', 'git']);
const NODE_SIDE_TABS = new Set(['intent', 'files']);

const EXPLORER_W_MIN = 180;
const EXPLORER_W_MAX = 640;
const PROBLEMS_W_MIN = 200;
const PROBLEMS_W_MAX = 800;
const AI_H_MIN = 120;
const AI_H_MAX = 640;

/** Whitelist + clamp prefs from DB or client body. */
export function sanitizeBaseEditorUiPrefs(raw: unknown): Record<string, string | number | boolean> {
    const out: Record<string, string | number | boolean> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const o = raw as Record<string, unknown>;

    if (typeof o.explorerMode === 'string' && EXPLORER_MODES.has(o.explorerMode)) {
        out.explorerMode = o.explorerMode;
    }
    if (typeof o.nodeSidePanelTab === 'string' && NODE_SIDE_TABS.has(o.nodeSidePanelTab)) {
        out.nodeSidePanelTab = o.nodeSidePanelTab;
    }
    if (typeof o.rightPanelOpen === 'boolean') out.rightPanelOpen = o.rightPanelOpen;
    if (typeof o.aiBottomOpen === 'boolean') out.aiBottomOpen = o.aiBottomOpen;

    if (typeof o.explorerPanelWidth === 'number' && Number.isFinite(o.explorerPanelWidth)) {
        out.explorerPanelWidth = Math.round(
            Math.max(EXPLORER_W_MIN, Math.min(EXPLORER_W_MAX, o.explorerPanelWidth)),
        );
    }
    if (typeof o.problemsPanelWidth === 'number' && Number.isFinite(o.problemsPanelWidth)) {
        out.problemsPanelWidth = Math.round(
            Math.max(PROBLEMS_W_MIN, Math.min(PROBLEMS_W_MAX, o.problemsPanelWidth)),
        );
    }
    if (typeof o.aiPanelHeight === 'number' && Number.isFinite(o.aiPanelHeight)) {
        out.aiPanelHeight = Math.round(Math.max(AI_H_MIN, Math.min(AI_H_MAX, o.aiPanelHeight)));
    }
    return out;
}

export async function loadBaseEditorUiPrefs(
    db: Db,
    domainId: string,
    baseDocId: number,
    branch: string,
    uid: unknown,
): Promise<Record<string, string | number | boolean>> {
    try {
        const coll = db.collection('base.userEditorUi');
        const b = branch && String(branch).trim() ? String(branch).trim() : 'main';
        const doc = await coll.findOne({ domainId, baseDocId, branch: b, uid });
        return sanitizeBaseEditorUiPrefs(doc?.prefs);
    } catch {
        return {};
    }
}
