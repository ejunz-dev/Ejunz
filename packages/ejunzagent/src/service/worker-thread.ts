export class MaterializeError extends Error {
  constructor(public readonly path: string, public readonly reason: string) {
    super(`${path}: ${reason}`)
    this.name = 'MaterializeError'
  }
}

export function renderThrown(error: unknown): string {
  try {
    const stack = (error as { stack?: unknown } | null | undefined)?.stack
    if (typeof stack === 'string' && stack.length > 0) return stack
    const message = (error as { message?: unknown } | null | undefined)?.message
    if (typeof message === 'string' && message.length > 0) return message
    return String(error)
  } catch {
    // A throwing accessor/toString on the thrown value — rendering must be
    // total (drive()'s never-reject contract), so fall back to a fixed label.
    return '[unrenderable thrown value]'
  }
}

function hasPlainPrototype(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto === null) return true
  return Object.getPrototypeOf(proto) === null
}

export function materializeFromRealm(value: unknown, root = 'value'): unknown {
  if (value === undefined) return undefined
  try {
    return materialize(value, root, new Set())
  } catch (error: unknown) {
    if (error instanceof MaterializeError) throw error
    // A property read ran script code that threw; total-ize it so callers can
    // keep the narrow MaterializeError contract.
    throw new MaterializeError(root, `reading the value threw: ${renderThrown(error)}`)
  }
}

function materialize(value: unknown, path: string, seen: Set<object>): unknown {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return value
    case 'number': {
      if (!Number.isFinite(value)) throw new MaterializeError(path, 'non-finite numbers are not JSON data')
      return value
    }
    case 'bigint':
      throw new MaterializeError(path, 'bigints are not JSON data')
    case 'function':
      throw new MaterializeError(path, 'functions are not plain JSON data')
    case 'symbol':
      throw new MaterializeError(path, 'symbols are not plain JSON data')
    case 'undefined':
      throw new MaterializeError(path, 'undefined is not JSON data')
    case 'object':
      break
  }
  if (value === null) return null
  const objectValue: object = value
  if (seen.has(objectValue)) throw new MaterializeError(path, 'circular references are not JSON data')
  seen.add(objectValue)
  try {
    if (Array.isArray(objectValue)) return materializeArray(objectValue, path, seen)
    return materializeObject(objectValue, path, seen)
  } finally {
    seen.delete(objectValue)
  }
}

function materializeArray(value: unknown[], path: string, seen: Set<object>): unknown[] {
  const out: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) throw new MaterializeError(`${path}[${index}]`, 'sparse arrays are not JSON data')
    out.push(materialize(value[index], `${path}[${index}]`, seen))
  }
  // Own enumerable props beyond the indices (e.g. `arr.total = 3`) would be
  // silently dropped by JSON — reject them instead.
  for (const key of Object.keys(value)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= value.length) {
      throw new MaterializeError(`${path}.${key}`, 'arrays with non-index properties are not JSON data')
    }
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
  }
  return out
}

