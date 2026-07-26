import DomainModel from '../model/domain';
import { developBaseKey, developTodayUtcYmd, getDevelopDailyMany } from './developBranchDaily';
import {
    developPoolFieldForMode,
    getDevelopMode,
    type DevelopSourceMode,
} from './developModePrefs';

export const DEVELOP_POOL_MAX = 24;

export type DevelopPoolEntryWire = {
    baseDocId: number;
    dailyNodeGoal: number;
    dailyCardGoal: number;
    dailyProblemGoal: number;
    /** Lower value = earlier in the develop-start queue and editor ordering. */
    sortOrder: number;
};

export function normalizeDevelopPool(raw: unknown): DevelopPoolEntryWire[] {
    if (!Array.isArray(raw)) return [];
    const acc: DevelopPoolEntryWire[] = [];
    const seen = new Set<number>();
    let inputIndex = 0;
    for (const row of raw) {
        if (!row || typeof row !== 'object') continue;
        const baseDocId = parseInt(String((row as any).baseDocId ?? ''), 10);
        if (!Number.isFinite(baseDocId) || baseDocId <= 0 || seen.has(baseDocId)) continue;
        seen.add(baseDocId);
        const dailyNodeGoal = Math.max(0, parseInt(String((row as any).dailyNodeGoal ?? 0), 10) || 0);
        const dailyCardGoal = Math.max(0, parseInt(String((row as any).dailyCardGoal ?? 0), 10) || 0);
        const dailyProblemGoal = Math.max(0, parseInt(String((row as any).dailyProblemGoal ?? 0), 10) || 0);
        const soRaw = (row as any).sortOrder;
        const sortOrder = Number.isFinite(Number(soRaw)) ? Number(soRaw) : inputIndex * 1000;
        inputIndex++;
        acc.push({ baseDocId, dailyNodeGoal, dailyCardGoal, dailyProblemGoal, sortOrder });
        if (acc.length >= DEVELOP_POOL_MAX) break;
    }
    acc.sort((a, b) => a.sortOrder - b.sortOrder || a.baseDocId - b.baseDocId);
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

export function computeDevelopRunQueueProgress(
    pool: DevelopPoolEntryWire[],
    baseDocId: number,
): { completed: number; total: number } | null {
    const total = pool.length;
    if (total <= 0) return null;
    const idx = pool.findIndex((e) => e.baseDocId === Number(baseDocId));
    return { completed: idx >= 0 ? idx : 0, total };
}

export function developRunTerminalTotals(
    prevProgress: unknown,
    fallbackTotal: number,
): { completed: number; total: number } | null {
    const p = prevProgress && typeof prevProgress === 'object' && !Array.isArray(prevProgress)
        ? (prevProgress as Record<string, unknown>)
        : {};
    const dr = p.developRun as { total?: unknown } | undefined;
    const t = Number(dr?.total);
    if (Number.isFinite(t) && t > 0) return { completed: t, total: t };
    if (fallbackTotal > 0) return { completed: fallbackTotal, total: fallbackTotal };
    return null;
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

export function developRowPendingTodayRun(row: DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
}): boolean {
    if (!developRowHasDailyGoal(row)) return true;
    return !developRowGoalsMet(row);
}

type DevelopDailyDb = Parameters<typeof getDevelopDailyMany>[0];

export async function loadDevelopRunQueuePool(
    db: DevelopDailyDb,
    domainId: string,
    uid: number,
    priv: number,
    mode?: DevelopSourceMode,
): Promise<DevelopPoolEntryWire[]> {
    const full = mode
        ? await loadUserDevelopPoolByMode(domainId, uid, priv, mode)
        : await loadUserDevelopPool(domainId, uid, priv);
    if (!full.length) return [];
    const stats = await getDevelopDailyMany(db, domainId, uid, developTodayUtcYmd(), full.map((e) => e.baseDocId));
    return full.filter((e) => {
        const st = stats.get(developBaseKey(e.baseDocId)) || { nodes: 0, cards: 0, problems: 0 };
        return developRowPendingTodayRun({ ...e, todayNodes: st.nodes, todayCards: st.cards, todayProblems: st.problems });
    });
}

export type DevelopEditorContextWire = {
    dateUtc: string;
    current: {
        baseDocId: number;
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

export async function loadUserDevelopPool(domainId: string, uid: number, priv: number): Promise<DevelopPoolEntryWire[]> {
    return loadUserDevelopPoolByMode(domainId, uid, priv, 'base');
}

export async function loadUserDevelopPoolByMode(
    domainId: string,
    uid: number,
    priv: number,
    mode: DevelopSourceMode,
): Promise<DevelopPoolEntryWire[]> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv });
    const field = developPoolFieldForMode(mode);
    return normalizeDevelopPool((dudoc as any)?.[field]);
}

