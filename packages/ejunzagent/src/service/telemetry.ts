import { Context, Service } from '@ejunz/cordis'

declare module '@ejunz/cordis' {
  interface Context {
    sessionTelemetry: SessionTelemetryBackend
  }

  interface Events {
    /**
     * Transform one outbound record before it reaches the backend. This
     * waterfall is the Service Definition's redaction extension point. It ships NO rules
     * of its own: the
     * innermost `next()` passes the record through unchanged, and with no
     * listener mounted records reach the backend as captured, so exported
     * data is exactly as clean as the rules a deployment mounts. Listeners
     * stack by transforming `next()`'s return value; returning without
     * `next()` replaces everything beneath. Dispatched synchronously on the
     * capture hot path inside the coordinator's containment: a throwing
     * listener withholds that one record (fail-closed) and never reaches the
     * agent loop. Live capture dispatches at append time; on-demand capture
     * dispatches while reading the canonical log. Redaction applies to the
     * exported copy only; the canonical session log is never rewritten.
     * @param record - the candidate record, already the coordinator's own deep
     *   copy; listeners return a (possibly new) record and must not mutate it.
     * @mode waterfall
     */
    'session-telemetry/record'(record: SessionTelemetryRecord, next: () => SessionTelemetryRecord): SessionTelemetryRecord
  }
}

export type SessionTelemetrySeverity = 'info' | 'warn' | 'error'

export interface SessionTelemetryRecord {
  /** Ledger (session-log mirror) or ops (operational signal) channel; backends keep the two under separate instrumentation scopes. */
  channel: 'ledger' | 'ops'
  /** Unix epoch milliseconds — the source event's append time for ledger records, the emission time for ops records. */
  time: number
  /** Pre-mapped alerting severity; see {@link SessionTelemetrySeverity}. */
  severity: SessionTelemetrySeverity
  /**
   * Identity attributes, deliberately minimal: ledger records carry
   * `session.id`, `event.type`, `event.seq`, plus `session.cwd` /
   * `session.parent_id` / `session.seed_length` when the header has them;
   * ops records carry `telemetry.op`, `session.id`, and (for `agent-error`)
   * `agent.id`, `turn`, `step`, `error.name`. Anything recoverable from the
   * body is intentionally NOT duplicated here.
   */
  attributes: Record<string, string | number>
  /**
   * The complete payload: a deep copy of the session event's `data` for
   * ledger records (JSON-serializable by `Session.append`'s own
   * validation), or the op payload for ops records. Never mutated after
   * handoff.
   */
  body: unknown
}

export interface SessionTelemetrySink {
  /**
   * Hand one record to the backend's pipeline. MUST be a non-blocking
   * enqueue — the coordinator calls this synchronously from the
   * `session/event` hot path or an explicit canonical-log capture, so anything
   * slower than a queue push would tax the agent loop or feedback handling.
   * Errors thrown here are contained by the coordinator and logged; they
   * never reach the loop.
   * @param record - the logical record to report; owned by the backend after the call.
   */
  emit(record: SessionTelemetryRecord): void
  /**
   * Optional hint that a turn ended. A backend may forward it to its SDK's
   * flush so records are exported after each turn. Called
   * fire-and-forget; implementations must not block and must not throw
   * meaningfully (the coordinator contains exceptions). Most backends should
   * leave this unimplemented and let their SDK's own batching cadence govern
   * export timing: a backend that does implement it owns the interaction
   * between its concurrent flushes and {@link shutdown}'s drain (the OTel
   * backend leaves it unimplemented for exactly that hazard — see the
   * revival Agent Note).
   */
  flush?(): void
  /**
   * Forward the fiber's disposal to the SDK: flush whatever is queued and
   * reach quiescence, per the SDK's own shutdown contract. Everything
   * emitted before this call must still be delivered — including records
   * enqueued while a {@link flush} hint is in flight, so a backend whose SDK
   * guards against concurrent flushes orders behind the outstanding one (the
   * coordinator emits its dispose-time `shutdown` markers immediately before
   * calling this). Awaited by the coordinator's dispose; a rejection is
   * logged as a warning and never fails application teardown.
   * The coordinator captures dispose-time shutdown markers immediately before
   * this call for live capture; on-demand capture creates no ops records.
   * @returns resolves when the backend's pipeline has quiesced.
   */
  shutdown(): Promise<void>
}

export type SessionTelemetrySharingStatus = 'full' | 'feedback-only' | 'disabled'

export abstract class SessionTelemetryBackend extends Service implements SessionTelemetrySink {
  constructor(ctx: Context) {
    super(ctx, 'sessionTelemetry')
  }

  /**
   * Deployment-selected session-sharing policy, disclosed for acknowledgement
   * surfaces that report whether recorded feedback leaves the process. Every
   * backend must disclose its policy; a consumer renders "not configured" only
   * when no telemetry service is mounted. The seam owns this vocabulary so the
   * disclosure is backend-independent.
   */
  abstract readonly sharing: SessionTelemetrySharingStatus

