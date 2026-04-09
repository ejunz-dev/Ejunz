import { throttle } from 'lodash';
import type { Context } from '../context';
import { NotFoundError, ValidationError } from '../error';
import { ObjectId } from 'mongodb';
import {
    ConnectionHandler,
    Handler,
    param,
    query,
    subscribe,
    Types,
} from '../service/server';
import {
    clearDevelopDailySessionPointer,
    DEVELOP_SESSION_REUSE_MS,
    developSessionNotSettledMongoFilter,
} from '../lib/developSessionResume';
import {
    computeDevelopRunQueueProgress,
    developBranchKey,
    developRunTerminalTotals,
    isEntireDevelopPoolGoalsMetToday,
    loadDevelopRunQueuePool,
    loadUserDevelopPool,
} from '../lib/developPoolShared';
import { PERM, PRIV } from '../model/builtin';
import { BaseModel } from '../model/base';
import DomainModel from '../model/domain';
import type { SessionRecordDoc } from '../model/record';
import SessionModel, { type SessionDoc, type SessionPatch } from '../model/session';
import user from '../model/user';
import {
    deriveSessionKind,
    deriveSessionLearnStatus,
    deriveSessionRecordType,
    formatSessionProgressDisplay,
    isAgentSessionRow,
    isDevelopSessionRow,
    isDevelopSessionSettled,
    isLearnSessionRow,
    type SessionListRecordType,
    type SessionListStatus,
} from '../lib/sessionListDisplay';
import { recordSummariesForSessionRow } from './record';

/** JSON-safe session document for lesson WebSocket clients. */
export function sessionDocToWire(doc: SessionDoc | null): Record<string, unknown> | null {
    if (!doc) return null;
    const d: any = { ...doc };
    if (d._id && typeof d._id.toString === 'function') d._id = d._id.toString();
    for (const k of ['createdAt', 'updatedAt', 'lastActivityAt', 'lessonAbandonedAt']) {
        if (d[k] instanceof Date) d[k] = d[k].toISOString();
    }
    return d;
}

function buildSessionListRow(
    self: { translate: (k: string) => string; url: (name: string, kwargs?: Record<string, unknown>) => string },
    doc: SessionDoc,
    recordSummaries: Awaited<ReturnType<typeof recordSummariesForSessionRow>>,
) {
    const status = deriveSessionLearnStatus(doc);
    const recordType = deriveSessionRecordType(doc);
    const sessionKind = deriveSessionKind(doc);
    let resumeUrl: string;
    // learn rows with _id: link to learn_lesson?session=… (history for timed_out / finished / abandoned)
    if (isAgentSessionRow(doc) && doc.agentSessionKind) {
        resumeUrl = self.url('session_chat_detail', { domainId: doc.domainId, sid: doc._id });
    } else if (isLearnSessionRow(doc) && doc._id) {
        const base = self.url('learn_lesson', { domainId: doc.domainId });
        const sep = base.includes('?') ? '&' : '?';
        resumeUrl = `${base}${sep}session=${encodeURIComponent(doc._id.toString())}`;
    } else if (isDevelopSessionRow(doc) && doc._id) {
        if (status === 'finished' || status === 'timed_out' || status === 'abandoned') {
            const base = self.url('develop_session_history', { domainId: doc.domainId });
            const sep = base.includes('?') ? '&' : '?';
            resumeUrl = `${base}${sep}session=${encodeURIComponent(doc._id.toString())}`;
        } else {
            const base = self.url('develop_editor', { domainId: doc.domainId });
            const sep = base.includes('?') ? '&' : '?';
            resumeUrl = `${base}${sep}session=${encodeURIComponent(doc._id.toString())}`;
        }
    } else if (isLearnSessionRow(doc)) {
        resumeUrl = self.url('learn', { domainId: doc.domainId });
    } else {
        resumeUrl = self.url('session_domain', { domainId: doc.domainId });
    }
    return {
        ...doc,
        sessionId: doc._id.toString(),
        status,
        recordType,
        statusLabel: self.translate(`session_status_${status}`),
        recordTypeLabel: self.translate(`session_record_type_${recordType}`),
        sessionKind,
        sessionKindLabel: self.translate(`session_kind_${sessionKind}`),
        resumeUrl,
        recordSummaries,
        cardProgressText: formatSessionProgressDisplay(doc),
        progressText: formatSessionProgressDisplay(doc),
    };
}

