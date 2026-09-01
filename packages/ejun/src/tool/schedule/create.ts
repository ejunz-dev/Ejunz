import { AgentScheduleModel, requireContext, scheduleToWire } from './shared';
import type { SystemToolExecutionContext, ToolArgs } from '../types';

export async function execute(args: ToolArgs, context?: SystemToolExecutionContext): Promise<unknown> {
    const { domainId, owner } = requireContext(context);
    const schedule = await AgentScheduleModel().create(domainId, {
        uid: owner,
        agentId: String(args.agentId || (args as any).__agentId || ''),
        title: typeof args.title === 'string' ? args.title : undefined,
        command: String(args.command || ''),
        scheduleType: args.scheduleType as any,
        executeAt: args.executeAt as any,
        intervalCount: Number(args.intervalCount || 1),
        intervalUnit: args.intervalUnit as any,
        maxRuns: args.maxRuns === undefined ? undefined : Number(args.maxRuns),
        endAt: args.endAt as any,
        timezone: typeof args.timezone === 'string' ? args.timezone : undefined,
        enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        description: typeof args.description === 'string' ? args.description : undefined,
        source: 'system_tool',
    });
    return { ok: true, schedule: scheduleToWire(domainId, schedule) };
}
