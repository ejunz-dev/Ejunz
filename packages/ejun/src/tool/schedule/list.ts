import { AgentScheduleModel, listFilter, requireContext, scheduleToWire, scheduleUrl } from './shared';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

export async function execute(args: ToolArgs, context?: SystemToolExecutionContext): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const result = await AgentScheduleModel().list(domainId, listFilter(args, owner), {
        page: Number(args.page || 1),
        limit: Number(args.limit || 20),
        includeDeleted: args.includeDeleted === true,
        includeEnded: args.includeEnded === true,
    });
    return {
        schedules: result.rows.map((schedule) => scheduleToWire(domainId, schedule)),
        count: result.count,
        page: result.page,
        limit: result.limit,
        scheduleUrl: scheduleUrl(domainId),
        historyUrl: scheduleUrl(domainId, '/schedule/history'),
    };
}
