import { AgentScheduleModel, requireContext, scheduleToWire } from './shared';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

export async function execute(args: ToolArgs, context?: SystemToolExecutionContext): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const current = await AgentScheduleModel().get(domainId, String(args.scheduleId || ''));
    if (!current || current.uid !== owner) throw new Error('Schedule not found');
    const schedule = await AgentScheduleModel().pause(domainId, current._id);
    return { ok: true, schedule: scheduleToWire(domainId, schedule) };
}
