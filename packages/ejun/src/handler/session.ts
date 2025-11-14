import { throttle } from 'lodash';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import {
    NotFoundError,
    PermissionError,
} from '../error';
import {
    Handler, ConnectionHandler, param, post, query, subscribe, Types,
} from '../service/server';
import { PERM, PRIV, STATUS } from '../model/builtin';
import SessionModel from '../model/session';
import { SessionDoc, RecordDoc } from '../interface';
import record from '../model/record';
import user from '../model/user';
import Agent from '../model/agent';
import { buildProjection } from '../utils';

export class SessionConnectionTracker {
    private static activeConnections = new Map<string, Set<ConnectionHandler>>();

    static add(sessionId: string, handler: ConnectionHandler) {
        if (!this.activeConnections.has(sessionId)) {
            this.activeConnections.set(sessionId, new Set());
        }
        this.activeConnections.get(sessionId)!.add(handler);
    }

    static remove(sessionId: string, handler: ConnectionHandler) {
        const handlers = this.activeConnections.get(sessionId);
        if (handlers) {
            handlers.delete(handler);
            if (handlers.size === 0) {
                this.activeConnections.delete(sessionId);
            }
        }
    }

    static isActive(sessionId: string): boolean {
        return this.activeConnections.has(sessionId) && 
               this.activeConnections.get(sessionId)!.size > 0;
    }
}

async function getSessionStatus(
    domainId: string,
    sdoc: SessionDoc,
): Promise<'working' | 'active' | 'detached'> {
    if (sdoc.recordIds && sdoc.recordIds.length > 0) {
        const records = await record.getList(domainId, sdoc.recordIds);
        const hasWorkingTask = Object.values(records).some((r: any) => {
            return r.status === STATUS.STATUS_TASK_PROCESSING || 
                   r.status === STATUS.STATUS_TASK_PENDING;
        });
        if (hasWorkingTask) {
            return 'working';
        }
    }

    const sessionId = sdoc._id.toString();
    if (SessionConnectionTracker.isActive(sessionId)) {
        return 'active';
    }

    return 'detached';
}

export class SessionDomainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('aid', Types.String, true)
    @query('uidOrName', Types.UidOrName, true)
    @query('status', Types.String, true)
    async get(domainId: string, page = 1, aid?: string, uidOrName?: string, status?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const query: any = { domainId };
        
        if (uidOrName) {
            const udoc = await user.getById(domainId, +uidOrName)
                || await user.getByUname(domainId, uidOrName)
                || await user.getByEmail(domainId, uidOrName);
            if (udoc) {
                query.uid = udoc._id;
            }
        } else {
            query.uid = this.user._id;
        }
        
        if (query.uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        
        if (aid) {
            const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
            try {
                const adoc = await Agent.get(domainId, normalizedId);
                if (adoc) {
                    query.agentId = adoc.aid || (adoc as any).docId?.toString() || aid;
                } else {
                    query.agentId = aid;
                }
            } catch {
                query.agentId = aid;
            }
        }
        
        const [sessions, count] = await Promise.all([
            SessionModel.getMulti(domainId, query, {
                sort: { _id: -1 },
                limit: 20,
                skip: (page - 1) * 20,
            }).toArray(),
            SessionModel.count(domainId, query),
        ]);
        
        const recordIds = sessions.flatMap(s => s.recordIds || []);
        const records = recordIds.length > 0 
            ? await record.getList(domainId, recordIds)
            : {};
        
        const sessionsWithRecords = await Promise.all(sessions.map(async (s) => {
            const sessionRecords = (s.recordIds || []).map(rid => records[rid.toString()]).filter(Boolean);
            const sessionStatus = await getSessionStatus(domainId, s);
            return {
                ...s,
                records: sessionRecords,
                status: sessionStatus,
            };
        }));
        
        let filteredSessions = sessionsWithRecords;
        if (status) {
            filteredSessions = sessionsWithRecords.filter(s => s.status === status);
        }
        
        const agentIds = [...new Set(sessions.map((s: any) => s.agentId).filter(Boolean))];
        let adict: Record<string, any> = {};
        if (agentIds.length > 0) {
            const agentDocs = await Promise.all(
                agentIds.map(async (aid) => {
                    try {
                        const adoc = await Agent.get(domainId, aid);
                        return [aid, adoc];
                    } catch {
                        return [aid, null];
                    }
                })
            );
            adict = Object.fromEntries(agentDocs);
        }
        
        const userIds = [...new Set(sessions.map((s: any) => s.uid))];
        const udict = await user.getList(domainId, userIds);
        
        const sessionsWithRecordsArray = filteredSessions.map(s => ({
            ...s,
            records: s.records || [],
        }));

        this.response.template = 'session_domain.html';
        this.response.body = {
            sessions: sessionsWithRecordsArray,
            page,
            count: status ? filteredSessions.length : count,
            pageCount: Math.ceil((status ? filteredSessions.length : count) / 20),
            adict,
            udict,
            filterAid: aid,
            filterUidOrName: uidOrName,
            filterStatus: status,
        };
    }
}

export class SessionDetailHandler extends Handler {
    @param('sid', Types.ObjectId)
    async get(domainId: string, sid: ObjectId) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const sdoc = await SessionModel.get(domainId, sid);
        if (!sdoc) {
            throw new NotFoundError('Session not found');
        }
        if (sdoc.uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        
        const records = sdoc.recordIds && sdoc.recordIds.length > 0
            ? await record.getList(domainId, sdoc.recordIds)
            : {};
        
        const recordsList = Object.values(records).sort((a: any, b: any) => 
            a._id.getTimestamp().getTime() - b._id.getTimestamp().getTime()
        );
        
        this.response.template = 'session_detail.html';
        this.response.body = {
            session: sdoc,
            records: recordsList,
        };
    }
    
