import { randomUUID } from 'node:crypto'

import { EjunzAgent, type EjunzAgentNotification } from '@ejunz/ea/sdk-client'

import type { ContentBlock } from '@ejunz/ea/llm'

import { SessionId, type SessionEvent, type TurnEndReason } from '@ejunz/ea/session'

import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@ejunz/ea/subagent'

import { AssistantOutputFold, settleRunResult, subprocessRunHandle } from '@ejunz/ea/subagent'

import { scrubbedParentEnv } from '@ejunz/ea/subprocess'

export interface SdkRunSpec {
  /** The executable to spawn (the child runtime — a `ea-jsonrpc-agent` bin or packaged exe). */
  command: string
  /** Arguments passed to {@link command} (typically the child's `cordis.yml` path). */
  args: string[]
  /**
   * Absolute working directory for the child process AND the workspace cwd
   * of its SDK session. The provider resolves it before this spec exists:
   * config override, else the delegating parent session's workspace.
   */
  cwd: string
  /** Provider route the child runtime initializes with. */
  provider: string
  /** Model the child runtime initializes with. */
  model: string
  /** Optional per-request output-token cap sent in the child runtime's initialize handshake. */
  maxTokens?: number
  /**
   * Extra environment variables to ADD for the child (e.g. the child
   * runtime's own `DEEPSEEK_API_KEY`, or `EA_CORDIS_CONFIG`). Merged after
   * the seam's `scrubbedParentEnv()` base, so an explicit credential or
   * current `EA_*` fact survives while ambient namesakes never leak.
   */
  env: Record<string, string>
  /** Bound (ms) on the protocol `shutdown` exchange during dispose. */
  shutdownTimeoutMs: number
  /** Grace period (ms) for the child's EOF-driven quiesce on dispose. */
  disposeEofGraceMs: number
  /** Termination confirmation window (ms), including forced exit on every platform. */
  disposeGraceMs: number
  /**
   * Sink for a child-level failure that the run flattened into a stop reason
   * (the seam contract forbids `result` rejecting). A throw from the sink
   * itself is contained. Optional — omitted in unit tests that assert the
   * stop reason directly.
   */
  onError?: (error: Error, stopReason: SubagentStopReason) => void
}

export const DEFAULT_DISPOSE_EOF_GRACE_MS = 6_000

export const DEFAULT_DISPOSE_GRACE_MS = 3_000

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1_000

export function sdkStopReason(reason: TurnEndReason | undefined): SubagentStopReason {
  switch (reason?.kind) {
    case 'completed':
      return 'completed'
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
      return 'aborted'
    // error / interrupted / disposed / a future merged variant /
    // no turn at all: the task did NOT finish cleanly — surface a generic
    // failure so the consumer maps it to an isError result.
    default:
      return 'error'
  }
}

