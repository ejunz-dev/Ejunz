import type { Context } from '../context';
import { ObjectId } from 'mongodb';
import { Handler, query, Types } from '../service/server';
import { PRIV, PERM } from '../model/builtin';
import { MethodNotAllowedError } from '@ejunz/framework';
import DomainModel from '../model/domain';
import { BaseModel } from '../model/base';
import { NotFoundError, ValidationError } from '../error';
import SessionModel, { type SessionDoc } from '../model/session';
import { buildBaseEditorPageBody } from './base';
import type { BaseDoc } from '../interface';
import { developBranchKey, developTodayUtcYmd, getDevelopBranchDailyMany } from '../lib/developBranchDaily';
import { appendUserCheckinDay, countConsecutiveCheckinDays } from '../lib/checkin';
import {
    developPoolHasAnyGoal,
    developRowGoalsMet,
    developRowHasDailyGoal,
    normalizeDevelopPool,
    type DevelopPoolEntryWire,
} from '../lib/developPoolShared';
import { buildTodayDevelopResumeFields, clearDevelopSessionsAfterPoolChange } from '../lib/developSessionResume';
import {
    deriveSessionRecordType,
    formatSessionProgressDisplay,
    isDevelopSessionSettled,
} from '../lib/sessionListDisplay';
import { buildSessionRecordHistoryRows, summarizeRecordDoc } from './record';

export type { DevelopPoolEntryWire };

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

/** GET `/develop/editor?session=` — same `base_editor.html` payload as branch editor, bound to a develop pool session. */
class DevelopSessionEditorHandler extends Handler {
    @query('session', Types.String, true)
    async get(domainId: string, sessionHex?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const sid = (sessionHex || '').trim();
        if (!sid || !ObjectId.isValid(sid)) {
            throw new ValidationError(this.translate('Invalid session'));
        }
        const sess = await SessionModel.coll.findOne({
            _id: new ObjectId(sid),
            domainId,
            uid: this.user._id,
            appRoute: 'develop',
        }) as SessionDoc | null;
        if (!sess) {
            throw new NotFoundError(this.translate('Session not found'));
        }
        if ((sess as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) {
            throw new NotFoundError(this.translate('Session not found'));
        }
        if (isDevelopSessionSettled(sess)) {
            throw new NotFoundError(this.translate('Session not found'));
        }
        const baseDocId = Number(sess.baseDocId);
        if (!Number.isFinite(baseDocId) || baseDocId <= 0) {
            throw new NotFoundError(this.translate('Session not found'));
        }
        const base = await BaseModel.get(domainId, baseDocId);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const requestedBranch = sess.branch && String(sess.branch).trim() ? String(sess.branch).trim() : 'main';
        const workspaceFromQuery = (this.request.query?.workspace as string) || '';

        this.response.template = 'base_editor.html';
        const domainName = (this as any).domain?.name || domainId;
        const editorBody = await buildBaseEditorPageBody({
            domainId,
            base,
            requestedBranch,
            uid: this.user._id,
            priv: this.user.priv,
            domainName,
            db: this.ctx.db.db,
            makeEditorUrl: (docId, br) => this.url('base_editor_branch', { domainId, docId, branch: br }),
            workspaceFromQuery,
        });
        this.response.body = {
            ...editorBody,
            page_name: 'develop_editor',
        };
    }
}

/** GET `/develop/session/history?session=` — settled develop session save records (layout similar to learn history). */
class DevelopSessionHistoryHandler extends Handler {
    @query('session', Types.String, true)
    async get(domainId: string, sessionHex?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const sid = (sessionHex || '').trim();
        if (!sid || !ObjectId.isValid(sid)) {
            throw new ValidationError(this.translate('Invalid session'));
        }
        const sess = await SessionModel.coll.findOne({
            _id: new ObjectId(sid),
            domainId,
            uid: this.user._id,
            appRoute: 'develop',
        }) as SessionDoc | null;
        if (!sess) throw new NotFoundError(this.translate('Session not found'));
        if (!isDevelopSessionSettled(sess)) {
            throw new NotFoundError(this.translate('Session not found'));
        }

        const recordHistoryRows = await buildSessionRecordHistoryRows(
            domainId,
            sess.recordIds,
            (name, kwargs) => this.url(name, kwargs as any),
        );
        const recordSummaries = recordHistoryRows.map((row) => {
            const s = summarizeRecordDoc(row.rdoc);
            return {
                _id: row.rdoc._id,
                cardId: row.rdoc.cardId,
                color: s.color,
                label: s.label,
                code: s.code,
            };
        });
        const rt = deriveSessionRecordType(sess);
        this.response.template = 'develop_session_history.html';
        this.response.body = {
            domainId,
            page_name: 'develop_session_history',
            session: {
                ...sess,
                status: 'finished' as const,
                statusLabel: this.translate('session_status_finished'),
                recordType: rt,
                recordTypeLabel: this.translate(`session_record_type_${rt}`),
                sessionKind: 'develop' as const,
                sessionKindLabel: this.translate('session_kind_develop'),
                recordSummaries,
                cardProgressText: formatSessionProgressDisplay(sess),
                progressText: formatSessionProgressDisplay(sess),
            },
            recordHistoryRows,
            developHomeUrl: this.url('develop', { domainId }),
        };
    }
}

class DevelopHandler extends Handler {
    async get(domainId: string) {
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (String(this.request.path || '').includes('/develop/pool')) {
            this.response.redirect = this.url('develop', { domainId: finalDomainId });
            return;
        }

        const dudoc = await DomainModel.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv });
        const developPool = normalizeDevelopPool((dudoc as any)?.developPool);

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
            const rowStats = {
                ...e,
                todayNodes: st.nodes,
                todayCards: st.cards,
                todayProblems: st.problems,
            };
            const hasGoal = developRowHasDailyGoal(e);
            const todayGoalsMet = hasGoal && developRowGoalsMet(rowStats);
            return {
                ...e,
                baseTitle: title,
                todayNodes: st.nodes,
                todayCards: st.cards,
                todayProblems: st.problems,
                todayGoalsMet,
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

        const resume = await buildTodayDevelopResumeFields(
            this.ctx.db.db,
            finalDomainId,
            this.user._id,
            this.user.priv,
            (sessionHex) => {
                const base = this.url('develop_editor', { domainId: finalDomainId });
                const sep = base.includes('?') ? '&' : '?';
                return `${base}${sep}session=${encodeURIComponent(sessionHex)}`;
            },
        );

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
            todayDevelopResumableSessionId: resume.todayDevelopResumableSessionId ?? '',
            todayDevelopResumeUrl: resume.todayDevelopResumeUrl ?? '',
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

        const developPool = normalizeDevelopPool((dudoc as any)?.developPool);
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
        const pool = normalizeDevelopPool(body.pool);
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
        await clearDevelopSessionsAfterPoolChange(finalDomainId, this.user._id);
        await DomainModel.setUserInDomain(finalDomainId, this.user._id, { developPool: pool });
        this.response.body = { success: true, pool };
    }
}

export async function apply(ctx: Context) {
    ctx.Route('develop_editor', '/develop/editor', DevelopSessionEditorHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('develop_session_history', '/develop/session/history', DevelopSessionHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('develop', '/develop', DevelopHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('develop_pool', '/develop/pool', DevelopHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('develop_checkin', '/develop/checkin', DevelopHandler, PRIV.PRIV_USER_PROFILE);
}