function readPatch(body: any): SessionPatch {
    if (!body || typeof body !== 'object') return {};
    const patch: SessionPatch = {};
    if (body.baseDocId !== undefined) {
        const n = Number(body.baseDocId);
        if (!Number.isFinite(n)) throw new ValidationError('Invalid baseDocId');
        patch.baseDocId = n;
    }
    if (typeof body.branch === 'string') patch.branch = body.branch;
    if (typeof body.cardId === 'string') patch.cardId = body.cardId;
    if (typeof body.nodeId === 'string') patch.nodeId = body.nodeId;
    if (body.cardIndex !== undefined) {
        const n = Number(body.cardIndex);
        if (!Number.isFinite(n)) throw new ValidationError('Invalid cardIndex');
        patch.cardIndex = n;
    }
    if (typeof body.route === 'string') patch.route = body.route;
    if (body.appRoute === 'learn' || body.appRoute === 'develop' || body.appRoute === 'agent') {
        patch.appRoute = body.appRoute;
    }
    if (body.lessonMode === null || body.lessonMode === 'today' || body.lessonMode === 'node') {
        patch.lessonMode = body.lessonMode;
    }
    if (body.currentLearnSectionIndex !== undefined) {
        const n = Number(body.currentLearnSectionIndex);
        if (!Number.isFinite(n)) throw new ValidationError('Invalid currentLearnSectionIndex');
        patch.currentLearnSectionIndex = n;
    }
    if (typeof body.currentLearnSectionId === 'string') patch.currentLearnSectionId = body.currentLearnSectionId;
    if (body.lessonReviewCardIds !== undefined) {
        if (!Array.isArray(body.lessonReviewCardIds)) throw new ValidationError('lessonReviewCardIds must be an array');
        patch.lessonReviewCardIds = body.lessonReviewCardIds.map(String);
    }
    if (body.lessonCardTimesMs !== undefined) {
        if (!Array.isArray(body.lessonCardTimesMs)) throw new ValidationError('lessonCardTimesMs must be an array');
        patch.lessonCardTimesMs = body.lessonCardTimesMs.map((x: unknown) => Number(x));
    }
    if (body.state === 'idle' || body.state === 'active') patch.state = body.state;
    if (body.progress !== undefined) {
        if (body.progress !== null && typeof body.progress !== 'object') {
            throw new ValidationError('progress must be an object');
        }
        patch.progress = body.progress == null ? {} : { ...body.progress };
    }
    return patch;
}

function mergeSessionProgressWithDevelopRun(
    prevRaw: unknown,
    run: { completed: number; total: number },
): Record<string, unknown> {
    const prev = prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
        ? { ...(prevRaw as Record<string, unknown>) }
        : {};
    prev.developRun = run;
    return prev;
}

/** POST JSON: allocate or reuse a develop-pool editor session (`appRoute: develop`). */
class DevelopSessionStartHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body = this.request.body || {};
        const baseDocId = Number(body.baseDocId);
        if (!Number.isFinite(baseDocId) || baseDocId <= 0) {
            throw new ValidationError('Invalid baseDocId');
        }
        const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'main';
        const base = await BaseModel.get(finalDomainId, baseDocId);
        if (!base) throw new NotFoundError('Base not found');
        if (!this.user.own(base)) this.checkPerm(PERM.PERM_EDIT_DISCUSSION);

        const pendingPool = await loadDevelopRunQueuePool(
            this.ctx.db.db,
            finalDomainId,
            this.user._id,
            this.user.priv,
        );
        const poolKey = developBranchKey(baseDocId, branch);
        if (!pendingPool.length) {
            throw new ValidationError(this.translate('Develop run queue empty today'));
        }
        if (!pendingPool.some((e) => developBranchKey(e.baseDocId, e.branch) === poolKey)) {
            throw new ValidationError(this.translate('Develop start goals done today'));
        }

        const cutoff = new Date(Date.now() - DEVELOP_SESSION_REUSE_MS);
        const recent = await SessionModel.coll
            .find({
                domainId: finalDomainId,
                uid: this.user._id,
                appRoute: 'develop',
                baseDocId,
                branch,
                lastActivityAt: { $gte: cutoff },
                $and: [
                    { $or: [{ lessonAbandonedAt: null }, { lessonAbandonedAt: { $exists: false } }] },
                    developSessionNotSettledMongoFilter,
                ],
            })
            .sort({ lastActivityAt: -1 })
            .limit(1)
            .toArray();
        const existing = recent[0] as SessionDoc | undefined;

        const run = computeDevelopRunQueueProgress(pendingPool, baseDocId, branch);

        if (existing) {
            const progress = run
                ? mergeSessionProgressWithDevelopRun(existing.progress, run)
                : (existing.progress && typeof existing.progress === 'object' && !Array.isArray(existing.progress)
                    ? { ...(existing.progress as Record<string, unknown>) }
                    : {});
            const bumped = await SessionModel.touchById(
                finalDomainId,
                this.user._id,
                existing._id,
                run ? { progress } : {},
                { silent: false },
            );
            const doc = bumped ?? existing;
            this.response.body = { success: true, sessionId: doc._id.toString(), reused: true };
            return;
        }

        const doc = await SessionModel.insertSession(finalDomainId, this.user._id, {
            appRoute: 'develop',
            route: 'develop',
            baseDocId,
            branch,
        });
        if (run) {
            const progress = mergeSessionProgressWithDevelopRun(doc.progress, run);
            await SessionModel.touchById(finalDomainId, this.user._id, doc._id, { progress }, { silent: false });
        }
        this.response.body = { success: true, sessionId: doc._id.toString(), reused: false };
    }
}