function materializeObject(value: object, path: string, seen: Set<object>): Record<string, unknown> {
  if (!hasPlainPrototype(value)) {
    throw new MaterializeError(path, 'only plain objects and arrays are JSON data (exotic prototype)')
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new MaterializeError(path, 'symbol-keyed properties are not plain JSON data')
  }
  const out: Record<string, unknown> = {}
  // Object.keys = own enumerable string keys, matching JSON.stringify's
  // property selection exactly (non-enumerable props never reach JSON output).
  for (const key of Object.keys(value)) {
    // defineProperty, never assignment: a "__proto__" key must become an OWN
    // data property of the copy, not a prototype mutation.
    Object.defineProperty(out, key, {
      value: materialize((value as Record<string, unknown>)[key], `${path}.${key}`, seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

import type { ContentBlock } from '@ejunz/ea/llm'

import type { ObjectJsonSchema } from '@ejunz/ea/tools'

import type { WorkflowMeta } from '@ejunz/ea/workflow'

export interface WorkerLimits {
  /** Concurrent `agent()` ceiling (already auto-resolved; ≥ 1). */
  maxConcurrentAgents: number
  /** Total `agent()` calls per run (the runaway-loop backstop). */
  maxTotalAgents: number
  /** Items accepted by one `parallel()`/`pipeline()` call. */
  maxItemsPerCall: number
  /** vm timeout for the script's initial synchronous slice (inside the worker). */
  syncTimeoutMs: number
}

export interface WorkerInit {
  /** The validated meta block (plain data off the start request, validated host-side). */
  meta: WorkflowMeta
  /** The plain-JS script body, exactly as the start request carried it. */
  body: string
  /** The run's `args` value; the workerData structured clone is the copy that isolates the caller. */
  args?: unknown
  /** The worker-enforced limits. */
  limits: WorkerLimits
}

export interface ChildStartRequest {
  /** The child's prompt text. */
  prompt: string
  /** The structured-output schema, if the call passed one (already subset-checked). */
  schema?: ObjectJsonSchema
  /** The per-child provider override, if the call passed one. */
  provider?: string
  /** The per-child model override, if the call passed one. */
  model?: string
}

export interface ChildResult {
  /** The child's final assistant output blocks. */
  output: ContentBlock[]
  /** The structured value, present iff the request carried a schema AND the provider honored it. */
  structured?: unknown
  /** Why the child run ended (`'completed'` is the only value the runtime branches on). */
  stopReason: string
}

export interface ChildHandle {
  /** The child agent's id (minted host-side by the subagent seam). */
  readonly id: string
  /**
   * Resolves with the child's terminal {@link ChildResult}; REJECTS only when
   * the host reports an infrastructure fault (`child-failed`) — a child that
   * failed for its own reasons resolves with a non-`completed` stop reason.
   */
  readonly result: Promise<ChildResult>
  /** Ask the host to dispose the child; resolves on the host's ack. */
  dispose(): Promise<void>
}

export interface ChildPort {
  /**
   * Start one child agent on the host (the `agent()` hook's start half).
   * @param request - the prompt and validated options.
   * @returns the published child handle; rejects when synchronous start or the
   *   provider's asynchronous start fails.
   */
  startAgent(request: ChildStartRequest): Promise<ChildHandle>
}

import * as vm from 'node:vm'

import type { ContentBlock } from '@ejunz/ea/llm'

import { SessionId } from '@ejunz/ea/session'

import { assertObjectJsonSchema, JsonSchemaError } from '@ejunz/ea/tools'

import type { ObjectJsonSchema } from '@ejunz/ea/tools'

import { isFatalWorkflowError, WorkflowError } from '@ejunz/ea/workflow'

import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowMeta,
  WorkflowResult,
} from '@ejunz/ea/workflow'

export interface ExecutionObserver {
  phase(title: string): void
  log(message: string): void
  agentStart(info: WorkflowAgentInfo): void
  agentEnd(info: WorkflowAgentEndInfo): void
}

const SUPPORTED_AGENT_OPTIONS = new Set(['label', 'phase', 'schema', 'provider', 'model'])

const DEFERRED_AGENT_OPTIONS = new Set(['effort', 'isolation', 'agentType'])

function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function defaultLabel(prompt: string): string {
  const newline = prompt.indexOf('\n')
  const line = newline === -1 ? prompt : prompt.slice(0, newline)
  return line.length <= 48 ? line : `${line.slice(0, 47)}…`
}

export class WorkflowExecution {
  /** 1-based count of `agent()` calls started (the `agentsStarted` result field). */
  private started = 0
  private activeSlots = 0
  private readonly slotWaiters: { resolve(): void; reject(error: unknown): void }[] = []
  private cancelReason: string | undefined
  private cancelError: WorkflowError | undefined
  private currentPhase: string | undefined
  private readonly context: vm.Context
  private readonly compiled: vm.Script

  constructor(
    meta: WorkflowMeta,
    body: string,
    args: unknown,
    private readonly limits: WorkerLimits,
    private readonly observer: ExecutionObserver,
    private readonly children: ChildPort,
  ) {
    // Compile FIRST: a body syntax error must throw out of the constructor
    // before any realm state exists. The host pre-parses the identical
    // wrapper, so under one Node version this throw is unreachable in
    // production — the session still maps it to an error result defensively.
    // lineOffset compensates for the wrapper line, so stack traces carry the
    // script's own line numbers.
    try {
      this.compiled = new vm.Script(`(async () => {\n${body}\n})()`, {
        filename: `workflow:${meta.name}`,
        lineOffset: -1,
      })
    } catch (error: unknown) {
      throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
    }

    this.context = vm.createContext({}, { name: `workflow:${meta.name}` })

    const globals: Record<string, unknown> = {
      agent: (prompt: unknown, opts?: unknown) => this.contain(this.agent(prompt, opts)),
      parallel: (thunks: unknown) => this.contain(this.parallel(thunks)),
      pipeline: (items: unknown, ...stages: unknown[]) => this.contain(this.pipeline(items, stages)),
      phase: (title: unknown) => { this.phase(title) },
      log: (message: unknown) => { this.log(message) },
      // workerData already performed the real cross-thread structured clone.
      args,
    }
    for (const [key, value] of Object.entries(globals)) {
      // Data properties on the contextified global; frozen shape not required —
      // a script overwriting its own hooks only sabotages itself.
      ;(this.context as Record<string, unknown>)[key] = typeof value === 'function' ? Object.freeze(value) : value
    }
  }

  /**
   * Whether the run has been cancelled. A METHOD, not an inline property
   * read: `cancel()` mutates `cancelReason` concurrently (the session's
   * message handler), and an inline read after an `await` gets narrowed by
   * control flow into an always-false comparison.
   */
  private isCancelled(): boolean {
    return this.cancelReason !== undefined
  }

  /**
   * Shared hook entry guard: after {@link cancel}, EVERY hook throws
   * `CANCELLED` at its next call — cancellation is the next HOOK boundary,
   * not just the next `agent()`, so a script that caught one cancelled
   * rejection cannot keep emitting progress through `phase`/`log` or enter a
   * combinator.
   */
  private throwIfCancelled(): void {
    if (this.isCancelled()) throw this.cancelledError()
  }

  /**
   * Cancel the run: waiting `agent()` slots reject and every future hook call
   * throws `CANCELLED` — the script dies at its next await. A script that
   * never settles anyway (parked on a promise no hook owns) is the HOST's
   * problem: its grace timer force-settles the run and terminates the
   * worker. Idempotent; the first reason wins.
   * @param reason - human-readable cause carried on the CANCELLED error. The
   * host independently aborts the required signal shared by every child.
   */
  cancel(reason: string): void {
    if (this.cancelReason !== undefined) return
    this.cancelReason = reason
    this.cancelError = new WorkflowError(`workflow run cancelled: ${this.cancelReason}`, 'CANCELLED')
    for (const waiter of this.slotWaiters.splice(0)) waiter.reject(this.cancelledError())
  }

  /**
   * Run the script to settlement. Resolves — never rejects — with the run's
   * {@link WorkflowResult}: the materialized return value on `completed`, the
   * failure message on `error`, and `cancelled` when the script died of
   * cancellation. This method only chooses the result; the session publishes
   * it and the host owns terminal child cancellation.
   * @returns the settled outcome — this promise NEVER rejects (the seam's
   * `result`-never-rejects contract); every failure maps to a variant.
   */
  async drive(): Promise<WorkflowResult> {
    try {
      // Cancelled before the body ever ran (an already-aborted start signal,
      // relayed by the host before its `go`): the script must not execute at
      // all, let alone report `completed`.
      if (this.isCancelled()) throw this.cancelledError()
      const scriptPromise = this.compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs }) as Promise<unknown>
      const raw: unknown = await this.contain(Promise.resolve(scriptPromise))
      // Cancelled while the body ran: a script that settled without touching
      // another hook (or without any) must still report `cancelled` — the
      // holder asked for cancellation and `completed` would be a lie.
      if (this.isCancelled()) throw this.cancelledError()
      const value = raw === undefined ? null : this.materializeResult(raw)
      return { value, stopReason: 'completed', agentsStarted: this.started }
    } catch (error: unknown) {
      // Any failure after cancel() reports `cancelled` with the canonical
      // reason — the reject path mirrors the resolve path's post-settle check.
      if (this.isCancelled()) {
        return { value: null, stopReason: 'cancelled', error: this.cancelledError().message, agentsStarted: this.started }
      }
      // renderThrown is total (thrown values of any realm), so this arm
      // cannot throw — drive() resolving is the `result` never-rejects contract
      // contract.
      return { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: this.started }
    }
  }

  /**
   * Attach a no-op rejection consumer WITHOUT changing what the caller
   * receives: if the script drops the promise (no await), cancellation cannot
   * become an unhandled rejection (which would kill the worker thread); if
   * the script does await it, it still observes the rejection.
   */
  private contain<T>(promise: Promise<T>): Promise<T> {
    promise.catch(() => { /* consumed: see method contract — a dropped hook promise must not surface an unhandled rejection */ })
    return promise
  }

  private cancelledError(): WorkflowError {
    // cancel() arms cancelError before any caller can observe isCancelled()
    // === true; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    return this.cancelError ?? new WorkflowError('workflow run cancelled', 'CANCELLED')
  }

  /** Materialize the script's return value; violations become RESULT_UNSERIALIZABLE. */
  private materializeResult(raw: unknown): unknown {
    try {
      return materializeFromRealm(raw, 'workflow result')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(
        `the workflow's return value is not plain JSON data — ${error.message}. Return only JSON-serializable objects/arrays/scalars.`,
        'RESULT_UNSERIALIZABLE',
        { cause: error },
      )
    }
  }

  /**
   * Acquire one concurrency slot (FIFO). Cancellation rejects QUEUED waiters
   * (see {@link cancel}); the callers guard their own entry and post-acquire
   * windows, so no cancelled-precheck is duplicated here.
   */
  private acquireSlot(): Promise<void> {
    if (this.activeSlots < this.limits.maxConcurrentAgents) {
      this.activeSlots += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      this.slotWaiters.push({
        resolve: () => {
          this.activeSlots += 1
          resolve()
        },
        reject,
      })
    })
  }

  private releaseSlot(): void {
    this.activeSlots -= 1
    const next = this.slotWaiters.shift()
    if (next) next.resolve()
  }

  /** The `agent(prompt, opts)` hook. */
  private async agent(rawPrompt: unknown, rawOpts: unknown): Promise<unknown> {
    this.throwIfCancelled()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw new WorkflowError('agent() requires a non-empty prompt string', 'INVALID_ARGUMENT')
    }
    const opts = this.readAgentOptions(rawOpts)
    if (this.started >= this.limits.maxTotalAgents) {
      throw new WorkflowError(
        `this run reached its total agent cap (${this.limits.maxTotalAgents}) — a runaway-loop backstop; raise the applicable maxTotalAgents limit if the scale is intentional`,
        'AGENT_CAP',
      )
    }
    this.started += 1
    const seq = this.started
    const label = opts.label ?? defaultLabel(rawPrompt)
    const phase = opts.phase ?? this.currentPhase

    await this.acquireSlot()
    try {
      // Re-check after the acquire: the await yields at least one microtask
      // tick even when a slot is free, and a queued waiter resumes a tick
      // after its release — a cancel() landing in either window must not
      // reach the host (which would refuse anyway, but the refusal reads as
      // a start failure rather than the cancellation it is).
      this.throwIfCancelled()
      let run: ChildHandle
      try {
        run = await this.children.startAgent({
          prompt: rawPrompt,
          ...opts.schema !== undefined ? { schema: opts.schema } : {},
          ...opts.provider !== undefined ? { provider: opts.provider } : {},
          ...opts.model !== undefined ? { model: opts.model } : {},
        })
      } catch (error: unknown) {
        // The host refuses starts once the run is cancelled — a refusal that
        // races our own cancel state must read as the cancellation it is,
        // not as a broken contract.
        if (this.isCancelled()) throw this.cancelledError()
        throw new WorkflowError(`agent() could not start a child: ${renderThrown(error)}`, 'AGENT_START', { cause: error })
      }
      // The start round-trip yields to the event loop, so a cancel CAN land
      // between the host starting the child and this continuation running —
      // wind the fresh child down instead of leaving it live behind a dead
      // script.
      if (this.isCancelled()) {
        await run.dispose()
        throw this.cancelledError()
      }
      const info: WorkflowAgentInfo = { seq, label, ...phase !== undefined ? { phase } : {}, childId: SessionId(run.id) }
      this.observer.agentStart(info)
      try {
        let result
        try {
          result = await run.result
        } catch (error: unknown) {
          // A rejected child result is an INFRASTRUCTURE fault relayed by the
          // host — distinct from a child that failed and resolved. Pair the
          // lifecycle before propagating, and propagate FATAL: an ordinary
          // throw would dissolve to a per-item null inside the combinators,
          // and a broken provider must not read as a failed child.
          if (this.isCancelled()) {
            this.observer.agentEnd({ ...info, outcome: 'cancelled' })
            throw this.cancelledError()
          }
          this.observer.agentEnd({ ...info, outcome: 'failed' })
          throw new WorkflowError(`child agent run failed: ${renderThrown(error)}`, 'AGENT_RESULT', { cause: error })
        }
        if (result.stopReason === 'completed') {
          if (opts.schema !== undefined) {
            // The provider honored outputSchema (capability-gated at start), so
            // a completed run without a structured value is a child failure.
            if (result.structured === undefined) {
              this.observer.agentEnd({ ...info, outcome: 'failed' })
              return null
            }
            this.observer.agentEnd({ ...info, outcome: 'completed' })
            return result.structured
          }
          this.observer.agentEnd({ ...info, outcome: 'completed' })
          return outputText(result.output)
        }
        // A cancelled RUN kills the script; a child that failed for its own
        // reasons resolves null (scripts .filter(Boolean) per the CC contract).
        if (this.isCancelled()) {
          this.observer.agentEnd({ ...info, outcome: 'cancelled' })
          throw this.cancelledError()
        }
        this.observer.agentEnd({ ...info, outcome: 'failed' })
        return null
      } finally {
        await run.dispose()
      }
    } finally {
      this.releaseSlot()
    }
  }

  /** Materialize + validate the `agent()` options bag from the realm. */
  private readAgentOptions(rawOpts: unknown): {
    label?: string
    phase?: string
    provider?: string
    model?: string
    schema?: ObjectJsonSchema
  } {
    if (rawOpts === undefined) return {}
    let opts: unknown
    try {
      opts = materializeFromRealm(rawOpts, 'agent() options')
    } catch (error: unknown) {
      /* v8 ignore next -- defensive rethrow arm: materializeFromRealm only throws MaterializeError */
      if (!(error instanceof MaterializeError)) throw error
      throw new WorkflowError(`agent() options must be plain JSON data — ${error.message}`, 'INVALID_ARGUMENT', { cause: error })
    }
    if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
      throw new WorkflowError('agent() options must be an object', 'INVALID_ARGUMENT')
    }
    const record = opts as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (SUPPORTED_AGENT_OPTIONS.has(key)) continue
      if (DEFERRED_AGENT_OPTIONS.has(key)) {
        throw new WorkflowError(`agent() option "${key}" is deferred and not supported by this engine (supported: label, phase, schema, provider, model)`, 'UNSUPPORTED_OPTION')
      }
      throw new WorkflowError(`agent() option "${key}" is not recognized (supported: label, phase, schema, provider, model)`, 'UNSUPPORTED_OPTION')
    }
    for (const key of ['label', 'phase', 'provider', 'model'] as const) {
      if (record[key] !== undefined && typeof record[key] !== 'string') {
        throw new WorkflowError(`agent() option "${key}" must be a string`, 'INVALID_ARGUMENT')
      }
    }
    let schema: ObjectJsonSchema | undefined
    if (record.schema !== undefined) {
      try {
        assertObjectJsonSchema(record.schema)
        schema = record.schema
      } catch (error: unknown) {
        /* v8 ignore next -- defensive rethrow arm: assertObjectJsonSchema only throws JsonSchemaError */
        if (!(error instanceof JsonSchemaError)) throw error
        throw new WorkflowError(`agent() schema is outside the supported subset — ${error.message}`, 'UNSUPPORTED_SCHEMA', { cause: error })
      }
    }
    return {
      ...record.label !== undefined ? { label: record.label as string } : {},
      ...record.phase !== undefined ? { phase: record.phase as string } : {},
      ...record.provider !== undefined ? { provider: record.provider as string } : {},
      ...record.model !== undefined ? { model: record.model as string } : {},
      ...schema !== undefined ? { schema } : {},
    }
  }

  /** The `parallel(thunks)` hook: each thunk caught → `null`; fatal errors propagate. */
  private async parallel(rawThunks: unknown): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawThunks)) {
      throw new WorkflowError('parallel() requires an array of zero-argument functions', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawThunks.length, 'parallel()')
    const thunks = rawThunks.map((thunk, index) => {
      if (typeof thunk !== 'function') {
        throw new WorkflowError(`parallel() item ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return thunk as () => unknown
    })
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk()
      } catch (error: unknown) {
        // Hook failures are WorkflowErrors built OUTSIDE the script's realm;
        // fatality is recognized by `instanceof` against this realm's class —
        // a script-built object can never pass it, so fatality cannot be
        // forged (nor accidentally dissolved).
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  /** The `pipeline(items, ...stages)` hook: per-item stage chains, NO cross-stage barrier. */
  private async pipeline(rawItems: unknown, rawStages: unknown[]): Promise<unknown[]> {
    this.throwIfCancelled()
    if (!Array.isArray(rawItems)) {
      throw new WorkflowError('pipeline() requires an items array', 'INVALID_ARGUMENT')
    }
    this.assertItemCap(rawItems.length, 'pipeline()')
    if (rawStages.length === 0) {
      throw new WorkflowError('pipeline() requires at least one stage function', 'INVALID_ARGUMENT')
    }
    const stages = rawStages.map((stage, index) => {
      if (typeof stage !== 'function') {
        throw new WorkflowError(`pipeline() stage ${index} is not a function`, 'INVALID_ARGUMENT')
      }
      return stage as (previous: unknown, item: unknown, index: number) => unknown
    })
    return Promise.all(rawItems.map(async (item: unknown, index) => {
      let value: unknown = item
      try {
        for (const stage of stages) {
          value = await stage(value, item, index)
        }
        return value
      } catch (error: unknown) {
        // An ordinary stage throw drops the ITEM to null and skips its
        // remaining stages; a fatal WorkflowError (see parallel()) kills the
        // whole script.
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  private assertItemCap(length: number, hook: string): void {
    if (length > this.limits.maxItemsPerCall) {
      throw new WorkflowError(
        `${hook} received ${length} items — over the per-call cap (${this.limits.maxItemsPerCall}); split the work or raise maxItemsPerCall in the engine config`,
        'ITEM_CAP',
      )
    }
  }

  /** The `phase(title)` hook: sets the current label for subsequent `agent()` calls and notifies observers. */
  private phase(title: unknown): void {
    this.throwIfCancelled()
    if (typeof title !== 'string' || title.length === 0) {
      throw new WorkflowError('phase() requires a non-empty title string', 'INVALID_ARGUMENT')
    }
    this.currentPhase = title
    this.observer.phase(title)
  }

  /** The `log(message)` hook: narration to observers. */
  private log(message: unknown): void {
    this.throwIfCancelled()
    if (typeof message !== 'string') {
      throw new WorkflowError('log() requires a message string', 'INVALID_ARGUMENT')
    }
    this.observer.log(message)
  }
}

import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowResult } from '@ejunz/ea/workflow'

export enum WorkerToHostType {
  /** The startup handshake: the session is listening and awaits {@link HostToWorkerType.Go}. */
  Ready = 'ready',
  /** Observer narration: a `phase(title)` call. */
  Phase = 'phase',
  /** Observer narration: a `log(message)` call. */
  Log = 'log',
  /** Observer lifecycle: one `agent()` call started a child. */
  AgentStart = 'agent-start',
  /** Observer lifecycle: one `agent()` call settled. */
  AgentEnd = 'agent-end',
  /** Child RPC: start a child on the host (answered by ChildStarted or ChildStartError). */
  ChildStart = 'child-start',
  /** Child RPC: dispose a started child (answered by ChildDisposed). */
  ChildDispose = 'child-dispose',
  /** The run's single terminal result. */
  Result = 'result',
}

export interface WorkerToHostPayloads {
  /** Ready carries nothing. */
  [WorkerToHostType.Ready]: Record<never, never>
  /** The phase title, verbatim. */
  [WorkerToHostType.Phase]: { title: string }
  /** The logged message, verbatim. */
  [WorkerToHostType.Log]: { message: string }
  /** The call's sequence number, label, phase, and child id. */
  [WorkerToHostType.AgentStart]: { info: WorkflowAgentInfo }
  /** The call identity plus its outcome. */
  [WorkerToHostType.AgentEnd]: { info: WorkflowAgentEndInfo }
  /** The RPC correlation id and the prompt plus validated options. */
  [WorkerToHostType.ChildStart]: { callId: number; request: ChildStartRequest }
  /** The RPC correlation id of the child to dispose. */
  [WorkerToHostType.ChildDispose]: { callId: number }
  /** The run's terminal outcome. */
  [WorkerToHostType.Result]: { result: WorkflowResult }
}

export enum HostToWorkerType {
  /** Releases the startup gate: run the script body. */
  Go = 'go',
  /** Cancel the run: hooks start throwing and the script dies at its next await. */
  Cancel = 'cancel',
  /** Child RPC reply: the provider fulfilled with a published run (exactly one start reply per ChildStart). */
  ChildStarted = 'child-started',
  /** Child RPC reply: the provider's asynchronous start failed. */
  ChildStartError = 'child-start-error',
  /** Child RPC: a started child's result RESOLVED (its JSON projection). */
  ChildSettled = 'child-settled',
  /** Child RPC: a started child's result REJECTED (an infrastructure fault, rendered). */
  ChildFailed = 'child-failed',
  /** Child RPC reply: a requested disposal completed. */
  ChildDisposed = 'child-disposed',
}

export interface HostToWorkerPayloads {
  /** Go carries nothing. */
  [HostToWorkerType.Go]: Record<never, never>
  /** The cancel reason, canonical for the whole run. */
  [HostToWorkerType.Cancel]: { reason: string }
  /** The RPC correlation id and the child agent's id (minted by the subagent seam). */
  [HostToWorkerType.ChildStarted]: { callId: number; childId: string }
  /** The RPC correlation id and the rendered start failure. */
  [HostToWorkerType.ChildStartError]: { callId: number; rendered: string }
  /** The RPC correlation id and the child's terminal result projection. */
  [HostToWorkerType.ChildSettled]: { callId: number; result: ChildResult }
  /** The RPC correlation id and the rendered infrastructure fault. */
  [HostToWorkerType.ChildFailed]: { callId: number; rendered: string }
  /** The RPC correlation id of the completed disposal. */
  [HostToWorkerType.ChildDisposed]: { callId: number }
}

export type WorkerToHostMessage<T extends WorkerToHostType = WorkerToHostType> =
  { [K in T]: { type: K } & WorkerToHostPayloads[K] }[T]

export type HostToWorkerMessage<T extends HostToWorkerType = HostToWorkerType> =
  { [K in T]: { type: K } & HostToWorkerPayloads[K] }[T]

import { tmpdir } from 'node:os'

import { Worker } from 'node:worker_threads'

import type { WorkerOptions } from 'node:worker_threads'

import { fileURLToPath } from 'node:url'

import type { Context } from '@ejunz/cordis'

import type { Agent } from '@ejunz/ea/agent'

import { assertNever } from '@ejunz/ea/llm'

import { snapshotJsonValue } from '@ejunz/ea/session'

import type SubagentRuntime from '@ejunz/ea/subagent'

import type { SubagentRun } from '@ejunz/ea/subagent'

import type { WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowMeta, WorkflowResult, WorkflowRun, WorkflowRunId } from '@ejunz/ea/workflow'

interface ChildRecord {
  readonly run: SubagentRun
  disposal?: Promise<void>
}

export function workerSpawnEnv(
  platform: NodeJS.Platform = process.platform,
  tsconfigPath?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform === 'win32') {
    const tmp = tmpdir()
    env.TMP = tmp
    env.TEMP = tmp
  }
  if (tsconfigPath !== undefined) env.TSX_TSCONFIG_PATH = tsconfigPath
  return env
}

function resolveWorkerSpawn(init: WorkerInit): { entry: string | URL; options: WorkerOptions } {
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/); the built-worker e2e exercises this shape for real */
  if (!import.meta.url.endsWith('.ts')) {
    return { entry: fileURLToPath(new URL('./worker.cjs', import.meta.url)), options: { workerData: init, env: workerSpawnEnv(), execArgv: [] } }
  }
  // Resolve tsx only for unbuilt consumers and install it before importing TS.
  const workerEntry = new URL('./worker.ts', import.meta.url)
  const tsxEsmApiEntry = import.meta.resolve('tsx/esm/api')
  const tsxCjsApiEntry = import.meta.resolve('tsx/cjs/api')
  const bootstrap = [
    `import { register as registerEsm } from ${JSON.stringify(tsxEsmApiEntry)}`,
    `import { register as registerCjs } from ${JSON.stringify(tsxCjsApiEntry)}`,
    'registerCjs()',
    'registerEsm()',
    `await import(${JSON.stringify(workerEntry.href)})`,
  ].join('\n')
  return {
    entry: new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`),
    options: {
      workerData: init,
      env: workerSpawnEnv(undefined, process.env.TSX_TSCONFIG_PATH),
      execArgv: [],
    },
  }
}

export class WorkerRun implements WorkflowRun {
  /** Settles exactly once with the run's outcome; never rejects. */
  readonly result: Promise<WorkflowResult>
  private settleResolve!: (result: WorkflowResult) => void
  private settled = false
  /** A Result/death/grace outcome atomically won before teardown callbacks. */
  private terminalClaimed = false
  /** The first death signal closes worker-message admission and owns failure-time cleanup. */
  private workerDeathObserved = false
  private cancelReason: string | undefined
  private graceTimer: NodeJS.Timeout | undefined
  private readonly worker: Worker
  /** Set on `exit`: the thread is gone, so posting has nowhere to go. */
  private workerGone = false
  /** Accepted `child-start` messages — the terminate-path `agentsStarted` (see module doc). */
  private hostStarted = 0
  /** Published children by callId; an entry leaves only after disposal settles. */
  private readonly children = new Map<number, ChildRecord>()
  /** Provider starts that have not yet fulfilled or rejected. */
  private readonly pendingStarts = new Set<Promise<void>>()
  /** Started-but-not-ended agents by seq — the pairing ledger the HOST guarantees (see {@link endAgent}). */
  private readonly liveAgents = new Map<number, WorkflowAgentInfo>()
  private readonly quiescenceWaiters: (() => void)[] = []
  /** The per-run abort fanout every child start request carries. */
  private readonly controller = new AbortController()
  /** External start signal and the exact callback installed on it, retained only until first settle/teardown. */
  private inputSignal: AbortSignal | undefined
  private inputSignalAbort: (() => void) | undefined
  private disposed: Promise<void> | undefined

  constructor(
    private readonly ctx: Context,
    private readonly subagents: SubagentRuntime,
    readonly id: WorkflowRunId,
    readonly meta: WorkflowMeta,
    private readonly parent: Agent,
    init: WorkerInit,
    private readonly provider: string,
    private readonly disposeGraceMs: number,
    private readonly observer: ExecutionObserver,
    signal: AbortSignal | undefined,
  ) {
    this.result = new Promise<WorkflowResult>((resolve) => { this.settleResolve = resolve })
    // workerData rides the structured clone: args are plain JSON by the seam
    // contract, so the clone is total and doubles as the caller-isolation
    // copy (a clone failure throws loud out of start()).
    const { entry, options } = resolveWorkerSpawn(init)
    this.worker = new Worker(entry, options)
    this.worker.on('message', (message: WorkerToHostMessage) => { this.onMessage(message) })
    this.worker.on('error', (error) => { this.onWorkerDeath(`workflow worker failed: ${renderThrown(error)}`, false) })
    /* v8 ignore next -- messageerror: not constructible from the engine's own protocol (every payload is JSON data) */
    this.worker.on('messageerror', (error) => { this.onWorkerDeath(`workflow worker message failed to deserialize: ${renderThrown(error)}`, false) })
    this.worker.on('exit', (code) => {
      this.workerGone = true
      this.onWorkerDeath(`workflow worker exited before the run settled (exit code ${code})`, true)
    })
    if (signal?.aborted) {
      this.cancel('workflow start signal already aborted')
    } else if (signal !== undefined) {
      const onAbort = (): void => {
        this.detachInputSignal()
        this.cancel('workflow signal aborted')
      }
      this.inputSignal = signal
      this.inputSignalAbort = onAbort
      signal.addEventListener('abort', onAbort, { once: true })
    }
  }

  /**
   * Cancel the run: the worker is told (its hooks start throwing and the
   * script dies at its next await), the required signal shared by every child
   * start is aborted, and the grace timer
   * arms: a run still unsettled `disposeGraceMs` later force-settles
   * `cancelled` and its worker is TERMINATED. Idempotent; the first reason
   * wins.
   * @param reason - human-readable cause (default `'workflow cancelled'`).
   */
  cancel(reason?: string): void {
    // A settled run has nothing left to cancel, and a terminal source claimed
    // before its cleanup callbacks must exclude cancellation reentered by one
    // of those callbacks. Without the settled guard the
    // ordinary consumer path (await result, then dispose -> cancel) would arm
    // a grace timer nothing ever clears, pinning the run and its Worker
    // closure until the grace expires - a bounded leak per completed run.
    if (this.settled || this.terminalClaimed || this.cancelReason !== undefined) return
    this.cancelReason = reason ?? 'workflow cancelled'
    this.post(HostToWorkerType.Cancel, { reason: this.cancelReason })
    this.abortChildren(this.cancelReason)
    this.graceTimer = setTimeout(() => {
      // Cancellation already owns the race through cancelReason; close the
      // terminal boundary explicitly before observer teardown callbacks.
      this.terminalClaimed = true
      // The worker may no longer speak (it is about to be terminated): pair
      // every stranded start before the run settles, so ends precede
      // workflow/end.
      this.endStrandedAgents()
      this.settleResult(this.cancelledResult(this.hostStarted))
      void this.worker.terminate()
    }, this.disposeGraceMs)
    // unref'd: an armed grace timer must never hold the process open.
    this.graceTimer.unref()
  }

  /**
   * Cancel + bounded settle + termination. Host-drives every registered
   * child's disposal IMMEDIATELY — a wedged worker can relay no dispose RPC,
   * and deferring child teardown to the post-terminate reap would spend the
   * whole grace waiting for a quiescence that cannot start, then return with
   * the disposals still in flight — so child disposal overlaps the same
   * grace the worker gets to settle (the worker's own dispose RPCs join the
   * shared per-child disposal). Waits (at most the grace) for the result and
   * child quiescence, then terminates the worker unconditionally — the
   * thread never outlives its run — and reaps whatever children remain
   * (their disposal is contained, not awaited past the grace, the same
   * abandonment the seam documents for a slow-disposing child). Idempotent;
   * safe on every path.
   * @returns resolves when the run's resources are released or abandoned.
   */
  dispose(): Promise<void> {
    if (this.disposed !== undefined) return this.disposed
    // Claim the public transaction BEFORE its body invokes child/provider
    // disposal. A raw provider callback can reenter handle.dispose(); it must
    // join this promise rather than start a second traversal.
    const claimed = Promise.withResolvers<undefined>()
    this.disposed = claimed.promise
    void (async () => {
      this.detachInputSignal()
      this.cancel('workflow disposed')
      // cancel() deliberately becomes a no-op after terminal settlement, but
      // disposal still owns every registered child. Reap independently so an
      // already-settled workflow cannot wait on child quiescence before it has
      // started the surviving children's disposals. On an unsettled run this
      // joins the cancel path through the per-call cancellation/disposal gates.
      this.reapChildren('workflow disposed')
      await Promise.race([
        (async () => {
          await this.result
          await this.childQuiescence()
        })(),
        sleep(this.disposeGraceMs),
      ])
      await this.worker.terminate()
      this.reapChildren('workflow disposed')
    })().then(
      () => { claimed.resolve(undefined) },
      /* v8 ignore next -- result/quiescence never reject and Worker.terminate is the only external promise */
      (error: unknown) => { claimed.reject(error) },
    )
    return this.disposed
  }

  /** Post one message to the worker (payload looked up from the tag's map entry), tolerating a thread that is already gone. */
  private post<T extends HostToWorkerType>(type: T, payload: HostToWorkerPayloads[T]): void {
    if (this.workerGone || this.workerDeathObserved) return
    try {
      this.worker.postMessage({ type, ...payload })
    } catch (error: unknown) {
      // Only a teardown race can land here (every engine message is JSON
      // data, so serialization cannot fail); there is nothing left to
      // deliver to — log and move on.
      /* v8 ignore next -- postMessage teardown race (a throw between exit and its event): not constructible in-process */
      this.ctx.logger.warn(`workflow-worker-thread: postMessage failed: ${renderThrown(error)}`)
    }
  }

  private onMessage(message: WorkerToHostMessage): void {
    // Node may emit `error`, then deliver an already-queued `message`, then
    // emit `exit`. The first death signal is the host's logical delivery
    // barrier: nothing arriving afterward may create a child, narrate after
    // workflow/end, or compete with the chosen outcome.
    if (this.workerDeathObserved) return
    switch (message.type) {
      case WorkerToHostType.Ready:
        this.post(HostToWorkerType.Go, {})
        break
      case WorkerToHostType.Phase:
        // Post-cancel narration is suppressed host-side: worker-side the
        // hooks throw once the cancel message is PROCESSED, but narration
        // already in flight (or emitted while the cancel crossed the
        // boundary) must not reach observers — nothing is emitted after
        // cancel() returns.
        if (this.cancelReason === undefined) this.observer.phase(message.title)
        break
      case WorkerToHostType.Log:
        if (this.cancelReason === undefined) this.observer.log(message.message)
        break
      case WorkerToHostType.AgentStart:
        this.liveAgents.set(message.info.seq, message.info)
        this.observer.agentStart(message.info)
        break
      case WorkerToHostType.AgentEnd:
        // NOT suppressed on cancel: cancelled children report their paired
        // agent-end with outcome 'cancelled'. The gate (with the termination
        // paths' synthesis) is what makes the one-pair-per-started-child
        // contract hold on every stop path.
        this.endAgent(message.info)
        break
      case WorkerToHostType.ChildStart:
        this.onChildStart(message.callId, message.request)
        break
      case WorkerToHostType.ChildDispose:
        this.onChildDispose(message.callId)
        break
      case WorkerToHostType.Result:
        this.onResult(message.result)
        break
      /* v8 ignore next 2 -- closed engine-owned union; the arm only makes adding a message type a compile error */
      default:
        assertNever(message, 'worker-to-host message')
    }
  }

  /** Why a ready provider result may no longer be admitted to the worker. */
  private childAdmissionFailure(): { reason: string; rendered: string } | undefined {
    if (this.cancelReason !== undefined) {
      return { reason: this.cancelReason, rendered: `workflow run cancelled: ${this.cancelReason}` }
    }
    if (this.workerDeathObserved) {
      return { reason: 'workflow worker gone', rendered: 'workflow worker is no longer available' }
    }
    if (this.terminalClaimed) {
      return { reason: 'workflow settled', rendered: 'workflow run already settled' }
    }
    return undefined
  }

  private onChildStart(callId: number, request: ChildStartRequest): void {
    const initialFailure = this.childAdmissionFailure()
    if (initialFailure !== undefined) {
      // Refuse after a terminal boundary: a child must never start on an
      // already-aborted signal (a provider subscribing only to future abort
      // events would never observe it).
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: initialFailure.rendered })
      return
    }
    this.hostStarted += 1
    const task = this.startChild(callId, request)
    this.pendingStarts.add(task)
    void task.then(
      () => { this.finishPendingStart(task) },
      /* v8 ignore next -- startChild contains provider and cleanup failures */
      () => { this.finishPendingStart(task) },
    )
  }

  /** Await one provider-owned startup transaction and publish only while admitted. */
  private async startChild(callId: number, request: ChildStartRequest): Promise<void> {
    let run: SubagentRun
    try {
      run = await this.subagents.start(this.provider, {
        prompt: [{ type: 'text', text: request.prompt }],
        parent: this.parent,
        signal: this.controller.signal,
        ...request.schema !== undefined ? { outputSchema: request.schema } : {},
        ...request.provider !== undefined || request.model !== undefined
          ? {
            agentOptions: {
              ...request.provider !== undefined ? { provider: request.provider } : {},
              ...request.model !== undefined ? { model: request.model } : {},
            },
          }
          : {},
      })
    } catch (error: unknown) {
      const failure = this.childAdmissionFailure()
      this.post(HostToWorkerType.ChildStartError, {
        callId,
        rendered: failure?.rendered ?? renderThrown(error),
      })
      return
    }
    const failure = this.childAdmissionFailure()
    if (failure !== undefined) {
      this.post(HostToWorkerType.ChildStartError, { callId, rendered: failure.rendered })
      try {
        await run.dispose()
      } catch (error: unknown) {
        this.ctx.logger.warn(`workflow-worker-thread: refused child dispose failed: ${renderThrown(error)}`)
      }
      return
    }

    const record: ChildRecord = { run }
    this.children.set(callId, record)
    // Attach result forwarding before publishing the child handle. Because the
    // callback itself runs in a later microtask, ChildStarted is still posted
    // first even for an already-settled scripted provider.
    const forwardResult = run.result.then<() => void, () => void>(
      (result) => {
        try {
          const snapshot = snapshotJsonValue<ChildResult>({
            output: result.output,
            ...result.structured !== undefined ? { structured: result.structured } : {},
            stopReason: result.stopReason,
          })
          if (snapshot === undefined) throw new TypeError('child result is not losslessly JSON-serializable')
          return () => { this.post(HostToWorkerType.ChildSettled, { callId, result: snapshot }) }
        } catch (error: unknown) {
          const rendered = `workflow child result could not cross the worker boundary: ${renderThrown(error)}`
          return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
        }
      },
      (error: unknown) => {
        const rendered = renderThrown(error)
        return () => { this.post(HostToWorkerType.ChildFailed, { callId, rendered }) }
      },
    )
    this.post(HostToWorkerType.ChildStarted, { callId, childId: run.id })
    void forwardResult.then((forward) => { forward() })
  }

  private onChildDispose(callId: number): void {
    const record = this.children.get(callId)
    if (record === undefined) {
      // Already disposed host-side (a dispose() drive or a death reap beat
      // the RPC) — the ack is still owed (the worker-side wrapper awaits it).
      this.post(HostToWorkerType.ChildDisposed, { callId })
      return
    }
    // disposeChild never rejects (containment is inside), so the ack always follows.
    void this.disposeChild(callId, record).then(() => { this.post(HostToWorkerType.ChildDisposed, { callId }) })
  }

  /**
   * Start (or join) one registered child's disposal; the registry entry
   * leaves when it settles. Memoized per callId: the worker's dispose RPC,
   * the dispose() host drive, and the reap can all land on the same child —
   * the child's `dispose()` runs once and every caller awaits that one
   * settlement. A rejection is contained (the subagent seam's dispose() is
   * not supposed to reject, but a backend that does anyway must not break
   * quiescence): logged, and the child still leaves the registry.
   * @param callId - the child's registry key.
   * @param record - the registered child (the caller looked it up).
   * @returns resolves when the disposal settled either way; never rejects.
   */
  private disposeChild(callId: number, record: ChildRecord): Promise<void> {
    if (record.disposal !== undefined) return record.disposal
    record.disposal = Promise.resolve()
      .then(() => record.run.dispose())
      .catch((error: unknown) => {
        this.ctx.logger.warn(`workflow-worker-thread: child dispose failed: ${renderThrown(error)}`)
      })
      .then(() => { this.finishChild(callId) })
    return record.disposal
  }

  /** Drop a child record and release quiescence waiters when all work ends. */
  private finishChild(callId: number): void {
    this.children.delete(callId)
    this.notifyChildQuiescence()
  }

  /** Retire one provider startup transaction. */
  private finishPendingStart(task: Promise<void>): void {
    this.pendingStarts.delete(task)
    this.notifyChildQuiescence()
  }

  /** Release waiters only after both pending starts and published children end. */
  private notifyChildQuiescence(): void {
    if (this.children.size !== 0 || this.pendingStarts.size !== 0) return
    for (const waiter of this.quiescenceWaiters.splice(0)) waiter()
  }

  /** Resolves once every pending start and published child has reached quiescence. */
  private childQuiescence(): Promise<void> {
    if (this.children.size === 0 && this.pendingStarts.size === 0) return Promise.resolve()
    return new Promise((resolve) => { this.quiescenceWaiters.push(resolve) })
  }

  /** Abort + dispose every registered child (worker death / final teardown); disposal is contained, not awaited. */
  private reapChildren(reason: string): void {
    this.abortChildren(this.cancelReason ?? reason)
    for (const [callId, record] of [...this.children]) {
      void this.disposeChild(callId, record)
    }
  }

  /** Abort the one canonical signal shared by pending and published children. */
  private abortChildren(reason: string): void {
    if (!this.controller.signal.aborted) this.controller.abort(reason)
  }

  private onResult(result: WorkflowResult): void {
    // The owned worker session sends one Result. Keep a late duplicate or a
    // Result queued behind another terminal source completely side-effect-free.
    if (this.terminalClaimed) return
    // First-wins is decided when the Result message reaches the host. If no
    // external cancellation was already in flight, this result won. Reaping a
    // stray child below may synchronously reenter cancel() through provider
    // callbacks, but that internal post-result cleanup must not retroactively
    // rewrite the worker result that arrived first.
    const cancellationWasRequested = this.cancelReason !== undefined
    // Claim before settlement cleanup invokes provider disposal. Once Result
    // won, a later cancellation cannot rewrite it.
    this.terminalClaimed = true
    // Abort pending starts and begin disposing published children before the
    // workflow becomes externally settled. Cleanup remains independently
    // tracked by childQuiescence and the holder's dispose().
    this.reapChildren('workflow settled')
    if (!cancellationWasRequested) {
      this.settleResult(result)
      return
    }
    if (result.stopReason !== 'cancelled') {
      // The script settled while our cancel was crossing the thread boundary
      // — the seam-visible result had NOT settled when cancellation was
      // requested, so report cancelled (the vm drive()'s post-settle check,
      // relocated to the receiving side of the race).
      this.settleResult(this.cancelledResult(result.agentsStarted))
      return
    }
    this.settleResult(result)
  }

  /** Process an error/messageerror/exit signal; `exit` also performs the final disposal sweep. */
  private onWorkerDeath(message: string, isExit: boolean): void {
    if (!this.workerDeathObserved) {
      // Close message admission BEFORE cleanup callbacks: Node can deliver a
      // message queued before the crash after its `error` event. Treating the
      // first death signal as a logical barrier prevents that late message
      // from creating work or narrating after workflow/end.
      this.workerDeathObserved = true
      const outcomeWasClaimed = this.terminalClaimed
      const cancellationWasRequested = this.cancelReason !== undefined
      // When death is itself the terminal source, claim BEFORE child reap or
      // synthesized observer callbacks. Either can reenter cancel(); a death
      // that arrived first remains an error, while a cancellation already
      // accepted before death remains cancelled. If Result/grace already won,
      // preserve it while still performing prompt failure-time cleanup.
      if (!outcomeWasClaimed) this.terminalClaimed = true
      if (this.children.size > 0 || this.pendingStarts.size > 0) this.reapChildren('workflow worker gone')
      this.endStrandedAgents()
      if (!outcomeWasClaimed) {
        if (cancellationWasRequested) {
          this.settleResult(this.cancelledResult(this.hostStarted))
        } else {
          this.settleResult({ value: null, stopReason: 'error', error: message, agentsStarted: this.hostStarted })
        }
      }
    }
    if (!isExit) return
    // `error` is not Node's physical delivery barrier: a queued message may
    // precede `exit`. Admission is already closed, so this final sweep only
    // joins/starts disposal for registry survivors; it deliberately does not
    // repeat explicit provider cancellation.
    for (const [callId, record] of [...this.children]) void this.disposeChild(callId, record)
    this.endStrandedAgents()
  }

  /**
   * The single agent-end emission gate: forwards `end` iff its start is still
   * unpaired in the ledger, so every forwarded `workflow/agent-start` gets
   * EXACTLY one `workflow/agent-end` — the worker's own report where it can
   * speak, a host-synthesized one where it cannot ({@link endStrandedAgents}).
   * @param end - the settlement to emit (worker-reported or synthesized).
   */
  private endAgent(end: WorkflowAgentEndInfo): void {
    /* v8 ignore next -- a real end still in flight across the grace force-settle: not orderable in-process */
    if (!this.liveAgents.delete(end.seq)) return
    this.observer.agentEnd(end)
  }

  /**
   * Synthesize the missing `agent-end` for every started-but-unpaired agent,
   * outcome `'cancelled'`: the reap cancels every child, and a real
   * settlement racing the force-settle loses to that already-started external
   * cancellation. The atomic terminal boundaries in {@link onResult} and
   * {@link onWorkerDeath} deliberately exclude teardown callbacks as contenders.
   * Called where the worker can no longer speak (the grace force-settle,
   * worker death, physical exit). When grace/death is the terminal source it
   * runs before settleResult, so already-known pairs precede `workflow/end`;
   * after an earlier Result, exit cleanup may close a survivor afterward.
   * The ledger preserves exactly-once pairing in both orders.
   */
  private endStrandedAgents(): void {
    for (const info of [...this.liveAgents.values()]) {
      this.endAgent({ ...info, outcome: 'cancelled' })
    }
  }

  private cancelledResult(agentsStarted: number): WorkflowResult {
    // cancel() is the only writer of cancelReason and every caller checks it
    // first; the fallback guards the type, not a reachable path.
    /* v8 ignore next */
    const reason = this.cancelReason ?? 'workflow cancelled'
    return { value: null, stopReason: 'cancelled', error: `workflow run cancelled: ${reason}`, agentsStarted }
  }

  /** Remove the exact abort callback installed on the caller's start signal. */
  private detachInputSignal(): void {
    const signal = this.inputSignal
    const onAbort = this.inputSignalAbort
    if (signal === undefined || onAbort === undefined) return
    this.inputSignal = undefined
    this.inputSignalAbort = undefined
    signal.removeEventListener('abort', onAbort)
  }

  /** First settle wins; disarms the grace timer and releases the caller signal. */
  private settleResult(result: WorkflowResult): void {
    // Every current terminal source claims ownership before calling here; keep
    // the fallback local so a future caller cannot resolve twice.
    /* v8 ignore next -- defensive fallback outside the claimed state machine */
    if (this.settled) return
    this.terminalClaimed = true
    this.settled = true
    this.detachInputSignal()
    clearTimeout(this.graceTimer)
    this.settleResolve(result)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

import { WorkflowError } from '@ejunz/ea/workflow'

import type { WorkflowMeta, WorkflowPhase } from '@ejunz/ea/workflow'

function validateMetaShape(meta: unknown): { meta?: WorkflowMeta; violations: string[] } {
  const violations: string[] = []
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { violations: ['meta must be an object'] }
  }
  const record = meta as Record<string, unknown>
  const known = new Set(['name', 'description', 'whenToUse', 'phases'])
  for (const key of Object.keys(record)) {
    if (!known.has(key)) violations.push(`meta.${key} is not a recognized field (name/description/whenToUse/phases)`)
  }
  if (typeof record.name !== 'string' || record.name.length === 0) violations.push('meta.name must be a non-empty string')
  if (typeof record.description !== 'string' || record.description.length === 0) violations.push('meta.description must be a non-empty string')
  if (record.whenToUse !== undefined && typeof record.whenToUse !== 'string') violations.push('meta.whenToUse must be a string')
  const phases: WorkflowPhase[] = []
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) {
      violations.push('meta.phases must be an array')
    } else {
      record.phases.forEach((phase, index) => {
        if (typeof phase !== 'object' || phase === null || Array.isArray(phase)) {
          violations.push(`meta.phases[${index}] must be an object`)
          return
        }
        const entry = phase as Record<string, unknown>
        for (const key of Object.keys(entry)) {
          if (!['title', 'detail', 'provider', 'model'].includes(key)) violations.push(`meta.phases[${index}].${key} is not a recognized field`)
        }
        if (typeof entry.title !== 'string' || entry.title.length === 0) violations.push(`meta.phases[${index}].title must be a non-empty string`)
        if (entry.detail !== undefined && typeof entry.detail !== 'string') violations.push(`meta.phases[${index}].detail must be a string`)
        if (entry.provider !== undefined && typeof entry.provider !== 'string') violations.push(`meta.phases[${index}].provider must be a string`)
        if (entry.model !== undefined && typeof entry.model !== 'string') violations.push(`meta.phases[${index}].model must be a string`)
        if (violations.length === 0) {
          phases.push({
            title: entry.title as string,
            ...entry.detail !== undefined ? { detail: entry.detail as string } : {},
            ...entry.provider !== undefined ? { provider: entry.provider as string } : {},
            ...entry.model !== undefined ? { model: entry.model as string } : {},
          })
        }
      })
    }
  }
  if (violations.length > 0) return { violations }
  return {
    violations,
    meta: {
      name: record.name as string,
      description: record.description as string,
      ...record.whenToUse !== undefined ? { whenToUse: record.whenToUse as string } : {},
      ...record.phases !== undefined ? { phases } : {},
    },
  }
}

