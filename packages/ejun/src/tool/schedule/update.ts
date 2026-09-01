import { AgentScheduleModel, requireContext, scheduleToWire } from './shared';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

export async function execute(args: ToolArgs, context?: SystemToolExecutionContext): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const current = await AgentScheduleModel().get(domainId, String(args.scheduleId || ''));
    if (!current || current.uid !== owner) throw new Error('Schedule not found');
    const schedule = await AgentScheduleModel().update(domainId, current._id, args as any);
    return { ok: true, schedule: scheduleToWire(domainId, schedule) };
}
