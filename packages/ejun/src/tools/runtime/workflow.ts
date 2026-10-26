import { Executor } from '@ejunz/framework';
import type { Context } from 'ejun/src/context';
import { PRIV } from 'ejun/src/model/builtin';
import Schema from 'schemastery';
import type { ToolArgs, ToolContext } from '../../lib/tool-types';
import type {} from '../../service/server';

export const inject = ['server'];

const RalphSchema = Schema.object({
    objective: Schema.string().required().description('The immutable completion objective for every fresh Ralph round.'),
    maxRounds: Schema.number().step(1).min(1).description('Optional positive safe-integer round cap, bounded by the deployment ceiling.'),
}).description(
    'Run a foreground fresh-agent Ralph loop toward one immutable objective. Use only when the direct human explicitly asks for Ralph or fresh-agent iteration. Each round opens a new child with no parent conversation or prior child session; the shared workspace is long-term memory, and only a bounded structured report crosses rounds. The call returns when a worker reports completion or a concrete blocker, or at the round limit. Ordinary long-running same-session work belongs to goal tools.',
);

const WorkflowMetaSchema = Schema.object({
    name: Schema.string().required().description('Short kebab-case workflow name.'),
    description: Schema.string().required().description('One-line description of what the workflow does.'),
    whenToUse: Schema.string().description('Optional guidance on when this workflow applies.'),
    phases: Schema.array(Schema.object({
        title: Schema.string().required().description('The phase title phase() calls match by exact string.'),
        detail: Schema.string().description('Optional one-line description of the phase.'),
        provider: Schema.string().description('Optional provider override this phase is expected to use.'),
        model: Schema.string().description('Optional model override this phase is expected to use.'),
    })).description('Optional phase declarations matched by phase() calls.'),
}).required().description('The workflow identity block (plain JSON — never code).');

const WorkflowSchema = Schema.object({
    script: Schema.string().required().description('The plain-JS workflow script body (top-level await allowed; NO `export const meta` statement; end with `return <json-value>`).'),
    meta: WorkflowMetaSchema,
    args: Schema.dict(Schema.any()).description('Optional JSON input exposed to the script as the `args` global.'),
}).description(
    'Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans out across many independent pieces — an audit over many files, a migration, multi-angle research, adversarial verification of findings — where you write the orchestration as a script instead of delegating turn by turn.',
);

class RalphExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'ralph' }; }
}
class WorkflowExecutor extends Executor<ToolContext, ToolArgs> {
    async execute() { return { type: 'ejunz/runtime-tool-call', toolName: 'workflow' }; }
}

export function apply(ctx: Context): void {
    ctx.Tool('agent-runtime', 'ralph', RalphExecutor, RalphSchema, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool('agent-runtime', 'workflow', WorkflowExecutor, WorkflowSchema, PRIV.USER_PRIV_USER_PROFILE);
}
