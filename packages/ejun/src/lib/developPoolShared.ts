import DomainModel from '../model/domain';
import { developBranchKey, developTodayUtcYmd, getDevelopBranchDailyMany } from './developBranchDaily';

/** Re-export for handlers that import pool helpers from this module (e.g. `session.ts`). */
export { developBranchKey };

export const DEVELOP_POOL_MAX = 24;

export type DevelopPoolEntryWire = {
    baseDocId: number;
    branch: string;
    dailyNodeGoal: number;
    dailyCardGoal: number;
    dailyProblemGoal: number;
    /** Lower value = earlier in the develop-start queue and editor ordering. */
    sortOrder: number;
};

export function normalizeDevelopPool(raw: unknown): DevelopPoolEntryWire[] {
    if (!Array.isArray(raw)) return [];
    type Acc = DevelopPoolEntryWire;
    const acc: Acc[] = [];
    const seen = new Set<string>();
    let inputIndex = 0;
    for (const row of raw) {
        if (!row || typeof row !== 'object') continue;
        const baseDocId = parseInt(String((row as any).baseDocId ?? ''), 10);
        if (!Number.isFinite(baseDocId) || baseDocId <= 0) continue;
        const branch = typeof (row as any).branch === 'string' && (row as any).branch.trim()
            ? (row as any).branch.trim()
            : 'main';
        const k = `${baseDocId}::${branch}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const dailyNodeGoal = Math.max(0, parseInt(String((row as any).dailyNodeGoal ?? 0), 10) || 0);
        const dailyCardGoal = Math.max(0, parseInt(String((row as any).dailyCardGoal ?? 0), 10) || 0);
        const dailyProblemGoal = Math.max(0, parseInt(String((row as any).dailyProblemGoal ?? 0), 10) || 0);
        const soRaw = (row as any).sortOrder;
        const sortOrder = Number.isFinite(Number(soRaw)) ? Number(soRaw) : inputIndex * 1000;
        inputIndex++;
        acc.push({
            baseDocId,
            branch,
            dailyNodeGoal,
            dailyCardGoal,
            dailyProblemGoal,
            sortOrder,
        });
        if (acc.length >= DEVELOP_POOL_MAX) break;
    }
    acc.sort((a, b) => a.sortOrder - b.sortOrder || a.baseDocId - b.baseDocId || a.branch.localeCompare(b.branch));
    return acc.map((e, i) => ({ ...e, sortOrder: i }));
}

export type DevelopPoolRowWithStats = DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
    baseTitle: string;
    editorUrl: string;
};

export function developPoolHasAnyGoal(pool: DevelopPoolEntryWire[]): boolean {
    return pool.some((e) => e.dailyNodeGoal > 0 || e.dailyCardGoal > 0 || e.dailyProblemGoal > 0);
}

/**
 * Session-list progress for the develop run queue: `completed` = zero-based index of this base in the pending
 * queue (how many pool entries come before it), `total` = pending queue length. Matches `session/develop/start`
 * writes; batch-save refresh should use this so list progress does not lag the client queue.
 */
export function computeDevelopRunQueueProgress(
    pool: DevelopPoolEntryWire[],
    baseDocId: number,
    branch: string,
): { completed: number; total: number } | null {
    const total = pool.length;
    if (total <= 0) return null;
    const key = developBranchKey(baseDocId, branch);
    const idx = pool.findIndex((e) => developBranchKey(e.baseDocId, e.branch) === key);
    const completed = idx >= 0 ? idx : 0;
    return { completed, total };
}

/**
 * When today’s pending develop queue is empty, the list should show T/T. Prefer the session’s existing
 * `developRun.total` (same denominator as in-progress 0/T) instead of full `developPool.length`, so rows
 * without goals or extra branches do not inflate T (e.g. 2/2 when the user only had one real task).
 */
export function developRunTerminalTotals(
    prevProgress: unknown,
    fallbackTotal: number,
): { completed: number; total: number } | null {
    const p = prevProgress && typeof prevProgress === 'object' && !Array.isArray(prevProgress)
        ? (prevProgress as Record<string, unknown>)
        : {};
    const dr = p.developRun as { total?: unknown } | undefined;
    const t = Number(dr?.total);
    if (Number.isFinite(t) && t > 0) {
        return { completed: t, total: t };
    }
    if (fallbackTotal > 0) {
        return { completed: fallbackTotal, total: fallbackTotal };
    }
    return null;
}

/**
 * Resolves `developRun` for the session list progress column from today’s pending develop queue; if the
 * pending queue is empty and the session’s base/branch is still in the user pool, all pool rows with daily
 * goals are met — show T/T via `developRunTerminalTotals`.
 */
export async function resolveDevelopRunProgressForSession(
    db: DevelopBranchDailyDb,
    domainId: string,
    uid: number,
    priv: number,
    baseDocId: number,
    branch: string,
    prevProgress?: unknown,
): Promise<{ completed: number; total: number } | null> {
    const pending = await loadDevelopRunQueuePool(db, domainId, uid, priv);
    if (pending.length > 0) {
        return computeDevelopRunQueueProgress(pending, baseDocId, branch);
    }
    const full = await loadUserDevelopPool(domainId, uid, priv);
    if (!full.length) return null;
    const key = developBranchKey(baseDocId, branch);
    if (!full.some((e) => developBranchKey(e.baseDocId, e.branch) === key)) {
        return null;
    }
    return developRunTerminalTotals(prevProgress ?? {}, full.length);
}

export function developRowGoalsMet(row: DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
}): boolean {
    if (row.dailyNodeGoal > 0 && row.todayNodes < row.dailyNodeGoal) return false;
    if (row.dailyCardGoal > 0 && row.todayCards < row.dailyCardGoal) return false;
    if (row.dailyProblemGoal > 0 && row.todayProblems < row.dailyProblemGoal) return false;
    return true;
}

export function developRowHasDailyGoal(row: DevelopPoolEntryWire): boolean {
    return row.dailyNodeGoal > 0 || row.dailyCardGoal > 0 || row.dailyProblemGoal > 0;
}

/** Row still belongs in the develop-start queue: no daily caps, or caps not yet met today. */
export function developRowPendingTodayRun(row: DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
}): boolean {
    if (!developRowHasDailyGoal(row)) return true;
    return !developRowGoalsMet(row);
}

type DevelopBranchDailyDb = Parameters<typeof getDevelopBranchDailyMany>[0];

/**
 * Subset of the develop pool that still has work today (excludes bases that already met daily goals); order
 * matches the full pool.
 */
export async function loadDevelopRunQueuePool(
    db: DevelopBranchDailyDb,
    domainId: string,
    uid: number,
    priv: number,
): Promise<DevelopPoolEntryWire[]> {
    const full = await loadUserDevelopPool(domainId, uid, priv);
    if (!full.length) return [];
    const date = developTodayUtcYmd();
    const stats = await getDevelopBranchDailyMany(db, domainId, uid, date, full);
    return full.filter((e) => {
        const st = stats.get(developBranchKey(e.baseDocId, e.branch)) || { nodes: 0, cards: 0, problems: 0 };
        return developRowPendingTodayRun({
            ...e,
            todayNodes: st.nodes,
            todayCards: st.cards,
            todayProblems: st.problems,
        });
    });
}

export type DevelopEditorContextWire = {
    dateUtc: string;
    current: {
        baseDocId: number;
        branch: string;
        baseTitle: string;
        editorUrl: string;
        dailyNodeGoal: number;
        dailyCardGoal: number;
        dailyProblemGoal: number;
        todayNodes: number;
        todayCards: number;
        todayProblems: number;
        goalsMet: boolean;
    };
    othersIncomplete: DevelopPoolRowWithStats[];
};

export async function loadUserDevelopPool(
    domainId: string,
    uid: number,
    priv: number,
): Promise<DevelopPoolEntryWire[]> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    return normalizeDevelopPool((dudoc as any)?.developPool);
}

/**
 * When the open base/branch is in the user's develop pool, returns goals + today's develop-branch stats
 * and siblings that still miss goals (for editor UI).
 */
export async function buildDevelopEditorContextWire(params: {
    db: { collection: (n: string) => any };
    domainId: string;
    uid: number;
    pool: DevelopPoolEntryWire[];
    baseDocId: number;
    branch: string;
    getBaseTitle: (docId: number) => Promise<string>;
    makeEditorUrl: (docId: number, branch: string) => string;
}): Promise<DevelopEditorContextWire | null> {
    const {
        db, domainId, uid, pool, baseDocId, branch, getBaseTitle, makeEditorUrl,
    } = params;
    const poolKey = developBranchKey(baseDocId, branch);
    if (!pool.some((e) => developBranchKey(e.baseDocId, e.branch) === poolKey)) {
        return null;
    }
    const date = developTodayUtcYmd();
    const stats = await getDevelopBranchDailyMany(db, domainId, uid, date, pool);
    const rows: DevelopPoolRowWithStats[] = [];
    for (const e of pool) {
        const st = stats.get(developBranchKey(e.baseDocId, e.branch)) || { nodes: 0, cards: 0, problems: 0 };
        const baseTitle = await getBaseTitle(e.baseDocId);
        rows.push({
            ...e,
            baseTitle,
            todayNodes: st.nodes,
            todayCards: st.cards,
            todayProblems: st.problems,
            editorUrl: makeEditorUrl(e.baseDocId, e.branch),
        });
    }
    const current = rows.find((r) => developBranchKey(r.baseDocId, r.branch) === poolKey);
    if (!current) return null;
    const goalsMet = developRowGoalsMet(current);
    const othersIncomplete = rows.filter(
        (r) => developBranchKey(r.baseDocId, r.branch) !== poolKey && !developRowGoalsMet(r),
    );
    return {
        dateUtc: date,
        current: {
            baseDocId: current.baseDocId,
            branch: current.branch,
            baseTitle: current.baseTitle,
            editorUrl: current.editorUrl,
            dailyNodeGoal: current.dailyNodeGoal,
            dailyCardGoal: current.dailyCardGoal,
            dailyProblemGoal: current.dailyProblemGoal,
            todayNodes: current.todayNodes,
            todayCards: current.todayCards,
            todayProblems: current.todayProblems,
            goalsMet,
        },
        othersIncomplete,
    };
}

/**
 * True when every pool row that has a daily goal has met it today (UTC calendar day).
 * Used to authorize develop session settlement.
 */
export async function isEntireDevelopPoolGoalsMetToday(
    db: DevelopBranchDailyDb,
    domainId: string,
    uid: number,
    priv: number,
): Promise<boolean> {
    const pool = await loadUserDevelopPool(domainId, uid, priv);
    if (!pool.length || !developPoolHasAnyGoal(pool)) return false;
    const date = developTodayUtcYmd();
    const stats = await getDevelopBranchDailyMany(db, domainId, uid, date, pool);
    for (const e of pool) {
        if (!developRowHasDailyGoal(e)) continue;
        const st = stats.get(developBranchKey(e.baseDocId, e.branch)) || { nodes: 0, cards: 0, problems: 0 };
        if (!developRowGoalsMet({
            ...e,
            todayNodes: st.nodes,
            todayCards: st.cards,
            todayProblems: st.problems,
        })) {
            return false;
        }
    }
    return true;
}