/** POST JSON: settle today’s develop session after every pool row with daily goals has met them. */
class DevelopSessionSettleHandler extends Handler {
    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const body = this.request.body || {};
        const sessionHex = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
        if (!sessionHex || !ObjectId.isValid(sessionHex)) {
            throw new ValidationError(this.translate('Invalid session'));
        }

        const okPool = await isEntireDevelopPoolGoalsMetToday(
            this.ctx.db.db,
            finalDomainId,
            this.user._id,
            this.user.priv,
        );
        if (!okPool) {
            throw new ValidationError(this.translate('Develop settle pool incomplete'));
        }

        const sess = await SessionModel.coll.findOne({
            _id: new ObjectId(sessionHex),
            domainId: finalDomainId,
            uid: this.user._id,
            appRoute: 'develop',
        }) as SessionDoc | null;
        if (!sess) throw new NotFoundError(this.translate('Session not found'));
        if ((sess as { lessonAbandonedAt?: Date | null }).lessonAbandonedAt) {
            throw new NotFoundError(this.translate('Session not found'));
        }
        if (isDevelopSessionSettled(sess)) {
            throw new ValidationError(this.translate('Develop settle already'));
        }

        const prevRaw = sess.progress;
        const prev = prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw)
            ? { ...(prevRaw as Record<string, unknown>) }
            : {};
        prev.developSettledAt = new Date();
        const fullPool = await loadUserDevelopPool(finalDomainId, this.user._id, this.user.priv);
        const term = developRunTerminalTotals(sess.progress, fullPool.length);
        if (term) prev.developRun = term;
        await SessionModel.touchById(finalDomainId, this.user._id, sess._id, { progress: prev });

        const dudoc = await DomainModel.getDomainUser(finalDomainId, { _id: this.user._id, priv: this.user.priv }) as any;
        const ptr = typeof dudoc?.developDailySessionId === 'string' ? dudoc.developDailySessionId.trim() : '';
        if (ptr === sessionHex) await clearDevelopDailySessionPointer(finalDomainId, this.user._id);

        const histBase = this.url('develop_session_history', { domainId: finalDomainId });
        const sep = histBase.includes('?') ? '&' : '?';
        const redirect = `${histBase}${sep}session=${encodeURIComponent(sessionHex)}`;
        this.response.body = { success: true, redirect };
    }
}

/** GET / POST own progress (JSON, for lesson client). */
class SessionMeHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const doc = await SessionModel.get(finalDomainId, this.user._id);
        this.response.body = { session: doc };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const finalDomainId = typeof domainId === 'string' ? domainId : (domainId as any)?.domainId || this.args.domainId;
        const patch = readPatch(this.request.body);
        const doc = await SessionModel.touch(finalDomainId, this.user._id, patch);
        this.response.body = { session: doc };
    }
}

function parseSessionListKind(s?: string): 'learn' | 'develop' | 'agent' | undefined {
    if (s === 'learn' || s === 'develop' || s === 'agent') return s;
    return undefined;
}

