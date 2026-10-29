/**
 * Model-facing `get_goal`, `create_goal`, and `update_goal` tools over the
 * persisted same-session goal domain.
 * @module @ejunz/ea-core/tool-goal
 */

import type { Context } from '@ejunz/cordis'
import z from '@ejunz/schemastery'
import { GoalId } from '@ejunz/ea-core/goal'
import type { GoalRef, GoalView } from '@ejunz/ea-core/goal'
import { boundContextSummary, createUserMessage, EjunzAgentError } from '@ejunz/ea-core/llm'
import { defineTool } from '@ejunz/ea-core/tools'
import type { GenericCallView } from '@ejunz/ea-core/tools'
import type {} from '@ejunz/ea-core/system-prompt'
import type { Agent } from '@ejunz/ea-core/agent'
import type { SessionEvent } from '@ejunz/ea-core/session'
import type { ToolRunContext } from '@ejunz/ea-core/tools'
import type { ContentBlock } from '@ejunz/ea-core/llm'

export const name = 'tool-goal'
export const inject = ['agents', 'goals', 'tools', 'systemPrompt']

/** Model policy and hard lower bounds for goal-state updates. */
export interface Config {
  /** Minimum admitted goal rounds before the model may self-report `blocked`. */
  blockedAfterConsecutiveRounds?: number
}

/** Schemastery config for the goal-tool policy. */
export const Config: z<Config> = z.object({
  blockedAfterConsecutiveRounds: z.number().step(1).min(1).default(3),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly blockedAfterConsecutiveRounds: number
}

type UpdateAction = 'edit' | 'pause' | 'resume' | 'complete' | 'blocked'

const UPDATE_ACTIONS: UpdateAction[] = ['edit', 'pause', 'resume', 'complete', 'blocked']

const CREATE_DESCRIPTION =
  'Create one persisted same-session completion goal when the current direct human request '
  + 'is a long-running objective that should continue across autonomous goal rounds. You may '
  + 'infer that intent without requiring the user to say "create a goal". Do not use this for '
  + 'trivial single-turn work. Execution rejects non-human and subagent authority.'

const GET_DESCRIPTION =
  'Read the current same-session goal, including its exact id/revision, objective, phase, completed '
  + 'continuation rounds, round limit, blocker reason when present, and whether another continuation is armed. '
  + 'Call this before updating a goal.'

/** Canonical goal-tool output, matching the existing compact Native JSON. */
type GoalToolValue =
  | { goal: null }
  | {
    goal: {
      id: string
      revision: number
      objective: string
      phase: GoalView['phase']
      roundsStarted: number
      maxGoalRounds: number
      blockedReason?: { code: string; message: string }
    }
    activation: GoalView['activation']
  }

const GOAL_VALUE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'null', required: true },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: {
          type: 'object',
          additionalProperties: false,
          required: true,
          properties: {
            id: { type: 'string', required: true },
            revision: { type: 'integer', required: true },
            objective: { type: 'string', required: true },
            phase: { type: 'string', required: true, enum: ['active', 'paused', 'blocked', 'complete'] },
            roundsStarted: { type: 'integer', required: true },
            maxGoalRounds: { type: 'integer', required: true },
            blockedReason: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
        activation: { type: 'string', required: true, enum: ['armed', 'disarmed'] },
      },
    },
  ],
} as const

/** Render policy guidance with its deployment-selected blocked threshold. */
function guidance(blockedAfter: number): string {
  return 'Use goal tools for one long-running completion objective in the current session. '
    + 'create_goal may infer goal intent from a direct human request in any language; do not '
    + 'create a goal for routine single-turn work. Call get_goal before update_goal and copy its '
    + 'exact goal_id and revision. After session resume or fork, an active goal is disarmed: when '
    + 'a human asks to continue or resume in any wording or language, use update_goal action '
    + 'resume to rearm it. Mark complete only when the objective is actually achieved. Mark '
    + `blocked only after the same blocking condition persists for at least ${blockedAfter} `
    + 'consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, '
    + 'or useful remaining work is not blocked.'
}

/** Validate config even when apply is called directly outside Loader normalization. */
function resolveConfig(config: Config): ResolvedConfig {
  const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3
  if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) {
    throw new TypeError('blockedAfterConsecutiveRounds must be a positive safe integer')
  }
  return { blockedAfterConsecutiveRounds: blockedAfter }
}

/** Whether optional text is meaningful rather than a strict-schema empty filler. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/** Whether an optional round cap is meaningful rather than a strict-schema zero filler. */
function hasRoundCap(value: number | undefined): value is number {
  return value !== undefined && value !== 0
}

