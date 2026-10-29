import type { Context } from '@ejunz/cordis'

import type { ToolSchema } from '@ejunz/ea/llm'

import type { ToolExecution, ToolRunContext } from '@ejunz/ea/tools'

import { ToolArgsError, validateJsonSchemaValue, type ObjectJsonSchema } from '@ejunz/ea/tools'

export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

export const STRUCTURED_OUTPUT_INSTRUCTION
  = 'When you have your final answer, you MUST report it by calling the '
    + `\`${STRUCTURED_OUTPUT_TOOL}\` tool with arguments matching its parameter schema exactly. `
    + 'Do not finish with a plain text answer: only the tool call counts as your result.'

export interface StructuredAttachment {
  /**
   * The captured value, once the child called the tool with valid arguments
   * and the authoritative final tool result accepted that call.
   * @returns the committed value, or undefined while none was accepted.
   */
  captured(): { value: unknown } | undefined
}

export function attachStructuredRuntime(childCtx: Context, schema: ObjectJsonSchema): StructuredAttachment {
  /**
   * Validated values staged by the capture tool body, awaiting THEIR OWN
   * authoritative `tools/result` notification. The execution object's identity
   * uniquely identifies a trip through the pipeline: adapter call ids may
   * repeat across steps, but another execution can never reach this WeakMap
   * entry. The final notification always deletes its own
   * stage, whether the result succeeded or failed.
   */
  const staged = new WeakMap<ToolExecution, { value: unknown }>()
  let captured: { value: unknown } | undefined

  const schemaEntry: ToolSchema = {
    name: STRUCTURED_OUTPUT_TOOL,
    description:
      'Report your final structured result. Call this exactly once, when your answer is complete; '
      + 'the arguments must match this tool\'s parameter schema exactly.',
    // ToolSchema.parameters is the wire-level JSON Schema object; the
    // asserted subset type is structurally exactly that.
    parameters: schema as unknown as Record<string, unknown>,
  }

  childCtx.tools.register({
    ...schemaEntry,
    output: {
      schema: {
        type: 'object',
        properties: { recorded: { type: 'boolean', const: true } },
        required: ['recorded'],
        additionalProperties: false,
      },
      render: () => [{ type: 'text', text: 'Structured output recorded.' }],
    },
    execute(args: unknown, exec: ToolRunContext): Promise<{ recorded: true }> {
      const violations = validateJsonSchemaValue(schema, args)
      // ToolArgsError → isError result with INVALID_ARGS: the model retries
      // within the same turn, exactly like a schema-validated defineTool call.
      if (violations.length > 0) throw new ToolArgsError(violations)
      // Two-phase commit, keyed by THIS execution: later transformable
      // waterfalls may still turn the success into an error. ToolRuntime has
      // already frozen model-bound arguments at the actual input boundary.
      staged.set(exec, { value: args })
      exec.concludeTurn()
      return Promise.resolve({ recorded: true })
    },
  })

  childCtx.systemPrompt.section({
    name: `tool:${STRUCTURED_OUTPUT_TOOL}`,
    order: 190,
    text: STRUCTURED_OUTPUT_INSTRUCTION,
  })

  // Terminal WITHIN the step. Guards run after the whole pre-execute
  // waterfall and compose monotonically (deny or abstain, never allow), so a
  // later prepended listener cannot resurrect dispatch. Calls that precede
  // capture in the same response remain untouched.
  childCtx.tools.guard(exec => captured === undefined
    ? undefined
    : `structured output already recorded: the run is complete, so \`${exec.name}\` is not executed`)

  // The capture COMMIT observes the immutable, authoritative result after the
  // complete pipeline and outer error normalization. This notification cannot
  // transform the outcome, so there is no wrapper outside the commit verdict.
  childCtx.on('tools/result', function (this: unknown, exec, result) {
    if (exec.name !== STRUCTURED_OUTPUT_TOOL) return
    const entry = staged.get(exec)
    if (entry === undefined) return
    staged.delete(exec)
    if (!result.isError && captured === undefined) captured = { value: entry.value }
  })

  return { captured: () => captured }
}

import { randomUUID } from 'node:crypto'

import type { Context } from '@ejunz/cordis'

import { foldConsumedWork } from '@ejunz/ea/agent'

import type { Agent, AgentHandle } from '@ejunz/ea/agent'

import { SessionId, type SessionEvent, type TurnEndReason } from '@ejunz/ea/session'

import { createUserMessage, type ContentBlock } from '@ejunz/ea/llm'

