import { AgentScheduleModel, historyFilter, requireContext, runToWire, scheduleUrl } from './shared';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

export async function execute(args: ToolArgs, context?: SystemToolExecutionContext): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const result = await AgentScheduleModel().history(domainId, historyFilter(args, owner), {
        page: Number(args.page || 1),
        limit: Number(args.limit || 20),
    });
    return {
        runs: result.rows.map((run) => runToWire(domainId, run)),
        count: result.count,
        page: result.page,
        limit: result.limit,
        historyUrl: scheduleUrl(domainId, '/schedule/history'),
    };
}
