import {
    omit, pick, throttle, uniqBy,
} from 'lodash';
import { Filter, ObjectId } from 'mongodb';
import {
    PermissionError,
    RecordNotFoundError, UserNotFoundError, NotFoundError,
} from '../error';
import { RecordDoc } from '../interface';
import { PERM, PRIV, STATUS } from '../model/builtin';
import record from '../model/record';
import system from '../model/system';
import TaskModel from '../model/task';
import user from '../model/user';
import Agent from '../model/agent';
import {
    Handler, ConnectionHandler, param, subscribe, Types,
} from '../service/server';
import { buildProjection } from '../utils';

class RecordListHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('status', Types.String, true)
    @param('aid', Types.String, true)
    @param('fullStatus', Types.Boolean)
    @param('all', Types.Boolean)
    @param('allDomain', Types.Boolean)
    async get(
        domainId: string, page = 1,
        uidOrName?: string, status?: string, aid?: string,
        full = false,
        all = false, allDomain = false,
    ) {
        this.response.template = 'record_main.html';
        const q: Filter<RecordDoc> = {};
        // 只查询 task record（通过 agentId 存在来识别）
        (q as any).agentId = { $exists: true, $ne: null };
        
        // 支持按 agent ID 过滤（从 task-record 路由迁移）
        if (aid) {
            const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
            try {
                const adoc = await Agent.get(domainId, normalizedId);
                if (adoc) {
                    (q as any).agentId = adoc.aid || (adoc as any).docId?.toString() || aid;
                } else {
                    (q as any).agentId = aid;
                }
            } catch {
                (q as any).agentId = aid;
            }
        }
        
        if (full) uidOrName = this.user._id.toString();
        if (uidOrName) {
            const udoc = await user.getById(domainId, +uidOrName)
                || await user.getByUname(domainId, uidOrName)
                || await user.getByEmail(domainId, uidOrName);
            if (udoc) q.uid = udoc._id;
        }
        if (q.uid !== this.user._id) this.checkPerm(PERM.PERM_VIEW_RECORD);
        
        // 支持字符串状态过滤（waiting, fetched, working, pending, delivered, 以及各种error）
        if (status) {
            const statusMap: Record<string, number> = {
                'waiting': STATUS.STATUS_TASK_WAITING,
                'fetched': STATUS.STATUS_TASK_FETCHED,
                'processing': STATUS.STATUS_TASK_PROCESSING,
                'pending': STATUS.STATUS_TASK_PENDING,
                'delivered': STATUS.STATUS_TASK_DELIVERED,
                'error-tool': STATUS.STATUS_TASK_ERROR_TOOL,
                'error-not-found': STATUS.STATUS_TASK_ERROR_NOT_FOUND,
                'error-server': STATUS.STATUS_TASK_ERROR_SERVER,
                'error-network': STATUS.STATUS_TASK_ERROR_NETWORK,
                'error-timeout': STATUS.STATUS_TASK_ERROR_TIMEOUT,
                'error-system': STATUS.STATUS_TASK_ERROR_SYSTEM,
                'error-unknown': STATUS.STATUS_TASK_ERROR_UNKNOWN,
                // 向后兼容
                'working': STATUS.STATUS_TASK_PROCESSING,
                'running': STATUS.STATUS_TASK_PROCESSING,
                'completed': STATUS.STATUS_TASK_DELIVERED,
                'failed': STATUS.STATUS_TASK_ERROR_UNKNOWN,
            };
            if (statusMap[status] !== undefined) {
                q.status = statusMap[status];
            }
        }
        if (allDomain) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        let cursor = record.getMulti(allDomain ? '' : domainId, q).sort('_id', -1);
        if (!full) cursor = cursor.project(buildProjection(record.PROJECTION_LIST));
        const limit = full ? 10 : system.get('pagination.record');
        const rdocs = await cursor.skip((page - 1) * limit).limit(limit).toArray();
        
        // 加载 agent 信息（所有记录都是 agent task record）
        const agentIds = [...new Set(rdocs.map((r: any) => r.agentId).filter(Boolean))];
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
        
        const [udict] = full ? [{}]
            : await Promise.all([
                user.getList(domainId, rdocs.map((rdoc) => rdoc.uid)),
            ]);
        this.response.body = {
            page,
            rdocs,
            udict,
            adict,
            all,
            allDomain,
            filterUidOrName: uidOrName,
            filterStatus: status,
            filterAid: aid,
        };
    }
}

