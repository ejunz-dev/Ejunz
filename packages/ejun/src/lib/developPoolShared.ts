import DomainModel from '../model/domain';
import { developBranchKey, developTodayUtcYmd, getDevelopBranchDailyMany } from './developBranchDaily';

export const DEVELOP_POOL_MAX = 24;

export type DevelopPoolEntryWire = {
    baseDocId: number;
    branch: string;
    dailyNodeGoal: number;
    dailyCardGoal: number;
    dailyProblemGoal: number;
};

export function normalizeDevelopPool(raw: unknown): DevelopPoolEntryWire[] {
    if (!Array.isArray(raw)) return [];
    const out: DevelopPoolEntryWire[] = [];
    const seen = new Set<string>();
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
        out.push({ baseDocId, branch, dailyNodeGoal, dailyCardGoal, dailyProblemGoal });
        if (out.length >= DEVELOP_POOL_MAX) break;
    }
    return out;
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
