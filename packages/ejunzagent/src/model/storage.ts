export type DomainErrorCode =
  | 'already-open'
  | 'facet-unsupported'
  | 'invalid-record'
  | 'missing-key'
  | 'closed'

export interface InvalidRecordDetail {
  /** Table holding the rejected record; `''` for the global singleton. */
  readonly table: string
  /** Key of the rejected record; `''` for the global singleton. */
  readonly key: string
}

export interface DomainErrorOptions extends ErrorOptions {
  /** Present exactly when `code` is `invalid-record`. */
  readonly detail?: InvalidRecordDetail
}

export class DomainError extends Error {
  override readonly name = 'DomainError'

  /** Present exactly when `code` is `invalid-record`. */
  readonly detail?: InvalidRecordDetail

  /**
   * @param code - Stable discriminant for the failure class.
   * @param message - Human-readable diagnostic detail.
   * @param options - Standard error options plus the `invalid-record` location.
   */
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    options?: DomainErrorOptions,
  ) {
    super(message, options)
    if (options?.detail) this.detail = options.detail
  }
}

import type { ZodType } from 'zod'

import { UNIT_NAME_RE, type KvUnitDescriptor } from '@ejunz/ea-core/storage'

export interface DomainGlobalSpec<G> {
  /** Validates the stored global at the durable boundary. */
  readonly schema: ZodType<G>
  /** Value served when the medium holds no global yet; not written until the first `set`. */
  readonly initial: G
}

export interface DomainTableSpec<K extends string = string, V = unknown> {
  /** Validates every stored record at the durable boundary. */
  readonly valueSchema: ZodType<V>
  /** Phantom carrier for the key type; never present at runtime. */
  readonly __key?: K
}

export interface DomainSpec {
  /** Domain name; must match `UNIT_NAME_RE` (doubles as the backend unit name). */
  readonly name: string
  /** Domain format version; a medium stamped with a different version rejects at open. */
  readonly version: number
  /** Optional global singleton slot. */
  readonly global?: DomainGlobalSpec<unknown>
  /** Table declarations keyed by table name; each name must match `UNIT_NAME_RE`. */
  readonly tables: Record<string, DomainTableSpec>
}

export type TableKeyOf<S extends DomainSpec, N extends keyof S['tables']> =
  S['tables'][N] extends DomainTableSpec<infer K> ? K : never

export type TableValueOf<S extends DomainSpec, N extends keyof S['tables']> =
  S['tables'][N] extends DomainTableSpec<string, infer V> ? V : never

export type GlobalValueOf<S extends DomainSpec> =
  S['global'] extends DomainGlobalSpec<infer G> ? G : never

export function domainTable<K extends string, V>(schema: ZodType<V>): DomainTableSpec<K, V> {
  return { valueSchema: schema }
}