class RecordDetailHandler extends Handler {
    rdoc: RecordDoc;

    @param('rid', Types.ObjectId)
    async prepare(domainId: string, rid: ObjectId) {
        // 验证 rid 是有效的 ObjectId 格式（24 个十六进制字符），避免匹配静态资源文件
        const ridStr = rid.toString();
        if (!/^[0-9a-fA-F]{24}$/.test(ridStr)) {
            throw new RecordNotFoundError(rid);
        }
        this.rdoc = await record.get(domainId, rid);
        if (!this.rdoc) throw new RecordNotFoundError(rid);
        if (this.rdoc.uid !== this.user._id) this.checkPerm(PERM.PERM_VIEW_RECORD);
    }

    @param('rid', Types.ObjectId)
    @param('rev', Types.ObjectId, true)
    async get(domainId: string, rid: ObjectId, rev?: ObjectId) {
        let rdoc = this.rdoc;
        const r = rdoc as any;
        
        // collHistory 相关逻辑已移除（judge 相关功能已删除）
        const allRevs: Record<string, Date> = {};
        // rev 参数已不再使用（judge 历史版本功能已删除）
        const udoc = await user.getById(domainId, rdoc.uid);
        
        // 加载 agent 信息（所有记录都是 agent task record）
        let adoc = null;
        if (r.agentId) {
            const Agent = require('./agent').Agent;
            try {
                adoc = await Agent.get(domainId, r.agentId);
            } catch (e) {
                // ignore
            }
        }
        
        this.response.template = 'record_detail.html';
        this.response.body = {
            udoc, rdoc, rev, allRevs, adoc,
        };
    }

}

class RecordMainConnectionHandler extends ConnectionHandler {
    all = false;
    allDomain = false;
    uid: number;
    status: number;
    aid?: string;
    pretest = false;
    applyProjection = false;
    noTemplate = false;
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;