export function validateMeta(value: unknown): WorkflowMeta {
  const { meta, violations } = validateMetaShape(value)
  if (meta === undefined) {
    throw new WorkflowError(`invalid meta: ${violations.join('; ')}`, 'META_INVALID')
  }
  return meta
}

import { randomUUID } from 'node:crypto'

import { availableParallelism } from 'node:os'

import * as vm from 'node:vm'

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import WorkflowEngine, { WorkflowError, WorkflowRunId } from '@ejunz/ea/workflow'

import type { WorkflowRun, WorkflowRunInfo, WorkflowStartRequest } from '@ejunz/ea/workflow'

export interface Config {
  /** The `ctx.subagents` provider children run on (default `spawn`). */
  provider?: string
  /** Concurrent `agent()` ceiling; `0` (the default) auto-resolves to `min(16, max(1, cores - 2))`. */
  maxConcurrentAgents?: number
  /** Total `agent()` calls one run may start — the runaway-loop backstop (default 1000). */
  maxTotalAgents?: number
  /** Items accepted by a single `parallel()`/`pipeline()` call (default 4096). */
  maxItemsPerCall?: number
  /** vm timeout for the script's initial synchronous slice, inside the worker (default 5000 ms). */
  syncTimeoutMs?: number
  /**
   * How long after a cancellation an unsettled script may keep running before
   * the run force-settles `cancelled` and its worker is TERMINATED (default
   * 5000 ms); also bounds `dispose()`.
   */
  disposeGraceMs?: number
}