function parseSessionListRecordType(s?: string): SessionListRecordType | undefined {
    const allowed: SessionListRecordType[] = ['daily', 'single_card', 'single_node', 'develop', 'agent', 'other'];
    if (s && allowed.includes(s as SessionListRecordType)) return s as SessionListRecordType;
    return undefined;
}

function parseSessionListStatus(s?: string): SessionListStatus | undefined {
    const allowed: SessionListStatus[] = [
        'in_progress', 'paused', 'finished', 'timed_out', 'abandoned', 'active', 'detached',
    ];
    if (s && allowed.includes(s as SessionListStatus)) return s as SessionListStatus;
    return undefined;
}

/** Live learn session list (HTML). */
export class SessionDomainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('uidOrName', Types.UidOrName, true)
    @query('kind', Types.String, true)
    @query('recordType', Types.String, true)
    @query('status', Types.String, true)
    async get(
        domainId: string,
        page = 1,
        uidOrName?: string,
        kindRaw?: string,
        recordTypeRaw?: string,
        statusRaw?: string,
    ) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        let filterUid: number | undefined;
        /** Only pass a user filter to `/session-conn` when it resolved; invalid strings (e.g. domain id) would close the socket with 4000. */
        let sessionConnUidOrName: string | undefined;
        if (uidOrName) {
            const udoc = await user.getById(domainId, +uidOrName)
                || await user.getByUname(domainId, uidOrName)
                || await user.getByEmail(domainId, uidOrName);
            if (udoc) {
                filterUid = udoc._id;
                sessionConnUidOrName = uidOrName;
            }
            if (filterUid !== this.user._id) {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
            }
        } else {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        const pageSize = 20;
        const kind = parseSessionListKind(kindRaw?.trim() || undefined);
        const recordType = parseSessionListRecordType(recordTypeRaw?.trim() || undefined);
        const listStatus = parseSessionListStatus(statusRaw?.trim() || undefined);
        const mongoListOpts = { hideLearnHomePlaceholderShells: true as const, sessionKind: kind };

        const qp = new URLSearchParams();
        if (uidOrName) qp.set('uidOrName', uidOrName);
        if (kind) qp.set('kind', kind);
        if (recordType) qp.set('recordType', recordType);
        if (listStatus) qp.set('status', listStatus);
        const sessionListFilterQuery = qp.toString();

        let rows: SessionDoc[];
        let count: number;
        if (recordType != null || listStatus != null) {
            const all = await SessionModel.findSortedForSessionList(domainId, filterUid, mongoListOpts);
            const filtered = all.filter((d) => {
                if (recordType != null && deriveSessionRecordType(d) !== recordType) return false;
                if (listStatus != null && deriveSessionLearnStatus(d) !== listStatus) return false;
                return true;
            });
            count = filtered.length;
            rows = filtered.slice((page - 1) * pageSize, page * pageSize);
        } else {
            const paged = await SessionModel.listPage(domainId, filterUid, page, pageSize, mongoListOpts);
            rows = paged.rows;
            count = paged.count;
        }

        const sessions = await Promise.all(rows.map(async (s) => buildSessionListRow(
            this,
            s,
            await recordSummariesForSessionRow(domainId, s.recordIds),
        )));
        const userIds = [...new Set(rows.map((s) => s.uid))];
        const udict = await user.getList(domainId, userIds);

        const hasActiveFilters = !!(uidOrName || kind || recordType || listStatus);

        this.response.template = 'session_domain.html';
        this.response.body = {
            sessions,
            page,
            page_name: 'session_domain',
            count,
            pageCount: Math.ceil(count / pageSize) || 1,
            filterUidOrName: uidOrName,
            filterKind: kind || '',
            filterRecordType: recordType || '',
            filterStatus: listStatus || '',
            sessionListFilterQuery,
            hasActiveFilters,
            sessionConnUidOrName,
            udict,
        };
    }
}

class SessionConnectionHandler extends ConnectionHandler {
    /** undefined = all users in domain (requires PERM_VIEW_RECORD). */
    watchUid?: number;
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;