export function defineDomain<S extends DomainSpec>(spec: S): S {
  if (!UNIT_NAME_RE.test(spec.name)) {
    throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`)
  }
  if (!Number.isInteger(spec.version) || spec.version < 0) {
    throw new Error(`domain '${spec.name}' version must be a non-negative integer, got ${spec.version}`)
  }
  for (const table of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(table)) {
      throw new Error(`domain '${spec.name}' table name '${table}' must match ${UNIT_NAME_RE}`)
    }
  }
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
    throw new Error(
      `domain '${spec.name}' global schema must not accept null: `
      + 'null is the medium\'s "never written" sentinel, so a stored null could not round-trip',
    )
  }
  return spec
}

export function descriptorOf(spec: DomainSpec): KvUnitDescriptor {
  return {
    name: spec.name,
    version: spec.version,
    tables: Object.keys(spec.tables),
    hasGlobal: spec.global !== undefined,
  }
}

export interface DomainChangedBase {
  /** Owning domain name. */
  readonly domain: string
  /** Table name; `''` for a global-singleton write. */
  readonly table: string
  /** Record key; `''` for a global-singleton write. */
  readonly key: string
}

export interface DomainChangedPut extends DomainChangedBase {
  readonly operation: 'put'
  /** The new snapshot. */
  readonly value: unknown
}

export interface DomainChangedDeleted extends DomainChangedBase {
  readonly operation: 'deleted'
  readonly value?: never
}

export type DomainChanged = DomainChangedPut | DomainChangedDeleted

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * A domain record or the global singleton changed, emitted once per write
     * strictly after the backend acknowledged durability. Events of one
     * domain arrive in its write-chain order.
     * @param change - domain, table (`''` for global), key (`''` for global),
     * operation discriminant, and on `put` the new snapshot.
     * @mode emit
     */
    'domain/changed'(change: DomainChanged): void
  }
}

import type { Context } from '@ejunz/cordis'

import type { KvUnit } from '@ejunz/ea-core/storage'

export interface DomainGlobal<G> {
  /**
   * Current value, synchronously from the authoritative in-memory state.
   * Before the first `set` this is the spec's `initial`.
   * @returns the current global value.
   */
  get(): G

  /**
   * Replace the value durably. Queued on the domain's write chain; the first
   * `set` is what materializes the global on the medium.
   * @param value - New value; must satisfy the spec's schema (not re-checked
   * here — validation happens at the durable read boundary).
   * @returns resolution after durability and event emission.
   */
  set(value: G): Promise<void>
}

export interface KvTable<K extends string, V> {
  /**
   * Read one record, synchronously from memory.
   * @param key - Record key.
   * @returns the record, or `undefined` when absent.
   */
  get(key: K): V | undefined

  /**
   * Snapshot iterator over `[key, record]` pairs. A snapshot, not a live
   * view: iteration stays stable while queued writes land.
   * @returns the pair iterator.
   */
  entries(): IterableIterator<[K, V]>

  /**
   * Snapshot iterator over keys.
   * @returns the key iterator.
   */
  keys(): IterableIterator<K>

  /** Current record count. */
  readonly size: number

  /**
   * Insert or overwrite one record durably.
   * @param key - Record key.
   * @param value - The full new record (no partial merge).
   * @returns resolution after durability and event emission.
   */
  put(key: K, value: V): Promise<void>

  /**
   * Delete one record durably.
   * @param key - Record key.
   * @returns `true` when the record existed, `false` when it was already
   * absent (no write and no event in that case).
   */
  delete(key: K): Promise<boolean>

  /**
   * Atomic read-modify-write on the domain's write chain: `fn` sees the
   * value current at its queue slot, so concurrent updates never interleave.
   * @param key - Record key; a missing key rejects with `missing-key`.
   * @param fn - Synchronous pure transform from current to next record.
   * @returns the stored next record.
   */
  update(key: K, fn: (current: V) => V): Promise<V>
}

export type DomainGlobalHandleOf<S extends DomainSpec> =
  S extends { readonly global: DomainGlobalSpec<infer G> } ? DomainGlobal<G> : never

export interface Domain<S extends DomainSpec> {
  /** Domain name from the spec. */
  readonly name: string
  /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * Resolve one declared table handle. Handles are stable — repeated calls
   * return the same instance.
   * @param name - Declared table name.
   * @returns the typed table handle.
   */
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), release the backend unit, then free
   * the domain name for a later open. Idempotent — repeated calls share one
   * teardown. The consumer owns this call (typically as its own `ctx.effect`
   * disposer); the facility closes any domain left open when it unmounts.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}

interface TableHost {
  readonly domainName: string
  readonly unit: KvUnit
  /** Queue one job on the domain's single write chain. */
  enqueue<T>(job: () => Promise<T>): Promise<T>
  /** Throw `closed` once the domain has fully closed (reads stay valid while draining). */
  assertReadable(): void
  /** Emit `domain/changed` for one durably landed write. */
  emitChanged(change: DomainChanged): void
}

const noop = () => {}

export class DomainImpl {
  /** Domain name from the spec. */
  readonly name: string

  private readonly tables = new Map<string, KvTableImpl<string, unknown>>()
  private globalValue: unknown
  private readonly globalHandle?: DomainGlobal<unknown>

  /** Tail of the write chain; every link settles (rejections are observed by the caller's slice). */
  private chain: Promise<void> = Promise.resolve()
  /** Set when close begins: new writes reject while already-queued writes drain. */
  private disposing = false
  /** Set when close finishes (chain drained, unit closed): reads reject from here on. */
  private closed = false
  private disposal?: Promise<void>

  /**
   * @param ctx - Context that carries `domain/changed` emissions.
   * @param spec - The domain declaration.
   * @param unit - The opened backend unit; this instance owns its lifecycle.
   * @param records - Validated records from the unit's `loadAll`, one entry
   * per declared table (empty maps included) — the facility builds it from
   * the spec, so the entry set IS the table set.
   * @param globalValue - Validated stored global, or the spec's `initial`
   * when the medium held none; `undefined` when the spec declares no global.
   * @param onClosed - Facility hook run once after teardown completes; frees
   * the domain name for a later open.
   */
  constructor(
    private readonly ctx: Context,
    spec: DomainSpec,
    private readonly unit: KvUnit,
    records: Map<string, Map<string, unknown>>,
    globalValue: unknown,
    private readonly onClosed: () => void,
  ) {
    this.name = spec.name
    const host: TableHost = {
      domainName: spec.name,
      unit,
      enqueue: job => this.enqueue(job),
      assertReadable: () => { this.assertReadable() },
      emitChanged: (change) => { this.emitChanged(change) },
    }
    for (const [table, tableRecords] of records) {
      this.tables.set(table, new KvTableImpl(host, table, tableRecords))
    }
    if (spec.global !== undefined) {
      this.globalValue = globalValue
      this.globalHandle = {
        get: () => {
          this.assertReadable()
          return this.globalValue
        },
        set: value => this.enqueue(async () => {
          await this.unit.setGlobal(value)
          this.globalValue = value
          this.emitChanged({ domain: this.name, table: '', key: '', operation: 'put', value })
        }),
      }
    }
  }

  /** Global singleton handle; accessing it on a spec that declares no global is a caller bug and throws. */
  get global(): DomainGlobal<unknown> {
    if (this.globalHandle === undefined) {
      throw new Error(`domain '${this.name}' declares no global`)
    }
    return this.globalHandle
  }

  /**
   * Resolve one declared table handle; an undeclared name is a caller bug
   * and throws.
   * @param name - Declared table name.
   * @returns the stable table handle.
   */
  table(name: string): KvTable<string, unknown> {
    const table = this.tables.get(name)
    if (table === undefined) {
      throw new Error(`domain '${this.name}' declares no table '${name}'`)
    }
    return table
  }

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), close the unit, then free the name via
   * the facility hook. Idempotent — repeated calls share one teardown.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void> {
    this.disposal ??= this.runClose()
    return this.disposal
  }

  private async runClose(): Promise<void> {
    this.disposing = true
    // Chain links never reject (each is settled via then(noop, noop)), so
    // this await is a pure drain barrier.
    await this.chain
    await this.unit.close()
    this.closed = true
    this.onClosed()
  }

  /**
   * Dispatch one post-durability change notification, containing observer
   * failures: the write is already committed (medium and memory both hold
   * the new state), so a throwing listener must not retroactively reject it.
   */
  private emitChanged(change: DomainChanged): void {
    try {
      this.ctx.emit('domain/changed', change)
    } catch (error) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant — the commit point has
      // passed, so containment (with a log) is the only correct outcome.
      this.ctx.logger.warn(`domain '${this.name}': domain/changed listener failed: ${String(error)}`)
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    if (this.disposing) {
      return Promise.reject(new DomainError('closed', `domain '${this.name}' is closed`))
    }
    const result = this.chain.then(job)
    this.chain = result.then(noop, noop)
    return result
  }

  private assertReadable(): void {
    if (this.closed) {
      throw new DomainError('closed', `domain '${this.name}' is closed`)
    }
  }
}

class KvTableImpl<K extends string, V> implements KvTable<K, V> {
  constructor(
    private readonly host: TableHost,
    private readonly tableName: string,
    private readonly records: Map<string, unknown>,
  ) {}

  get(key: K): V | undefined {
    this.host.assertReadable()
    return this.records.get(key) as V | undefined
  }

  entries(): IterableIterator<[K, V]> {
    this.host.assertReadable()
    return ([...this.records.entries()] as [K, V][])[Symbol.iterator]()
  }

  keys(): IterableIterator<K> {
    this.host.assertReadable()
    return ([...this.records.keys()] as K[])[Symbol.iterator]()
  }

  get size(): number {
    this.host.assertReadable()
    return this.records.size
  }

  put(key: K, value: V): Promise<void> {
    return this.host.enqueue(async () => {
      await this.host.unit.putRecord(this.tableName, key, value)
      this.records.set(key, value)
      this.emitPut(key, value)
    })
  }

  delete(key: K): Promise<boolean> {
    return this.host.enqueue(async () => {
      // Existence is decided at this job's chain slot, not at call time: an
      // earlier queued put of the same key makes this delete observe it.
      if (!this.records.has(key)) return false
      await this.host.unit.deleteRecord(this.tableName, key)
      this.records.delete(key)
      this.host.emitChanged({
        domain: this.host.domainName,
        table: this.tableName,
        key,
        operation: 'deleted',
      })
      return true
    })
  }

  update(key: K, fn: (current: V) => V): Promise<V> {
    return this.host.enqueue(async () => {
      if (!this.records.has(key)) {
        throw new DomainError(
          'missing-key',
          `domain '${this.host.domainName}' table '${this.tableName}' has no record '${key}' to update`,
        )
      }
      const next = fn(this.records.get(key) as V)
      await this.host.unit.putRecord(this.tableName, key, next)
      this.records.set(key, next)
      this.emitPut(key, next)
      return next
    })
  }

  private emitPut(key: K, value: V): void {
    this.host.emitChanged({
      domain: this.host.domainName,
      table: this.tableName,
      key,
      operation: 'put',
      value,
    })
  }
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { storageBackendServiceKey } from '@ejunz/ea-core/storage'

declare module '@ejunz/ea-core/storage' {
  interface StorageForms {
    domain: DomainFacility
  }
}

declare module '@ejunz/cordis' {
  interface Context {
    storageDomain: DomainFacility
  }
}

export const name = 'storage-domain'

export const inject = ['storage']

export interface Config {
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>
}

export const Config: z<Config> = z.object({
  backend: z.string().required(),
  routes: z.dict(z.string()).default({}),
})

export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl>()
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>()

  /**
   * @param ctx - Context of the domain plugin; open-domain effects and change
   * events attach here.
   * @param config - Validated plugin config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

  /**
   * Open one declared domain. Steps, each failing the whole call: reject a
   * name that is already open (`already-open`); resolve the backend route
   * (`backend-not-found` passes through from the hub); require its `kv` facet
   * (`facet-unsupported`); open the unit projected from the spec (backend
   * `version-mismatch`/`malformed-medium` pass through); load and validate
   * every stored record against the spec's zod schemas (`invalid-record`
   * with the offending table and key); construct the domain.
   *
   * Lifecycle: the CALLER owns the returned handle and closes it via
   * `Domain.close()` (typically as its own `ctx.effect` disposer) — the
   * facility does not tie the domain to any consumer fiber. Domains still
   * open when the facility unmounts are closed by the plugin disposer.
   * @param spec - The domain declaration, typically from `defineDomain`.
   * @returns the opened domain handle, typed by the spec.
   */
  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`)
    }
    this.reserved.add(spec.name)
    try {
      const backendName = this.config.routes?.[spec.name] ?? this.config.backend
      const backend = this.ctx.storage.backend.get(backendName)
      if (!backend.kv) {
        throw new DomainError(
          'facet-unsupported',
          `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
        )
      }
      const unit = await backend.kv.open(descriptorOf(spec))
      try {
        const snapshot = await unit.loadAll()
        const tables = new Map<string, Map<string, unknown>>()
        for (const [table, tableSpec] of Object.entries(spec.tables)) {
          const records = new Map<string, unknown>()
          for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
            records.set(key, parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw)))
          }
          tables.set(table, records)
        }
        // A null stored global means "never written": serve `initial` without
        // materializing it — the first `set` writes.
        const globalSpec = spec.global
        const globalValue = globalSpec === undefined
          ? undefined
          : snapshot.global === null
            ? globalSpec.initial
            : parseRecord(spec.name, '', '', () => globalSpec.schema.parse(snapshot.global))
        // The onClosed hook runs strictly after teardown completes: writes
        // landing during the drain still emit domain/changed, and the domain
        // stays resolvable (the package invariant cross-checks each event)
        // until fully closed — only then does the name free up for reopening.
        const domain: DomainImpl = new DomainImpl(this.ctx, spec, unit, tables, globalValue, () => {
          this.domains.delete(spec.name)
          this.reserved.delete(spec.name)
        })
        this.domains.set(spec.name, domain)
        // The single type-erasure point: DomainImpl is the untyped runtime,
        // Domain<S> the spec-typed view; the unknown hop is required because
        // S's conditional global-handle type stays unresolved here.
        return domain as unknown as Domain<S>
      } catch (error) {
        await unit.close()
        throw error
      }
    } catch (error) {
      // Any failure means the domain never registered (nothing can throw
      // after it), so releasing the name reservation is unconditional.
      this.reserved.delete(spec.name)
      throw error
    }
  }

  /**
   * Look up an open domain by name, untyped. Diagnostic surface (the package
   * invariant cross-checks change events against live domain state); typed
   * consumers hold the handle returned by {@link open}.
   * @param name - Domain name.
   * @returns the open domain runtime, or `undefined` when not open.
   */
  get(name: string): DomainImpl | undefined {
    return this.domains.get(name)
  }

  /**
   * Close every domain still open on this facility. The unmount path for
   * consumers that never called `Domain.close()` themselves; closing is
   * idempotent, so double-closing an already-closed domain is harmless.
   * @returns resolution after every unit is released.
   */
  async closeAll(): Promise<void> {
    await Promise.all([...this.domains.values()].map(domain => domain.close()))
  }
}

function parseRecord<T>(domain: string, table: string, key: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    const slot = table === '' ? 'global' : `record '${key}' in table '${table}'`
    throw new DomainError(
      'invalid-record',
      `domain '${domain}': stored ${slot} does not match its schema`,
      { detail: { table, key }, cause: error },
    )
  }
}

export function apply(ctx: Context, config: Config): Promise<void> {
  const backendServices = [...new Set([
    config.backend,
    ...Object.values(config.routes ?? {}),
  ])].map(storageBackendServiceKey)

  const fiber = ctx.inject(backendServices, (domainCtx) => {
    const facility = new DomainFacility(domainCtx, config)
    domainCtx.effect(() => {
      const unmount = domainCtx.storage.mount('domain', facility)
      return async () => {
        // Close leftovers before unmounting: draining writes still emit
        // domain/changed, whose invariant resolves the facility through the hub.
        await facility.closeAll()
        unmount()
      }
    })
    domainCtx.provide('storageDomain', facility)
  })
  return Promise.resolve(fiber).then(() => {})
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/storage'
  export const name = 'storage-domain-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
