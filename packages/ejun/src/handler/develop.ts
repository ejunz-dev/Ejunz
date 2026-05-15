import type { Context } from '../context';
import moment from 'moment-timezone';
import { ObjectId } from 'mongodb';
import { Handler, query, Types } from '../service/server';
import { PRIV, PERM } from '../model/builtin';
import { MethodNotAllowedError } from '@ejunz/framework';
import DomainModel from '../model/domain';
import { BaseModel, type MindMapDocType } from '../model/base';
import * as document from '../model/document';
import { SkillModel } from '../model/skill';
import { NotFoundError, ValidationError } from '../error';
import SessionModel, {
    readDevelopEditorUrl,
    readDevelopSessionEditTotals,
    validateDevelopEditorStoredLocation,
    type SessionDoc,
} from '../model/session';
import { readDevelopSessionDeadlineMs } from '../lib/sessionUtcDaily';
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
import { buildDevelopDomainWallPayload } from '../lib/developDomainWall';
import {
    buildTodayDevelopResumeFields,
    clearDevelopSessionsAfterPoolChange,
    hasDevelopSessionInProgressOrPaused,
} from '../lib/developSessionResume';
import {
    deriveSessionLearnStatus,
    deriveSessionRecordType,
    developSessionRecordTypeLabelKey,
    formatSessionProgressDisplay,
    inferDevelopSessionKind,
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
        const histSt = deriveSessionLearnStatus(sess);
        if (histSt === 'timed_out' || histSt === 'finished' || histSt === 'abandoned') {
            const histBase = this.url('develop_session_history', { domainId });
            const sep = histBase.includes('?') ? '&' : '?';
            this.response.redirect = `${histBase}${sep}session=${encodeURIComponent(sid)}`;
            return;
        }
        const baseDocId = Number(sess.baseDocId);
        if (!Number.isFinite(baseDocId) || baseDocId <= 0) {
            throw new NotFoundError(this.translate('Session not found'));
        }
        const mRaw = sess.developMapDocType;
        if (mRaw !== document.TYPE_BASE && mRaw !== document.TYPE_SKILL) {
            throw new NotFoundError(this.translate('Session not found'));
        }
        const mapDt: MindMapDocType = mRaw;
        const base = mapDt === document.TYPE_SKILL
            ? ((await SkillModel.get(domainId, baseDocId)) as BaseDoc | null)
            : await BaseModel.get(domainId, baseDocId);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const requestedBranch = sess.branch && String(sess.branch).trim() ? String(sess.branch).trim() : 'main';
        const q = this.request.query || {};
        const hasCardInUrl = typeof q.cardId === 'string' && q.cardId.trim().length > 0;
        const hasNodeInUrl = typeof q.nodeId === 'string' && q.nodeId.trim().length > 0;

        if (inferDevelopSessionKind(sess) === 'outline_node') {
            const savedEditorUrl = readDevelopEditorUrl(sess);
            if (!hasCardInUrl && !hasNodeInUrl && savedEditorUrl) {
                const locOk = await validateDevelopEditorStoredLocation(
                    domainId,
                    savedEditorUrl,
                    sid,
                    baseDocId,
                    requestedBranch,
                );
                if (locOk) {
                    this.response.redirect = savedEditorUrl;
                    return;
                }
            }
            const docSeg = (base as { bid?: string }).bid && String((base as { bid?: string }).bid).trim()
                ? String((base as { bid?: string }).bid).trim()
                : String(base.docId);
            const sp = new URLSearchParams();
            sp.set('session', sid);
            if (hasCardInUrl) sp.set('cardId', String(q.cardId).trim());
            if (hasNodeInUrl) sp.set('nodeId', String(q.nodeId).trim());
            const pathSeg = mapDt === document.TYPE_SKILL ? 'skill' : 'base';
            this.response.redirect = `/d/${encodeURIComponent(domainId)}/${pathSeg}/${encodeURIComponent(docSeg)}/branch/${encodeURIComponent(requestedBranch)}/editor?${sp.toString()}`;
            return;
        }

        const savedDailyUrl = readDevelopEditorUrl(sess);
        if (!hasCardInUrl && !hasNodeInUrl && savedDailyUrl) {
            const locOk = await validateDevelopEditorStoredLocation(
                domainId,
                savedDailyUrl,
                sid,
                baseDocId,
                requestedBranch,
            );
            if (locOk) {
                this.response.redirect = savedDailyUrl;
                return;
            }
        }

        this.response.template = mapDt === document.TYPE_SKILL ? 'skill_editor.html' : 'base_editor.html';
        const domainName = (this as any).domain?.name || domainId;
        const qNode = typeof q.nodeId === 'string' ? q.nodeId.trim() : '';
        const sessNodeId = typeof (sess as { nodeId?: string }).nodeId === 'string'
            ? String((sess as { nodeId?: string }).nodeId).trim()
            : '';
        const rootNodeIdFromQuery = qNode || sessNodeId;
        const editorBody = await buildBaseEditorPageBody({
            domainId,
            base,
            requestedBranch,
            uid: this.user._id,
            priv: this.user.priv,
            domainName,
            db: this.ctx.db.db,
            makeEditorUrl: (docId, br) => (mapDt === document.TYPE_SKILL
                ? `/d/${encodeURIComponent(domainId)}/skill/${encodeURIComponent(String(docId))}/outline/branch/${encodeURIComponent(br)}`
                : this.url('base_outline_doc_branch', { domainId, docId: String(docId), branch: br })),
            rootNodeIdFromQuery,
            developPoolUiMode: inferDevelopSessionKind(sess) === 'outline_node' ? 'none' : 'full',
            mapDocType: mapDt,
        });
        const deadlineMs = readDevelopSessionDeadlineMs(sess);
        const createdAt = sess.createdAt instanceof Date
            ? sess.createdAt
            : new Date(sess.createdAt as Date);
        this.response.body = {
            ...editorBody,
            page_name: 'develop_editor',
            editorDevelopSessionKind: 'daily' as const,
            developSessionEditTotals: readDevelopSessionEditTotals(sess),
            developSessionDeadlineIso: deadlineMs != null ? new Date(deadlineMs).toISOString() : null,
            developSessionStartedAtIso: Number.isNaN(createdAt.getTime()) ? null : createdAt.toISOString(),
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
        const historySt = deriveSessionLearnStatus(sess);
        const allowHistory = isDevelopSessionSettled(sess)
            || historySt === 'timed_out'
            || historySt === 'abandoned';
        if (!allowHistory) {
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
        const developLabelKey = developSessionRecordTypeLabelKey(sess);
        const recordTypeLabel = developLabelKey
            ? this.translate(developLabelKey)
            : this.translate(`session_record_type_${rt}`);
        const isAbandoned = historySt === 'abandoned';
        const isTimedOut = historySt === 'timed_out';
        const histStatus = isAbandoned ? ('abandoned' as const) : isTimedOut ? ('timed_out' as const) : ('finished' as const);
        const histLabelKey = isAbandoned
            ? 'session_status_abandoned'
            : isTimedOut
                ? 'session_status_timed_out'
                : 'session_status_finished';
        this.response.template = 'develop_session_history.html';
        this.response.body = {
            domainId,
            page_name: 'develop_session_history',
            session: {
                ...sess,
                status: histStatus,
                statusLabel: this.translate(histLabelKey),
                recordType: rt,
                recordTypeLabel,
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
                editorUrl: this.url('base_outline_doc_branch', {
                    domainId: finalDomainId,
                    docId: String(e.baseDocId),
                    branch: e.branch,
                }),
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

        const developContinueDevelop = await hasDevelopSessionInProgressOrPaused(
            finalDomainId,
            this.user._id,
        );

        const sinceWallYmd = moment.utc().subtract(364, 'days').format('YYYY-MM-DD');
        const domainNameWall = (this as any).domain?.name || finalDomainId;
        const developWall = await buildDevelopDomainWallPayload(
            this.ctx.db.db,
            finalDomainId,
            domainNameWall,
            this.user._id,
            developActivityDates,
            sinceWallYmd,
            date,
            (name, kwargs) => this.url(name, kwargs as any),
            (key) => this.translate(key),
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
            developContinueDevelop,
            developWallContributions: developWall.developWallContributions,
            developWallContributionDetails: developWall.developWallContributionDetails,
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
