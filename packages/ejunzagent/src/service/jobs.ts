import type { Branded } from '@ejunz/ea-core/brand'

export type JobId = Branded<'JobId'>

export function JobId(id: string): JobId {
  return id as JobId
}

import type { Agent } from '@ejunz/ea-core/agent'

import type { SessionId } from '@ejunz/ea-core/session'

export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

export interface JobKindMap {
  bash: 'bash'
  subagent: 'subagent'
}

export type JobKind = JobKindMap[keyof JobKindMap]

export interface JobOutcome {
  /** How the job ended: finished (`completed`), cancelled (`killed`), or broke (`failed`). */
  status: 'completed' | 'killed' | 'failed'
  /** Kind-specific detail rendered into status lines ('exit code: 3', 'max-tokens'). */
  detail?: string
  /** Final output for jobs without `readOutput`; stream jobs leave it unset. */
  output?: string
}

export interface JobStart {
  /** Producer kind — also the id prefix (`bash`, `subagent`, …). */
  kind: JobKind
  /** One-line model-facing label (the command; the delegation description). */
  label: string
  /**
   * Optional UTF-8 byte cap for each complete model-facing completion notice or
   * output read, including controller status metadata.
   */
  outputLimitBytes?: number
  /**
   * Owning live agent. Access is fenced by its session id, and agent disposal
   * cancels and awaits the job. The instance must be the one currently
   * registered under its agent id. Omitting the owner creates an unowned job,
   * open to any caller until service disposal.
   */
  owner?: Agent
  /**
   * Start the work after preflight and synchronously return its hooks. Called
   * once; a throw leaves nothing registered, and the producer must clean up any
   * partially started resources.
   */
  run(): JobHooks
}

export interface JobHooks {
  /**
   * Request termination. Must be synchronous, idempotent, and eventually settle
   * {@link done}; throws propagate. The optional reason is forwarded verbatim.
   */
  cancel(reason?: string): void
  /**
   * Resolves after the producer releases its resources, not merely when work
   * finishes. Must not reject; the runtime converts a rejection to `failed`.
   * If teardown cancellation throws, the runtime may force-fail only the
   * registry record without claiming that the work stopped.
   */
  done: Promise<JobOutcome>
  /**
   * Consume output produced since the previous call. The producer formats
   * truncation and spill notices. Absence marks a final-output-only job; each
   * job has one consuming cursor.
   */
  readOutput?(): string
}

export interface JobSnapshot {
  /** The registry-issued id (`<kind>-N`). */
  id: JobId
  /** The producer kind the job was registered with. */
  kind: JobKind
  /** The producer-supplied one-line label. */
  label: string
  /** Producer-owned cap for complete model-facing notices and output reads. */
  outputLimitBytes?: number
  /**
   * Owner session id used for authorization and correlation; absent for
   * unowned jobs. Completion listeners receive the exact {@link Agent}
   * separately through {@link JobDoneListener}.
   */
  ownerSession?: SessionId
  /** Current lifecycle state. */
  status: JobStatus
  /** Kind-specific status detail, present once the producer supplied one (usually terminal). */
  detail?: string
  /** Epoch ms when the job was registered. */
  startedAt: number
  /** Epoch ms when the job settled; absent while `running`/`stopping`. */
  finishedAt?: number
  /**
   * True when a kill, read, wait, or teardown cancel has reported or committed
   * to report the terminal state. Completion reporters suppress redundant
   * notices when set. Teardown claims it because the owner or service being
   * destroyed leaves no reader: a reporter that opens a turn on notice would
   * otherwise spend a model request per teardown layer.
   */
  reported: boolean
}

export interface JobRead {
  /**
   * Stream kinds: the consuming delta since the previous read. Final-output
   * kinds: empty while live, the terminal {@link JobOutcome.output} (or
   * empty) once settled — idempotent, never consumed.
   */
  text: string
  /** The job's state at read time. */
  snapshot: JobSnapshot
}

export type JobDoneListener = (
  snapshot: JobSnapshot,
  owner: Agent | undefined,
) => void | PromiseLike<void>

export type JobsChangedListener = (owner: Agent | undefined) => void

import { Context, Service } from '@ejunz/cordis'

import type { Agent } from '@ejunz/ea-core/agent'

declare module '@ejunz/cordis' {
  interface Context {
    jobs: JobRegistry
  }
}

export abstract class JobRegistry extends Service {
  constructor(ctx: Context) {
    // `abstract` erases at runtime, so a composition row naming this package
    // would register a ctx.jobs with no method implementations and fail far
    // from the misconfiguration. Fail loud at load instead.
    if (new.target === JobRegistry) {
      throw new Error('@ejunz/ea-core/jobs is the abstract job registry seam; load an implementation such as @ejunz/ea-core/jobs-local instead')
    }
    super(ctx, 'jobs')
  }

