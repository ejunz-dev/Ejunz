import type { Context } from '../context';
import { Handler } from '../service/server';
import { PRIV } from '../model/builtin';
import { MethodNotAllowedError } from '@ejunz/framework';
import DomainModel from '../model/domain';
import { BaseModel } from '../model/base';
import { ValidationError } from '../error';
import type { BaseDoc } from '../interface';
import { developBranchKey, developTodayUtcYmd, getDevelopBranchDailyMany } from '../lib/developBranchDaily';
import { appendUserCheckinDay, countConsecutiveCheckinDays } from '../lib/checkin';

const MAX_POOL = 24;

export type DevelopPoolEntryWire = {
    baseDocId: number;
    branch: string;
    dailyNodeGoal: number;
    dailyCardGoal: number;
    dailyProblemGoal: number;
};

function branchesForDevelopBase(base: BaseDoc): string[] {
    const s = new Set<string>(['main']);
    const raw = (base as any).branches;
    if (Array.isArray(raw)) {
        for (const x of raw) {
            if (typeof x === 'string' && x.trim()) s.add(x.trim());
        }
    }
    if (base.branchData) {
        for (const k of Object.keys(base.branchData)) {
            if (k) s.add(k);
        }
    }
    return [...s];
}

function normalizePool(raw: unknown): DevelopPoolEntryWire[] {
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
        if (out.length >= MAX_POOL) break;
    }
    return out;
}

function developPoolHasAnyGoal(pool: DevelopPoolEntryWire[]): boolean {
    return pool.some((e) => e.dailyNodeGoal > 0 || e.dailyCardGoal > 0 || e.dailyProblemGoal > 0);
}

type DevelopRowWithStats = DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
};

function developRowGoalsMet(row: DevelopRowWithStats): boolean {
    if (row.dailyNodeGoal > 0 && row.todayNodes < row.dailyNodeGoal) return false;
    if (row.dailyCardGoal > 0 && row.todayCards < row.dailyCardGoal) return false;
    if (row.dailyProblemGoal > 0 && row.todayProblems < row.dailyProblemGoal) return false;
    return true;
}

function allDevelopGoalsMet(rows: DevelopRowWithStats[]): boolean {
    if (!rows.length) return false;
    if (!developPoolHasAnyGoal(rows)) return false;
    return rows.every(developRowGoalsMet);
}

class DevelopHandler extends Handler {
    async after(domainId: string) {
        if (this.request.json || !this.response.template) return;
        this.response.body.overrideNav = [
            {
                name: 'homepage',
                args: {},
                displayName: this.translate('Home'),
                checker: () => true,
            },
            {
                name: 'learn',
                args: {},
                displayName: this.translate('Learn'),
                checker: () => true,
            },
        ];
    }

    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (String(this.request.path || '').includes('/develop/pool')) {
            this.response.redirect = this.url('develop', { domainId: finalDomainId });
            return;
        }

        const dudoc = await DomainModel.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const developPool = normalizePool((dudoc as any)?.developPool);

        const bases = await BaseModel.getAll(finalDomainId);
        bases.sort((a, b) => {
            const ta = a.updateAt instanceof Date ? a.updateAt.getTime() : 0;
            const tb = b.updateAt instanceof Date ? b.updateAt.getTime() : 0;
            return tb - ta;
        });
        const baseById = new Map(bases.map((b) => [Number(b.docId), b]));
        const learnBases = bases.map((b) => ({
            docId: Number(b.docId),
            title: ((b.title || '').trim() || String(b.docId)),
            branches: branchesForDevelopBase(b),
        }));

        const date = developTodayUtcYmd();
        const stats = await getDevelopBranchDailyMany(
            this.ctx.db.db,
            finalDomainId,
            this.user._id,
            date,
            developPool,
        );

        const rows = developPool.map((e) => {
            const b = baseById.get(e.baseDocId);
            const title = b ? ((b.title || '').trim() || String(e.baseDocId)) : `Base ${e.baseDocId}`;
            const st = stats.get(developBranchKey(e.baseDocId, e.branch)) || { nodes: 0, cards: 0, problems: 0 };
            return {
                ...e,
                baseTitle: title,
                todayNodes: st.nodes,
                todayCards: st.cards,
                todayProblems: st.problems,
                editorUrl: this.url('base_editor_branch', { domainId: finalDomainId, docId: e.baseDocId, branch: e.branch }),
            };
        });

        const rawAct = (dudoc as any)?.developActivityDates;
        const developActivityDates: string[] = Array.isArray(rawAct)
            ? rawAct.map((x: unknown) => String(x))
            : [];
        const developTotalCheckinDays = developActivityDates.length;
        const developConsecutiveDays = countConsecutiveCheckinDays(developActivityDates);
        const developCheckedInToday = developActivityDates.includes(date);
        const developAllGoalsMet = allDevelopGoalsMet(rows);

        this.response.template = 'develop.html';
        this.response.body = {
            domainId: finalDomainId,
            developPool: rows,
            learnBases,
            developDateUtc: date,
            developTotalCheckinDays,
            developConsecutiveDays,
            developCheckedInToday,
            developAllGoalsMet,
        };
    }

    async postCheckin(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const dudoc = await DomainModel.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const todayYmd = developTodayUtcYmd();
        const rawAct = (dudoc as any)?.developActivityDates;
        const developActivityDates: string[] = Array.isArray(rawAct)
            ? rawAct.map((x: unknown) => String(x))
            : [];
        if (developActivityDates.includes(todayYmd)) {
            this.response.body = { success: true, already: true };
            return;
        }

        const developPool = normalizePool((dudoc as any)?.developPool);
        if (!developPool.length || !developPoolHasAnyGoal(developPool)) {
            throw new ValidationError(this.translate('Develop check-in need goals set'));
        }

        const stats = await getDevelopBranchDailyMany(
            this.ctx.db.db,
            finalDomainId,
            this.user._id,
            todayYmd,
            developPool,
        );
        const rows: DevelopRowWithStats[] = developPool.map((e) => {
            const st = stats.get(developBranchKey(e.baseDocId, e.branch)) || { nodes: 0, cards: 0, problems: 0 };
            return {
                ...e,
                todayNodes: st.nodes,
                todayCards: st.cards,
                todayProblems: st.problems,
            };
        });

        if (!allDevelopGoalsMet(rows)) {
            throw new ValidationError(this.translate('Develop check-in goals not met'));
        }

        await appendUserCheckinDay(finalDomainId, this.user._id, this.user.priv, 'developActivityDates');
        this.response.body = { success: true };
    }

    async post(domainId: string) {
        if (String(this.request.path || '').includes('/develop/checkin')) {
            return this.postCheckin(domainId);
        }
        if (!this.request.path.includes('/pool')) {
            throw new MethodNotAllowedError('POST');
        }
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const body: any = this.request.body || {};
        const pool = normalizePool(body.pool);
        for (const e of pool) {
            const b = await BaseModel.get(finalDomainId, e.baseDocId);
            if (!b) {
                throw new ValidationError(this.translate('Develop unknown base'));
            }
            const allowed = new Set(branchesForDevelopBase(b));
            if (!allowed.has(e.branch)) {
                throw new ValidationError(this.translate('Develop invalid branch'));
            }
        }
        await DomainModel.setUserInDomain(finalDomainId, this.user._id, { developPool: pool });
        this.response.body = { success: true, pool };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('develop', '/develop', DevelopHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('develop_pool', '/develop/pool', DevelopHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('develop_checkin', '/develop/checkin', DevelopHandler, PRIV.PRIV_USER_PROFILE);
}