export async function loadUserDevelopPoolForActiveMode(
    domainId: string,
    uid: number,
    priv: number,
): Promise<{ mode: DevelopSourceMode; pool: DevelopPoolEntryWire[] }> {
    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv }) as Record<string, unknown> | null;
    const mode = getDevelopMode(dudoc);
    const field = developPoolFieldForMode(mode);
    return { mode, pool: normalizeDevelopPool(dudoc?.[field]) };
}

export async function buildDevelopEditorContextWire(params: {
    db: { collection: (n: string) => any };
    domainId: string;
    uid: number;
    pool: DevelopPoolEntryWire[];
    baseDocId: number;
    getBaseTitle: (docId: number) => Promise<string>;
    makeEditorUrl: (docId: number, _legacy?: unknown) => string;
}): Promise<DevelopEditorContextWire | null> {
    const { db, domainId, uid, pool, baseDocId, getBaseTitle, makeEditorUrl } = params;
    if (!pool.some((e) => e.baseDocId === Number(baseDocId))) return null;
    const stats = await getDevelopDailyMany(db, domainId, uid, developTodayUtcYmd(), pool.map((e) => e.baseDocId));
    const rows: DevelopPoolRowWithStats[] = [];
    for (const e of pool) {
        const st = stats.get(developBaseKey(e.baseDocId)) || { nodes: 0, cards: 0, problems: 0 };
        rows.push({
            ...e,
            baseTitle: await getBaseTitle(e.baseDocId),
            todayNodes: st.nodes,
            todayCards: st.cards,
            todayProblems: st.problems,
            editorUrl: makeEditorUrl(e.baseDocId),
        });
    }
    const current = rows.find((r) => r.baseDocId === Number(baseDocId));
    if (!current) return null;
    return {
        dateUtc: developTodayUtcYmd(),
        current: {
            baseDocId: current.baseDocId,
            baseTitle: current.baseTitle,
            editorUrl: current.editorUrl,
            dailyNodeGoal: current.dailyNodeGoal,
            dailyCardGoal: current.dailyCardGoal,
            dailyProblemGoal: current.dailyProblemGoal,
            todayNodes: current.todayNodes,
            todayCards: current.todayCards,
            todayProblems: current.todayProblems,
            goalsMet: developRowGoalsMet(current),
        },
        othersIncomplete: rows.filter((r) => r.baseDocId !== Number(baseDocId) && !developRowGoalsMet(r)),
    };
}

export async function resolveDevelopRunProgressForSession(
    db: DevelopDailyDb,
    domainId: string,
    uid: number,
    priv: number,
    baseDocId: number,
    prevProgress?: unknown,
): Promise<{ completed: number; total: number } | null> {
    const pending = await loadDevelopRunQueuePool(db, domainId, uid, priv);
    if (pending.length > 0) return computeDevelopRunQueueProgress(pending, baseDocId);
    const full = await loadUserDevelopPool(domainId, uid, priv);
    if (!full.some((e) => e.baseDocId === Number(baseDocId))) return null;
    return developRunTerminalTotals(prevProgress ?? {}, full.length);
}

export async function isEntireDevelopPoolGoalsMetToday(
    db: DevelopDailyDb,
    domainId: string,
    uid: number,
    priv: number,
): Promise<boolean> {
    const pool = await loadUserDevelopPool(domainId, uid, priv);
    if (!pool.length || !developPoolHasAnyGoal(pool)) return false;
    const stats = await getDevelopDailyMany(db, domainId, uid, developTodayUtcYmd(), pool.map((e) => e.baseDocId));
    return pool.filter(developRowHasDailyGoal).every((e) => {
        const st = stats.get(developBaseKey(e.baseDocId)) || { nodes: 0, cards: 0, problems: 0 };
        return developRowGoalsMet({ ...e, todayNodes: st.nodes, todayCards: st.cards, todayProblems: st.problems });
    });
}