  /**
   * See {@link SessionTelemetrySink.emit} — that declaration is the contract's one home.
   * @param record - the logical record to report; owned by the backend after the call.
   */
  abstract emit(record: SessionTelemetryRecord): void

  /** See {@link SessionTelemetrySink.flush}. */
  flush?(): void

  /**
   * See {@link SessionTelemetrySink.shutdown}.
   * @returns resolves when the backend's pipeline has quiesced.
   */
  abstract shutdown(): Promise<void>
}

import type { Context } from '@ejunz/cordis'

import type { Session, SessionEvent } from '@ejunz/ea-core/session'

import type { Agent } from '@ejunz/ea-core/agent'

export type SessionTelemetryCapture = 'live' | 'on-demand'

interface ProjectedRecord {
  readonly record: SessionTelemetryRecord
  /** Ledger cursor advanced only after the backend accepts this record. */
  readonly seq?: number
}

const handoffCursor = new WeakMap<Session, number>()

export class SessionTelemetryCoordinator {
  /**
   * Sessions adopted by THIS fiber and still live, for double-adoption
   * protection and the teardown sweep of unmarked sessions;
   * `session/disposed` marks and retires entries.
   */
  private readonly adopted = new Set<Session>()
  /** Per session, the `turn:step` keys whose first chunk already shipped; rebuilt from the log on re-adoption. */
  private readonly chunkSeen = new WeakMap<Session, Set<string>>()
  /**
   * @param ctx - the composing backend's context; listeners bind to its fiber.
   * @param backend - the backend receiving records; owned elsewhere, never disposed here beyond `shutdown()` forwarding.
   * @param capture - follow live events, or wait for explicit canonical-log capture.
   */
  constructor(
    private readonly ctx: Context,
    private readonly backend: SessionTelemetrySink,
    capture: SessionTelemetryCapture = 'live',
  ) {
    if (capture === 'live') {
      ctx.on('session/created', (session) => {
        this.adopt(session)
      })
      // Capture the shutdown marker at the session's own termination edge,
      // then retire the only strong reference owned by this coordinator.
      ctx.on('session/disposed', (session) => {
        this.contain(() => {
          if (!this.adopted.delete(session)) return
          this.deliver(session, { record: this.redact(shutdownRecord(session)) })
        })
      })
      ctx.on('session/event', (session, event) => {
        this.contain(() => {
          this.captureEvent(session, event)
        })
      })
      // Parallel listeners are awaited by the loop at turn end; returning void
      // (not the SDK's flush promise) is the turn-latency contract.
      ctx.on('session/flush', (session) => {
        this.contain(() => {
          this.hintFlush(session)
        })
      })
      ctx.on('agent/error', ({ agent, turn, step, error }) => {
        this.contain(() => {
          this.relayAgentError(agent, turn, step, error)
        })
      })
      for (const session of ctx.sessions.list()) {
        this.adopt(session)
      }
    }
    ctx.effect(() => async () => {
      // Sessions still adopted here are alive through whole-application
      // teardown, so capture the marker before the backend quiesces.
      for (const session of this.adopted) {
        this.contain(() => {
          this.deliver(session, { record: this.redact(shutdownRecord(session)) })
        })
      }
      try {
        await this.backend.shutdown()
      } catch (error) {
        this.ctx.logger.warn(`telemetry: backend shutdown failed: ${String(error)}`)
      }
    }, 'telemetry capture')
  }

  /**
   * Project and hand over the canonical session-log suffix after the handoff
   * cursor, optionally stopping at an inclusive sequence boundary. Redaction
   * runs during this call, so an on-demand caller retains no copied records
   * before requesting capture and uses the policy mounted at that time.
   * Backend and policy failures remain contained per event and do not starve
   * later events in the same replay.
   * @param session - session whose current canonical-log prefix may be handed over.
   * @param throughSeq - optional last sequence included in this capture.
   */
  captureSession(session: Session, throughSeq?: number): void {
    const cursor = handoffCursor.get(session) ?? session.firstLiveSeq - 1
    // Containment is PER EVENT: one rejected record is withheld fail-closed
    // while the rest of the historical replay proceeds.
    for (const event of session.events) {
      if (throughSeq !== undefined && event.seq > throughSeq) break
      this.contain(() => {
        if (event.seq <= cursor) this.track(session, event)
        else this.captureEvent(session, event)
      })
    }
  }

  /**
   * Adopt a session: replay its log THROUGH the projection from the handoff
   * cursor, then rely on the firehose for everything after. When no cursor
   * survived, replay starts at the session's construction boundary
   * (`firstLiveSeq`), not seq 0: constructor seeds never publish on the
   * firehose, and their content already left the process under another
   * identity — the same id in a previous process (resume) or the parent's
   * stream (fork, stitched by receivers via `session.seed_length`). Events
   * at or below the start still feed the projection state (first-chunk
   * tracking) without being re-handed, so a resumed fiber drops mid-step
   * chunk continuations exactly like the fiber that saw the step begin. The
   * cost, accepted with the capture contract's at-most-once stance: a resume no longer
   * backfills records a previous process failed to deliver.
   * @param session - the live session to adopt; a second adoption is a no-op.
   */
  private adopt(session: Session): void {
    if (this.adopted.has(session)) return
    this.adopted.add(session)
    this.captureSession(session)
  }

