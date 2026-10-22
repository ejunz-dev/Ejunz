import type { Context } from 'ejun/src/context';
import type {} from '../service/server';
import { PRIV } from 'ejun/src/model/builtin';
import { ADDON_ID, SESSION_TOOL, runtimeToolExecutor } from './agent-runtime';

export const inject = ['server'];

const SendMessageDescription = [
    "Send a message to a background subagent by its subagent id, continuing the same conversation. It ",
    "becomes the subagent's next turn: if it is still working, the message waits until its current turn ",
    "finishes, so it cannot redirect work already underway. This call returns no answer from the ",
    "subagent — only confirmation that the message was delivered — so use it to give it more work. A ",
    "failure means the message was NOT delivered.",
].join('');
const SendMessageInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    subagent_id: {
      type: 'string',
      description: 'The subagent id returned when the background subagent was started.'
    },
    message: {
      type: 'string',
      description: 'The message to deliver to the subagent.'
    }
  },
  required: [
    'subagent_id',
    'message'
  ]
};

const InterruptAgentDescription = [
    "Request cancellation of a background agent's current turn by its agent id. The target may be your ",
    "direct child or a deeper agent created under you. Only the current turn stops: messages already ",
    "queued for the agent stay parked until a later send_message, agents it started keep running, and ",
    "the agent itself stays available for follow-ups. This call returns as soon as the stop request is ",
    "accepted, so the target may keep running briefly; interrupting an agent that already finished is an ",
    "accepted no-op.",
].join('');
const InterruptAgentInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    agent_id: {
      type: 'string',
      description: 'The agent id of the running agent to interrupt.'
    }
  },
  required: [
    'agent_id'
  ]
};

const ListAgentsDescription = [
    "List your continuable background subagents by durable id and label. Use it to recall which ones you ",
    "started, not to poll for completion — you are told when one finishes. Status comes from the live ",
    "registry: running means the agent is working right now, idle means it is loaded but between turns ",
    "(it may be waiting on agents it started), and ready means it exists only in storage — resumable, ",
    "not terminal, and not a result waiting to be collected; a send_message starts a new turn on the ",
    "same conversation, and a direct child remains a send_message candidate in every status. The ",
    "snapshot is not a delivery promise — send_message performs the authoritative check and may still ",
    "fail. Children that could not be read are reported as diagnostics instead of being silently ",
    "dropped. Scope descendants walks the whole tree below you in stable pre-order, annotating each ",
    "entry with its durable direct-parent session id and depth. You may use send_message only for ",
    "depth-1 entries; deeper entries are candidates for interrupt_agent only.",
].join('');
const ListAgentsInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      description: 'children (default) lists direct children only; descendants walks the complete tree below you.',
      enum: [
        'children',
        'descendants'
      ]
    }
  }
};

const SubagentDescription = [
    "Delegate a self-contained task to a subagent (a separate agent that works in its own context) to ",
    "offload focused, independent work — research, a scoped implementation, an analysis — so it does not ",
    "consume this conversation's context. The subagent returns its result, not its intermediate steps. ",
    "Give it a complete, standalone prompt: it does not see this conversation. This call waits for the ",
    "result by default. Set run_in_background: true to return a job id; collect with job_output and stop ",
    "with job_kill.",
].join('');
const SubagentInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description: 'A short (3-5 word) description of the delegated task, for display.'
    },
    prompt: {
      type: 'string',
      description: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
    },
    run_in_background: {
      type: 'boolean',
      description: 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.'
    }
  },
  required: [
    'description',
    'prompt'
  ]
};

const SubagentForkDescription = [
    "Delegate a self-contained task to a subagent using the fork backend. This shipped alias is ",
    "configured separately; its exact schema is selected from the current Agent scope.",
].join('');
const SubagentForkInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    description: {
      type: 'string'
    },
    prompt: {
      type: 'string'
    },
    run_in_background: {
      type: 'boolean'
    }
  },
  required: [
    'description',
    'prompt'
  ]
};

const ReportDescription = [
    "Report selected content to the agent that started you. Call this once before you finish, with a ",
    "self-contained final result, and earlier for progress or findings that change what that agent does ",
    "next. That agent shares your workspace but does not automatically receive your transcript, tool ",
    "output, or reasoning, so finishing your work is not itself a result. Reporting does not end your ",
    "turn or finish your work, and only your direct parent receives it. A failed call may still have ",
    "arrived, so do not blindly repeat it.",
].join('');
const ReportInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    output: {
      type: 'string',
      description: 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.'
    }
  },
  required: [
    'output'
  ]
};

const StructuredOutputDescription = [
    "Report your final structured result. Call this exactly once, when your answer is complete; the ",
    "arguments must match this tool's parameter schema exactly.",
].join('');
const StructuredOutputInputSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true
};

export function apply(ctx: Context): void {
    ctx.Tool(ADDON_ID, 'send_message', runtimeToolExecutor('send_message'), {
        ...SESSION_TOOL,
        description: SendMessageDescription,
        inputSchema: SendMessageInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'interrupt_agent', runtimeToolExecutor('interrupt_agent'), {
        ...SESSION_TOOL,
        description: InterruptAgentDescription,
        inputSchema: InterruptAgentInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'list_agents', runtimeToolExecutor('list_agents'), {
        ...SESSION_TOOL,
        description: ListAgentsDescription,
        inputSchema: ListAgentsInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'subagent', runtimeToolExecutor('subagent'), {
        ...SESSION_TOOL,
        description: SubagentDescription,
        inputSchema: SubagentInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'subagent_fork', runtimeToolExecutor('subagent_fork'), {
        ...SESSION_TOOL,
        description: SubagentForkDescription,
        inputSchema: SubagentForkInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'report', runtimeToolExecutor('report'), {
        ...SESSION_TOOL,
        description: ReportDescription,
        inputSchema: ReportInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'structured_output', runtimeToolExecutor('structured_output'), {
        ...SESSION_TOOL,
        description: StructuredOutputDescription,
        inputSchema: StructuredOutputInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
}