    @param('sid', Types.ObjectId)
    @post('title', Types.String, true)
    @post('operation', Types.String, true)
    async postUpdate(domainId: string, sid: ObjectId, title?: string, operation?: string) {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        
        if (operation === 'delete') {
            const sdoc = await SessionModel.get(domainId, sid);
            if (!sdoc) {
                throw new NotFoundError('Session not found');
            }
            if (sdoc.uid !== this.user._id) {
                throw new PermissionError('You can only delete your own sessions');
            }
            
            await SessionModel.delete(domainId, sid);
            this.response.redirect = this.url('session_domain', { domainId });
            return;
        }
        
        const sdoc = await SessionModel.get(domainId, sid);
        if (!sdoc) {
            throw new NotFoundError('Session not found');
        }
        if (sdoc.uid !== this.user._id) {
            throw new PermissionError('You can only update your own sessions');
        }
        
        const update: any = { updatedAt: new Date() };
        if (title !== undefined) {
            update.title = title;
        }
        
        await SessionModel.update(domainId, sid, update);
        this.response.redirect = this.url('session_detail', { domainId, sid });
    }
}

class SessionDomainConnectionHandler extends ConnectionHandler {
    aid?: string;
    uid?: number;
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;

    @param('aid', Types.String, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('domainId', Types.String, true)
    async prepare(
        domainId?: string,
        aid?: string,
        uidOrName?: string,
    ) {
        try {
            const queryDomainId = this.request.query.domainId as string || domainId || this.args.domainId;
            const queryAid = this.request.query.aid as string || aid;
            const queryUidOrName = this.request.query.uidOrName as string || uidOrName;
            const finalDomainId = queryDomainId;
            
            if (!finalDomainId) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            
            this.args.domainId = finalDomainId;
            
            if (queryAid) {
                this.aid = queryAid;
            }
            
            if (queryUidOrName) {
                const udoc = await user.getById(finalDomainId, +queryUidOrName)
                    || await user.getByUname(finalDomainId, queryUidOrName);
                if (udoc) {
                    this.uid = udoc._id;
                } else {
                    this.close(4000, `User not found: ${queryUidOrName}`);
                    return;
                }
            } else {
                this.uid = this.user._id;
            }
            
            if (this.uid !== this.user._id) {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
            }
            
            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
        } catch (error: any) {
            try {
                this.close(4000, error.message || String(error));
            } catch (e) {
                // ignore
            }
        }
    }

    async message(msg: { sids: string[] }) {
        if (!(msg.sids instanceof Array)) return;
        const sids = msg.sids.map((id) => new ObjectId(id));
        const sdocs = await SessionModel.getMulti(this.args.domainId, { _id: { $in: sids } })
            .toArray();
        for (const sdoc of sdocs) this.onSessionChange(sdoc);
    }

    @subscribe('session/change')
    async onSessionChange(sdoc: SessionDoc) {
        if (sdoc.domainId !== this.args.domainId) return;
        if (typeof this.uid === 'number') {
            if (sdoc.uid !== this.uid) return;
        } else {
            if (sdoc.uid !== this.user._id) return;
        }
        if (this.aid && sdoc.agentId !== this.aid) return;

        await this.sendSessionUpdate(sdoc);
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: RecordDoc) {
        const r = rdoc as any;
        if (!r.agentId) return;
        if (r.domainId !== this.args.domainId) return;
        if (this.uid && r.uid !== this.uid) return;
        if (this.aid && r.agentId !== this.aid) return;

        const sdocs = await SessionModel.getMulti(this.args.domainId, {
            recordIds: { $in: [r._id] },
        }).toArray();

        for (const sdoc of sdocs) {
            if (this.uid && sdoc.uid !== this.uid) continue;
            if (this.aid && sdoc.agentId !== this.aid) continue;
            await this.sendSessionUpdate(sdoc);
        }
    }

    async sendSessionUpdate(sdoc: SessionDoc) {
        const recordIds = sdoc.recordIds || [];
        const records = recordIds.length > 0 
            ? await record.getList(this.args.domainId, recordIds, [
                '_id', 'status', 'score', 'domainId', 'uid', 'agentId',
            ] as any)
            : {};
        
        const sessionRecords = recordIds.map(rid => {
            const r = records[rid.toString()];
            if (r) {
                const recordWithId = r as any;
                if (!recordWithId._id) {
                    recordWithId._id = rid;
                }
                return recordWithId;
            }
            return null;
        }).filter(Boolean);
        
        const status = await getSessionStatus(this.args.domainId, sdoc);
        
        let adoc = null;
        if (sdoc.agentId) {
            try {
                adoc = await Agent.get(this.args.domainId, sdoc.agentId);
            } catch (e) {
                // ignore
            }
        }
        
        const udoc = await user.getById(this.args.domainId, sdoc.uid);

        const sessionWithData = {
            ...sdoc,
            status,
            records: sessionRecords,
        };

        this.queueSend(sdoc._id.toHexString(), async () => ({
            html: await this.renderHTML('session_domain_tr.html', {
                session: sessionWithData,
                adoc,
                udoc,
            }),
        }));
    }

    queueSend(sid: string, fn: () => Promise<any>) {
        this.queue.set(sid, fn);
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

export async function apply(ctx: Context) {
    ctx.Route('session_domain', '/session', SessionDomainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('session_detail', '/session/:sid', SessionDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('session_domain_conn', '/session-conn', SessionDomainConnectionHandler, PRIV.PRIV_USER_PROFILE);
}

