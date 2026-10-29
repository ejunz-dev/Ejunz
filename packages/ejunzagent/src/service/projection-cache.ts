import { z } from 'zod'

import { SessionId } from '@ejunz/ea/session'

import { defineDomain, domainTable } from '@ejunz/ea/storage'

export const checkpointRow = z.object({
  ver: z.number().int().nonnegative(),
  seq: z.number().int().gte(-1),
  val: z.json(),
})

export const checkpointIdentity = z.object({
  createdAt: z.number().int().nonnegative(),
  cwd: z.string().optional(),
})

export type CheckpointIdentity = z.infer<typeof checkpointIdentity>

export const checkpointRecord = z.object({
  identity: checkpointIdentity,
  rows: z.record(z.string(), checkpointRow),
})

export type CheckpointRecord = z.infer<typeof checkpointRecord>

export const projectionCacheDomainSpec = defineDomain({
  name: 'session_projcache',
  version: 3,
  tables: { sessions: domainTable<SessionId, CheckpointRecord>(checkpointRecord) },
})

import { Context, Service } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { snapshotJsonValue } from '@ejunz/ea/session'

import type { Session, SessionEvent, SessionHeader, SessionId } from '@ejunz/ea/session'

import type {} from '@ejunz/ea/session-persistence'

import type { ProjectionCheckpoint, ProjectionSnapshot } from '@ejunz/ea/session-projection'

import type { KvTable } from '@ejunz/ea/storage'

declare module '@ejunz/cordis' {
  interface Context {
    sessionProjectionCache: SessionProjectionCache
  }
}

export interface Config {
  /** Committed events per session that force a durable checkpoint write between mandatory points. */
  writeEveryEvents: number
  /** Longest time (milliseconds) a dirty checkpoint may stay unwritten between mandatory points. */
  writeIntervalMs: number
}

export const Config: z<Config> = z.object({
  writeEveryEvents: z.natural().min(1).required(),
  writeIntervalMs: z.natural().min(1).required(),
})

interface DirtyState {
  /** Committed events since the last durable write. */
  pending: number
  /** Interval trigger armed at the first dirty event after a clean write. */
  timer: ReturnType<typeof setTimeout> | undefined
}

export class SessionProjectionCache extends Service {
  static inject = ['storageDomain', 'sessionProjections', 'sessionPersistence', 'sessions']

  static Config: z<Config> = Config

