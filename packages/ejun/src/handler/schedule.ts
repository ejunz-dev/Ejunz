import { throttle } from 'lodash';
import { ObjectId } from 'mongodb';
import type { Context } from '../context';
import {
    ConnectionHandler,
    Handler,
    query,
    subscribe,
    Types,
} from '../service/server';
import { PERM, PRIV } from '../model/builtin';
import AgentScheduleModel, { type AgentScheduleDoc, type AgentScheduleRunDoc } from '../model/agent_schedule';
import user from '../model/user';

function commandPreview(command: string): string {
    const text = String(command || '').replace(/\s+/g, ' ').trim();
    return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

function scheduleDisplay(self: Handler | ConnectionHandler, doc: AgentScheduleDoc) {
    const id = doc._id.toHexString();
    return {
        ...AgentScheduleModel.toView(doc),
        commandPreview: commandPreview(doc.command),
        statusLabel: doc.deletedAt ? 'deleted' : doc.endedAt ? 'ended' : doc.enabled ? 'enabled' : 'paused',
        historyUrl: `${self.url('schedule_history', { domainId: doc.domainId })}?scheduleId=${encodeURIComponent(id)}`,
    };
}

function runDisplay(self: Handler | ConnectionHandler, run: AgentScheduleRunDoc, schedule?: AgentScheduleDoc) {
    const rid = run.recordId?.toHexString?.();
    const sid = run.agentChatSessionId?.toHexString?.();
    return {
        ...run,
        id: run._id.toHexString(),
        scheduleTitle: schedule?.title || run.scheduleId.toHexString(),
        commandPreview: commandPreview(run.command),
        recordUrl: rid ? self.url('record_detail', { domainId: run.domainId, rid }) : '',
        sessionUrl: sid ? self.url('session_chat_detail', { domainId: run.domainId, sid }) : '',
    };
}

function parseOid(value?: string): ObjectId | undefined {
    if (!value || !ObjectId.isValid(value)) return undefined;
    return new ObjectId(value);
}

function oidString(value: unknown): string {
    if (value instanceof ObjectId) return value.toHexString();
    return String(value || '');
}

function idsFromMessage(value: unknown): ObjectId[] {
    if (!(value instanceof Array)) return [];
    return value.filter((id) => typeof id === 'string' && ObjectId.isValid(id)).map((id) => new ObjectId(id));
}

function queryString(parts: Record<string, string | undefined>): string {
    const params = new URLSearchParams();
    for (const key in parts) {
        if (parts[key]) params.set(key, parts[key]!);
    }
    return params.toString();
}

class ScheduleMainHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('agentId', Types.String, true)
    @query('enabled', Types.String, true)
    @query('scheduleId', Types.String, true)
    async get(domainId: string, page = 1, agentId = '', enabled = '', scheduleId = '') {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const filter: Record<string, unknown> = {};
        if (!this.user.hasPerm(PERM.PERM_VIEW_RECORD)) filter.uid = this.user._id;
        if (agentId) filter.agentId = agentId;
        if (enabled === 'true') filter.enabled = true;
        if (enabled === 'false') filter.enabled = false;
        const sid = parseOid(scheduleId);
        if (sid) filter._id = sid;

        const pageSize = 20;
        const res = await AgentScheduleModel.list(domainId, filter as any, { page, limit: pageSize });
        const schedules = res.rows.map((doc) => scheduleDisplay(this, doc));
        const udict = await user.getList(domainId, [...new Set(res.rows.map((doc) => doc.uid))]);

        this.response.template = 'schedule_main.html';
        this.response.body = {
            schedules,
            udict,
            page: res.page,
            count: res.count,
            pageCount: Math.ceil(res.count / pageSize) || 1,
            filterAgentId: agentId,
            filterEnabled: enabled,
            filterScheduleId: scheduleId,
            scheduleConnQuery: queryString({ domainId, agentId, enabled, scheduleId }),
        };
    }
}

class ScheduleHistoryHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    @query('scheduleId', Types.String, true)
    @query('agentId', Types.String, true)
    @query('status', Types.String, true)
    async get(domainId: string, page = 1, scheduleId = '', agentId = '', status = '') {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const filter: Record<string, unknown> = {};
        if (!this.user.hasPerm(PERM.PERM_VIEW_RECORD)) filter.uid = this.user._id;
        const sid = parseOid(scheduleId);
        if (sid) filter.scheduleId = sid;
        if (agentId) filter.agentId = agentId;
        if (status) filter.status = status;

        const pageSize = 20;
        const res = await AgentScheduleModel.history(domainId, filter as any, { page, limit: pageSize });
        const scheduleIds = [...new Set(res.rows.map((run) => run.scheduleId.toHexString()))].map((id) => new ObjectId(id));
        const scheduleRows = scheduleIds.length
            ? await AgentScheduleModel.coll.find({ domainId, _id: { $in: scheduleIds } }).toArray() as AgentScheduleDoc[]
            : [];
        const scheduleMap = new Map(scheduleRows.map((doc) => [doc._id.toHexString(), doc]));
        const runs = res.rows.map((run) => runDisplay(this, run, scheduleMap.get(run.scheduleId.toHexString())));
        const udict = await user.getList(domainId, [...new Set(res.rows.map((run) => run.uid))]);

        this.response.template = 'schedule_history.html';
        this.response.body = {
            runs,
            udict,
            page: res.page,
            count: res.count,
            pageCount: Math.ceil(res.count / pageSize) || 1,
            filterScheduleId: scheduleId,
            filterAgentId: agentId,
            filterStatus: status,
            scheduleHistoryConnQuery: queryString({ domainId, scheduleId, agentId, status }),
        };
    }
}

class ScheduleMainConnectionHandler extends ConnectionHandler {
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;
    filterAgentId = '';
    filterEnabled = '';
    filterScheduleId?: ObjectId;

    async prepare() {
        try {
            const domainId = String(this.request.query.domainId || this.args.domainId || '');
            if (!domainId) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            this.args.domainId = domainId;
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            this.filterAgentId = String(this.request.query.agentId || '');
            this.filterEnabled = String(this.request.query.enabled || '');
            this.filterScheduleId = parseOid(String(this.request.query.scheduleId || ''));
            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
        } catch (e: any) {
            try { this.close(4000, e.message || String(e)); } catch { /* ignore */ }
        }
    }

    async message(msg: { scheduleIds?: string[] }) {
        const ids = idsFromMessage(msg.scheduleIds);
        if (!ids.length) return;
        const rows = await AgentScheduleModel.coll.find({
            domainId: this.args.domainId,
            _id: { $in: ids },
        }).toArray() as AgentScheduleDoc[];
        for (const doc of rows) await this.sendScheduleUpdate(doc);
    }

    @subscribe('agent_schedule/change' as any)
    async onScheduleChange(doc: AgentScheduleDoc) {
        if (doc.domainId !== this.args.domainId) return;
        await this.sendScheduleUpdate(doc);
    }

    matches(doc: AgentScheduleDoc) {
        if (!AgentScheduleModel.isVisible(doc)) return false;
        if (!this.user.hasPerm(PERM.PERM_VIEW_RECORD) && doc.uid !== this.user._id) return false;
        if (this.filterAgentId && doc.agentId !== this.filterAgentId) return false;
        if (this.filterEnabled === 'true' && !doc.enabled) return false;
        if (this.filterEnabled === 'false' && doc.enabled) return false;
        if (this.filterScheduleId && !doc._id.equals(this.filterScheduleId)) return false;
        return true;
    }