/** Build the exact compare-and-set ref from model arguments. */
function goalRef(goalId: string, revision: number): GoalRef {
  if (goalId.length === 0 || goalId !== goalId.trim()
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new EjunzAgentError(
      'goal_id must be non-empty and revision must be a positive safe integer',
      'GOAL_TOOL_INVALID_UPDATE',
    )
  }
  return { id: GoalId(goalId), revision }
}

/** Stable compact model result; activation is an observation, not replay state. */
function goalValue(goal: GoalView | undefined): GoalToolValue {
  if (goal === undefined) return { goal: null }
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...goal.blockedReason === undefined ? {} : {
        blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message },
      },
    },
    activation: goal.activation,
  }
}

/** Reusable canonical output declaration for all three goal controls. */
const GOAL_OUTPUT = {
  schema: GOAL_VALUE_SCHEMA,
  render: (_args: unknown, value: GoalToolValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Generic, args-only pending presentation shared by the goal tools. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/** Register the three Codex-shaped goal tools and their shared policy section. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'tool:goal',
    order: 114,
    text: guidance(resolved.blockedAfterConsecutiveRounds),
  })

  ctx.tools.register(defineTool({
    name: 'get_goal',
    description: GET_DESCRIPTION,
    parameters: {},
    output: GOAL_OUTPUT,
    execute(_args, exec) {
      const execution = goalToolExecution(ctx, exec)
      return Promise.resolve(goalValue(ctx.goals.get(execution.agent)))
    },
    presentCall: () => present('Read current goal', 'read'),
  }))

  ctx.tools.register(defineTool({
    name: 'create_goal',
    description: CREATE_DESCRIPTION,
    parameters: {
      objective: {
        type: 'string',
        required: true,
        description: 'The concrete completion objective inferred from the direct human request.',
      },
      max_goal_rounds: {
        type: 'number',
        description: 'Optional positive safe-integer limit on automatic continuation rounds.',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      const execution = goalToolExecution(ctx, exec)
      requireDirectHuman(ctx, execution)
      const goal = ctx.goals.create(execution.agent, {
        objective: args.objective,
        ...args.max_goal_rounds === undefined ? {} : { maxGoalRounds: args.max_goal_rounds },
      })
      return Promise.resolve(goalValue(goal))
    },
    presentCall: args => present('Create goal', 'other', args.objective),
  }))

  ctx.tools.register(defineTool({
    name: 'update_goal',
    description: 'Update the exact current goal revision. edit, pause, and resume require a direct '
      + 'top-level human request. During an automatic continuation of the current goal, complete '
      + 'and blocked are also allowed. blocked is rejected before the configured minimum round count; the model remains '
      + 'responsible for judging that the same condition persisted across those rounds and must explain it in blocked_reason.',
    parameters: {
      goal_id: { type: 'string', required: true, description: 'Exact id returned by get_goal.' },
      revision: { type: 'number', required: true, description: 'Exact positive revision returned by get_goal.' },
      action: {
        type: 'string',
        required: true,
        enum: UPDATE_ACTIONS,
        description: 'edit | pause | resume | complete | blocked',
      },
      objective: { type: 'string', description: 'Replacement objective; valid only with action edit.' },
      max_goal_rounds: { type: 'number', description: 'Replacement cap; valid only with action edit.' },
      blocked_reason: {
        type: 'string',
        description: 'Concrete blocking condition; required only with action blocked.',
      },
    },
    output: GOAL_OUTPUT,
    execute(args, exec) {
      const execution = goalToolExecution(ctx, exec)
      const ref = goalRef(args.goal_id, args.revision)
      const replacements = {
        ...hasText(args.objective) ? { objective: args.objective } : {},
        ...hasRoundCap(args.max_goal_rounds) ? { maxGoalRounds: args.max_goal_rounds } : {},
      }
      if (args.action === 'edit') {
        requireDirectHuman(ctx, execution)
        if (hasText(args.blocked_reason)) {
          throw new EjunzAgentError('blocked_reason is valid only with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
        }
        const goal = ctx.goals.edit(execution.agent, ref, replacements)
        return Promise.resolve(goalValue(goal))
      }
      if (args.action === 'pause' || args.action === 'resume') {
        requireDirectHuman(ctx, execution)
        if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds) || hasText(args.blocked_reason)) {
          throw new EjunzAgentError(
            'objective and max_goal_rounds are valid only with action edit; blocked_reason is valid only with action blocked',
            'GOAL_TOOL_INVALID_UPDATE',
          )
        }
        const goal = args.action === 'pause'
          ? ctx.goals.pause(execution.agent, ref)
          : ctx.goals.resume(execution.agent, ref)
        return Promise.resolve(goalValue(goal))
      }
      const authority = completionAuthority(ctx, execution)
      if (hasText(args.objective) || hasRoundCap(args.max_goal_rounds)) {
        throw new EjunzAgentError(
          'objective and max_goal_rounds are valid only with action edit',
          'GOAL_TOOL_INVALID_UPDATE',
        )
      }
      if (args.action === 'complete' && hasText(args.blocked_reason)) {
        throw new EjunzAgentError('blocked_reason is valid only with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
      }
      if (args.action === 'blocked'
        && (args.blocked_reason === undefined || args.blocked_reason.trim().length === 0)) {
        throw new EjunzAgentError('blocked_reason is required with action blocked', 'GOAL_TOOL_INVALID_UPDATE')
      }
      if (args.action === 'blocked' && authority.kind === 'goal-round'
        && authority.goal.roundsStarted < resolved.blockedAfterConsecutiveRounds) {
        throw new EjunzAgentError(
          `blocked requires at least ${resolved.blockedAfterConsecutiveRounds} consecutive goal rounds; `
          + `current round is ${authority.goal.roundsStarted}`,
          'GOAL_TOOL_BLOCK_THRESHOLD',
        )
      }
      const goal = args.action === 'complete'
        ? ctx.goals.complete(execution.agent, ref)
        : ctx.goals.block(execution.agent, ref, {
          code: 'model-reported',
          message: args.blocked_reason as string,
        })
      if (authority.kind === 'goal-round') {
        exec.deferContext(createUserMessage({
          content: args.action === 'complete'
            ? renderWrapupContext(goal.objective)
            : renderWrapupContext(goal.objective, args.blocked_reason as string),
          source: {
            kind: 'plugin',
            plugin: 'tool-goal',
            form: 'notice',
            summary: boundContextSummary(`${args.action as string}: ${goal.objective}`),
          },
        }))
      }
      return Promise.resolve(goalValue(goal))
    },
    presentCall: args => present(
      `${args.action === 'blocked' ? 'Mark' : args.action.charAt(0).toUpperCase() + args.action.slice(1)} goal`,
      'other',
      hasText(args.blocked_reason)
        ? args.blocked_reason
        : hasText(args.objective)
          ? args.objective
          : hasRoundCap(args.max_goal_rounds) ? args.max_goal_rounds : args.goal_id,
    ),
  }))
}

type TurnStartEvent = Extract<SessionEvent, { type: 'turn/start' }>

/** Current open turn plus the events accepted after its start boundary. */
export interface GoalToolExecution {
  readonly agent: Agent
  readonly start: TurnStartEvent
  readonly events: readonly SessionEvent[]
}

/** Hard authority granted to one state-changing call. */
export type GoalToolAuthority =
  | { readonly kind: 'direct-human' }
  | { readonly kind: 'goal-round'; readonly goal: GoalView }

/** Throw one structured tool-policy failure. */
function reject(message: string, code = 'GOAL_TOOL_AUTHORITY_REQUIRED'): never {
  throw new EjunzAgentError(message, code)
}

/** Locate the open turn enclosing a model tool call. */
function openTurn(agent: Agent): { start: TurnStartEvent; events: readonly SessionEvent[] } {
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const boundary = events[index]
    if (boundary?.type === 'turn/end') {
      reject('goal tools require an open model turn', 'GOAL_TOOL_DRIVER_REQUIRED')
    }
    if (boundary?.type === 'turn/start') {
      return { start: boundary, events: events.slice(index + 1) }
    }
  }
  return reject('goal tools require an open model turn', 'GOAL_TOOL_DRIVER_REQUIRED')
}

/**
 * Resolve and authenticate the calling agent and its driver boundary.
 * @param ctx - Context carrying the live agent registry.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns The authenticated agent and its current turn window.
 */
export function goalToolExecution(ctx: Context, exec: ToolRunContext): GoalToolExecution {
  const agent = exec.agent
  if (agent === undefined) {
    return reject('goal tools require a calling agent', 'GOAL_TOOL_AGENT_REQUIRED')
  }
  if (ctx.agents.get(agent.id) !== agent || agent.status !== 'running'
    || ctx.agents.currentInitiator() !== agent) {
    return reject(
      'goal tools require the exact live calling agent inside its active driver',
      'GOAL_TOOL_DRIVER_REQUIRED',
    )
  }
  return { agent, ...openTurn(agent) }
}

/**
 * Whether host-attested human input appears in the current root-agent turn.
 * An omitted `Agent.followup()` / `steer()` source resolves to `user`, so non-human
 * producers must supply their own source rather than inheriting this authority.
 */
function hasDirectHumanInput(ctx: Context, execution: GoalToolExecution): boolean {
  if (!ctx.agents.roots().includes(execution.agent)) return false
  return execution.events.some(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')
}

/** Whether this turn is the current goal's exact admitted round. */
function isMatchingGoalRound(execution: GoalToolExecution, goal: GoalView): boolean {
  return execution.events.some(event => event.type === 'user/message'
    && event.data.source.kind === 'goal'
    && event.data.source.goalId === goal.id
    && event.data.source.revision === goal.revision
    && event.data.source.round === goal.roundsStarted)
}

/**
 * Require authority originating in a human message accepted by a runtime root.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - Authenticated current tool execution.
 */
export function requireDirectHuman(ctx: Context, execution: GoalToolExecution): void {
  if (hasDirectHumanInput(ctx, execution)) return
  reject('this goal operation requires a direct human turn on a top-level agent')
}

/**
 * Resolve completion authority from either direct human input or the exact goal round.
 * @param ctx - Context carrying live agents and goal state.
 * @param execution - Authenticated current tool execution.
 * @returns The direct-human or exact-goal-round authority grant.
 */
export function completionAuthority(ctx: Context, execution: GoalToolExecution): GoalToolAuthority {
  if (hasDirectHumanInput(ctx, execution)) return { kind: 'direct-human' }
  const goal = ctx.goals.get(execution.agent)
  if (goal !== undefined && isMatchingGoalRound(execution, goal)) {
    return { kind: 'goal-round', goal }
  }
  return reject('complete and blocked require a direct human turn or the current goal round')
}

const GROUNDING =
  'Report only what earlier rounds and tool results in this session actually establish; '
  + 'when a detail is not in the session, say so instead of inventing it. '

/**
 * Render the closing-message instruction injected after an autonomous goal
 * round reports `complete` or `blocked`, replacing the former hard turn stop
 * so the model still addresses the user once before the turn ends.
 * @param objective - the terminal goal's objective, echoed for grounding.
 * @param blockedReason - the validated report for `blocked`; omitted for `complete`.
 * @returns a fresh one-block context for `ToolRunContext.deferContext()`.
 */
export function renderWrapupContext(objective: string, blockedReason?: string): ContentBlock[] {
  const heading = `Objective: ${JSON.stringify(objective)}\n`
  const text = blockedReason === undefined
    ? '<goal_complete>\n'
      + heading
      + 'The goal is marked complete and this autonomous run is ending. Write the closing '
      + 'message to the user now: state the outcome, summarize what was done and how it was '
      + 'verified, and point to the concrete results (files, commits, or other artifacts). '
      + GROUNDING
      + 'Note anything the user should review or do next. Address the user directly. Do not '
      + "call any more tools in this run; further work waits for the user's next instruction.\n"
      + '</goal_complete>'
    : '<goal_blocked>\n'
      + heading
      + `Blocked: ${JSON.stringify(blockedReason)}\n`
      + 'The goal is marked blocked and this autonomous run is ending. Write the closing '
      + 'message to the user now: state what has been completed so far, describe the concrete '
      + 'blocking condition and what you tried, and say exactly what you need from the user to '
      + 'continue. '
      + GROUNDING
      + 'Address the user directly. Do not call any more tools in this run; further work '
      + "waits for the user's next instruction.\n"
      + '</goal_blocked>'
  return [{ type: 'text', text }]
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'

namespace invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/tool-goal'
  
  /** Cordis companion plugin name. */
  export const name = 'tool-goal-invariant'
  /** Service required before the companion can reserve package ownership. */
  export const inject = ['invariants']
  
  /**
   * No runtime invariant: this model-facing adapter owns no independent state or event protocol;
   * accepted mutations are checked by the goal domain and authority behavior is package-tested.
   */
  const install: InvariantInstaller = () => {}
  
  /**
   * Register this package's invariant companion.
   * @param ctx - Cordis context carrying the invariant service.
   * @returns the installed registration's disposer after setup succeeds.
   */
  export const apply = (ctx: Context): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
  /* jscpd:ignore-end */
}
export import __invariant_companion = invariant
