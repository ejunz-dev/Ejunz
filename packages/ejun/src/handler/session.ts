import { throttle } from 'lodash';
import type { Context } from '../context';
import { ValidationError } from '../error';
import {
    ConnectionHandler,
    Handler,
    param,
    query,
    subscribe,
    Types,
} from '../service/server';
import { PERM, PRIV } from '../model/builtin';
import type { RecordDoc } from '../model/record';
import SessionModel, { type SessionDoc, type SessionPatch } from '../model/session';
import user from '../model/user';
import { recordSummariesForSessionRow } from './record';

/** JSON-safe session document for lesson WebSocket clients. */
export function sessionDocToWire(doc: SessionDoc | null): Record<string, unknown> | null {
    if (!doc) return null;
    const d: any = { ...doc };
    if (d._id && typeof d._id.toString === 'function') d._id = d._id.toString();
    for (const k of ['createdAt', 'updatedAt', 'lastActivityAt']) {
        if (d[k] instanceof Date) d[k] = d[k].toISOString();
    }
    return d;
}

const ACTIVITY_MS = 5 * 60 * 1000;

function rowStatus(doc: SessionDoc): 'active' | 'detached' {
    const t = doc.lastActivityAt ? new Date(doc.lastActivityAt).getTime() : 0;
    return Date.now() - t < ACTIVITY_MS ? 'active' : 'detached';
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
    if (body.appRoute === 'learn' || body.appRoute === 'collect' || body.appRoute === 'flag') {
        patch.appRoute = body.appRoute;
    }
    if (body.lessonMode === null || body.lessonMode === 'today' || body.lessonMode === 'node' || body.lessonMode === 'allDomains') {
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
    if (body.allDomainsEntryDomainId !== undefined) {
        patch.allDomainsEntryDomainId = body.allDomainsEntryDomainId === null || body.allDomainsEntryDomainId === ''
            ? null
            : String(body.allDomainsEntryDomainId);
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

/** GET / POST own progress (JSON, for lesson client). */
class SessionMeHandler extends Handler {
    async get(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const doc = await SessionModel.get(domainId, this.user._id);
        this.response.body = { session: doc };
    }

    async post(domainId: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const patch = readPatch(this.request.body);
        const doc = await SessionModel.touch(domainId, this.user._id, patch);
        this.response.body = { session: doc };
    }
}

/** Live learn session list (HTML), same idea as room_domain. */
export class SessionDomainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('uidOrName', Types.UidOrName, true)
    async get(domainId: string, page = 1, uidOrName?: string) {
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
        const { rows, count } = await SessionModel.listPage(
            domainId,
            filterUid,
            page,
            pageSize,
        );
        const sessions = await Promise.all(rows.map(async (s) => ({
            ...s,
            status: rowStatus(s),
            recordSummaries: await recordSummariesForSessionRow(domainId, s.recordIds),
        })));
        const userIds = [...new Set(rows.map((s) => s.uid))];
        const udict = await user.getList(domainId, userIds);

        this.response.template = 'session_domain.html';
        this.response.body = {
            sessions,
            page,
            page_name: 'session_domain',
            count,
            pageCount: Math.ceil(count / pageSize) || 1,
            filterUidOrName: uidOrName,
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

    async message(msg: { uids: string[] }) {
        if (!(msg.uids instanceof Array)) return;
        const uids = msg.uids.map((id) => Number(id)).filter((n) => Number.isFinite(n));
        for (const uid of uids) {
            const doc = await SessionModel.get(this.args.domainId, uid);
            if (doc) await this.sendSessionUpdate(doc);
        }
    }

    @subscribe('session/change')
    async onSessionChange(doc: SessionDoc) {
        if (doc.domainId !== this.args.domainId) return;
        if (this.watchUid != null && doc.uid !== this.watchUid) return;
        await this.sendSessionUpdate(doc);
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: RecordDoc) {
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
        const session = { ...sdoc, status: rowStatus(sdoc), recordSummaries };
        const key = String(sdoc.uid);
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
    ctx.Route('session_domain', '/session', SessionDomainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('session_conn', '/session-conn', SessionConnectionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('session_me_conn', '/session-me-conn', SessionMeLessonConnectionHandler, PRIV.PRIV_USER_PROFILE);
}
