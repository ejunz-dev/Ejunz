import { ObjectId } from 'mongodb';
import type { AgentScheduleDoc, AgentScheduleRunDoc } from '../model/agent_schedule';
import type { SystemToolCatalogEntry, SystemToolExecutionContext } from './systemTools';

type AgentScheduleModelStatic = typeof import('../model/agent_schedule').default;

function AgentScheduleModel(): AgentScheduleModelStatic {
    return require('../model/agent_schedule').default;
}

export const SCHEDULE_SYSTEM_TOOL_NAMES = new Set([
    'schedule_create',
    'schedule_get',
    'schedule_list',
    'schedule_update',
    'schedule_delete',
    'schedule_pause',
    'schedule_resume',
    'schedule_history',
]);

export const SCHEDULE_SYSTEM_TOOLS_CATALOG: SystemToolCatalogEntry[] = [
    {
        name: 'schedule_create',
        description: 'Create a domain-scoped scheduled task that invokes an agent with a command at a future time or interval.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string', description: 'Agent aid or numeric docId. Optional; defaults to the current executing agent when called by an agent.' },
                title: { type: 'string' },
                command: { type: 'string', description: 'Message or slash command to send to the agent.' },
                scheduleType: { type: 'string', enum: ['once', 'interval'] },
                executeAt: { type: 'string', description: 'ISO datetime for one-shot schedules.' },
                intervalCount: { type: 'number' },
                intervalUnit: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'] },
                maxRuns: { type: 'number', description: 'Maximum number of executions for interval schedules.' },
                endAt: { type: 'string', description: 'ISO datetime after which interval schedules stop.' },
                timezone: { type: 'string' },
                enabled: { type: 'boolean' },
                description: { type: 'string' },
            },
            required: ['command', 'scheduleType'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_get',
        description: 'Get a scheduled agent task by id.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_list',
        description: 'List scheduled agent tasks in the current domain.',
        inputSchema: {
            type: 'object',
            properties: {
                agentId: { type: 'string' },
                enabled: { type: 'boolean' },
                includeDeleted: { type: 'boolean' },
                includeEnded: { type: 'boolean' },
                page: { type: 'number' },
                limit: { type: 'number' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_update',
        description: 'Update a scheduled agent task.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string' },
                agentId: { type: 'string' },
                title: { type: 'string' },
                command: { type: 'string' },
                scheduleType: { type: 'string', enum: ['once', 'interval'] },
                executeAt: { type: 'string' },
                intervalCount: { type: 'number' },
                intervalUnit: { type: 'string', enum: ['minute', 'hour', 'day', 'week', 'month'] },
                maxRuns: { type: 'number', description: 'Maximum number of executions for interval schedules.' },
                endAt: { type: 'string', description: 'ISO datetime after which interval schedules stop.' },
                timezone: { type: 'string' },
                enabled: { type: 'boolean' },
                description: { type: 'string' },
            },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_delete',
        description: 'Soft-delete a scheduled agent task and remove its pending trigger.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_pause',
        description: 'Pause a scheduled agent task and remove its pending trigger.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_resume',
        description: 'Resume a paused scheduled agent task and enqueue its next trigger.',
        inputSchema: {
            type: 'object',
            properties: { scheduleId: { type: 'string' } },
            required: ['scheduleId'],
            additionalProperties: false,
        },
    },
    {
        name: 'schedule_history',
        description: 'List scheduled agent task execution history with links to record/session details when available.',
        inputSchema: {
            type: 'object',
            properties: {
                scheduleId: { type: 'string' },
                agentId: { type: 'string' },
                status: { type: 'string', enum: ['queued', 'running', 'success', 'error', 'skipped'] },
                page: { type: 'number' },
                limit: { type: 'number' },
            },
            additionalProperties: false,
        },
    },
];

export function isScheduleSystemTool(name: string): boolean {
    return SCHEDULE_SYSTEM_TOOL_NAMES.has(name);
}

export function isScheduleSystemToolMutating(name: string): boolean {
    return new Set(['schedule_create', 'schedule_update', 'schedule_delete', 'schedule_pause', 'schedule_resume']).has(name);
}

function requireContext(context?: SystemToolExecutionContext): { domainId: string; owner: number } {
    if (!context?.domainId) throw new Error('Schedule tool requires a domain execution context.');
    const owner = Number(context.owner);
    if (!Number.isFinite(owner) || owner <= 0) throw new Error('Schedule tool requires a positive caller/owner context.');
    return { domainId: context.domainId, owner };
}

function scheduleUrl(domainId: string, path = '/schedule'): string {
    return `/d/${domainId}${path}`;
}

function objectIdString(id?: ObjectId): string | undefined {
    return id?.toHexString?.();
}

function scheduleToWire(domainId: string, doc: AgentScheduleDoc) {
    return {
        id: doc._id.toHexString(),
        scheduleId: doc._id.toHexString(),
        domainId: doc.domainId,
        uid: doc.uid,
        agentId: doc.agentId,
        title: doc.title,
        command: doc.command,
        enabled: doc.enabled,
        scheduleType: doc.scheduleType,
        executeAt: doc.executeAt?.toISOString?.(),
        intervalCount: doc.intervalCount,
        intervalUnit: doc.intervalUnit,
        maxRuns: doc.maxRuns,
        endAt: doc.endAt?.toISOString?.(),
        timezone: doc.timezone,
        nextRunAt: doc.nextRunAt?.toISOString?.(),
        lastRunAt: doc.lastRunAt?.toISOString?.(),
        lastRunStatus: doc.lastRunStatus,
        lastRunId: objectIdString(doc.lastRunId),
        runCount: doc.runCount,
        endedAt: doc.endedAt?.toISOString?.(),
        endReason: doc.endReason,
        deletedAt: doc.deletedAt?.toISOString?.(),
        scheduleUrl: scheduleUrl(domainId, `/schedule?scheduleId=${encodeURIComponent(doc._id.toHexString())}`),
        historyUrl: scheduleUrl(domainId, `/schedule/history?scheduleId=${encodeURIComponent(doc._id.toHexString())}`),
    };
}

