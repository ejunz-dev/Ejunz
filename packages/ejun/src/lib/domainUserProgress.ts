import moment from 'moment-timezone';
import type { Db } from 'mongodb';
import { PRIV } from '../model/builtin';
import DomainModel from '../model/domain';
import user from '../model/user';
import { BaseModel } from '../model/base';
import { getLearnDailyGoal } from './learnModePrefs';
import { getTodayUserDomainConsumption } from './homepageRanking';
import { developBranchKey, developTodayUtcYmd, getDevelopBranchDailyMany } from './developBranchDaily';
import {
    developPoolHasAnyGoal,
    developRowGoalsMet,
    developRowHasDailyGoal,
    normalizeDevelopPool,
    loadDevelopRunQueuePool,
    type DevelopPoolEntryWire,
} from './developPoolShared';
import { countConsecutiveCheckinDays } from './checkin';
import {
    hasDevelopSessionInProgressOrPaused,
    peekResumableDevelopDailySessionIdReadOnly,
} from './developSessionResume';

type DevelopRowWithStats = DevelopPoolEntryWire & {
    todayNodes: number;
    todayCards: number;
    todayProblems: number;
};

function allDevelopGoalsMet(rows: DevelopRowWithStats[]): boolean {
    if (!rows.length) return false;
    if (!developPoolHasAnyGoal(rows)) return false;
    return rows.every(developRowGoalsMet);
}

function modeDone(goal: number, completed: number): boolean {
    return goal > 0 ? completed >= goal : completed > 0;
}

function modeRemaining(goal: number, completed: number): number {
    if (goal > 0) return Math.max(0, goal - completed);
    return completed > 0 ? 0 : 1;
}

/**
 * Learn + develop daily progress for one user in a domain (UTC calendar day).
 * Aligns with homepage check-in / develop page counters.
 */
export async function getDomainUserProgressForTool(
    domainId: string,
    uid: number,
    mongoDb: Db,
): Promise<Record<string, unknown>> {
    const rawDudoc = await mongoDb.collection('domain.user').findOne({ domainId, uid });
    const udoc = await user.getById(domainId, uid);
    if ((!rawDudoc || !(rawDudoc as { join?: boolean }).join) && !(udoc.priv & PRIV.PRIV_VIEW_ALL_DOMAIN)) {
        return {
            needJoinDomain: true,
            domainId,
            uid,
        };
    }

    const dudoc = await DomainModel.getDomainUser(domainId, { _id: uid, priv: udoc.priv });
    const todayKey = moment.utc().format('YYYY-MM-DD');

    const learnDates: string[] = Array.isArray((dudoc as { learnActivityDates?: unknown }).learnActivityDates)
        ? (dudoc as { learnActivityDates: unknown[] }).learnActivityDates.map((x) => String(x))
        : [];
    const learnSet = new Set(learnDates);
    const learnDailyGoal = getLearnDailyGoal(dudoc as Record<string, unknown>);
    const consumption = await getTodayUserDomainConsumption(mongoDb, domainId, uid, todayKey);
    const learnTodayCompleted = consumption.cards;

    const developDateUtc = developTodayUtcYmd();
    const developPool = normalizeDevelopPool((dudoc as { developPool?: unknown }).developPool);
    const bases = await BaseModel.getAll(domainId);
    const baseById = new Map(bases.map((b) => [Number(b.docId), b]));
    const stats = await getDevelopBranchDailyMany(mongoDb, domainId, uid, developDateUtc, developPool);

    const developRows = developPool.map((e) => {
        const b = baseById.get(e.baseDocId);
        const title = b ? ((b.title || '').trim() || String(e.baseDocId)) : `Base ${e.baseDocId}`;
        const st = stats.get(developBranchKey(e.baseDocId, e.branch)) || { nodes: 0, cards: 0, problems: 0 };
        const rowStats: DevelopRowWithStats = {
            ...e,
            todayNodes: st.nodes,
            todayCards: st.cards,
            todayProblems: st.problems,
        };
        const hasGoal = developRowHasDailyGoal(e);
        const todayGoalsMet = hasGoal && developRowGoalsMet(rowStats);
        return {
            baseDocId: e.baseDocId,
            branch: e.branch,
            baseTitle: title,
            dailyNodeGoal: e.dailyNodeGoal,
            dailyCardGoal: e.dailyCardGoal,
            dailyProblemGoal: e.dailyProblemGoal,
            todayNodes: st.nodes,
            todayCards: st.cards,
            todayProblems: st.problems,
            todayGoalsMet,
        };
    });

    const rawAct = (dudoc as { developActivityDates?: unknown }).developActivityDates;
    const developActivityDates: string[] = Array.isArray(rawAct)
        ? rawAct.map((x) => String(x))
        : [];
    const developTotalCheckinDays = developActivityDates.length;
    const developConsecutiveDays = countConsecutiveCheckinDays(developActivityDates);
    const developCheckedInToday = developActivityDates.includes(developDateUtc);
    const developAllGoalsMet = allDevelopGoalsMet(
        developPool.map((e) => {
            const st = stats.get(developBranchKey(e.baseDocId, e.branch)) || { nodes: 0, cards: 0, problems: 0 };
            return {
                ...e,
                todayNodes: st.nodes,
                todayCards: st.cards,
                todayProblems: st.problems,
            };
        }),
    );

    const developPendingQueue = await loadDevelopRunQueuePool(mongoDb, domainId, uid, udoc.priv);
    const todayResumableSessionId = await peekResumableDevelopDailySessionIdReadOnly(
        mongoDb,
        domainId,
        uid,
        udoc.priv,
    );
    const developContinueDevelop = await hasDevelopSessionInProgressOrPaused(domainId, uid);

    return {
        dateUtc: todayKey,
        learn: {
            totalActiveDays: learnSet.size,
            dailyGoalCards: learnDailyGoal,
            todayConsumption: consumption,
            todayDone: modeDone(learnDailyGoal, learnTodayCompleted),
            todayRemaining: modeRemaining(learnDailyGoal, learnTodayCompleted),
        },
        develop: {
            developDateUtc,
            developTotalCheckinDays,
            developConsecutiveDays,
            developCheckedInToday,
            developAllGoalsMet,
            developContinueDevelop,
            todayResumableSessionId,
            pendingQueueBranches: developPendingQueue.length,
            pool: developRows,
        },
    };
}
