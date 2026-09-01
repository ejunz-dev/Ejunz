import { AgentScheduleModel, requireContext } from './shared';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

export async function execute(args: ToolArgs, context?: SystemToolExecutionContext): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const current = await AgentScheduleModel().get(domainId, String(args.scheduleId || ''));
    if (!current || current.uid !== owner) throw new Error('Schedule not found');
    await AgentScheduleModel().softDelete(domainId, current._id);
    return { ok: true, scheduleId: current._id.toHexString() };
}