import {
  appendDelegatedPolicyOverrides,
  applyChildComposition,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
} from '@ejunz/ea/subagent'

import type {
  ResolvedSubagentStartRequest,
  SubagentDescriptorData,
  SubagentResult,
  SubagentRun,
  SubagentStopReason,
} from '@ejunz/ea/subagent'

function toStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // A pre-step rejection discarded the claimed prompt: the task was
    // declined, and the caller must not read the run as done.
    case 'blocked':
      return 'refusal'
    case 'error':
    case 'interrupted':
    default:
      return 'error'
  }
}

export interface InProcessRunOptions {
  /** Completed-turn seed for fork, or undefined for a fresh spawn. */
  readonly seed?: SessionEvent[]
}

function prePublicationAbort(): Error {
  return new Error('subagent request was aborted before child publication')
}

function attachDescriptorAppend(childCtx: Context, descriptor: SubagentDescriptorData): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

export async function startInProcessRun(
  request: ResolvedSubagentStartRequest,
  options: InProcessRunOptions,
): Promise<SubagentRun> {
  assertSubagentMaxDepth(request.maxDepth)
  if (request.signal.aborted) throw prePublicationAbort()
  const parent = request.parent
  const childDepth = resolveChildDepth(parent, request.maxDepth)

  const childId = SessionId(randomUUID())
  const seed = options.seed
  const activationBoundary = seed?.length ?? 0

  // Capture before the first await: a later parent switch belongs to the
  // parent's future.
  const inherited = captureDelegatedPolicyOverrides(parent)

  let structured: StructuredAttachment | undefined
  const setup = (childCtx: Context): void => {
    appendDelegatedPolicyOverrides((childCtx.agent as Agent).session, inherited)
    applyChildComposition(childCtx, parent, {
      persona: request.persona,
      toolFilter: request.toolFilter,
    })
    if (request.outputSchema !== undefined) {
      structured = attachStructuredRuntime(childCtx, request.outputSchema)
    }
    attachDescriptorAppend(childCtx, request.descriptor)
  }

  const handle = await parent.ctx.agents.create({
    sessionId: childId,
    meta: childSessionMeta(parent, childDepth, activationBoundary),
    ...seed !== undefined ? { seed } : {},
    agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
    signal: request.signal,
    setup,
  })
  return drivePublishedRun(
    handle,
    request.signal,
    request.prompt,
    childId,
    activationBoundary,
    structured,
  )
}

function drivePublishedRun(
  handle: AgentHandle,
  signal: AbortSignal,
  prompt: ContentBlock[],
  childId: SessionId,
  boundary: number,
  structured: StructuredAttachment | undefined,
): SubagentRun {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = (): void => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  // Agent creation detaches its creation-only listener before returning. The
  // post-registration check closes that handoff without treating an already
  // published child as a failed start.
  if (signal.aborted) onAbort()

  const result: Promise<SubagentResult> = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      return readResult(
        child,
        boundary,
        flags.cancelled,
        structured ? { captured: structured.captured() } : undefined,
      )
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()

  return {
    id: childId,
    localAgent: child,
    result,
    async dispose(): Promise<void> {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const settlements = await Promise.allSettled([handle.dispose(), result])
      const disposal = settlements[0]
      // The result channel owns run faults; disposal reports only failure to
      // release the published handle after both operations settle.
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

function readResult(
  child: Agent,
  boundary: number,
  cancelled: boolean,
  structured?: { captured?: { value: unknown } | undefined },
): SubagentResult {
  const own = child.session.events.slice(boundary)
  // `droppedUnrun` is deliberately unread: a one-shot prompt is claimed by its
  // awaited first turn almost immediately, and the owner's own teardown is the
  // `cancelled` flag below. A cancellation with no accounting turn resolves
  // `error` through `toStopReason(undefined)`, which never overstates success.
  const lastEnd = foldConsumedWork(own).end
  // The seam's canonical selection rule; a partial answer survives cancel and truncation.
  const output: ContentBlock[] = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  // Disposal can tear the owner down before the loop records its ordinary
  // `aborted` end, yielding `disposed` instead.
  const stopReason: SubagentStopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  if (structured !== undefined) {
    if (structured.captured !== undefined) {
      return { output, structured: structured.captured.value, stopReason }
    }
    if (stopReason === 'completed') return { output, stopReason: cancelled ? 'aborted' : 'error' }
  }
  return { output, stopReason }
}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/subagent-in-process-driver'
  export const name = 'subagent-in-process-driver-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