  /**
   * Preflight access, validation, owner cleanup, and implementation-owned
   * admission before starting and atomically registering work. Any preflight
   * rejection leaves no job id or execution resource. A throwing starter
   * leaves nothing registered; after it returns, registration cannot fail.
   * Settlement records the outcome, notifies listeners, and releases waiters.
   * @param spec - job identity, owner, and synchronous starter.
   * @returns the registry-issued `<kind>-N` id.
   */
  abstract start(spec: JobStart): JobId

  /**
   * List caller-owned and unowned jobs in registration order without exposing
   * another session's labels.
   * @param caller - reading agent; a non-agent caller sees only unowned jobs.
   * @returns fresh snapshots.
   */
  abstract list(caller?: Agent): JobSnapshot[]

  /**
   * Return a non-consuming snapshot without changing its read cursor or notice
   * state. Throws for an unknown or foreign job.
   * @param id - job to look up.
   * @param caller - reading agent checked against the owner.
   * @returns a fresh snapshot.
   */
  abstract get(id: JobId, caller?: Agent): JobSnapshot

  /**
   * Read the next stream delta, or the idempotent final output after settlement.
   * A terminal read marks the job reported. Throws for an unknown or foreign
   * job.
   * @param id - job to read.
   * @param caller - reading agent checked against the owner.
   * @returns output text and the post-read snapshot.
   */
  abstract read(id: JobId, caller?: Agent): JobRead

  /**
   * Request cancellation, then mark the job stopping and reported. A producer
   * throw propagates without changing job state. Throws for an unknown or
   * foreign job.
   * @param id - job to cancel.
   * @param caller - killing agent checked against the owner.
   * @param reason - logged reason forwarded to the producer.
   * @returns `requested` for live work, otherwise `already-finished`.
   */
  abstract kill(id: JobId, caller?: Agent, reason?: string): 'requested' | 'already-finished'

  /**
   * Wait for settlement or timeout without cancelling the job. Caller abort
   * rejects only while the job is live; after settlement the terminal
   * snapshot wins so a notice suppressed for this waiter is still delivered.
   * Throws for invalid, unknown, or foreign input.
   * @param id - job to wait for.
   * @param timeoutMs - positive finite wait bound in milliseconds.
   * @param caller - waiting agent checked against the owner.
   * @param signal - optional cancellation of the wait itself.
   * @returns snapshot at settlement or timeout.
   */
  abstract wait(id: JobId, timeoutMs: number, caller?: Agent, signal?: AbortSignal): Promise<JobSnapshot>

  /**
   * Register an effect-scoped completion listener. It receives the settlements
   * of the owners its registering context's scope covers; each listener is
   * contained; returned promises are observed but not awaited. No listener runs
   * after service disposal.
   * @param listener - receives each terminal snapshot and its exact owner.
   * @returns disposer that unregisters the listener.
   */
  abstract onJobDone(listener: JobDoneListener): () => void

  /**
  /**
   * Register an effect-scoped observer of visible-set changes. It fires after
   * every commit that changes what {@link list} returns for that owner —
   * registration, every stopping transition (including the one teardown
   * performs before it awaits a slow producer), settlement, owner-disposal
   * removal, and the emptying that service disposal commits — so an observer
   * re-reads rather than accumulating deltas.
   *
   * Delivery is owner-relative on the same terms as {@link onJobDone}: an
   * observer registered from an unscoped context — a host composition's own
   * carrier — sees every owner, while one registered under an agent
   * composition's scope sees exactly the agents composed under it.
   *
   * This is not a superset of {@link onJobDone}: that one delivers the terminal
   * record under first-wins semantics a job controller couples to notice
   * delivery, while this one carries no delivery meaning and marks nothing
   * reported. Listeners are contained and never awaited.
   * @param listener - receives the owner whose visible set changed, or
   *   `undefined` when an unowned job changed and every caller's set did.
   * @returns disposer that unregisters the listener.
   */
  abstract onJobsChanged(listener: JobsChangedListener): () => void

  /**
   * Attach an effect-scoped controller that can read and stop jobs. It serves the
   * owners its registering context's scope covers, and {@link start} refuses an
   * owner no attached controller serves.
   * @param name - diagnostic label; duplicate names remain independent.
   * @returns disposer that detaches this controller.
   */
  abstract attachController(name: string): () => void
}

export default JobRegistry

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/jobs'
  export const name = 'jobs-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