  /** Feed the chunk projection without handing off — the ≤cursor half of re-adoption. */
  private track(session: Session, event: SessionEvent): void {
    if (event.type === 'assistant/chunk') {
      this.seen(session).add(`${event.data.turn}:${event.data.step}`)
    }
  }

  /** Project, redact, and hand one event to the backend. */
  private captureEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'assistant/chunk') {
      const key = `${event.data.turn}:${event.data.step}`
      const seen = this.seen(session)
      // Fixed chunk projection: only the first chunk of each (turn, step)
      // ships — the stream-started signal; content is byte-complete in the
      // step's assembled assistant/message. Dropped chunks do not advance
      // the cursor, so re-adoption re-drops them deterministically.
      if (seen.has(key)) return
      seen.add(key)
    }
    this.deliver(session, {
      record: this.redact({
        channel: 'ledger',
        time: event.time,
        severity: severityOf(event),
        attributes: identityOf(session, event),
        // The canonical event object is mutable and the backend serializes
        // later; append-time validation guarantees this clone cannot throw.
        body: structuredClone(event.data),
      }),
      seq: event.seq,
    })
  }

  /**
   * Run the `session-telemetry/record` waterfall at capture time. The innermost `next`
   * passes the record through unchanged — this package ships no rules; exported
   * data is as clean as the listeners a deployment mounts. Callers run inside
   * {@link contain}, so a throwing rule withholds the record instead of
   * reaching the loop (fail-closed). On-demand capture invokes this waterfall
   * while reading the canonical session log, not when the event was appended.
   */
  private redact(record: SessionTelemetryRecord): SessionTelemetryRecord {
    return this.ctx.waterfall('session-telemetry/record', record, () => record)
  }

  /** Hand one redacted record to the backend, then advance its ledger cursor. */
  private deliver(session: Session, pending: ProjectedRecord): void {
    this.backend.emit(pending.record)
    if (pending.seq !== undefined) handoffCursor.set(session, pending.seq)
  }

  /** Forward the turn-end boundary to the backend's optional flush hint. */
  private hintFlush(session: Session): void {
    if (this.adopted.has(session)) this.backend.flush?.()
  }

  /** Relay one `agent/error` bus emission as an `agent-error` operational record. */
  private relayAgentError(agent: Agent, turn: number, step: number, error: unknown): void {
    const detail = errorDetail(error)
    this.deliver(agent.session, {
      record: this.redact({
        channel: 'ops',
        time: Date.now(),
        severity: 'error',
        attributes: {
          'telemetry.op': 'agent-error',
          'session.id': String(agent.session.id),
          'agent.id': agent.id,
          'error.name': detail.name,
          turn,
          step,
        },
        body: detail,
      }),
    })
  }

  /** Lazily create the per-session first-chunk tracking set. */
  private seen(session: Session): Set<string> {
    let set = this.chunkSeen.get(session)
    if (!set) this.chunkSeen.set(session, set = new Set())
    return set
  }

  /**
   * Run one capture-side step with its exception contained: cordis `emit`
   * is stop-on-throw, so a throwing listener would starve every subscriber
   * registered after this plugin — nothing from the backend may escape.
   */
  private contain(step: () => void): void {
    try {
      step()
    } catch (error) {
      this.ctx.logger.warn(`telemetry: capture step failed: ${String(error)}`)
    }
  }
}

function shutdownRecord(session: Session): SessionTelemetryRecord {
  return {
    channel: 'ops',
    time: Date.now(),
    severity: 'info',
    attributes: { 'telemetry.op': 'shutdown', 'session.id': String(session.id) },
    body: { op: 'shutdown' },
  }
}

function severityOf(event: SessionEvent): SessionTelemetrySeverity {
  switch (event.type) {
    case 'tool/result':
      return event.data.message.content[0].isError === true ? 'error' : 'info'
    case 'turn/end':
      return event.data.reason.kind === 'error' ? 'error' : 'info'
    default:
      // Merge-extensible fall-through (no assertNever): event types this coordinator
      // does not depend on — including plugin-merged ones it never heard of —
      // pass through as info; their owners' outcome semantics stay theirs.
      return 'info'
  }
}

function errorDetail(error: unknown): { name: string; message: string } {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return { name: normalized.name, message: normalized.message }
}

function identityOf(session: Session, event: SessionEvent): Record<string, string | number> {
  const attributes: Record<string, string | number> = {
    'session.id': String(session.id),
    'event.type': event.type,
    'event.seq': event.seq,
  }
  const { cwd, parentSession, seedLength } = session.header
  if (cwd !== undefined) attributes['session.cwd'] = cwd
  if (parentSession !== undefined) attributes['session.parent_id'] = String(parentSession)
  // The durable fork boundary: a forked stream starts here, and its prefix
  // lives in the parent's stream — receivers stitch on (parent_id, seed_length).
  if (seedLength !== undefined) attributes['session.seed_length'] = seedLength
  return attributes
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/session-telemetry'
  export const name = 'session-telemetry-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