type ResolvedConfig = Required<Config>

const META_STATEMENT = /^\s*export\s+const\s+meta\b/

function assertBodyParses(body: string, name: string): void {
  if (META_STATEMENT.test(body)) {
    throw new WorkflowError('workflow meta rides the `meta` request field, not the script: remove the `export const meta = {...}` statement from the body', 'SCRIPT_PARSE')
  }
  try {
    // Parse only — the script object is discarded, nothing executes.
    void new vm.Script(`(async () => {\n${body}\n})()`, { filename: `workflow:${name}`, lineOffset: -1 })
  } catch (error: unknown) {
    throw new WorkflowError(`workflow script does not parse: ${String(error)}`, 'SCRIPT_PARSE', { cause: error })
  }
}

function resolveSubagentProvider(ctx: Context, configured: string, override: string | undefined): string {
  const provider = override ?? configured
  if (provider.length === 0 || provider !== provider.trim()) {
    throw new WorkflowError(
      'workflow subagentProvider must be a non-empty normalized string',
      'INVALID_ARGUMENT',
    )
  }
  if (ctx.subagents.getProvider(provider) === undefined) {
    throw new WorkflowError(`no subagent provider registered for "${provider}"`, 'AGENT_START')
  }
  return provider
}

function resolveMaxTotalAgents(requested: number | undefined, ceiling: number): number {
  if (requested === undefined) return ceiling
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new WorkflowError('workflow maxTotalAgents must be a positive safe integer', 'INVALID_ARGUMENT')
  }
  if (requested > ceiling) {
    throw new WorkflowError(
      `workflow maxTotalAgents ${requested} exceeds the engine ceiling ${ceiling}`,
      'INVALID_ARGUMENT',
    )
  }
  return requested
}