function toError(value: unknown): Error {
  // The catch only sees rejections from the SDK client, which are always
  // `Error`s; the `String(value)` arm is a defensive fallback for a non-Error
  // throw that the typed surfaces cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

export async function startSdkRun(request: SubagentStartRequest, spec: SdkRunSpec): Promise<SubagentRun> {
  if (request.signal.aborted) throw new Error('subagent request was aborted before the SDK child started')
  // The run id lives in the parent namespace; the child runtime's session id
  // (minted below, private to the wire) exists only inside the child process.
  const id = SessionId(randomUUID())

  const ejunzAgent = new EjunzAgent({
    launch: {
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: { ...scrubbedParentEnv(), ...spec.env },
      shutdownTimeoutMs: spec.shutdownTimeoutMs,
      disposeEofGraceMs: spec.disposeEofGraceMs,
      disposeGraceMs: spec.disposeGraceMs,
    },
    cwd: spec.cwd,
    provider: spec.provider,
    model: spec.model,
    ...spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens },
  })

  // Cancellation settles the result without waiting for a cooperative child.
  const flags = { cancelled: false }
  let signalCancelSettled!: () => void
  const cancelSettled = new Promise<void>((resolve) => { signalCancelSettled = resolve })
  const requestCancel = (): void => {
    if (flags.cancelled) return
    flags.cancelled = true
    signalCancelSettled()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  // Establish the child handshake before publishing a handle. Any failure
  // owns the still-private process and reaps it before rejecting.
  try {
    await Promise.race([
      ejunzAgent.start(),
      cancelSettled.then((): never => { throw new Error('subagent cancelled before the SDK child initialized') }),
    ])
    // Defensive: an abort() is a macrotask and no user callback runs inside
    // the microtask drain between handshake fulfillment and this continuation,
    // so the recheck is not schedulable today; it guards future reentrancy.
    /* v8 ignore next */
    if (flags.cancelled) throw new Error('subagent cancelled before the SDK child initialized')
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    await ejunzAgent.close()
    if (flags.cancelled) throw new Error('subagent request was aborted before the SDK child started')
    throw toError(error)
  }

  const childSessionId = `session-${randomUUID().replaceAll('-', '')}`
  // The child's final answer under the seam's canonical selection rule
  // (`AssistantOutputFold`); a partial answer survives cancel and error paths.
  const fold = new AssistantOutputFold()
  const observe = (notification: EjunzAgentNotification): void => {
    if (notification.method !== 'session.event' || notification.params.sessionId !== childSessionId) return
    fold.push(notification.params.event as SessionEvent)
  }
  const collectOutput = (): ContentBlock[] => fold.collect() ?? []

  // Race the child turn against local cancellation; the shared settlement
  // flattens failures under the seam's never-reject contract.
  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      const turn = await Promise.race([
        ejunzAgent.session(childSessionId).run(request.prompt, { onNotification: observe }),
        cancelSettled.then(() => 'cancelled' as const),
      ])
      if (turn === 'cancelled') return { output: collectOutput(), stopReason: 'aborted' }
      const lastEnd = turn.events.findLast(
        (event): event is Extract<SessionEvent, { type: 'turn/end' }> => event.type === 'turn/end',
      )
      return { output: collectOutput(), stopReason: sdkStopReason(lastEnd?.data.reason) }
    },
    collectOutput,
    cancelled: () => flags.cancelled,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  // There is no wire-level prompt cancel: dispose settles the result locally,
  // then the bounded shutdown request + dispose ladder tears the child down.
  return subprocessRunHandle({
    id,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => ejunzAgent.close(),
  })
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import type { SubagentCapabilities, SubagentProvider, SubagentStartRequest } from '@ejunz/ea/subagent'

import { assertPositiveFinite, NO_START_CAPABILITIES, resolveChildCwd, validateConfiguredCwd } from '@ejunz/ea/subagent'

export const name = 'subagent-ea-sdk'

export const inject = ['subagents']

export interface Config {
  /** Provider name on `ctx.subagents` (default `ea-sdk`). */
  providerName: string
  /** The executable to spawn for each run (the child runtime bin or packaged exe). */
  command: string
  /** Arguments passed to {@link command} (typically the child's `cordis.yml` path). */
  args: string[]
  /**
   * Working directory override for the child process and its SDK session
   * workspace. Must be non-empty; a relative path resolves against the
   * ejunzAgent launch directory at load, and the result must be an existing
   * directory. When omitted, each child inherits its delegating parent
   * session's cwd — and starting one from a parent session that has no cwd
   * fails.
   */
  cwd?: string
  /** Provider route the child runtime initializes with (default `deepseek-official`). */
  provider: string
  /** Model the child runtime initializes with (default `deepseek-flash`). */
  model: string
  /** Optional per-request output-token cap for the child runtime. */
  maxTokens?: number
  /**
   * Extra environment variables for the child process — e.g. the child
   * runtime's own `DEEPSEEK_API_KEY`, or `EA_CORDIS_CONFIG` naming its
   * config. Forwarded on top of a credential-scrubbed copy of the parent
   * env, so an explicit key here reaches the child while ambient secrets do
   * not leak implicitly.
   */
  env: Record<string, string>
  /** Bound (ms) on the protocol `shutdown` exchange during dispose. */
  shutdownTimeoutMs?: number
  /**
   * Grace period (ms) for the child's EOF-driven quiesce on dispose — its
   * window to flush persistence and tear down its own nested subprocesses
   * before the parent escalates to a signal.
   */
  disposeEofGraceMs?: number
  /** Termination confirmation window (ms), including forced exit on every platform. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().default('ea-sdk'),
  command: z.string().required(),
  args: z.array(z.string()).default([]),
  cwd: z.string(),
  provider: z.string().default('deepseek-official'),
  model: z.string().default('deepseek-flash'),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  env: z.dict(z.string()).default({}),
  shutdownTimeoutMs: z.number().default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  disposeEofGraceMs: z.number().default(DEFAULT_DISPOSE_EOF_GRACE_MS),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Required<Omit<Config, 'cwd' | 'maxTokens'>> & Pick<Config, 'cwd' | 'maxTokens'>

class SdkSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  // Context contract: an out-of-process SDK child starts fresh — no parent conversation crosses the process boundary.
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly ctx: Context, private readonly config: ResolvedConfig) {}

  start(request: SubagentStartRequest) {
    const spec: SdkRunSpec = {
      command: this.config.command,
      args: this.config.args,
      cwd: resolveChildCwd('subagent-ea-sdk', this.config.cwd, request.parent.session.header.cwd),
      provider: this.config.provider,
      model: this.config.model,
      ...this.config.maxTokens === undefined ? {} : { maxTokens: this.config.maxTokens },
      env: this.config.env,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      disposeEofGraceMs: this.config.disposeEofGraceMs,
      disposeGraceMs: this.config.disposeGraceMs,
      onError: (error, stopReason) => {
        // The seam forbids `result` rejecting, so a child-level failure is
        // flattened to a stop reason — preserve it here rather than losing it.
        this.ctx.logger.warn(`subagent-ea-sdk "${this.name}": child run failed (${stopReason}): ${error.message}`)
      },
    }
    return startSdkRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  // schemastery (Config) has already filled every defaulted field.
  const resolved = config as ResolvedConfig
  assertPositiveFinite('subagent-ea-sdk', 'shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertPositiveFinite('subagent-ea-sdk', 'disposeEofGraceMs', resolved.disposeEofGraceMs)
  assertPositiveFinite('subagent-ea-sdk', 'disposeGraceMs', resolved.disposeGraceMs)
  if (resolved.maxTokens !== undefined && (!Number.isSafeInteger(resolved.maxTokens) || resolved.maxTokens <= 0)) {
    throw new TypeError('subagent-ea-sdk maxTokens must be a positive safe integer')
  }
  // Interpret a relative configured cwd against the ejunzAgent launch directory
  // ONCE, at load, and fail a misconfigured directory here — not per start.
  const configuredCwd = validateConfiguredCwd('subagent-ea-sdk', resolved.cwd)
  const validated: ResolvedConfig = configuredCwd === undefined
    ? resolved
    : { ...resolved, cwd: configuredCwd }
  ctx.subagents.registerProvider(new SdkSubagentProvider(validated.providerName, ctx, validated))
}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/subagent-ea-sdk'
  export const name = 'subagent-ea-sdk-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
