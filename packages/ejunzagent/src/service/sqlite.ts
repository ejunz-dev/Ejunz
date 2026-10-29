import { DatabaseSync } from 'node:sqlite'

import { mkdir, open } from 'node:fs/promises'

import { dirname, resolve } from 'node:path'

import { StorageError } from '@ejunz/ea/storage'

export const STORAGE_SQLITE_SCHEMA_VERSION = 1

export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

export async function openDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const db = new DatabaseSync(actual)
  try {
    configureDatabase(db, actual, journalMode)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function configureDatabase(db: DatabaseSync, path: string, journalMode: JournalMode): void {
  db.exec('PRAGMA foreign_keys = ON')
  // The validated union is safe to interpolate into a non-bindable PRAGMA.
  db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
  // `PRAGMA user_version` always returns exactly one row { user_version }.
  const { user_version: onDisk } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (onDisk !== 0 && onDisk !== STORAGE_SQLITE_SCHEMA_VERSION) {
    throw new StorageError(
      'version-mismatch',
      `storage database at "${path}" has schema version ${onDisk}, incompatible with this build (${STORAGE_SQLITE_SCHEMA_VERSION})`,
    )
  }
  /* jscpd:ignore-end */
  db.exec(`
    CREATE TABLE IF NOT EXISTS units (
      name    TEXT PRIMARY KEY,
      version INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS unit_globals (
      unit  TEXT PRIMARY KEY REFERENCES units(name),
      value TEXT NOT NULL
    ) STRICT
  `)
  if (onDisk === 0) {
    // Stamp fresh databases LAST: the stamp asserts the layout is complete,
    // so a failure above must leave the medium unstamped (a re-open after
    // the obstruction is cleared retries materialization from scratch).
    db.exec(`PRAGMA user_version = ${STORAGE_SQLITE_SCHEMA_VERSION}`)
  }
}

export function recordTableName(unit: string, table: string): string {
  return `u_${unit}_${table}`
}

import type { DatabaseSync, StatementSync } from 'node:sqlite'

import { StorageError } from '@ejunz/ea/storage'

import type { KvUnit, KvUnitDescriptor } from '@ejunz/ea/storage'

interface TableStatements {
  upsert: StatementSync
  remove: StatementSync
  selectAll: StatementSync
}

export class SqliteKvUnit implements KvUnit {
  private readonly tables = new Map<string, TableStatements>()
  private readonly globalUpsert: StatementSync | undefined
  private readonly globalSelect: StatementSync | undefined
  private closed = false

  /**
   * @param db - Open database handle owned by the backend (never closed here).
   * @param descriptor - Validated descriptor whose record tables already exist.
   * @param onClose - Backend callback releasing this unit's open-name slot.
   */
  constructor(
    db: DatabaseSync,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {
    for (const table of descriptor.tables) {
      // Both name segments are validated against UNIT_NAME_RE by the backend,
      // so the physical identifier is safe to interpolate into statement text.
      const physical = recordTableName(descriptor.name, table)
      this.tables.set(table, {
        upsert: db.prepare(
          `INSERT INTO "${physical}" (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ),
        remove: db.prepare(`DELETE FROM "${physical}" WHERE key = ?`),
        selectAll: db.prepare(`SELECT key, value FROM "${physical}"`),
      })
    }
    this.globalUpsert = descriptor.hasGlobal
      ? db.prepare(
        'INSERT INTO unit_globals (unit, value) VALUES (?, ?) ON CONFLICT(unit) DO UPDATE SET value = excluded.value',
      )
      : undefined
    this.globalSelect = descriptor.hasGlobal
      ? db.prepare('SELECT value FROM unit_globals WHERE unit = ?')
      : undefined
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return this.settle(() => {
      const tables: Record<string, Record<string, unknown>> = {}
      for (const [name, statements] of this.tables) {
        // Null prototype: record keys are arbitrary strings, so '__proto__'
        // must land as an own property instead of mutating the prototype.
        const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        for (const row of statements.selectAll.all() as unknown as Array<{ key: string; value: string }>) {
          records[row.key] = this.parseValue(row.value, `table '${name}' key '${row.key}'`)
        }
        tables[name] = records
      }
      let global: unknown = null
      if (this.globalSelect !== undefined) {
        const row = this.globalSelect.get(this.descriptor.name) as { value: string } | undefined
        if (row !== undefined) global = this.parseValue(row.value, 'global slot')
      }
      return { tables, global }
    })
  }

  /** Parse one stored value column, mapping bad JSON to `malformed-medium`. */
  private parseValue(text: string, slot: string): unknown {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`,
        { cause: error },
      )
    }
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.settle(() => {
      this.statementsFor(table).upsert.run(key, JSON.stringify(value))
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.settle(() => {
      this.statementsFor(table).remove.run(key)
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.settle(() => {
      if (this.globalUpsert === undefined) {
        throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
      }
      this.globalUpsert.run(this.descriptor.name, JSON.stringify(value))
    })
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    return Promise.resolve()
  }

  /**
   * Run one synchronous primitive behind the closed guard, mapping a throw to
   * a rejection so the Promise-returning contract never throws synchronously.
   */
  private settle<T>(operation: () => T): Promise<T> {
    try {
      this.ensureOpen()
      return Promise.resolve(operation())
    } catch (error) {
      // Non-Error throws can only enter through JSON.stringify propagating a
      // value's own toJSON throw; wrap those, preserve every real Error.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
    }
  }

  private statementsFor(table: string): TableStatements {
    const statements = this.tables.get(table)
    if (statements === undefined) {
      throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`)
    }
    return statements
  }
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import type { DatabaseSync } from 'node:sqlite'

import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@ejunz/ea/storage'

import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@ejunz/ea/storage'

export const name = 'storage-sqlite'

export const inject = ['storage']

export interface Config {
  /**
   * Filesystem path to the SQLite database file. The special value `:memory:`
   * opens an in-process database (tests). On filesystems with POSIX modes,
   * missing directories and databases are created owner-only; existing path
   * modes are preserved. Filesystem setup errors other than an existing
   * database fail the open. The backend does not protect confidentiality or
   * integrity when another principal can replace the database entry in its
   * parent directory.
   */
  path: string
  /**
   * SQLite `journal_mode` pragma. `wal` (the default) suits local disks; pick
   * a rollback-journal mode (`delete`/`truncate`/`persist`) on filesystems
   * where WAL's shared-memory files do not work (network mounts). See
   * {@link JournalMode}.
   */
  journalMode?: JournalMode
}

export const Config: z<Config> = z.object({
  path: z.string().required(),
  journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
})

export class SqliteStorageBackend implements StorageBackend {
  /** The key-value facet; the only shape this backend serves. */
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }

  private readonly ready: Promise<DatabaseSync>
  /** Open (or still-opening) units by name; presence is the double-open guard. */
  private readonly units = new Map<string, Promise<SqliteKvUnit>>()
  private closing: Promise<void> | undefined

  /**
   * @param config - Validated plugin configuration.
   */
  constructor(config: Config) {
    this.ready = openDatabase(config.path, (config as Required<Config>).journalMode)
    // Mark the rejection handled: every primitive re-awaits `ready`, so an
    // open failure still surfaces to each caller; this guard only prevents an
    // unhandled-rejection crash when the failure precedes the first use.
    this.ready.catch(() => {})
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closing !== undefined) {
      return Promise.reject(new StorageError('closed', 'sqlite storage backend is closed'))
    }
    if (!UNIT_NAME_RE.test(descriptor.name)) {
      return Promise.reject(new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`))
    }
    for (const table of descriptor.tables) {
      if (!UNIT_NAME_RE.test(table)) {
        return Promise.reject(new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`))
      }
    }
    if (this.units.has(descriptor.name)) {
      return Promise.reject(new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`))
    }
    // Reserve the name synchronously so a concurrent second open of the same
    // name rejects instead of racing past the guard during the awaits below.
    const pending = this.materializeUnit(descriptor)
    this.units.set(descriptor.name, pending)
    pending.catch(() => this.units.delete(descriptor.name))
    return pending
  }

  private async materializeUnit(descriptor: KvUnitDescriptor): Promise<SqliteKvUnit> {
    const db = await this.ready
    const row = db.prepare('SELECT version FROM units WHERE name = ?').get(descriptor.name) as
      | { version: number }
      | undefined
    if (row === undefined) {
      db.prepare('INSERT INTO units (name, version) VALUES (?, ?)').run(descriptor.name, descriptor.version)
    } else if (row.version !== descriptor.version) {
      throw new StorageError(
        'version-mismatch',
        `kv unit '${descriptor.name}' is stamped version ${row.version} on the medium, incompatible with descriptor version ${descriptor.version}`,
      )
    }
    for (const table of descriptor.tables) {
      // Both segments passed UNIT_NAME_RE, so the identifier is safe in DDL.
      db.exec(`
        CREATE TABLE IF NOT EXISTS "${recordTableName(descriptor.name, table)}" (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT
      `)
    }
    return new SqliteKvUnit(db, descriptor, () => {
      this.units.delete(descriptor.name)
    })
  }

  /**
   * Close every open unit and release the database. Idempotent; concurrent
   * and repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    let db: DatabaseSync
    try {
      db = await this.ready
    } catch {
      // The medium never opened; that failure already rejected the opener and
      // every unit call, so there is nothing left to release here.
      return
    }
    for (const pending of [...this.units.values()]) {
      const unit = await pending.catch(() => undefined)
      await unit?.close()
    }
    db.close()
  }
}

export function apply(ctx: Context, config: Config) {
  const backend = new SqliteStorageBackend(config)
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('sqlite', backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'storage-sqlite.registerBackend')
  ctx.provide(storageBackendServiceKey('sqlite'), backend)
}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/storage-sqlite'
  export const name = 'storage-sqlite-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
