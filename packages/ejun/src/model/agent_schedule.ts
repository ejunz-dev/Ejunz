import moment from 'moment-timezone';
import { Filter, ObjectId } from 'mongodb';
import type { Context } from '../context';
import { STATUS } from './builtin';
import bus from '../service/bus';
import Agent from './agent';
import ScheduleModel from './schedule';
import RecordModel from './record';
import db from '../service/db';
import { Logger } from '../logger';
import { enqueueAgentTask } from '../lib/agentTaskQueue';

const logger = new Logger('model/agent_schedule');
const coll = db.collection('agent_schedule');
const runColl = db.collection('agent_schedule_run');

export type AgentScheduleType = 'once' | 'interval';
export type AgentScheduleRunStatus = 'queued' | 'running' | 'success' | 'error' | 'skipped';
export type AgentScheduleIntervalUnit = 'minute' | 'hour' | 'day' | 'week' | 'month';
export type AgentScheduleEndReason = 'completed' | 'maxRuns' | 'endAt' | 'deleted';

export interface AgentScheduleDoc {
    _id: ObjectId;
    domainId: string;
    uid: number;
    agentId: string;
    title: string;
    command: string;
    enabled: boolean;
    scheduleType: AgentScheduleType;
    executeAt?: Date;
    intervalCount?: number;
    intervalUnit?: AgentScheduleIntervalUnit;
    maxRuns?: number;
    endAt?: Date;
    timezone: string;
    nextRunAt?: Date;
    lastRunAt?: Date;
    lastRunStatus?: AgentScheduleRunStatus;
    lastRunId?: ObjectId;
    runCount: number;
    createdAt: Date;
    updatedAt: Date;
    endedAt?: Date;
    endReason?: AgentScheduleEndReason;
    deletedAt?: Date;
    meta?: {
        source?: 'system_tool' | 'ui' | 'slash';
        createdByAgentId?: string;
        description?: string;
    };
}

export interface AgentScheduleRunDoc {
    _id: ObjectId;
    domainId: string;
    scheduleId: ObjectId;
    uid: number;
    agentId: string;
    command: string;
    plannedAt: Date;
    queuedAt?: Date;
    completedAt?: Date;
    status: AgentScheduleRunStatus;
    taskId?: ObjectId;
    recordId?: ObjectId;
    agentChatSessionId?: ObjectId;
    error?: { message: string; code?: string };
    createdAt: Date;
    updatedAt: Date;
}

export interface AgentScheduleInput {
    uid: number;
    agentId?: string;
    title?: string;
    command: string;
    enabled?: boolean;
    scheduleType: AgentScheduleType;
    executeAt?: string | Date;
    intervalCount?: number;
    intervalUnit?: AgentScheduleIntervalUnit;
    maxRuns?: number;
    endAt?: string | Date;
    timezone?: string;
    description?: string;
    createdByAgentId?: string;
    source?: 'system_tool' | 'ui' | 'slash';
}

function oid(value: ObjectId | string): ObjectId {
    if (value instanceof ObjectId) return value;
    if (!ObjectId.isValid(value)) throw new Error(`Invalid schedule id: ${value}`);
    return new ObjectId(value);
}

function normalizeDate(value: unknown, field: string): Date | undefined {
    if (value == null || value === '') return undefined;
    const d = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(d.getTime())) throw new Error(`Invalid ${field}`);
    return d;
}