    @param('domainId', Types.String, true)
    @param('uidOrName', Types.UidOrName, true)
    async prepare(domainId?: string, uidOrName?: string) {
        try {
            const q = (this.request.query.domainId as string) || domainId || this.args.domainId;
            if (!q) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            this.args.domainId = q;
            this.checkPriv(PRIV.PRIV_USER_PROFILE);

            if (uidOrName) {
                const udoc = await user.getById(q, +uidOrName)
                    || await user.getByUname(q, uidOrName)
                    || await user.getByEmail(q, uidOrName);
                if (udoc) {
                    this.watchUid = udoc._id;
                    if (this.watchUid !== this.user._id) {
                        this.checkPerm(PERM.PERM_VIEW_RECORD);
                    }
                } else {
                    this.watchUid = undefined;
                    this.checkPerm(PERM.PERM_VIEW_RECORD);
                }
            } else {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
                this.watchUid = undefined;
            }

            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
        } catch (e: any) {
            try {
                this.close(4000, e.message || String(e));
            } catch {
            }
        }
    }

    async message(msg: { uids?: string[]; sids?: string[] }) {
        const domainId = this.args.domainId;
        if (msg.sids instanceof Array && msg.sids.length) {
            for (const sid of msg.sids) {
                if (!ObjectId.isValid(sid)) continue;
                const doc = await SessionModel.coll.findOne({ _id: new ObjectId(sid), domainId });
                if (doc) {
                    await this.sendSessionUpdate(doc as SessionDoc);
                }
            }
            return;
        }
        if (!(msg.uids instanceof Array)) return;
        const uids = msg.uids.map((id) => Number(id)).filter((n) => Number.isFinite(n));
        for (const uid of uids) {
            const docs = await SessionModel.coll.find({ domainId, uid }).toArray();
            for (const doc of docs) {
                await this.sendSessionUpdate(doc as SessionDoc);
            }
        }
    }

    @subscribe('session/change')
    async onSessionChange(doc: SessionDoc) {
        if (doc.domainId !== this.args.domainId) return;
        if (this.watchUid != null && doc.uid !== this.watchUid) return;
        await this.sendSessionUpdate(doc);
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: SessionRecordDoc) {
        if (rdoc.domainId !== this.args.domainId) return;
        const q: Record<string, unknown> = {
            domainId: this.args.domainId,
            recordIds: rdoc._id,
        };
        if (this.watchUid != null) (q as any).uid = this.watchUid;
        const sessions = await SessionModel.coll.find(q).toArray();
        for (const sdoc of sessions) {
            await this.sendSessionUpdate(sdoc as SessionDoc);
        }
    }

    async sendSessionUpdate(sdoc: SessionDoc) {
        const udoc = await user.getById(this.args.domainId, sdoc.uid);
        const recordSummaries = await recordSummariesForSessionRow(this.args.domainId, sdoc.recordIds);
        const session = buildSessionListRow(this, sdoc, recordSummaries);
        const key = sdoc._id.toString();
        this.queue.set(key, async () => ({
            html: await this.renderHTML('session_domain_tr.html', { session, udoc }),
        }));
        this.throttleQueueClear();
    }

    async queueClear() {
        await Promise.all([...this.queue.values()].map(async (fn) => this.send(await fn())));
        this.queue.clear();
    }

    async cleanup() {
        this.queue.clear();
    }
}

/** Own-domain session updates (JSON) for lesson UI — no PERM_VIEW_RECORD required. */
class SessionMeLessonConnectionHandler extends ConnectionHandler {
    @param('domainId', Types.String, true)
    async prepare(domainId?: string) {
        try {
            const q = (this.request.query.domainId as string) || domainId || this.args.domainId;
            if (!q) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            this.args.domainId = q;
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const doc = await SessionModel.get(q, this.user._id);
            await this.send({ type: 'learnSession', event: 'snapshot', session: sessionDocToWire(doc) });
        } catch (e: any) {
            try {
                this.close(4000, e.message || String(e));
            } catch {
            }
        }
    }

    @subscribe('session/change')
    async onSessionChange(doc: SessionDoc) {
        if (doc.domainId !== this.args.domainId || doc.uid !== this.user._id) return;
        await this.send({ type: 'learnSession', event: 'update', session: sessionDocToWire(doc) });
    }
}

export async function apply(ctx: Context) {
    ctx.Route('session_me', '/session/me', SessionMeHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('session_develop_start', '/session/develop/start', DevelopSessionStartHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('session_develop_settle', '/session/develop/settle', DevelopSessionSettleHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('session_domain', '/session', SessionDomainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('session_conn', '/session-conn', SessionConnectionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('session_me_conn', '/session-me-conn', SessionMeLessonConnectionHandler, PRIV.PRIV_USER_PROFILE);
}