    @param('uidOrName', Types.UidOrName, true)
    @param('status', Types.String, true)
    @param('aid', Types.String, true)
    @param('pretest', Types.Boolean)
    @param('all', Types.Boolean)
    @param('allDomain', Types.Boolean)
    @param('noTemplate', Types.Boolean, true)
    async prepare(
        domainId: string, uidOrName?: string,
        status?: string, aid?: string,
        pretest = false, all = false, allDomain = false, noTemplate = false,
    ) {
        try {
            const finalDomainId = domainId || this.request.query.domainId as string || this.args.domainId;
            
            if (!finalDomainId) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            
            this.args.domainId = finalDomainId;
            
            if (pretest) {
                this.pretest = true;
                this.uid = this.user._id;
            } else if (uidOrName) {
                let udoc = await user.getById(finalDomainId, +uidOrName);
                if (udoc) this.uid = udoc._id;
                else {
                    udoc = await user.getByUname(finalDomainId, uidOrName);
                    if (udoc) this.uid = udoc._id;
                    else {
                        this.close(4000, `User not found: ${uidOrName}`);
                        return;
                    }
                }
            }
            
            if (this.uid && this.uid !== this.user._id) {
                this.checkPerm(PERM.PERM_VIEW_RECORD);
            }
            
            if (status) {
                const statusMap: Record<string, number> = {
                    'waiting': STATUS.STATUS_TASK_WAITING,
                    'fetched': STATUS.STATUS_TASK_FETCHED,
                    'processing': STATUS.STATUS_TASK_PROCESSING,
                    'pending': STATUS.STATUS_TASK_PENDING,
                    'delivered': STATUS.STATUS_TASK_DELIVERED,
                    'error-tool': STATUS.STATUS_TASK_ERROR_TOOL,
                    'error-not-found': STATUS.STATUS_TASK_ERROR_NOT_FOUND,
                    'error-server': STATUS.STATUS_TASK_ERROR_SERVER,
                    'error-network': STATUS.STATUS_TASK_ERROR_NETWORK,
                    'error-timeout': STATUS.STATUS_TASK_ERROR_TIMEOUT,
                    'error-system': STATUS.STATUS_TASK_ERROR_SYSTEM,
                    'error-unknown': STATUS.STATUS_TASK_ERROR_UNKNOWN,
                    'working': STATUS.STATUS_TASK_PROCESSING,
                    'running': STATUS.STATUS_TASK_PROCESSING,
                    'completed': STATUS.STATUS_TASK_DELIVERED,
                    'failed': STATUS.STATUS_TASK_ERROR_UNKNOWN,
                };
                if (statusMap[status] !== undefined) {
                    this.status = statusMap[status];
                }
            }
            
            if (aid) {
                const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
                try {
                    const adoc = await Agent.get(finalDomainId, normalizedId);
                    if (adoc) {
                        this.aid = adoc.aid || (adoc as any).docId?.toString() || aid;
                    } else {
                        this.aid = aid;
                    }
                } catch {
                    this.aid = aid;
                }
            }
            
        if (all) {
            this.all = true;
        }
        if (allDomain) {
                this.checkPriv(PRIV.PRIV_MANAGE_ALL_DOMAIN);
            this.allDomain = true;
        }
            this.noTemplate = noTemplate;
            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
        } catch (error: any) {
            try {
                this.close(4000, error.message || String(error));
            } catch (e) {
                // ignore
            }
        }
    }

    async message(msg: { rids: string[] }) {
        if (!(msg.rids instanceof Array)) return;
        const rids = msg.rids.map((id) => new ObjectId(id));
        const rdocs = await record.getMulti(this.args.domainId, { _id: { $in: rids } })
            .project<RecordDoc>(buildProjection(record.PROJECTION_LIST)).toArray();
        for (const rdoc of rdocs) this.onRecordChange(rdoc);
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: RecordDoc) {
        const r = rdoc as any;
        
        // 只处理 task 记录（通过 agentId 存在来识别）
        if (!r.agentId) return;
        
        if (!this.allDomain) {
            if (r.domainId !== this.args.domainId) return;
        }
        
        if (typeof this.uid === 'number' && r.uid !== this.uid) return;
        if (this.status && r.status !== this.status) return;
        if (this.aid && r.agentId !== this.aid) return;

        const udoc = await user.getById(this.args.domainId, r.uid);
        
        let adoc = null;
        if (r.agentId) {
            try {
                adoc = await Agent.get(this.args.domainId, r.agentId);
            } catch (e) {
                // ignore
            }
        }
        
        if (this.pretest) {
            this.queueSend(r._id.toHexString(), async () => ({ rdoc: omit(r, ['code', 'input']) }));
        } else if (this.noTemplate) {
            this.queueSend(r._id.toHexString(), async () => ({ rdoc }));
        } else {
            this.queueSend(r._id.toHexString(), async () => ({
                html: await this.renderHTML('task_record_main_tr.html', {
                    rdoc, udoc, adoc, r, allDomain: this.allDomain,
                }),
            }));
        }
    }