function runToWire(domainId: string, run: AgentScheduleRunDoc) {
    const rid = run.recordId?.toHexString?.();
    const sid = run.agentChatSessionId?.toHexString?.();
    return {
        id: run._id.toHexString(),
        runId: run._id.toHexString(),
        scheduleId: run.scheduleId.toHexString(),
        domainId: run.domainId,
        uid: run.uid,
        agentId: run.agentId,
        command: run.command,
        plannedAt: run.plannedAt?.toISOString?.(),
        queuedAt: run.queuedAt?.toISOString?.(),
        completedAt: run.completedAt?.toISOString?.(),
        status: run.status,
        taskId: objectIdString(run.taskId),
        recordId: rid,
        agentChatSessionId: sid,
        error: run.error,
        recordUrl: rid ? scheduleUrl(domainId, `/record/${encodeURIComponent(rid)}`) : undefined,
        sessionUrl: sid ? scheduleUrl(domainId, `/session/chat/${encodeURIComponent(sid)}`) : undefined,
    };
}

function listFilter(args: Record<string, unknown>, owner: number) {
    const filter: Record<string, unknown> = { uid: owner };
    if (typeof args.agentId === 'string' && args.agentId.trim()) filter.agentId = args.agentId.trim();
    if (typeof args.enabled === 'boolean') filter.enabled = args.enabled;
    return filter;
}

function historyFilter(args: Record<string, unknown>, owner: number) {
    const filter: Record<string, unknown> = { uid: owner };
    if (typeof args.scheduleId === 'string' && ObjectId.isValid(args.scheduleId)) filter.scheduleId = new ObjectId(args.scheduleId);
    if (typeof args.agentId === 'string' && args.agentId.trim()) filter.agentId = args.agentId.trim();
    if (typeof args.status === 'string' && args.status.trim()) filter.status = args.status.trim();
    return filter;
}

export async function executeScheduleSystemTool(
    name: string,
    args: Record<string, unknown> = {},
    context?: SystemToolExecutionContext,
): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const a = args || {};
    if (name === 'schedule_create') {
        const doc = await AgentScheduleModel().create(domainId, {
            uid: owner,
            agentId: String(a.agentId || (a as any).__agentId || ''),
            title: typeof a.title === 'string' ? a.title : undefined,
            command: String(a.command || ''),
            scheduleType: a.scheduleType as any,
            executeAt: a.executeAt as any,
            intervalCount: Number(a.intervalCount || 1),
            intervalUnit: a.intervalUnit as any,
            maxRuns: a.maxRuns === undefined ? undefined : Number(a.maxRuns),
            endAt: a.endAt as any,
            timezone: typeof a.timezone === 'string' ? a.timezone : undefined,
            enabled: typeof a.enabled === 'boolean' ? a.enabled : undefined,
            description: typeof a.description === 'string' ? a.description : undefined,
            source: 'system_tool',
        });
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_get') {
        const doc = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!doc || doc.uid !== owner) throw new Error('Schedule not found');
        return { schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_list') {
        const res = await AgentScheduleModel().list(domainId, listFilter(a, owner), {
            page: Number(a.page || 1),
            limit: Number(a.limit || 20),
            includeDeleted: a.includeDeleted === true,
            includeEnded: a.includeEnded === true,
        });
        return {
            schedules: res.rows.map((doc) => scheduleToWire(domainId, doc)),
            count: res.count,
            page: res.page,
            limit: res.limit,
            scheduleUrl: scheduleUrl(domainId),
            historyUrl: scheduleUrl(domainId, '/schedule/history'),
        };
    }
    if (name === 'schedule_update') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        const doc = await AgentScheduleModel().update(domainId, cur._id, a as any);
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_delete') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        await AgentScheduleModel().softDelete(domainId, cur._id);
        return { ok: true, scheduleId: cur._id.toHexString() };
    }
    if (name === 'schedule_pause') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        const doc = await AgentScheduleModel().pause(domainId, cur._id);
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_resume') {
        const cur = await AgentScheduleModel().get(domainId, String(a.scheduleId || ''));
        if (!cur || cur.uid !== owner) throw new Error('Schedule not found');
        const doc = await AgentScheduleModel().resume(domainId, cur._id);
        return { ok: true, schedule: scheduleToWire(domainId, doc) };
    }
    if (name === 'schedule_history') {
        const res = await AgentScheduleModel().history(domainId, historyFilter(a, owner), {
            page: Number(a.page || 1),
            limit: Number(a.limit || 20),
        });
        return {
            runs: res.rows.map((run) => runToWire(domainId, run)),
            count: res.count,
            page: res.page,
            limit: res.limit,
            historyUrl: scheduleUrl(domainId, '/schedule/history'),
        };
    }
    throw new Error(`Unknown schedule tool: ${name}`);
}