class WorkerThreadWorkflowEngine extends WorkflowEngine {
  static inject = ['subagents']

  static Config: z<Config> = z.object({
    provider: z.string().default('spawn'),
    maxConcurrentAgents: z.natural().default(0),
    maxTotalAgents: z.natural().min(1).default(1000),
    maxItemsPerCall: z.natural().min(1).default(4096),
    syncTimeoutMs: z.natural().min(1).default(5000),
    disposeGraceMs: z.natural().default(5000),
  })

  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // schemastery (static Config) has already filled the defaulted fields;
    // the assertion records that resolution, not a hidden fallback.
    this.config = config as ResolvedConfig
  }

  /**
   * Validate and execute a workflow script in a fresh worker thread. Throws
   * {@link WorkflowError} synchronously (`META_INVALID` for a malformed meta
   * block, `SCRIPT_PARSE` for a body that does not compile) for a request
   * that cannot begin; once a run is returned, every failure resolves through
   * `result.stopReason` instead.
   * @param request - the script body, its meta data and `args`, the parent
   *   agent, and an optional cancel signal.
   * @returns the live run (its `result` resolves when the script settles).
   */
  start(request: WorkflowStartRequest): WorkflowRun {
    const meta = validateMeta(request.meta)
    assertBodyParses(request.script, meta.name)
    const subagentProvider = resolveSubagentProvider(this.ctx, this.config.provider, request.subagentProvider)
    const maxTotalAgents = resolveMaxTotalAgents(request.maxTotalAgents, this.config.maxTotalAgents)
    const id = WorkflowRunId(randomUUID())
    const info: WorkflowRunInfo = { id, meta }
    const limits: WorkerLimits = {
      maxConcurrentAgents: this.config.maxConcurrentAgents === 0
        ? Math.min(16, Math.max(1, availableParallelism() - 2))
        : this.config.maxConcurrentAgents,
      maxTotalAgents,
      maxItemsPerCall: this.config.maxItemsPerCall,
      syncTimeoutMs: this.config.syncTimeoutMs,
    }
    const init: WorkerInit = {
      meta,
      body: request.script,
      ...request.args !== undefined ? { args: request.args } : {},
      limits,
    }
    // Capture the dependency while this service call is still traced through
    // the start() holder. Cordis strips the engine-provider shadow when it
    // returns the SubagentRuntime handle, so an already-returned run can keep
    // starting children after an engine HMR unload removes ctx.workflowEngine.
    // Re-resolving `this.ctx.subagents` later from WorkerRun would instead walk
    // the now-inactive engine fiber and break the seam's holder-owned lifetime.
    const runCtx = this.ctx
    const subagents = runCtx.subagents
    const workerRun = new WorkerRun(
      runCtx,
      subagents,
      id,
      meta,
      request.parent,
      init,
      subagentProvider,
      this.config.disposeGraceMs,
      {
        phase: (title) => { this.emitWorkflowEvent('workflow/phase', info, title) },
        log: (message) => { this.emitWorkflowEvent('workflow/log', info, message) },
        agentStart: (agent) => { this.emitWorkflowEvent('workflow/agent-start', info, agent) },
        agentEnd: (agent) => { this.emitWorkflowEvent('workflow/agent-end', info, agent) },
      },
      request.signal,
    )

    this.emitWorkflowEvent('workflow/start', info)
    // `workflow/end` fires as the (never-rejecting) result settles, with the
    // outcome DATA only — the value stays with the run's holder.
    void workerRun.result.then((settled) => {
      this.emitWorkflowEvent('workflow/end', info, {
        stopReason: settled.stopReason,
        ...settled.error !== undefined ? { error: settled.error } : {},
        agentsStarted: settled.agentsStarted,
      })
    })

    return workerRun
  }
}