    async sendScheduleUpdate(doc: AgentScheduleDoc) {
        const id = doc._id.toHexString();
        if (!this.matches(doc)) {
            this.queue.set(id, async () => ({ type: 'remove', id }));
            this.throttleQueueClear();
            return;
        }
        const udoc = await user.getById(this.args.domainId, doc.uid);
        const schedule = scheduleDisplay(this, doc);
        this.queue.set(id, async () => ({
            type: 'schedule',
            id,
            html: await this.renderHTML('schedule_main_tr.html', { schedule, udoc }),
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

class ScheduleActionHandler extends Handler {
    async post(domainId: string | Record<string, any>, args: Record<string, any> = {}) {
        await this.checkPriv(PRIV.PRIV_USER_PROFILE);
        const actualDomainId = typeof domainId === 'string' ? domainId : this.args.domainId;
        args = this.request.body || (typeof domainId === 'object' ? domainId : args) || {};
        const scheduleId = String(args.scheduleId || '').trim();
        const action = String(args.action || '').trim();
        if (!scheduleId || !ObjectId.isValid(scheduleId)) throw new Error('Invalid schedule id');
        const doc = await AgentScheduleModel.get(actualDomainId, scheduleId);
        if (!doc) throw new Error('Schedule not found');
        if (!this.user.hasPerm(PERM.PERM_VIEW_RECORD) && doc.uid !== this.user._id) throw new Error('Schedule not found');
        if (action !== 'delete' && (doc.deletedAt || doc.endedAt)) throw new Error('Schedule is no longer editable');
        if (action === 'pause') {
            const updated = await AgentScheduleModel.pause(actualDomainId, doc._id);
            this.response.body = { ok: 1, schedule: AgentScheduleModel.toView(updated) };
            return;
        }
        if (action === 'resume') {
            const updated = await AgentScheduleModel.resume(actualDomainId, doc._id);
            this.response.body = { ok: 1, schedule: AgentScheduleModel.toView(updated) };
            return;
        }
        if (action === 'delete') {
            await AgentScheduleModel.softDelete(actualDomainId, doc._id);
            this.response.body = { ok: 1 };
            return;
        }
        if (action === 'update') {
            const patch: any = {};
            for (const key of ['agentId', 'title', 'command', 'scheduleType', 'executeAt', 'intervalUnit', 'timezone', 'description', 'endAt']) {
                if (args[key] !== undefined) patch[key] = args[key];
            }
            for (const key of ['intervalCount', 'maxRuns']) {
                if (args[key] !== undefined && args[key] !== '') patch[key] = Number(args[key]);
                else if (args[key] === '') patch[key] = undefined;
            }
            const updated = await AgentScheduleModel.update(actualDomainId, doc._id, patch);
            this.response.body = { ok: 1, schedule: AgentScheduleModel.toView(updated) };
            return;
        }
        throw new Error('Unknown schedule action');
    }
}

class ScheduleHistoryConnectionHandler extends ConnectionHandler {
    queue: Map<string, () => Promise<any>> = new Map();
    throttleQueueClear: () => void;
    filterScheduleId?: ObjectId;
    filterAgentId = '';
    filterStatus = '';

    async prepare() {
        try {
            const domainId = String(this.request.query.domainId || this.args.domainId || '');
            if (!domainId) {
                this.close(4000, 'Domain ID is required');
                return;
            }
            this.args.domainId = domainId;
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            this.filterScheduleId = parseOid(String(this.request.query.scheduleId || ''));
            this.filterAgentId = String(this.request.query.agentId || '');
            this.filterStatus = String(this.request.query.status || '');
            this.throttleQueueClear = throttle(this.queueClear, 100, { trailing: true });
        } catch (e: any) {
            try { this.close(4000, e.message || String(e)); } catch { /* ignore */ }
        }
    }

    async message(msg: { runIds?: string[] }) {
        const ids = idsFromMessage(msg.runIds);
        if (!ids.length) return;
        const rows = await AgentScheduleModel.runColl.find({
            domainId: this.args.domainId,
            _id: { $in: ids },
        }).toArray() as AgentScheduleRunDoc[];
        for (const run of rows) await this.sendRunUpdate(run);
    }

    @subscribe('agent_schedule_run/change' as any)
    async onRunChange(run: AgentScheduleRunDoc) {
        if (run.domainId !== this.args.domainId) return;
        await this.sendRunUpdate(run);
    }

    matches(run: AgentScheduleRunDoc) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_RECORD) && run.uid !== this.user._id) return false;
        if (this.filterScheduleId && !run.scheduleId.equals(this.filterScheduleId)) return false;
        if (this.filterAgentId && run.agentId !== this.filterAgentId) return false;
        if (this.filterStatus && run.status !== this.filterStatus) return false;
        return true;
    }

    async sendRunUpdate(run: AgentScheduleRunDoc) {
        const id = run._id.toHexString();
        if (!this.matches(run)) {
            this.queue.set(id, async () => ({ type: 'remove', id }));
            this.throttleQueueClear();
            return;
        }
        const [schedule, udoc] = await Promise.all([
            AgentScheduleModel.get(this.args.domainId, run.scheduleId),
            user.getById(this.args.domainId, run.uid),
        ]);
        const displayRun = runDisplay(this, run, schedule || undefined);
        this.queue.set(id, async () => ({
            type: 'run',
            id,
            html: await this.renderHTML('schedule_history_tr.html', { run: displayRun, udoc }),
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

export async function apply(ctx: Context) {
    ctx.Route('schedule_main', '/schedule', ScheduleMainHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('schedule_history', '/schedule/history', ScheduleHistoryHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('schedule_action', '/schedule/action', ScheduleActionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('schedule_conn', '/schedule-conn', ScheduleMainConnectionHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Connection('schedule_history_conn', '/schedule/history-conn', ScheduleHistoryConnectionHandler, PRIV.PRIV_USER_PROFILE);
}