  private table?: KvTable<SessionId, CheckpointRecord>
  private readonly dirty = new Map<Session, DirtyState>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'sessionProjectionCache')
  }

  /** Open the domain and install the write-behind listeners. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(projectionCacheDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'sessionProjectionCache.domainClose')
    this.table = domain.table('sessions')
    this.installWritePath()
  }

  /**
   * The stored record for one session, accepted only when its bound log
   * identity matches `expected`. A session id names a slot, not a lifecycle:
   * a recreated id or a persistence store swapped under a surviving cache
   * must not let an old record seed state folded from an unrelated log.
   * Synchronous from the domain's in-memory state.
   * @param id - the session whose record is read.
   * @param expected - the log identity the caller holds (live or stored header).
   * @returns the identity-matching record, or `undefined` (absent or unrelated).
   */
  private recordFor(id: SessionId, expected: CheckpointIdentity): CheckpointRecord | undefined {
    const record = this.requireTable().get(id)
    if (record === undefined) return undefined
    return identityMatches(record.identity, expected) ? record : undefined
  }

  /**
   * The zero-I/O listing read: whole values viewed straight from the stored
   * rows (version-matching keys only), each cut carried with its watermark
   * so a client value store can seed under its higher-seq-wins rule — as
   * stale as the last durable checkpoint but never wrong, and never from an
   * unrelated log (the caller's header is the identity witness). Fresher
   * paths (the history tail baseline, {@link coldSnapshot}) supersede these
   * values whenever a session is actually opened.
   * @param meta - the listed session's header (identity witness; no log read).
   * @returns the cut (`asOfSeq` = lowest served-row watermark), or
   *   `undefined` when no usable row exists for this lifecycle.
   */
  cachedSnapshot(meta: SessionHeader): ProjectionSnapshot | undefined {
    const record = this.recordFor(meta.id, identityOf(meta))
    if (record === undefined) return undefined
    const values = this.ctx.sessionProjections.viewCheckpoint(record.rows)
    const keys = Object.keys(values)
    if (keys.length === 0) return undefined
    // The block carries ONE cut: the lowest served watermark is the seq every
    // value is at least current as of (under-claiming is safe under
    // higher-seq-wins; over-claiming would let a stale value outrank pushes).
    const asOfSeq = Math.min(...keys.map(key => (record.rows[key] as { seq: number }).seq))
    return { asOfSeq, values }
  }

  /**
   * Durably checkpoint one live session NOW (both mandatory points call
   * this; tests and carriers may too). The registry cut is snapshotted at
   * this boundary (states are live references), then the whole record is
   * replaced. NOT fail-soft — callers on the fail-soft paths contain it.
   * @param session - the live session to checkpoint.
   * @returns resolution after durability and event emission.
   */
  async write(session: Session): Promise<void> {
    const rows = this.ctx.sessionProjections.checkpoint(session)
    this.markClean(session)
    // Durability barrier: the checkpoint cut was taken above, so flushing
    // AFTER it guarantees every event inside the cut is durably logged
    // before the cache row lands — a crash can leave the cache behind the
    // log (longer tail replay) but never ahead of it (phantom values folded
    // from events no stored log contains). At detach the store entry is
    // already gone; persistence's own retirement drain covers that path and
    // any residual overreach is caught by the cold read's anchored floor.
    if (this.ctx.sessions.get(session.id) === session) await this.ctx.sessions.flush(session)
    await this.put(session.id, identityOf(session.header), rows)
  }

  /**
   * Cold-read one persisted session's projections with zero full-log load:
   * cached rows + a persistence `readFrom` tail from the registry's restore
   * floor, refolded by the registry and written back (fail-soft) so the next
   * cold read starts closer. A cache row invalidated by a shrunk log
   * (crash-repair truncation) triggers one full re-read from seq 0 — the
   * ladder's slow rung, still no crash. Rejects when the session has no
   * persisted log (`not found` from the persistence seam).
   * @param id - the persisted session to read.
   * @param signal - optional cancellation for the persistence reads.
   * @returns the snapshot cut at the stored log end.
   */
  async coldSnapshot(id: SessionId, signal?: AbortSignal): Promise<ProjectionSnapshot> {
    const record = this.requireTable().get(id)
    const cached = record?.rows ?? {}
    const floor = this.ctx.sessionProjections.restoreFloor(cached)
    const persistence = this.ctx.sessionPersistence
    if (floor === undefined) {
      // No unit registered: nothing to fold, but the not-found contract must
      // hold in this topology too — the probe read rejects for an absent log
      // and dates the empty cut for a present one.
      const probe = await persistence.readFrom(id, 0, signal)
      return { asOfSeq: probe.events.at(-1)?.seq ?? -1, values: {} }
    }
    let restored: { snapshot: ProjectionSnapshot; checkpoint: ProjectionCheckpoint }
    const tail = await persistence.readFrom(id, floor, signal)
    // The tail's stored header is the identity witness: a record bound to a
    // different lifecycle (recreated id, swapped store) is discarded whole
    // before any of its rows can seed a fold.
    const related = record === undefined || identityMatches(record.identity, identityOf(tail.meta))
    try {
      if (!related) throw new Error('unrelated log identity')
      restored = this.ctx.sessionProjections.restore(cached, tail.events, floor)
    } catch {
      // The recoverable restore failures: an unrelated record, or a row
      // overreaching the stored log end (or predating the floor). Both imply
      // floor > 0 (baseSeq-0 restores never throw and an unrelated record
      // still carried a usable watermark), so the full log is a fresh read.
      const whole = await persistence.readFrom(id, 0, signal)
      restored = this.ctx.sessionProjections.restore({}, whole.events, 0)
    }
    await this.putSoft(id, identityOf(tail.meta), restored.checkpoint, 'cold-read write-back')
    return restored.snapshot
  }

  // --- write-behind (throttle + mandatory points) ---

  private installWritePath(): void {
    // Every committed event advances the dirty counter; turn/end is a
    // mandatory point (the durable value most reads want is the turn-final
    // one), count/interval throttle the in-turn stream.
    this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type === 'turn/end') {
        void this.flushSoft(session, 'turn/end')
        return
      }
      const state = this.dirty.get(session) ?? { pending: 0, timer: undefined }
      this.dirty.set(session, state)
      state.pending += 1
      if (state.pending >= this.config.writeEveryEvents) {
        void this.flushSoft(session, 'count threshold')
        return
      }
      state.timer ??= setTimeout(() => {
        void this.flushSoft(session, 'interval')
      }, this.config.writeIntervalMs)
    })

    // Detach (the live-to-cold moment): the second mandatory point. After
    // this write the cold-read ladder serves the session from the cache.
    // flushSoft's synchronous prefix reads and resets the dirty state, so
    // dropping it (timer already cleared by markClean) right after is safe.
    this.ctx.on('session/disposed', (session: Session) => {
      void this.flushSoft(session, 'detach')
      this.markClean(session)
      this.dirty.delete(session)
    })

    // Clear pending timers with the plugin (their sessions outlive the cache).
    this.ctx.effect(() => () => {
      for (const state of this.dirty.values()) {
        if (state.timer !== undefined) clearTimeout(state.timer)
      }
      this.dirty.clear()
    }, 'sessionProjectionCache.timers')
  }

  /**
   * One fail-soft durable checkpoint. Every caller has work by construction:
   * the throttle triggers only fire dirty (markClean clears the timer with
   * the counter) and the two mandatory points write unconditionally.
   */
  private async flushSoft(session: Session, trigger: string): Promise<void> {
    try {
      await this.write(session)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${trigger} write for "${session.id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  /** Reset one session's dirty bookkeeping (its checkpoint is being written). */
  private markClean(session: Session): void {
    const state = this.dirty.get(session)
    if (state === undefined) return
    state.pending = 0
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
  }

  /** Replace one session's stored record with its log identity and a detached snapshot of `rows`. */
  private async put(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint): Promise<void> {
    const detached = snapshotJsonValue(rows)
    if (detached === undefined) {
      throw new TypeError('projection checkpoint is not losslessly JSON-serializable (a unit state violates the plain-JSON contract)')
    }
    await this.requireTable().put(id, { identity, rows: detached as CheckpointRecord['rows'] })
  }

  /** Fail-soft {@link put}: cache writes must never fail their caller's read or event path. */
  private async putSoft(id: SessionId, identity: CheckpointIdentity, rows: ProjectionCheckpoint, what: string): Promise<void> {
    try {
      await this.put(id, identity, rows)
    } catch (error) {
      this.ctx.logger.warn(`session projection cache: ${what} for "${id}" failed (cache stays stale): ${String(error)}`)
    }
  }

  private requireTable(): KvTable<SessionId, CheckpointRecord> {
    /* v8 ignore next -- Service.init assigns the table before the service becomes injectable */
    if (this.table === undefined) throw new Error('session projection cache is not initialized')
    return this.table
  }
}

function identityOf(header: SessionHeader): CheckpointIdentity {
  return { createdAt: header.createdAt, ...header.cwd === undefined ? {} : { cwd: header.cwd } }
}

function identityMatches(stored: CheckpointIdentity, expected: CheckpointIdentity): boolean {
  return stored.createdAt === expected.createdAt && stored.cwd === expected.cwd
}

export default SessionProjectionCache

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/session-projection-cache'
  export const name = 'session-projection-cache-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