    queueSend(rid: string, fn: () => Promise<any>) {
        this.queue.set(rid, fn);
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

class RecordDetailConnectionHandler extends ConnectionHandler {
    rid: string = '';
    disconnectTimeout: NodeJS.Timeout;
    throttleSend: any;
    noTemplate = false;

    @param('rid', Types.ObjectId)
    @param('noTemplate', Types.Boolean, true)
    async prepare(domainId: string, rid: ObjectId, noTemplate = false) {
        const rdoc = await record.get(domainId, rid);
        if (!rdoc) return;
        this.noTemplate = noTemplate;
        this.throttleSend = throttle(this.sendUpdate, 1000, { trailing: true });
        this.rid = rid.toString();
        this.onRecordChange(rdoc);
    }

    async sendUpdate(rdoc: RecordDoc) {
        if (this.noTemplate) {
            this.send({ rdoc });
        } else {
            this.send({
                status: rdoc.status,
                status_html: await this.renderHTML('record_detail_status.html', { rdoc }),
                summary_html: await this.renderHTML('record_detail_summary.html', { rdoc }),
            });
        }
    }

    @subscribe('record/change')
    // eslint-disable-next-line
    async onRecordChange(rdoc: RecordDoc, $set?: any, $push?: any) {
        if (rdoc._id.toString() !== this.rid) return;
        if (this.disconnectTimeout) {
            clearTimeout(this.disconnectTimeout);
            this.disconnectTimeout = null;
        }
        if (![STATUS.STATUS_TASK_WAITING, STATUS.STATUS_TASK_FETCHED, STATUS.STATUS_TASK_PROCESSING, STATUS.STATUS_TASK_PENDING].includes(rdoc.status)) {
            this.disconnectTimeout = setTimeout(() => this.close(4001, 'Ended'), 30000);
        }
        this.throttleSend(rdoc);
    }
}

// Task record handlers
class TaskRecordListHandler extends Handler {
    @param('page', Types.PositiveInt, true)
    @param('aid', Types.String, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('status', Types.String, true)
    async get(
        domainId: string,
        page = 1,
        aid?: string,
        uidOrName?: string,
        status?: string,
    ) {
        this.response.template = 'task_record_main.html';
        const q: Filter<RecordDoc> = {
            agentId: { $exists: true, $ne: null },
        } as any;
        
        if (aid) {
            const normalizedId: number | string = /^\d+$/.test(aid) ? Number(aid) : aid;
            const adoc = await Agent.get(domainId, normalizedId);
            if (adoc) {
                (q as any).agentId = adoc.aid || (adoc as any).docId?.toString() || aid;
            } else {
                (q as any).agentId = aid;
            }
        }
        
        if (uidOrName) {
            const udoc = await user.getById(domainId, +uidOrName)
                || await user.getByUname(domainId, uidOrName)
                || await user.getByEmail(domainId, uidOrName);
            if (udoc) (q as any).uid = udoc._id;
        }
        
        if (status) {
            const statusMap: Record<string, number> = {
                'waiting': STATUS.STATUS_TASK_WAITING,
                'fetched': STATUS.STATUS_TASK_FETCHED,
                'processing': STATUS.STATUS_TASK_PROCESSING,
                'pending': STATUS.STATUS_TASK_PENDING,
                'delivered': STATUS.STATUS_TASK_DELIVERED,
                'error-tool': STATUS.STATUS_TASK_ERROR_TOOL,
                'error-not-found': STATUS.STATUS_TASK_ERROR_NOT_FOUND,
                'error-server': STATUS.STATUS_TASK_ERROR_SERVER,
                'error-network': STATUS.STATUS_TASK_ERROR_NETWORK,
                'error-timeout': STATUS.STATUS_TASK_ERROR_TIMEOUT,
                'error-system': STATUS.STATUS_TASK_ERROR_SYSTEM,
                'error-unknown': STATUS.STATUS_TASK_ERROR_UNKNOWN,
                // 向后兼容
                'working': STATUS.STATUS_TASK_PROCESSING,
                'running': STATUS.STATUS_TASK_PROCESSING,
                'completed': STATUS.STATUS_TASK_DELIVERED,
                'failed': STATUS.STATUS_TASK_ERROR_UNKNOWN,
            };
            if (statusMap[status] !== undefined) {
                (q as any).status = statusMap[status];
            }
        }
        
        if ((q as any).uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        
        const limit = system.get('pagination.record');
        const cursor = record.getMulti(domainId, q)
            .sort('_id', -1)
            .project(buildProjection(record.PROJECTION_LIST));
        
        const records = await cursor.skip((page - 1) * limit).limit(limit).toArray();
        
        const [udict, adict] = await Promise.all([
            user.getList(domainId, records.map((r: any) => r.uid)),
            Promise.all(records.map(async (r: any) => {
                try {
                    const agentId = r.agentId;
                    if (!agentId) return [null, null];
                    const adoc = await Agent.get(domainId, agentId);
                    return [agentId, adoc];
                } catch {
                    return [r.agentId, null];
                }
            })).then((results) => Object.fromEntries(results.filter(([k]) => k !== null))),
        ]);
        
        this.response.body = {
            page,
            records,
            udict,
            adict,
            filterAid: aid,
            filterUidOrName: uidOrName,
            filterStatus: status,
        };
    }
}

class TaskRecordDetailHandler extends Handler {
    record: RecordDoc;

    @param('rid', Types.ObjectId)
    async prepare(domainId: string, rid: ObjectId) {
        this.record = await record.get(domainId, rid);
        if (!this.record) throw new NotFoundError('Task record not found');
        const rdoc = this.record as any;
        // 通过 agentId 存在来识别 task 记录
        if (!rdoc.agentId) {
            throw new NotFoundError('Task record not found');
        }
        if (rdoc.uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
    }

    @param('rid', Types.ObjectId)
    async get(domainId: string, rid: ObjectId) {
        const rdoc = this.record as any;
        const agentId = rdoc.agentId;
        const [adoc, udoc] = await Promise.all([
            agentId ? Agent.get(domainId, agentId).catch(() => null) : Promise.resolve(null),
            user.getById(domainId, rdoc.uid),
        ]);
        
        this.response.template = 'task_record_detail.html';
        this.response.body = {
            record: this.record,
            adoc,
            udoc,
        };
    }
}

class TaskRecordMainConnectionHandler extends ConnectionHandler {
    aid?: string;
    uid?: number;
    status?: string;
    noTemplate = false;
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;

    @param('aid', Types.String, true)
    @param('uidOrName', Types.UidOrName, true)
    @param('status', Types.String, true)
    @param('noTemplate', Types.Boolean, true)
    @param('domainId', Types.String, true)
    async prepare(
        domainId?: string,
        aid?: string,
        uidOrName?: string,
        status?: string,
        noTemplate = false,
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
            
            if (queryAid) this.aid = queryAid;
            if (queryUidOrName) {
                const udoc = await user.getById(finalDomainId, +queryUidOrName)
                    || await user.getByUname(finalDomainId, queryUidOrName);
            if (udoc) this.uid = udoc._id;
                else {
                    this.close(4000, `User not found: ${queryUidOrName}`);
                    return;
                }
        }
        if (status) this.status = status;
            this.noTemplate = noTemplate;
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

    async message(msg: { rids: string[] }) {
        if (!(msg.rids instanceof Array)) return;
        const rids = msg.rids.map((id) => new ObjectId(id));
        const rdocs = await record.getMulti(this.args.domainId, { 
            _id: { $in: rids },
            agentId: { $exists: true, $ne: null },
        })
            .project<RecordDoc>(buildProjection(record.PROJECTION_LIST)).toArray();
        for (const rdoc of rdocs) this.onRecordChange(rdoc);
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: RecordDoc) {
        const r = rdoc as any;
        if (r.domainId !== this.args.domainId) return;
        if (!r.agentId) return;
        const agentId = r.agentId;
        if (this.aid && agentId !== this.aid) return;
        if (this.uid && r.uid !== this.uid) return;
        if (this.status) {
            const statusMap: Record<string, number> = {
                'waiting': STATUS.STATUS_TASK_WAITING,
                'fetched': STATUS.STATUS_TASK_FETCHED,
                'processing': STATUS.STATUS_TASK_PROCESSING,
                'pending': STATUS.STATUS_TASK_PENDING,
                'delivered': STATUS.STATUS_TASK_DELIVERED,
                'error-tool': STATUS.STATUS_TASK_ERROR_TOOL,
                'error-not-found': STATUS.STATUS_TASK_ERROR_NOT_FOUND,
                'error-server': STATUS.STATUS_TASK_ERROR_SERVER,
                'error-network': STATUS.STATUS_TASK_ERROR_NETWORK,
                'error-timeout': STATUS.STATUS_TASK_ERROR_TIMEOUT,
                'error-system': STATUS.STATUS_TASK_ERROR_SYSTEM,
                'error-unknown': STATUS.STATUS_TASK_ERROR_UNKNOWN,
                // 向后兼容
                'working': STATUS.STATUS_TASK_PROCESSING,
                'running': STATUS.STATUS_TASK_PROCESSING,
                'completed': STATUS.STATUS_TASK_DELIVERED,
                'failed': STATUS.STATUS_TASK_ERROR_UNKNOWN,
            };
            if (statusMap[this.status] !== r.status) return;
        }

        if (this.noTemplate) {
            // 返回 JSON 格式的 record 数据，用于前端直接处理
            this.queueSend(r._id.toHexString(), async () => ({ rdoc: r }));
        } else {
            this.queueSend(r._id.toHexString(), async () => {
                const [udoc, adoc] = await Promise.all([
                    user.getById(this.args.domainId, r.uid),
                    agentId ? Agent.get(this.args.domainId, agentId).catch(() => null) : Promise.resolve(null),
                ]);
                return {
                    html: await this.renderHTML('task_record_main_tr.html', {
                        r, udoc, adoc,
                    }),
                };
            });
        }
    }

    queueSend(rid: string, fn: () => Promise<any>) {
        this.queue.set(rid, fn);
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

class TaskRecordDetailConnectionHandler extends ConnectionHandler {
    rid: string = '';

    @param('rid', Types.ObjectId)
    async prepare(domainId: string, rid: ObjectId) {
        const rdoc = await record.get(domainId, rid);
        if (!rdoc) return;
        const r = rdoc as any;
        // 通过 agentId 存在来识别 task 记录
        if (!r.agentId) return;
        if (r.uid !== this.user._id) {
            this.checkPerm(PERM.PERM_VIEW_RECORD);
        }
        this.rid = rid.toString();
        this.onRecordChange(rdoc);
    }

    @subscribe('record/change')
    async onRecordChange(rdoc: RecordDoc) {
        const r = rdoc as any;
        if (r._id.toString() !== this.rid) return;
        // 通过 agentId 存在来识别 task 记录
        if (!r.agentId) return;
        
        const agentId = r.agentId;
        const [adoc, udoc] = await Promise.all([
            agentId ? Agent.get(r.domainId, agentId).catch(() => null) : Promise.resolve(null),
            user.getById(r.domainId, r.uid),
        ]);

        this.send({
            record: rdoc,
            adoc,
            udoc,
        });
    }
}

export async function apply(ctx) {
    ctx.Route('record_main', '/record', RecordListHandler);
    ctx.Route('record_detail', '/record/:rid', RecordDetailHandler);
    ctx.Connection('record_conn', '/record-conn', RecordMainConnectionHandler);
    ctx.Connection('record_detail_conn', '/record-detail-conn', RecordDetailConnectionHandler);
    ctx.Route('task_record_main', '/task-record', RecordListHandler);
    ctx.Route('task_record_detail', '/task-record/:rid', RecordDetailHandler);
    ctx.Connection('task_record_conn', '/task-record-conn', TaskRecordMainConnectionHandler);
    ctx.Connection('task_record_detail_conn', '/task-record-detail-conn', TaskRecordDetailConnectionHandler);
}