export default WorkerThreadWorkflowEngine

import type { MessagePort } from 'node:worker_threads'

import { assertNever } from '@ejunz/ea/llm'

interface PendingChild {
  started: PromiseWithResolvers<string>
  settled: PromiseWithResolvers<ChildResult>
  disposed: PromiseWithResolvers<void>
}

type Post = <T extends WorkerToHostType>(type: T, payload: WorkerToHostPayloads[T]) => void

class RpcChildHandle implements ChildHandle {
  readonly result: Promise<ChildResult>

  constructor(
    private readonly post: Post,
    private readonly callId: number,
    private readonly entry: PendingChild,
    readonly id: string,
  ) {
    this.result = entry.settled.promise
  }

  dispose(): Promise<void> {
    this.post(WorkerToHostType.ChildDispose, { callId: this.callId })
    return this.entry.disposed.promise
  }
}

class ChildRpcBridge implements ChildPort {
  private nextCallId = 0
  private readonly pending = new Map<number, PendingChild>()

  constructor(private readonly post: Post) {}

  async startAgent(request: ChildStartRequest): Promise<ChildHandle> {
    this.nextCallId += 1
    const callId = this.nextCallId
    const entry: PendingChild = {
      started: Promise.withResolvers<string>(),
      settled: Promise.withResolvers<ChildResult>(),
      disposed: Promise.withResolvers<void>(),
    }
    // Containment: when asynchronous provider start fails (or
    // the run is torn down), the settled promise may never gain a consumer —
    // it must not surface as an unhandled rejection and kill the worker.
    entry.settled.promise.catch(() => { /* consumed: unconsumed child settlement after failed start */ })
    this.pending.set(callId, entry)
    this.post(WorkerToHostType.ChildStart, { callId, request })
    const childId = await entry.started.promise
    return new RpcChildHandle(this.post, callId, entry, childId)
  }

