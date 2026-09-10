import { AgentScheduleModel, requireContext, scheduleToWire } from './shared';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

export async function execute(args: ToolArgs, context?: SystemToolExecutionContext): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const schedule = await AgentScheduleModel().get(domainId, String(args.scheduleId || ''));
    if (!schedule || schedule.uid !== owner) throw new Error('Schedule not found');
    return { schedule: scheduleToWire(domainId, schedule) };
}
