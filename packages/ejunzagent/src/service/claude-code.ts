import { EventEmitter } from 'node:events'

import { extname } from 'node:path'

import type {
  SpawnedProcess,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'

import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@ejunz/ea-core/subprocess'

const WINDOWS_BATCH_EXECUTABLE_ENV = 'EA_CLAUDE_CODE_EXECUTABLE'

function thrown(value: unknown): Error {
  /* v8 ignore next -- the subprocess seam rejects with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

export function sdkEnvironmentOverlay(
  env: SpawnOptions['env'],
): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined
  }
  return overlay
}

export function claudeSpawnSpec(
  options: SpawnOptions,
  graceMs: number,
  platform: NodeJS.Platform = process.platform,
): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd.length === 0) {
    throw new Error('subagent-claude-code: SDK spawn request omitted its workspace')
  }
  const extension = extname(options.command).toLowerCase()
  const batchShim = platform === 'win32' && (extension === '.cmd' || extension === '.bat')
  const env = sdkEnvironmentOverlay(options.env)
  const argv = batchShim
    ? ['cmd.exe', '/d', '/v:off', '/s', '/c', `%${WINDOWS_BATCH_EXECUTABLE_ENV}%`, ...options.args]
    : [options.command, ...options.args]
  if (batchShim) env[WINDOWS_BATCH_EXECUTABLE_ENV] = `"${options.command}"`
  return {
    argv,
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs,
    signal: options.signal,
    env,
  }
}

export class ManagedClaudeCodeProcess implements SpawnedProcess {
  readonly stdin
  readonly stdout
  private readonly events = new EventEmitter()
  private exitCodeValue: number | null = null
  private signalCodeValue: NodeJS.Signals | null = null
  private killRequested = false

  /**
   * Project a managed process with piped stdin and stdout.
   * @param child - shared handle that remains the process-tree authority.
   */
  constructor(private readonly child: SubprocessHandle) {
    this.stdin = child.stdin as NonNullable<SubprocessHandle['stdin']>
    this.stdout = child.stdout as NonNullable<SubprocessHandle['stdout']>
    // EventEmitter gives `error` special throw semantics without a listener.
    // The SDK attaches its listener synchronously after custom spawn returns,
    // while this no-op also contains an already-rejected spawn handle.
    this.events.on('error', () => {})
    void child.done.then(
      (outcome) => {
        this.exitCodeValue = outcome.exitCode
        this.signalCodeValue = outcome.signal
        this.events.emit('exit', outcome.exitCode, outcome.signal)
      },
      (error: unknown) => {
        this.events.emit('error', thrown(error))
      },
    )
  }

  /** Whether the SDK has requested managed tree termination. */
  get killed(): boolean {
    return this.killRequested
  }

  /** Direct-child exit code, or null while running or after signal exit. */
  get exitCode(): number | null {
    return this.exitCodeValue
  }

  /** Direct-child terminating signal, if any. */
  get signalCode(): NodeJS.Signals | null {
    return this.signalCodeValue
  }

  /**
   * Route the SDK's termination request to the tree-scoped process owner.
   * @param _signal - SDK-selected signal; the shared seam owns its escalation ladder.
   * @returns false only after exit or a previous termination request.
   */
  kill(_signal: NodeJS.Signals): boolean {
    if (
      this.killRequested
      || this.exitCodeValue !== null
      || this.signalCodeValue !== null
    ) {
      return false
    }
    this.killRequested = true
    this.child.terminate()
    return true
  }

  /** Register a persistent process lifecycle listener. */
  on(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.on(event, listener)
  }

  /** Register a one-shot process lifecycle listener. */
  once(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.once(event, listener)
  }

  /** Remove a process lifecycle listener. */
  off(
    event: 'exit' | 'error',
    listener: ((code: number | null, signal: NodeJS.Signals | null) => void)
      | ((error: Error) => void),
  ): void {
    this.events.off(event, listener)
  }
}

import { randomUUID } from 'node:crypto'

import {
  query as officialQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk'

import type { ContentBlock } from '@ejunz/ea-core/llm'

import { SessionId } from '@ejunz/ea-core/session'

import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@ejunz/ea-core/subagent'

import {
  scrubbedParentEnv,
  type SubprocessHandle,
  type SubprocessSpawnSpec,
} from '@ejunz/ea-core/subprocess'

export const DEFAULT_DISPOSE_GRACE_MS = 3_000

export interface ClaudeCodeRunSpec {
  /** Parent Session workspace supplied to the SDK and real CLI. */
  readonly cwd: string
  /** Exact native Claude Code executable resolved from the host PATH. */
  readonly executable: string
  /** Explicit deployment/test environment layered after shared scrubbing. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared process-tree owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed SDK and subprocess failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

export function textTask(prompt: readonly ContentBlock[]): string {
  if (prompt.length === 0) {
    throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-claude-code: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-claude-code: the one-shot task must not be empty')
  }
  return texts.join('')
}

export function successfulResult(message: SDKResultMessage): string {
  if (
    message.subtype !== 'success'
    || message.is_error
    || message.result.trim().length === 0
  ) {
    const detail = message.subtype === 'success'
      ? 'success result was marked as an error or contained no answer'
      : message.errors.join('; ') || message.subtype
    throw new Error(`subagent-claude-code: Claude Code failed: ${detail}`)
  }
  return message.result
}

export async function consumeClaudeQuery(
  query: AsyncIterable<SDKMessage>,
): Promise<SubagentResult> {
  let answer: string | undefined
  for await (const message of query) {
    if (message.type !== 'result') continue
    answer = successfulResult(message)
  }
  if (answer === undefined) {
    throw new Error('subagent-claude-code: Claude Code ended without a result')
  }
  return {
    output: [{ type: 'text', text: answer }],
    stopReason: 'completed',
  }
}

export async function disposeClaudeCodeChild(
  query: Pick<Query, 'close'> | undefined,
  child: SubprocessHandle,
): Promise<void> {
  const failures: Error[] = []
  try {
    query?.close()
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  if (child.pid > 0) {
    child.terminate()
    try {
      await child.waitForExit()
    } catch (error: unknown) {
      failures.push(thrown(error))
    }
  }
  try {
    await child.done
  } catch (error: unknown) {
    failures.push(thrown(error))
  }

  const firstFailure = failures[0]
  if (failures.length === 1 && firstFailure !== undefined) throw firstFailure
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'subagent-claude-code: query and process cleanup failed',
    )
  }
}

export function claudeQueryOptions(
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (child: SubprocessHandle) => void,
): Options {
  return {
    abortController: controller,
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: spec.executable,
    env: { ...scrubbedParentEnv(), ...spec.env },
    persistSession: false,
    disallowedTools: ['AskUserQuestion'],
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      capture(child)
      return new ManagedClaudeCodeProcess(child)
    },
  }
}

export async function startClaudeCodeRun(
  request: SubagentStartRequest,
  spec: ClaudeCodeRunSpec,
): Promise<SubagentRun> {
  const prompt = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-claude-code: request was aborted before SDK startup')
  }

  const controller = new AbortController()
  const requestCancel = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('subagent-claude-code: run cancelled locally'))
    }
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  let child: SubprocessHandle | undefined
  let query: Query | undefined
  try {
    query = officialQuery({
      prompt,
      options: claudeQueryOptions(spec, controller, (captured) => {
        child = captured
      }),
    })
    if (child === undefined || child.pid <= 0) {
      throw new Error(
        'subagent-claude-code: official SDK did not publish a controllable Claude Code process',
      )
    }
    if (controller.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const cancelledBeforeCleanup = controller.signal.aborted
    requestCancel()
    if (child !== undefined) {
      try {
        await disposeClaudeCodeChild(query, child)
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and CLI cleanup also failed',
        )
      }
    } else if (query !== undefined) {
      try {
        query.close()
      } catch (disposeError: unknown) {
        throw new AggregateError(
          [thrown(error), thrown(disposeError)],
          'subagent-claude-code: startup failed and query cleanup also failed',
        )
      }
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the request can abort while process cleanup is awaited.
    if (cancelledBeforeCleanup || request.signal.aborted) {
      throw new Error('subagent-claude-code: request was aborted before SDK startup')
    }
    throw thrown(error)
  }

  const publishedQuery = query
  const publishedChild = child
  const result = settleRunResult({
    attempt: () => consumeClaudeQuery(publishedQuery),
    collectOutput: () => [],
    cancelled: () => controller.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  return subprocessRunHandle({
    id: SessionId(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: () => disposeClaudeCodeChild(
      publishedQuery,
      publishedChild,
    ),
  })
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea-core/timeout'

import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@ejunz/ea-core/subagent'

export const name = 'subagent-claude-code'

export const inject = ['subagents', 'subprocess']

export interface Config {
  /**
   * Explicit environment entries layered over the subprocess seam's
   * credential-scrubbed parent environment.
   */
  env?: Record<string, string>
  /** Grace in milliseconds for Claude Code process-tree termination. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Required<Config>

class ClaudeCodeProvider implements SubagentProvider {
  readonly name = 'claude-code'
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {}

  async start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-claude-code: no working directory for the child — delegate from a parent session that has one',
      )
    }
    const executable = await this.ctx.subprocess.resolveExecutable(
      'claude',
      this.config.env,
      request.signal,
    )
    const spec: ClaudeCodeRunSpec = {
      cwd: resolveChildCwd(
        'subagent-claude-code',
        undefined,
        parentCwd,
      ),
      executable,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-claude-code: child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startClaudeCodeRun(request, spec)
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite(
    'subagent-claude-code',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-claude-code: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new ClaudeCodeProvider(ctx, resolved))
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/subagent-claude-code'
  export const name = 'subagent-claude-code-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
