export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

export interface StorageBackend {
  /** Key-value operations; absent when this backend cannot serve them. */
  readonly kv?: KvFacet

  /**
   * Drain in-flight writes across all open units and release the medium.
   * Idempotent; concurrent and repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void>
}

export interface KvFacet {
  /**
   * Open one unit, creating it when the medium holds no trace of it yet
   * (materialization may defer to the first write, but {@link KvUnit.loadAll}
   * must immediately serve the empty shape). A version already stamped on the
   * medium that differs from `descriptor.version` rejects with
   * `version-mismatch`; a medium that cannot be parsed as this unit rejects
   * with `malformed-medium`. Opening the same unit name twice without closing
   * is a caller bug and rejects.
   * @param descriptor - Static identity and shape of the unit to open.
   * @returns the opened unit.
   */
  open(descriptor: KvUnitDescriptor): Promise<KvUnit>
}

export interface KvUnitDescriptor {
  /** Unit name; must match {@link UNIT_NAME_RE}. Also the file-name / SQL-identifier segment. */
  readonly name: string
  /** Unit format version; a non-negative integer stamped on the medium at first materialization. */
  readonly version: number
  /** Table names; each must match {@link UNIT_NAME_RE}. */
  readonly tables: readonly string[]
  /** Whether this unit carries the global singleton slot. */
  readonly hasGlobal: boolean
}

export interface KvUnit {
  /**
   * Read the full current snapshot.
   * @returns every table's records keyed by table name, plus the global
   * singleton (`null` when never written or not declared).
   */
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>

  /**
   * Upsert one record durably. Overwrite semantics: an existing key is replaced.
   * @param table - Declared table name.
   * @param key - Record key; any string is safe (keys never reach file paths).
   * @param value - Opaque JSON-serializable record.
   * @returns resolution after durability.
   */
  putRecord(table: string, key: string, value: unknown): Promise<void>

  /**
   * Delete one record durably. Idempotent: a missing key is a no-op.
   * @param table - Declared table name.
   * @param key - Record key.
   * @returns resolution after durability.
   */
  deleteRecord(table: string, key: string): Promise<void>

  /**
   * Write the global singleton durably. Only valid when the descriptor
   * declared `hasGlobal`.
   * @param value - Opaque JSON-serializable value.
   * @returns resolution after durability.
   */
  setGlobal(value: unknown): Promise<void>

  /**
   * Drain this unit's in-flight writes and release it. Idempotent.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}

export type StorageErrorCode =
  | 'backend-not-found'
  | 'form-not-mounted'
  | 'duplicate-backend'
  | 'duplicate-mount'
  | 'version-mismatch'
  | 'malformed-medium'
  | 'closed'

export class StorageError extends Error {
  override readonly name = 'StorageError'

  /**
   * @param code - Stable discriminant for the failure class.
   * @param message - Human-readable diagnostic detail.
   * @param options - Standard error options (`cause`).
   */
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export class BackendRegistry {
  private readonly backends = new Map<string, StorageBackend>()

  /**
   * Register a named backend. Registration is an effect: the returned
   * disposer removes the name. Disposal does NOT close the backend — the
   * owning plugin closes it after unregistering.
   * @param name - Backend name, e.g. `json` or `sqlite`.
   * @param backend - The backend instance.
   * @returns the disposer that unregisters the name.
   */
  register(name: string, backend: StorageBackend): () => void {
    if (this.backends.has(name)) {
      throw new StorageError('duplicate-backend', `storage backend '${name}' is already registered`)
    }
    this.backends.set(name, backend)
    return () => {
      // Remove only this registration's contribution: after dispose + re-register,
      // a stale disposer firing again must not remove the successor.
      if (this.backends.get(name) === backend) {
        this.backends.delete(name)
      }
    }
  }

  /**
   * Resolve a backend by name.
   * @param name - Registered backend name.
   * @returns the backend.
   */
  get(name: string): StorageBackend {
    const backend = this.backends.get(name)
    if (!backend) {
      throw new StorageError(
        'backend-not-found',
        `storage backend '${name}' is not registered (registered: ${[...this.backends.keys()].join(', ') || 'none'})`,
      )
    }
    return backend
  }

  /**
   * Registered backend names, for diagnostics.
   * @returns a snapshot array of names.
   */
  names(): string[] {
    return [...this.backends.keys()]
  }
}

import { Context, Service } from '@ejunz/cordis'

export function storageBackendServiceKey(name: string): string {
  return `storage.backend.${name}`
}

declare module '@ejunz/cordis' {
  interface Context {
    storage: Storage
  }
}

export interface StorageForms {}

export class Storage extends Service {
  /** Named backend table; multiple backends stay mounted side by side. */
  readonly backend: BackendRegistry = new BackendRegistry()

  private readonly forms = new Map<keyof StorageForms, unknown>()

  constructor(ctx: Context) {
    super(ctx, 'storage')
  }

  /**
   * Mount a data-form facility on the hub. Mounting is an effect: the
   * returned disposer unmounts the form.
   * @param form - Form key declared in {@link StorageForms}.
   * @param facility - The facility instance to expose.
   * @returns the disposer that unmounts the form.
   */
  mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void {
    if (this.forms.has(form)) {
      throw new StorageError('duplicate-mount', `storage form '${String(form)}' is already mounted`)
    }
    this.forms.set(form, facility)
    return () => {
      // Same stale-disposer guard as BackendRegistry.register.
      if (this.forms.get(form) === facility) {
        this.forms.delete(form)
      }
    }
  }

  /**
   * Resolve a mounted data form.
   * @param form - Form key declared in {@link StorageForms}.
   * @returns the mounted facility.
   */
  form<K extends keyof StorageForms>(form: K): StorageForms[K] {
    if (!this.forms.has(form)) {
      throw new StorageError('form-not-mounted', `storage form '${String(form)}' is not mounted`)
    }
    return this.forms.get(form) as StorageForms[K]
  }

  /** Domain data form; present once the domain layer plugin is loaded. */
  get domain(): StorageForms extends { domain: infer D } ? D : never {
    return this.form('domain' as keyof StorageForms)
  }
}

export default Storage

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/storage'
  export const name = 'storage-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