function normalizePositiveInt(value: unknown, field: string): number | undefined {
    if (value == null || value === '') return undefined;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${field} must be a positive integer`);
    return n;
}

function normalizeIntervalUnit(unit: unknown): AgentScheduleIntervalUnit {
    const u = String(unit || '').trim().toLowerCase();
    if (u === 'minute' || u === 'minutes') return 'minute';
    if (u === 'hour' || u === 'hours') return 'hour';
    if (u === 'day' || u === 'days') return 'day';
    if (u === 'week' || u === 'weeks') return 'week';
    if (u === 'month' || u === 'months') return 'month';
    throw new Error('intervalUnit must be minute, hour, day, week, or month');
}

function computeNextRun(input: Partial<AgentScheduleDoc>, from = new Date()): Date | undefined {
    if (input.enabled === false || input.deletedAt || input.endedAt) return undefined;
    if (input.scheduleType === 'once') {
        const d = normalizeDate(input.executeAt, 'executeAt');
        return d && d.getTime() >= from.getTime() ? d : undefined;
    }
    if (input.scheduleType === 'interval') {
        if (input.maxRuns && (input.runCount || 0) >= input.maxRuns) return undefined;
        const count = Math.max(1, Math.floor(Number(input.intervalCount) || 0));
        const unit = normalizeIntervalUnit(input.intervalUnit);
        const base = input.lastRunAt || from;
        let next = moment(base).add(count, unit).toDate();
        if (next.getTime() < from.getTime()) next = moment(from).add(count, unit).toDate();
        const endAt = normalizeDate(input.endAt, 'endAt');
        if (endAt && next.getTime() > endAt.getTime()) return undefined;
        return next;
    }
    throw new Error('scheduleType must be once or interval');
}

function ruleLabel(doc: AgentScheduleDoc): string {
    if (doc.scheduleType === 'once') return `once at ${doc.executeAt?.toISOString?.() || ''}`;
    const parts = [`every ${doc.intervalCount || 1} ${doc.intervalUnit || 'day'}${(doc.intervalCount || 1) === 1 ? '' : 's'}`];
    if (doc.maxRuns) parts.push(`max ${doc.maxRuns} runs`);
    if (doc.endAt) parts.push(`until ${doc.endAt.toISOString()}`);
    return parts.join(', ');
}

function visibleScheduleMongoFilter() {
    const now = new Date();
    return {
        deletedAt: { $exists: false },
        endedAt: { $exists: false },
        $or: [
            { scheduleType: 'once', runCount: 0 },
            {
                $and: [
                    { scheduleType: 'interval' },
                    { $or: [{ endAt: { $exists: false } }, { endAt: null }, { endAt: { $gte: now } }] },
                    { $or: [{ maxRuns: { $exists: false } }, { maxRuns: null }, { $expr: { $lt: ['$runCount', '$maxRuns'] } }] },
                ],
            },
        ],
    };
}

function isTerminalAgentStatus(status?: number): boolean {
    return status === STATUS.STATUS_TASK_DELIVERED
        || status === STATUS.STATUS_TASK_ERROR_SYSTEM
        || status === STATUS.STATUS_TASK_ERROR_TOOL
        || status === STATUS.STATUS_TASK_ERROR_NOT_FOUND
        || status === STATUS.STATUS_TASK_ERROR_NOT_ADDED
        || status === STATUS.STATUS_TASK_ERROR_SERVER
        || status === STATUS.STATUS_TASK_ERROR_NETWORK
        || status === STATUS.STATUS_TASK_ERROR_TIMEOUT
        || status === STATUS.STATUS_TASK_ERROR_UNKNOWN;
}

export default class AgentScheduleModel {
    static coll = coll;
    static runColl = runColl;
    static triggerSubType = 'agent.schedule';

    static isVisible(doc: AgentScheduleDoc): boolean {
        if (doc.deletedAt || doc.endedAt) return false;
        if (doc.scheduleType === 'once') return (doc.runCount || 0) === 0;
        if (doc.scheduleType === 'interval') {
            if (doc.maxRuns && (doc.runCount || 0) >= doc.maxRuns) return false;
            if (doc.endAt && doc.endAt.getTime() < Date.now()) return false;
            return true;
        }
        return false;
    }

    static visibleFilter() {
        return visibleScheduleMongoFilter();
    }

    static async create(domainId: string, input: AgentScheduleInput): Promise<AgentScheduleDoc> {
        if (!Number.isFinite(Number(input.uid)) || Number(input.uid) <= 0) throw new Error('uid is required');
        if (input.scheduleType !== 'once' && input.scheduleType !== 'interval') throw new Error('scheduleType must be once or interval');
        const agentId = String(input.agentId || '').trim();
        if (!agentId) throw new Error('agentId is required when schedule_create is not called by an agent');
        const adoc = await Agent.get(domainId, agentId, Agent.PROJECTION_PUBLIC);
        if (!adoc) throw new Error(`Agent not found: ${agentId}`);
        const now = new Date();
        const doc: AgentScheduleDoc = {
            _id: new ObjectId(),
            domainId,
            uid: Number(input.uid),
            agentId: adoc.aid || adoc.docId.toString(),
            title: String(input.title || '').trim() || String(input.command || '').trim().slice(0, 80) || 'Scheduled agent task',
            command: String(input.command || '').trim(),
            enabled: input.enabled !== false,
            scheduleType: input.scheduleType,
            executeAt: input.scheduleType === 'once' ? normalizeDate(input.executeAt, 'executeAt') : undefined,
            intervalCount: input.scheduleType === 'interval' ? Math.max(1, Math.floor(Number(input.intervalCount) || 1)) : undefined,
            intervalUnit: input.scheduleType === 'interval' ? normalizeIntervalUnit(input.intervalUnit || 'day') : undefined,
            maxRuns: input.scheduleType === 'interval' ? normalizePositiveInt(input.maxRuns, 'maxRuns') : undefined,
            endAt: input.scheduleType === 'interval' ? normalizeDate(input.endAt, 'endAt') : undefined,
            timezone: String(input.timezone || 'UTC').trim() || 'UTC',
            runCount: 0,
            createdAt: now,
            updatedAt: now,
            meta: {
                source: input.source,
                createdByAgentId: input.createdByAgentId,
                description: input.description,
            },
        };
        if (!doc.command) throw new Error('command is required');
        if (doc.scheduleType === 'once' && !doc.executeAt) throw new Error('executeAt is required for once schedules');
        doc.nextRunAt = computeNextRun(doc, now);
        if (doc.enabled && !doc.nextRunAt) throw new Error('Schedule has no future run time');
        await coll.insertOne(doc as any);
        (bus.broadcast as any)('agent_schedule/change', doc);
        await this.enqueueNextTrigger(doc);
        return doc;
    }

    static async get(domainId: string, id: ObjectId | string): Promise<AgentScheduleDoc | null> {
        return coll.findOne({ _id: oid(id), domainId }) as Promise<AgentScheduleDoc | null>;
    }

    static list(domainId: string, query: Filter<AgentScheduleDoc> = {}, opts: { page?: number; limit?: number; includeDeleted?: boolean; includeEnded?: boolean } = {}) {
        const page = Math.max(1, Math.floor(Number(opts.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(opts.limit) || 20)));
        const filter: any = { domainId, ...query };
        if (!opts.includeEnded) {
            const visible = visibleScheduleMongoFilter() as any;
            if (opts.includeDeleted) delete visible.deletedAt;
            filter.$and = [...(filter.$and || []), visible];
        } else if (!opts.includeDeleted) filter.deletedAt = { $exists: false };
        return Promise.all([
            coll.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).toArray() as Promise<AgentScheduleDoc[]>,
            coll.countDocuments(filter),
        ]).then(([rows, count]) => ({ rows, count, page, limit }));
    }

    static async update(domainId: string, id: ObjectId | string, patch: Partial<AgentScheduleInput>): Promise<AgentScheduleDoc> {
        const cur = await this.get(domainId, id);
        if (!cur || cur.deletedAt || cur.endedAt) throw new Error('Schedule not found');
        const next: AgentScheduleDoc = { ...cur };
        if (patch.agentId !== undefined) {
            const adoc = await Agent.get(domainId, patch.agentId, Agent.PROJECTION_PUBLIC);
            if (!adoc) throw new Error(`Agent not found: ${patch.agentId}`);
            next.agentId = adoc.aid || adoc.docId.toString();
        }
        if (patch.title !== undefined) next.title = String(patch.title || '').trim() || next.title;
        if (patch.command !== undefined) next.command = String(patch.command || '').trim();
        if (patch.enabled !== undefined) next.enabled = patch.enabled !== false;
        if (patch.scheduleType !== undefined) next.scheduleType = patch.scheduleType;
        if (patch.executeAt !== undefined) next.executeAt = normalizeDate(patch.executeAt, 'executeAt');
        if (patch.intervalCount !== undefined) next.intervalCount = Math.max(1, Math.floor(Number(patch.intervalCount) || 1));
        if (patch.intervalUnit !== undefined) next.intervalUnit = normalizeIntervalUnit(patch.intervalUnit);
        if (Object.prototype.hasOwnProperty.call(patch, 'maxRuns')) next.maxRuns = normalizePositiveInt(patch.maxRuns, 'maxRuns');
        if (Object.prototype.hasOwnProperty.call(patch, 'endAt')) next.endAt = normalizeDate(patch.endAt, 'endAt');
        if (patch.timezone !== undefined) next.timezone = String(patch.timezone || 'UTC').trim() || 'UTC';
        if (patch.description !== undefined) next.meta = { ...(next.meta || {}), description: patch.description };
        if (!next.command) throw new Error('command is required');
        if (next.scheduleType !== 'once' && next.scheduleType !== 'interval') throw new Error('scheduleType must be once or interval');
        if (next.scheduleType === 'interval') {
            next.intervalCount ||= 1;
            next.intervalUnit ||= 'day';
            next.executeAt = undefined;
        }
        if (next.scheduleType === 'once') {
            next.maxRuns = undefined;
            next.endAt = undefined;
            if (!next.executeAt) throw new Error('executeAt is required for once schedules');
        }
        next.nextRunAt = computeNextRun(next, new Date());
        if (next.enabled && !next.nextRunAt) throw new Error('Schedule has no future run time');
        next.updatedAt = new Date();
        const { _id: _ignoredId, ...setDoc } = next as any;
        await coll.updateOne({ _id: cur._id, domainId }, {
            $set: { ...setDoc, nextRunAt: next.nextRunAt || null },
            $unset: {
                ...(next.scheduleType === 'once' ? { intervalCount: '', intervalUnit: '', maxRuns: '', endAt: '' } : { executeAt: '' }),
                ...(next.maxRuns ? {} : { maxRuns: '' }),
                ...(next.endAt ? {} : { endAt: '' }),
            },
        });
        (bus.broadcast as any)('agent_schedule/change', next);
        await this.clearPendingTriggers(domainId, cur._id);
        await this.enqueueNextTrigger(next);
        return next;
    }

    static async softDelete(domainId: string, id: ObjectId | string): Promise<void> {
        const _id = oid(id);
        const now = new Date();
        await coll.updateOne({ _id, domainId }, { $set: { deletedAt: now, endReason: 'deleted', enabled: false, nextRunAt: null, updatedAt: now } });
        const doc = await this.get(domainId, _id);
        if (doc) (bus.broadcast as any)('agent_schedule/change', doc);
        await this.clearPendingTriggers(domainId, _id);
    }

    static async pause(domainId: string, id: ObjectId | string): Promise<AgentScheduleDoc> {
        const _id = oid(id);
        const cur = await this.get(domainId, _id);
        if (!cur || cur.deletedAt || cur.endedAt) throw new Error('Schedule not found');
        const now = new Date();
        await coll.updateOne({ _id, domainId }, { $set: { enabled: false, nextRunAt: null, updatedAt: now } });
        await this.clearPendingTriggers(domainId, _id);
        const doc = await this.get(domainId, _id);
        if (!doc) throw new Error('Schedule not found');
        (bus.broadcast as any)('agent_schedule/change', doc);
        return doc;
    }

    static async resume(domainId: string, id: ObjectId | string): Promise<AgentScheduleDoc> {
        const cur = await this.get(domainId, id);
        if (!cur || cur.deletedAt || cur.endedAt) throw new Error('Schedule not found');
        const nextRunAt = computeNextRun({ ...cur, enabled: true }, new Date());
        if (!nextRunAt) throw new Error('Schedule has no future run time');
        const updated = { ...cur, enabled: true, nextRunAt, updatedAt: new Date() };
        const { _id: _ignoredId, ...setDoc } = updated as any;
        await coll.updateOne({ _id: cur._id, domainId }, { $set: { ...setDoc, nextRunAt: updated.nextRunAt || null } });
        (bus.broadcast as any)('agent_schedule/change', updated);
        await this.clearPendingTriggers(domainId, cur._id);
        await this.enqueueNextTrigger(updated);
        return updated;
    }

    static history(domainId: string, query: Filter<AgentScheduleRunDoc> = {}, opts: { page?: number; limit?: number } = {}) {
        const page = Math.max(1, Math.floor(Number(opts.page) || 1));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(opts.limit) || 20)));
        const filter: any = { domainId, ...query };
        return Promise.all([
            runColl.find(filter).sort({ plannedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).toArray() as Promise<AgentScheduleRunDoc[]>,
            runColl.countDocuments(filter),
        ]).then(([rows, count]) => ({ rows, count, page, limit }));
    }

    static clearPendingTriggers(domainId: string, scheduleId: ObjectId) {
        return ScheduleModel.deleteMany({ type: 'schedule', subType: this.triggerSubType, domainId, scheduleId });
    }

    static async enqueueNextTrigger(doc: AgentScheduleDoc): Promise<void> {
        if (!doc.enabled || doc.deletedAt || doc.endedAt || !doc.nextRunAt) return;
        await ScheduleModel.add({
            type: 'schedule',
            subType: this.triggerSubType,
            domainId: doc.domainId,
            scheduleId: doc._id,
            executeAfter: doc.nextRunAt,
        });
    }

    static async createRun(doc: AgentScheduleDoc, plannedAt: Date, status: AgentScheduleRunStatus = 'queued'): Promise<AgentScheduleRunDoc> {
        const now = new Date();
        const run: AgentScheduleRunDoc = {
            _id: new ObjectId(),
            domainId: doc.domainId,
            scheduleId: doc._id,
            uid: doc.uid,
            agentId: doc.agentId,
            command: doc.command,
            plannedAt,
            status,
            createdAt: now,
            updatedAt: now,
        };
        await runColl.insertOne(run as any);
        return run;
    }

    static async advanceScheduleAfterFire(
        doc: AgentScheduleDoc,
        run: AgentScheduleRunDoc,
        status: AgentScheduleRunStatus,
        now = new Date(),
    ): Promise<AgentScheduleDoc> {
        const runCount = (doc.runCount || 0) + 1;
        let nextRunAt: Date | undefined;
        let enabled = doc.enabled;
        let endedAt: Date | undefined;
        let endReason: AgentScheduleEndReason | undefined;
        if (doc.scheduleType === 'once') {
            enabled = false;
            endedAt = now;
            endReason = 'completed';
        } else if (doc.maxRuns && runCount >= doc.maxRuns) {
            enabled = false;
            endedAt = now;
            endReason = 'maxRuns';
        } else {
            nextRunAt = computeNextRun({ ...doc, runCount, lastRunAt: now }, now);
            if (!nextRunAt) {
                enabled = false;
                endedAt = now;
                endReason = 'endAt';
            }
        }
        const updated: AgentScheduleDoc = {
            ...doc,
            enabled,
            lastRunAt: now,
            lastRunStatus: status,
            lastRunId: run._id,
            runCount,
            nextRunAt,
            updatedAt: now,
            ...(endedAt ? { endedAt, endReason } : {}),
        };
        await coll.updateOne({ _id: doc._id, domainId: doc.domainId }, {
            $set: {
                lastRunAt: now,
                lastRunStatus: status,
                lastRunId: run._id,
                runCount: updated.runCount,
                nextRunAt: nextRunAt || null,
                enabled: updated.enabled,
                updatedAt: now,
                ...(endedAt ? { endedAt, endReason } : {}),
            },
        });
        (bus.broadcast as any)('agent_schedule/change', updated);
        if (nextRunAt && updated.enabled) await this.enqueueNextTrigger(updated);
        return updated;
    }

    static async failRun(doc: AgentScheduleDoc, run: AgentScheduleRunDoc, err: any): Promise<void> {
        const now = new Date();
        const patch = {
            ...run,
            status: 'error' as const,
            completedAt: now,
            updatedAt: now,
            error: { message: err?.message || String(err), code: err?.code },
        };
        await runColl.updateOne({ _id: run._id, domainId: run.domainId }, {
            $set: {
                status: patch.status,
                completedAt: patch.completedAt,
                updatedAt: patch.updatedAt,
                error: patch.error,
            },
        });
        (bus.broadcast as any)('agent_schedule_run/change', patch);
        await this.advanceScheduleAfterFire(doc, patch, 'error', now);
    }

    static async fireDue(triggerDoc: any): Promise<void> {
        const scheduleId = triggerDoc?.scheduleId;
        if (!scheduleId) return;
        const doc = await this.get(triggerDoc.domainId, scheduleId);
        const plannedAt = normalizeDate(triggerDoc.executeAfter, 'executeAfter') || new Date();
        if (!doc || doc.deletedAt || doc.endedAt || !doc.enabled) {
            if (doc) {
                const run = await this.createRun(doc, plannedAt, 'skipped');
                (bus.broadcast as any)('agent_schedule_run/change', run);
            }
            return;
        }
        if (doc.nextRunAt && Math.abs(doc.nextRunAt.getTime() - plannedAt.getTime()) > 1000) {
            logger.info('Skip stale schedule trigger schedule=%s planned=%s next=%s', doc._id.toString(), plannedAt.toISOString(), doc.nextRunAt.toISOString());
            return;
        }
        const run = await this.createRun(doc, plannedAt, 'queued');
        try {
            const result = await enqueueAgentTask({
                domainId: doc.domainId,
                uid: doc.uid,
                agentId: doc.agentId,
                message: doc.command,
                history: [],
                sessionTitle: `Scheduled: ${doc.title}`,
                source: 'schedule',
                scheduleId: doc._id,
                scheduleRunId: run._id,
            });
            const now = new Date();
            const runPatch = {
                ...run,
                queuedAt: now,
                status: 'queued' as const,
                taskId: result.taskId,
                recordId: result.recordId,
                agentChatSessionId: result.chatSessionId,
                updatedAt: now,
            };
            await runColl.updateOne({ _id: run._id, domainId: doc.domainId }, {
                $set: {
                    queuedAt: now,
                    status: 'queued',
                    taskId: result.taskId,
                    recordId: result.recordId,
                    agentChatSessionId: result.chatSessionId,
                    updatedAt: now,
                },
            });
            (bus.broadcast as any)('agent_schedule_run/change', runPatch);
            await this.advanceScheduleAfterFire(doc, runPatch, 'queued', now);
        } catch (e: any) {
            await this.failRun(doc, run, e);
        }
    }

    static async completeRunByRecord(domainId: string, recordId: ObjectId | string, taskId?: string): Promise<void> {
        await this.refreshRunFromRecord(domainId, recordId, taskId, true);
    }

    static async refreshRunFromRecord(
        domainId: string,
        recordId: ObjectId | string,
        taskId?: string,
        force = false,
    ): Promise<void> {
        const rid = oid(recordId);
        const run = await runColl.findOne({ domainId, recordId: rid }) as AgentScheduleRunDoc | null;
        if (!run) return;
        const rdoc = await RecordModel.get(domainId, rid);
        if (!rdoc || (!force && !isTerminalAgentStatus(rdoc.status))) return;
        const ok = rdoc.status === STATUS.STATUS_TASK_DELIVERED;
        const status: AgentScheduleRunStatus = ok ? 'success' : 'error';
        const now = new Date();
        const patch = {
            ...run,
            status,
            completedAt: now,
            updatedAt: now,
            ...(taskId && ObjectId.isValid(taskId) ? { taskId: new ObjectId(taskId) } : {}),
            ...(ok ? {} : { error: { message: rdoc.agentError?.message || 'Agent task failed', code: rdoc.agentError?.code } }),
        };
        await runColl.updateOne({ _id: run._id, domainId }, {
            $set: {
                status: patch.status,
                completedAt: patch.completedAt,
                updatedAt: patch.updatedAt,
                ...(patch.taskId ? { taskId: patch.taskId } : {}),
                ...(patch.error ? { error: patch.error } : {}),
            },
        });
        (bus.broadcast as any)('agent_schedule_run/change', patch);
        await coll.updateOne({ _id: run.scheduleId, domainId }, {
            $set: { lastRunStatus: status, lastRunId: run._id, updatedAt: now },
        });
        const schedule = await this.get(domainId, run.scheduleId);
        if (schedule) (bus.broadcast as any)('agent_schedule/change', schedule);
    }

    static toView(doc: AgentScheduleDoc) {
        return {
            ...doc,
            id: doc._id.toHexString(),
            ruleLabel: ruleLabel(doc),
        };
    }
}

export async function apply(ctx: Context) {
    ctx.inject(['worker'], (c) => {
        c.worker.addHandler(AgentScheduleModel.triggerSubType, (doc: any) => AgentScheduleModel.fireDue(doc));
    });

    ctx.on('domain/delete', (domainId) => {
        coll.deleteMany({ domainId });
        runColl.deleteMany({ domainId });
        ScheduleModel.deleteMany({ domainId, subType: AgentScheduleModel.triggerSubType });
    });

    (ctx.on as any)('task/agent-completed', async (payload: { recordId: string; domainId: string; taskId?: string }) => {
        try {
            if (!payload.recordId) return;
            await AgentScheduleModel.completeRunByRecord(payload.domainId, payload.recordId, payload.taskId);
        } catch (e) {
            logger.error('Error handling scheduled agent completion:', e);
        }
    });

    ctx.on('record/change', async (rdoc: any) => {
        try {
            if (rdoc?.recordKind !== 'agent' || !rdoc?._id || !isTerminalAgentStatus(rdoc.status)) return;
            await AgentScheduleModel.refreshRunFromRecord(rdoc.domainId, rdoc._id);
        } catch (e) {
            logger.error('Error refreshing scheduled run from record change:', e);
        }
    });

    await db.ensureIndexes(
        coll,
        { key: { domainId: 1, enabled: 1, nextRunAt: 1 }, name: 'agent_schedule_next' },
        { key: { domainId: 1, uid: 1, updatedAt: -1 }, name: 'agent_schedule_uid' },
        { key: { domainId: 1, agentId: 1, updatedAt: -1 }, name: 'agent_schedule_agent' },
        { key: { domainId: 1, deletedAt: 1, endedAt: 1, updatedAt: -1 }, name: 'agent_schedule_visible' },
    );
    await db.ensureIndexes(
        runColl,
        { key: { domainId: 1, scheduleId: 1, plannedAt: -1 }, name: 'agent_schedule_run_schedule' },
        { key: { domainId: 1, uid: 1, createdAt: -1 }, name: 'agent_schedule_run_uid' },
        { key: { domainId: 1, recordId: 1 }, name: 'agent_schedule_run_record' },
    );

    (global.Ejunz.model as any).agent_schedule = AgentScheduleModel;
}