  /** The host established a published child; releases the `startAgent` await. */
  onChildStarted(callId: number, childId: string): void {
    this.pending.get(callId)?.started.resolve(childId)
  }

  /** Asynchronous provider start failed; reject and retire the pending RPC. */
  onChildStartError(callId: number, rendered: string): void {
    const entry = this.pending.get(callId)
    this.pending.delete(callId)
    entry?.started.reject(new Error(rendered))
  }

  /** The child's terminal result arrived. */
  onChildSettled(callId: number, result: ChildResult): void {
    this.pending.get(callId)?.settled.resolve(result)
  }

  /** The child's `result` rejected host-side (an infrastructure fault, relayed as fatal). */
  onChildFailed(callId: number, rendered: string): void {
    this.pending.get(callId)?.settled.reject(new Error(rendered))
  }

  /** The host acked the dispose; the call's book-keeping is complete. */
  onChildDisposed(callId: number): void {
    const entry = this.pending.get(callId)
    this.pending.delete(callId)
    entry?.disposed.resolve()
  }
}

export function requireParentPort(port: MessagePort | null): MessagePort {
  if (port === null) throw new Error('the workflow worker entry must be loaded inside a worker thread (no parentPort)')
  return port
}

export async function runWorkerSession(port: MessagePort, init: WorkerInit): Promise<void> {
  const post: Post = (type, payload) => {
    port.postMessage({ type, ...payload })
  }
  const children = new ChildRpcBridge(post)

  const observer: ExecutionObserver = {
    phase: (title) => { post(WorkerToHostType.Phase, { title }) },
    log: (message) => { post(WorkerToHostType.Log, { message }) },
    agentStart: (info) => { post(WorkerToHostType.AgentStart, { info }) },
    agentEnd: (info) => { post(WorkerToHostType.AgentEnd, { info }) },
  }

  let execution: WorkflowExecution
  try {
    execution = new WorkflowExecution(init.meta, init.body, init.args, init.limits, observer, children)
  } catch (error: unknown) {
    post(WorkerToHostType.Result, { result: { value: null, stopReason: 'error', error: renderThrown(error), agentsStarted: 0 } })
    return
  }

  const gate = Promise.withResolvers<void>()
  port.on('message', (message: HostToWorkerMessage) => {
    switch (message.type) {
      case HostToWorkerType.Go:
        gate.resolve()
        break
      case HostToWorkerType.Cancel:
        execution.cancel(message.reason)
        // A cancel doubles as the gate release: drive() checks the cancelled
        // state before running the body, so the script never executes.
        gate.resolve()
        break
      case HostToWorkerType.ChildStarted:
        children.onChildStarted(message.callId, message.childId)
        break
      case HostToWorkerType.ChildStartError:
        children.onChildStartError(message.callId, message.rendered)
        break
      case HostToWorkerType.ChildSettled:
        children.onChildSettled(message.callId, message.result)
        break
      case HostToWorkerType.ChildFailed:
        children.onChildFailed(message.callId, message.rendered)
        break
      case HostToWorkerType.ChildDisposed:
        children.onChildDisposed(message.callId)
        break
      /* v8 ignore next 2 -- closed engine-owned union; the arm only makes adding a message type a compile error */
      default:
        assertNever(message, 'host-to-worker message')
    }
  })

  post(WorkerToHostType.Ready, {})
  await gate.promise
  const result = await execution.drive()
  post(WorkerToHostType.Result, { result })
}

import { parentPort, workerData } from 'node:worker_threads'

void runWorkerSession(requireParentPort(parentPort), workerData as WorkerInit)

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/workflow-worker-thread'
  export const name = 'workflow-worker-thread-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
