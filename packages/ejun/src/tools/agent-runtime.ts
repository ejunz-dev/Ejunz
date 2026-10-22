import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import Schema from 'schemastery';
import { delegateAgentRuntimeTool } from '../lib/agent-runtime-tool';
import type { ToolArgs, ToolContext } from '../lib/tool-types';
import { registerAgentAddon } from '../service/addons';
import type {} from '../service/server';

export const inject = ['server'];


export const TodoWriteSchema = Schema.object({
    todos: Schema.array(Schema.object({
        content: Schema.string().required().description('What the task is — a short imperative line.'),
        status: Schema.union(['pending', 'in_progress', 'completed'] as const)
            .required()
            .description('pending (not started) | in_progress (being worked now) | completed (done).'),
    })).required().description('The complete task list, replacing any previous list.'),
}).description(
    'Record and update a structured task list for the current work. Send the ENTIRE list every call — it REPLACES the previous list (there are no partial updates, no per-item edits). Use it to plan multi-step work and show progress: add one todo per concrete step before you start. '
        + 'Mark every todo being actively worked on `in_progress` — several at once when work genuinely runs in parallel (e.g. concurrent subagents or background commands), one for sequential work; while work remains, at least one task should be `in_progress`. '
        + 'Mark a todo `completed` the moment it is done (do not batch completions), and allow no `in_progress` item only once all work is complete. Skip the list for trivial single-step tasks. Statuses: `pending` (not started), `in_progress` (being worked on now), `completed` (finished).',
);

export const AskUserQuestionSchema = Schema.object({
    questions: Schema.array(Schema.object({
        id: Schema.string().required().description('Stable id for this question; echoed in the answer.'),
        question: Schema.string().required().description('The specific question to ask the user.'),
        header: Schema.string().description('Optional short heading for the question.'),
        options: Schema.array(Schema.object({
            label: Schema.string().required().description('Short user-facing option label.'),
            description: Schema.string().description('One sentence explaining the option or tradeoff.'),
        })).description('Optional choices. Put a recommended choice first and mark it “(Recommended)”.'),
        multi_select: Schema.boolean().description('Whether the user may select more than one option; defaults to false.'),
    })).required().description('Questions to ask the user before continuing.'),
}).description('Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.');

export const JobOutputSchema = Schema.object({
    job_id: Schema.string().required().description('Job id returned by the tool that started the background work.'),
    wait: Schema.boolean().description('Wait until the job finishes or the timeout expires.'),
    timeout_ms: Schema.number().description('Maximum wait in milliseconds; meaningful only when wait is true.'),
}).description('Read a background job. Stream jobs return only output since the previous read; final-output jobs return their result after settlement. Every response ends with `[status: ...]`. Reads are non-blocking unless `wait: true`, which waits up to the configured cap.');

export const JobListSchema = Schema.object({}).description('List your background jobs (running and finished) with their ids, kinds, and statuses.');

export const JobKillSchema = Schema.object({
    job_id: Schema.string().required().description('Job id returned by the tool that started the background work.'),
    reason: Schema.string().description('Optional short reason for cancelling the job.'),
}).description('Request cancellation of a running background job by job id. Returns immediately; the job settles as killed once its work actually stops.');

export const GetGoalSchema = Schema.object({}).description(
    'Read the current same-session goal, including its exact id/revision, objective, phase, completed continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. Call this before updating a goal.',
);

export const CreateGoalSchema = Schema.object({
    objective: Schema.string().required().description('Concrete completion objective inferred from the direct human request.'),
    max_goal_rounds: Schema.number().description('Optional positive safe-integer limit on automatic continuation rounds.'),
}).description(
    'Create one persisted same-session completion goal when the current direct human request is a long-running objective that should continue across autonomous goal rounds. You may infer that intent without requiring the user to say “create a goal”. Do not use this for trivial single-turn work. Execution rejects non-human and subagent authority.',
);

export const UpdateGoalSchema = Schema.object({
    goal_id: Schema.string().required().description('Exact id returned by get_goal.'),
    revision: Schema.number().required().description('Exact positive revision returned by get_goal.'),
    action: Schema.union(['edit', 'pause', 'resume', 'complete', 'blocked'] as const).required(),
    objective: Schema.string().description('Replacement objective; valid only with action edit.'),
    max_goal_rounds: Schema.number().description('Replacement cap; valid only with action edit.'),
    blocked_reason: Schema.string().description('Concrete blocking condition; required only with action blocked.'),
}).description(
    'Update the exact current goal revision. edit, pause, and resume require a direct top-level human request. During an automatic continuation of the current goal, complete and blocked are also allowed. blocked is rejected before the configured minimum round count; explain the concrete persistent condition in blocked_reason.',
);

export const SkillSchema = Schema.object({
    name: Schema.string().required().description('Exact skill name from the current session skill catalog.'),
}).description('Load the full instructions for an available skill. Call this with the exact skill name from the session skill catalog before acting on a task that names or clearly matches the skill.');

export const ExitPlanModeSchema = Schema.object({
    plan: Schema.string().required().description('The complete plan as markdown, starting with a # heading that names it.'),
}).description('Use only in plan mode. Present your complete plan as markdown, starting with a # heading. The user may approve and leave plan mode or keep planning and return feedback; revise and present the plan again when asked.');

class TodoWriteExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('todo_write');
    }
}

class AskUserQuestionExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('ask_user_question');
    }
}

class JobOutputExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('job_output');
    }
}

class JobListExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('job_list');
    }
}

class JobKillExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('job_kill');
    }
}

class GetGoalExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('get_goal');
    }
}

class CreateGoalExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('create_goal');
    }
}

class UpdateGoalExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('update_goal');
    }
}

class SkillExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('skill');
    }
}

class ExitPlanModeExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() {
        return delegateAgentRuntimeTool('exit_plan_mode');
    }
}

export function apply(ctx: Context): void {
    const unregisterAddon = registerAgentAddon({
        addonId: 'agent-runtime',
        displayName: 'Agent Runtime Tools',
        description: 'Use native Agent tools for interaction, tasks, jobs, goals, skills, web access, scheduling, session search, code navigation, subagents, workflows, and optional Cordis extensions.',
        toolPrefixes: [
            'todo_', 'ask_user_question', 'job_', 'get_goal', 'create_goal', 'update_goal', 'skill', 'exit_plan_mode',
            'web_fetch', 'schedule_', 'session_', 'lsp', 'send_message', 'interrupt_agent', 'list_agents',
            'subagent', 'report', 'structured_output', 'workflow', 'ralph', 'cordis_', 'mcp__',
        ],
        defaultEnabled: true,
    });
    ctx.effect(() => unregisterAddon);

    ctx.Tool('agent-runtime', 'todo_write', TodoWriteExecutor, TodoWriteSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'ask_user_question', AskUserQuestionExecutor, AskUserQuestionSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'job_output', JobOutputExecutor, JobOutputSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'job_list', JobListExecutor, JobListSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'job_kill', JobKillExecutor, JobKillSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'get_goal', GetGoalExecutor, GetGoalSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'create_goal', CreateGoalExecutor, CreateGoalSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'update_goal', UpdateGoalExecutor, UpdateGoalSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'skill', SkillExecutor, SkillSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'exit_plan_mode', ExitPlanModeExecutor, ExitPlanModeSchema, { source: 'session', bindBase: 'none' }, PRIV.USER_PRIV_USER_PROFILE);
}
