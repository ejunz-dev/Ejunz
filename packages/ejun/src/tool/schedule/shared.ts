import { ObjectId } from 'mongodb';
import type { AgentScheduleDoc, AgentScheduleRunDoc } from '../../model/agent_schedule';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

type AgentScheduleModelStatic = typeof import('../../model/agent_schedule').default;

export function AgentScheduleModel(): AgentScheduleModelStatic {
    return require('../../model/agent_schedule').default;
}

export function requireContext(context?: SystemToolExecutionContext): { domainId: string; owner: number } {
    if (!context?.domainId) throw new Error('Schedule tool requires a domain execution context.');
    const owner = Number(context.owner);
    if (!Number.isFinite(owner) || owner <= 0) throw new Error('Schedule tool requires a positive caller/owner context.');
    return { domainId: context.domainId, owner };
}

export function scheduleUrl(domainId: string, path = '/schedule'): string {
    return `/d/${domainId}${path}`;
}

function objectIdString(id?: ObjectId): string | undefined {
    return id?.toHexString?.();
}

export function scheduleToWire(domainId: string, doc: AgentScheduleDoc) {
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

export function runToWire(domainId: string, run: AgentScheduleRunDoc) {
    const recordId = run.recordId?.toHexString?.();
    const sessionId = run.agentChatSessionId?.toHexString?.();
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
        recordId,
        agentChatSessionId: sessionId,
        error: run.error,
        recordUrl: recordId ? scheduleUrl(domainId, `/record/${encodeURIComponent(recordId)}`) : undefined,
        sessionUrl: sessionId ? scheduleUrl(domainId, `/session/chat/${encodeURIComponent(sessionId)}`) : undefined,
    };
}

export function listFilter(args: ToolArgs, owner: number) {
    const filter: Record<string, unknown> = { uid: owner };
    if (typeof args.agentId === 'string' && args.agentId.trim()) filter.agentId = args.agentId.trim();
    if (typeof args.enabled === 'boolean') filter.enabled = args.enabled;
    return filter;
}

export function historyFilter(args: ToolArgs, owner: number) {
    const filter: Record<string, unknown> = { uid: owner };
    if (typeof args.scheduleId === 'string' && ObjectId.isValid(args.scheduleId)) filter.scheduleId = new ObjectId(args.scheduleId);
    if (typeof args.agentId === 'string' && args.agentId.trim()) filter.agentId = args.agentId.trim();
    if (typeof args.status === 'string' && args.status.trim()) filter.status = args.status.trim();
    return filter;
}
