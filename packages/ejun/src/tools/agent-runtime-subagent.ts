import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import Schema from 'schemastery';
import { delegateAgentRuntimeTool } from '../lib/agent-runtime-tool';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import type {} from '../service/server';

export const inject = ['server'];

const SendMessageSchema = Schema.object({
    subagent_id: Schema.string().required().description('The subagent id returned when the background subagent was started.'),
    message: Schema.string().required().description('The message to deliver to the subagent.'),
}).description(
    'Send a message to a background subagent by its subagent id, continuing the same conversation. It becomes the subagent\'s next turn: if it is still working, the message waits until its current turn finishes, so it cannot redirect work already underway. This call returns no answer from the subagent — only confirmation that the message was delivered — so use it to give it more work. A failure means the message was NOT delivered.',
);

const InterruptAgentSchema = Schema.object({
    agent_id: Schema.string().required().description('The agent id of the running agent to interrupt.'),
}).description(
    'Request cancellation of a background agent\'s current turn by its agent id. The target may be your direct child or a deeper agent created under you. Only the current turn stops: messages already queued for the agent stay parked until a later send_message, agents it started keep running, and the agent itself stays available for follow-ups. This call returns as soon as the stop request is accepted, so the target may keep running briefly; interrupting an agent that already finished is an accepted no-op.',
);

const ListAgentsSchema = Schema.object({
    scope: Schema.union(['children', 'descendants'] as const)
        .description('children (default) lists direct children only; descendants walks the complete tree below you.'),
}).description(
    'List your continuable background subagents by durable id and label. Use it to recall which ones you started, not to poll for completion — you are told when one finishes. Status comes from the live registry: running means the agent is working right now, idle means it is loaded but between turns (it may be waiting on agents it started), and ready means it exists only in storage — resumable, not terminal, and not a result waiting to be collected; a send_message starts a new turn on the same conversation, and a direct child remains a send_message candidate in every status. The snapshot is not a delivery promise — send_message performs the authoritative check and may still fail. Children that could not be read are reported as diagnostics instead of being silently dropped. Scope descendants walks the whole tree below you in stable pre-order, annotating each entry with its durable direct-parent session id and depth. You may use send_message only for depth-1 entries; deeper entries are candidates for interrupt_agent only.',
);

const SubagentSchema = Schema.object({
    description: Schema.string().required().description('A short (3-5 word) description of the delegated task, for display.'),
    prompt: Schema.string().required().description('The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.'),
    run_in_background: Schema.boolean().description('Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.'),
}).description(
    'Delegate a self-contained task to a subagent (a separate agent that works in its own context) to offload focused, independent work — research, a scoped implementation, an analysis — so it does not consume this conversation\'s context. The subagent returns its result, not its intermediate steps. Give it a complete, standalone prompt: it does not see this conversation. This call waits for the result by default. Set run_in_background: true to return a job id; collect with job_output and stop with job_kill.',
);

const SubagentForkSchema = Schema.object({
    description: Schema.string().required(),
    prompt: Schema.string().required(),
    run_in_background: Schema.boolean(),
}).description(
    'Delegate a self-contained task to a subagent using the fork backend. Its exact schema and foreground/background behavior follow the current Agent configuration.',
);

const ReportSchema = Schema.object({
    output: Schema.string().required().description('Actionable content for your parent; summarize conclusions and reference relevant shared paths.'),
}).description(
    'Report selected content to the agent that started you. Call this once before you finish, with a self-contained final result, and earlier for progress or findings that change what that agent does next. That agent shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so finishing your work is not itself a result. Reporting does not end your turn or finish your work, and only your direct parent receives it. A failed call may still have arrived, so do not blindly repeat it.',
);

const StructuredOutputSchema = Schema.any().description(
    'Report your final structured result. Call this exactly once, when your answer is complete; the arguments must match this tool\'s parameter schema exactly.',
);

class SendMessageExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('send_message'); }
}
class InterruptAgentExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('interrupt_agent'); }
}
class ListAgentsExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('list_agents'); }
}
class SubagentExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('subagent'); }
}
class SubagentForkExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('subagent_fork'); }
}
class ReportExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('report'); }
}
class StructuredOutputExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return delegateAgentRuntimeTool('structured_output'); }
}

export function apply(ctx: Context): void {
    ctx.Tool('agent-runtime', 'send_message', SendMessageExecutor, SendMessageSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'interrupt_agent', InterruptAgentExecutor, InterruptAgentSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'list_agents', ListAgentsExecutor, ListAgentsSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'subagent', SubagentExecutor, SubagentSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'subagent_fork', SubagentForkExecutor, SubagentForkSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'report', ReportExecutor, ReportSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'structured_output', StructuredOutputExecutor, StructuredOutputSchema, PRIV.USER_PRIV_USER_PROFILE);
}
