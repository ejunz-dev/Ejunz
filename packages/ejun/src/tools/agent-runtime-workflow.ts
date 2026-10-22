import type { Context } from 'ejun/src/context';
import type {} from '../service/server';
import { PRIV } from 'ejun/src/model/builtin';
import { ADDON_ID, SESSION_TOOL, runtimeToolExecutor } from './agent-runtime';

export const inject = ['server'];

const RalphDescription = [
    "Run a foreground fresh-agent Ralph loop toward one immutable objective. Use only when the direct ",
    "human explicitly asks for Ralph or fresh-agent iteration. Each round opens a new child with no ",
    "parent conversation or prior child session; the shared workspace is long-term memory, and only a ",
    "bounded structured report crosses rounds. The call returns when a worker reports completion or a ",
    "concrete blocker, or at the round limit. Ordinary long-running same-session work belongs to goal ",
    "tools.",
].join('');
const RalphInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    objective: {
      type: 'string',
      description: 'The immutable completion objective for every fresh Ralph round.'
    },
    maxRounds: {
      type: 'number',
      description: 'Optional positive safe-integer round cap, bounded by the deployment ceiling.'
    }
  },
  required: [
    'objective'
  ]
};

const WorkflowDescription = [
    "Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work that fans ",
    "out across many independent pieces — an audit over many files, a migration, multi-angle research, ",
    "adversarial verification of findings — where you write the orchestration as a script instead of ",
    "delegating turn by turn.",
].join('');
const WorkflowInputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description: 'The plain-JS workflow script body (top-level await allowed; NO export const meta statement; end with return <json-value>).'
    },
    meta: {
      type: 'object',
      additionalProperties: true,
      properties: {
        name: {
          type: 'string',
          description: 'Short kebab-case workflow name.'
        },
        description: {
          type: 'string',
          description: 'One-line description of what the workflow does.'
        },
        whenToUse: {
          type: 'string',
          description: 'Optional guidance on when this workflow applies.'
        },
        phases: {
          type: 'array',
          description: 'Optional phase declarations matched by phase() calls.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              title: {
                type: 'string',
                description: 'The phase title phase() calls match by exact string.'
              },
              detail: {
                type: 'string',
                description: 'Optional one-line description of the phase.'
              },
              provider: {
                type: 'string',
                description: 'Optional provider override this phase is expected to use.'
              },
              model: {
                type: 'string',
                description: 'Optional model override this phase is expected to use.'
              }
            },
            required: [
              'title'
            ]
          }
        },
        args: {
          type: 'object',
          description: 'Optional JSON input exposed to the script as the args global.',
          additionalProperties: true
        }
      },
      required: [
        'name',
        'description'
      ]
    }
  },
  required: [
    'script',
    'meta'
  ]
};

export function apply(ctx: Context): void {
    ctx.Tool(ADDON_ID, 'ralph', runtimeToolExecutor('ralph'), {
        ...SESSION_TOOL,
        description: RalphDescription,
        inputSchema: RalphInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
    ctx.Tool(ADDON_ID, 'workflow', runtimeToolExecutor('workflow'), {
        ...SESSION_TOOL,
        description: WorkflowDescription,
        inputSchema: WorkflowInputSchema,
    }, PRIV.USER_PRIV_USER_PROFILE);
}
