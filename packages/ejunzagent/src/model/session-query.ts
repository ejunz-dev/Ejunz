import type { DatabaseSync } from 'node:sqlite'

import { mkdir, open } from 'node:fs/promises'

import { dirname, resolve } from 'node:path'

export const SESSION_QUERY_SQLITE_SCHEMA_VERSION = 8

export const SESSION_QUERY_SQLITE_APPLICATION_ID = 0x44534851

export type JournalMode = 'wal' | 'delete' | 'truncate' | 'persist'

const DERIVED_USER_TABLES = new Set([
  'search_state',
  'persisted_sessions',
  'persisted_docs',
  'persisted_docs_data',
  'persisted_docs_idx',
  'persisted_docs_content',
  'persisted_docs_docsize',
  'persisted_docs_config',
])

async function createDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

export async function openSearchDatabase(path: string, journalMode: JournalMode): Promise<DatabaseSync> {
  const actual = path === ':memory:' ? path : resolve(path)
  if (actual !== ':memory:') {
    await mkdir(dirname(actual), { recursive: true, mode: 0o700 })
    await createDatabaseFile(actual)
  }
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(actual)
  try {
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const userTables = listUserTables(db)
    if (applicationId !== 0 && applicationId !== SESSION_QUERY_SQLITE_APPLICATION_ID) {
      throw new Error(`session-search database at "${actual}" belongs to another application`)
    }
    if (applicationId === 0 && userTables.length > 0) {
      throw new Error(`session-search database at "${actual}" is not an empty or recognized derived index`)
    }
    if (applicationId === SESSION_QUERY_SQLITE_APPLICATION_ID) {
      assertDerivedUserTables(actual, userTables)
      if (version !== SESSION_QUERY_SQLITE_SCHEMA_VERSION) resetDerivedSchema(db, userTables)
    }
    // Apply mutating pragmas only after refusing foreign or canonical files.
    // journalMode is a validated closed union, not caller-controlled SQL.
    db.exec(`PRAGMA journal_mode = ${journalMode.toUpperCase()}`)
    ensurePersistentSchema(db)
    ensureTemporarySchema(db)
    return db
  } catch (error: unknown) {
    db.close()
    throw error
  }
}

function listUserTables(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
  ).all() as Array<{ name: string }>
  return rows.map(row => row.name)
}

function assertDerivedUserTables(path: string, userTables: readonly string[]): void {
  const unknownTables = userTables.filter(name => !DERIVED_USER_TABLES.has(name))
  if (unknownTables.length > 0) {
    throw new Error(
      `session-search database at "${path}" has unrecognized user tables: ${unknownTables.join(', ')}`,
    )
  }
}

function resetDerivedSchema(db: DatabaseSync, userTables: readonly string[]): void {
  for (const name of userTables) {
    db.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(name)}`)
  }
  db.exec('PRAGMA user_version = 0')
}

function ensurePersistentSchema(db: DatabaseSync): void {
  db.exec(`PRAGMA application_id = ${SESSION_QUERY_SQLITE_APPLICATION_ID}`)
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_state (
      singleton         INTEGER PRIMARY KEY CHECK (singleton = 1),
      global_generation INTEGER NOT NULL
    ) STRICT
  `)
  db.exec('INSERT OR IGNORE INTO search_state (singleton, global_generation) VALUES (1, 0)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS persisted_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      revision       TEXT NOT NULL,
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS persisted_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
  db.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_SCHEMA_VERSION}`)
}

function ensureTemporarySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS live_sessions (
      id             TEXT PRIMARY KEY,
      version        INTEGER NOT NULL,
      created_at     INTEGER NOT NULL,
      cwd            TEXT,
      parent_session TEXT,
      seed_length    INTEGER,
      delegation_depth INTEGER,
      agent_preset  TEXT,
      fingerprint    TEXT NOT NULL,
      persisted      INTEGER NOT NULL CHECK (persisted IN (0, 1)),
      generation     INTEGER NOT NULL
    ) STRICT
  `)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.live_docs USING fts5(
      text,
      session_id UNINDEXED,
      seq UNINDEXED,
      type UNINDEXED,
      time UNINDEXED,
      surface UNINDEXED,
      codepoint_length UNINDEXED,
      tokenize = 'unicode61'
    )
  `)
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

import {
  SessionQueryError,
  materializeSessionEventResultFilters,
  materializeSessionResultFilters,
} from '@ejunz/ea-core/session-query'

import type {
  SessionAvailability,
  SessionEventMetadataFilter,
  SessionEventResultFilter,
  SessionEventSearchRequest,
  SessionResultFilter,
  SessionSearchCursor,
  SessionSearchRequest,
} from '@ejunz/ea-core/session-query'

export const FTS_HIGHLIGHT_START = '\uFDD0'

export const FTS_HIGHLIGHT_END = '\uFDD1'

export const SQLITE_MAX_PAGE_LIMIT = Number.MAX_SAFE_INTEGER - 1

export const SQLITE_PORTABLE_VARIABLE_LIMIT = 32_766

export const SQLITE_FTS5_OUTER_PREDICATE_LIMIT = 14

export function assertPortableBindingCount(count: number): void {
  if (count > SQLITE_PORTABLE_VARIABLE_LIMIT) {
    throw new SessionQueryError(
      `session-search request exceeds SQLite's portable ${SQLITE_PORTABLE_VARIABLE_LIMIT}-variable limit; reduce filter values`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

export function assertFts5OuterPredicateCount(count: number): void {
  if (count > SQLITE_FTS5_OUTER_PREDICATE_LIMIT) {
    throw new SessionQueryError(
      `session-search request exceeds the supported SQLite FTS5 outer-predicate budget of ${SQLITE_FTS5_OUTER_PREDICATE_LIMIT}; reduce filters`,
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
}

export interface QueryLimits {
  /** Page size used when the request omits one. */
  defaultLimit: number
  /** Largest accepted page size. */
  maxLimit: number
}

export interface NormalizedSessionRequest {
  query: string
  sessionFilters: readonly SessionResultFilter[]
  eventFilters: readonly SessionEventMetadataFilter[]
  limit: number
  cursor?: SessionSearchCursor
}

export interface NormalizedEventRequest {
  sessionId: SessionEventSearchRequest['sessionId']
  query: string
  filters: readonly SessionEventMetadataFilter[]
  limit: number
  cursor?: SessionSearchCursor
}

export interface SqlWhere {
  /** SQL without the leading `WHERE`. */
  sql: string
  /** Bindings in placeholder order. */
  params: Array<string | number>
  /** Number of compiled predicates in `sql`. */
  predicateCount: number
}

export function normalizeSessionRequest(
  request: SessionSearchRequest,
  limits: QueryLimits,
): NormalizedSessionRequest {
  const sessionFilters = materializeSessionResultFilters(request.sessionFilters ?? [])
  const eventFilters = materializeMetadataFilters(request.eventFilters ?? [])
  const cursor = materializeCursor(request.cursor)
  return {
    query: normalizeQuery(request.query),
    sessionFilters,
    eventFilters,
    limit: normalizeLimit(request.limit, limits),
    ...cursor === undefined ? {} : { cursor },
  }
}

export function normalizeEventRequest(
  request: SessionEventSearchRequest,
  limits: QueryLimits,
): NormalizedEventRequest {
  if (typeof request.sessionId !== 'string') {
    throw new SessionQueryError('session-search session id must be text', 'SESSION_QUERY_INVALID_FILTER')
  }
  const filters = materializeMetadataFilters(request.filters ?? [])
  const cursor = materializeCursor(request.cursor)
  return {
    sessionId: request.sessionId,
    query: normalizeQuery(request.query),
    filters,
    limit: normalizeLimit(request.limit, limits),
    ...cursor === undefined ? {} : { cursor },
  }
}

export function buildSessionWhere(filters: readonly SessionResultFilter[]): SqlWhere {
  const clauses: string[] = []
  const params: Array<string | number> = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'id':
        addList(clauses, params, 'session_id', filter.values)
        break
      case 'cwd':
        addNullableList(clauses, params, 'cwd', filter.values)
        break
      case 'created-at':
        addRange(clauses, params, 'created_at', filter)
        break
      case 'parent':
        addNullableList(clauses, params, 'parent_session', filter.values)
        break
      case 'availability': {
        const availability = [...new Set(filter.values)]
        if (availability.length === 0) clauses.push('0')
        else if (availability.length === 1) {
          const value = availability[0] as SessionAvailability
          switch (value) {
            case 'live':
              clauses.push('live = 1')
              break
            case 'persisted':
              clauses.push('persisted = 1')
              break
            default:
              unknownAvailability(value)
          }
        }
        break
      }
      default:
        unknownFilter(filter)
    }
  }
  assertFts5OuterPredicateCount(clauses.length)
  return { sql: clauses.join(' AND '), params, predicateCount: clauses.length }
}

export function buildEventWhere(filters: readonly SessionEventMetadataFilter[]): SqlWhere {
  const clauses: string[] = []
  const params: Array<string | number> = []
  for (const filter of filters) {
    switch (filter.kind) {
      case 'seq':
        addRange(clauses, params, 'seq', filter)
        break
      case 'time':
        addRange(clauses, params, 'time', filter)
        break
      case 'type':
        addList(clauses, params, 'type', filter.values)
        break
      case 'surface':
        addList(clauses, params, 'surface', filter.values)
        break
      default:
        unknownFilter(filter)
    }
  }
  assertFts5OuterPredicateCount(clauses.length)
  return { sql: clauses.join(' AND '), params, predicateCount: clauses.length }
}

export function quoteFtsData(query: string): string {
  return `"${query.replaceAll('"', '""')}"`
}

export function sanitizeFtsText(text: string): string {
  return text
    .replaceAll('\0', '\uFFFD')
    .replaceAll(FTS_HIGHLIGHT_START, '\uFFFD')
    .replaceAll(FTS_HIGHLIGHT_END, '\uFFFD')
}

export function requestFingerprint(request: NormalizedSessionRequest | NormalizedEventRequest): string {
  if ('sessionId' in request) {
    return JSON.stringify({
      scope: 'events',
      sessionId: request.sessionId,
      query: request.query,
      filters: canonicalFilters(request.filters),
      limit: request.limit,
    })
  }
  return JSON.stringify({
    scope: 'sessions',
    query: request.query,
    sessionFilters: canonicalFilters(request.sessionFilters),
    eventFilters: canonicalFilters(request.eventFilters),
    limit: request.limit,
  })
}

export function makeSnippet(markedText: string, maxChars: number): string {
  const { text: clean, matchStart } = normalizeMarkedText(markedText)
  const characters = Array.from(clean)
  if (characters.length <= maxChars) return clean
  if (maxChars === 1) return '…'
  const matchedIndex = Math.min(matchStart, characters.length - 1)
  let start = Math.max(0, matchedIndex - Math.floor(maxChars / 3))
  const prefix = start > 0 ? '…' : ''
  let suffix = '…'
  let contentLength = maxChars - prefix.length - suffix.length
  if (contentLength < 1) {
    start = matchedIndex
    suffix = ''
    contentLength = maxChars - prefix.length - suffix.length
  } else if (matchedIndex >= start + contentLength) {
    start = matchedIndex - contentLength + 1
  }
  let end = Math.min(characters.length, start + contentLength)
  if (end === characters.length) {
    suffix = ''
    contentLength = maxChars - prefix.length
    start = Math.max(0, end - contentLength)
  }
  end = Math.min(characters.length, start + contentLength)
  return `${prefix}${characters.slice(start, end).join('')}${suffix}`
}

function normalizeMarkedText(markedText: string): { text: string; matchStart: number } {
  const characters: string[] = []
  let matchStart: number | undefined
  for (const character of markedText) {
    if (character === FTS_HIGHLIGHT_START) {
      matchStart ??= characters.length
      continue
    }
    if (character === FTS_HIGHLIGHT_END) continue
    if (/\s/u.test(character)) {
      if (characters.length > 0 && characters.at(-1) !== ' ') characters.push(' ')
    } else {
      characters.push(character)
    }
  }
  if (characters.at(-1) === ' ') characters.pop()
  return {
    text: characters.join(''),
    matchStart: matchStart ?? 0,
  }
}

function normalizeQuery(value: string): string {
  if (typeof value !== 'string') {
    throw new SessionQueryError('session-search query must be text', 'SESSION_QUERY_INVALID_QUERY')
  }
  const query = value.trim().replace(/\s+/gu, ' ')
  if (query.length === 0) {
    throw new SessionQueryError(
      'session-search query must contain non-whitespace text',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  if (query.includes('\0')) {
    throw new SessionQueryError(
      'session-search query must not contain NUL',
      'SESSION_QUERY_INVALID_QUERY',
    )
  }
  return sanitizeFtsText(query)
}

function materializeCursor(cursor: SessionSearchCursor | undefined): SessionSearchCursor | undefined {
  if (cursor === undefined) return undefined
  if (typeof cursor !== 'string') {
    throw new SessionQueryError('session-search cursor must be text', 'SESSION_QUERY_INVALID_CURSOR')
  }
  return cursor
}

function materializeMetadataFilters(
  filters: readonly SessionEventMetadataFilter[],
): SessionEventMetadataFilter[] {
  const candidates: readonly SessionEventResultFilter[] = filters
  for (const filter of candidates) {
    switch (filter.kind) {
      case 'seq':
      case 'time':
      case 'type':
      case 'surface':
        break
      case 'text':
        throw new SessionQueryError(
          'session-search metadata filters do not accept text clauses',
          'SESSION_QUERY_INVALID_FILTER',
        )
      default:
        unknownFilter(filter)
    }
  }
  return materializeSessionEventResultFilters(filters) as SessionEventMetadataFilter[]
}

function normalizeLimit(value: number | undefined, limits: QueryLimits): number {
  const limit = value ?? limits.defaultLimit
  const maxLimit = Math.min(limits.maxLimit, SQLITE_MAX_PAGE_LIMIT)
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || limit > maxLimit
  ) {
    throw new SessionQueryError(
      `session-search limit must be an integer between 1 and ${maxLimit}`,
      'SESSION_QUERY_INVALID_LIMIT',
    )
  }
  return limit
}

function addList(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly (string | number)[],
): void {
  if (values.length === 0) {
    clauses.push('0')
    return
  }
  clauses.push(`${column} IN (${appendListBindings(params, values)})`)
}

function addNullableList(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  values: readonly (string | null)[],
): void {
  if (values.length === 0) {
    clauses.push('0')
    return
  }
  const concrete = values.filter((value): value is string => value !== null)
  const parts: string[] = []
  if (concrete.length > 0) {
    parts.push(`${column} IN (${appendListBindings(params, concrete)})`)
  }
  if (values.includes(null)) parts.push(`${column} IS NULL`)
  clauses.push(`(${parts.join(' OR ')})`)
}

function addRange(
  clauses: string[],
  params: Array<string | number>,
  column: string,
  range: { from?: number; to?: number },
): void {
  if (range.from !== undefined) {
    assertPortableBindingCount(params.length + 1)
    clauses.push(`CAST(${column} AS INTEGER) >= ?`)
    params.push(range.from)
  }
  if (range.to !== undefined) {
    assertPortableBindingCount(params.length + 1)
    clauses.push(`CAST(${column} AS INTEGER) <= ?`)
    params.push(range.to)
  }
}

function appendListBindings(
  params: Array<string | number>,
  values: readonly (string | number)[],
): string {
  assertPortableBindingCount(params.length + values.length)
  for (const value of values) params.push(value)
  return values.map(() => '?').join(', ')
}

function canonicalFilters(filters: readonly (SessionResultFilter | SessionEventMetadataFilter)[]): unknown[] {
  return filters.map((filter) => {
    if ('values' in filter) {
      return { ...filter, values: [...filter.values].sort(compareNullable) }
    }
    return {
      kind: filter.kind,
      from: filter.from ?? null,
      to: filter.to ?? null,
    }
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return -1
  if (b === null) return 1
  return a.localeCompare(b)
}

function unknownAvailability(value: never): never {
  throw new SessionQueryError(
    `session availability filter contains unknown value "${String(value)}"`,
    'SESSION_QUERY_INVALID_FILTER',
  )
}

function unknownFilter(filter: never): never {
  const kind = (filter as { kind?: unknown }).kind
  throw new SessionQueryError(
    `session filter contains unknown kind ${typeof kind === 'string' ? `"${kind}"` : '(missing)'}`,
    'SESSION_QUERY_INVALID_FILTER',
  )
}

import { createHash, randomUUID } from 'node:crypto'

import type { DatabaseSync } from 'node:sqlite'

import { Context, Service, type Fiber } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import type { Session, SessionEvent, SessionHeader, SessionId } from '@ejunz/ea-core/session'

import type SessionPersistence from '@ejunz/ea-core/session-persistence'

import type {
  SessionPersistenceRevision,
  SessionPersistenceSnapshot,
} from '@ejunz/ea-core/session-persistence'

import SessionQueryEngine, {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SESSION_QUERY_READ_WINDOW_MAX,
  SessionQueryError,
  SessionSearchCursor,
  assertSessionHeadersCompatible,
  buildSessionEventSearchDocuments,
} from '@ejunz/ea-core/session-query'

import type {
  Config as SessionQueryConfig,
  SessionEventSearchDocument,
  SessionEventSearchHit,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionSearchExecContext,
  SessionSearchHit,
  SessionSearchCursor as SessionSearchCursorValue,
  SessionSearchPage,
  SessionSearchRequest,
} from '@ejunz/ea-core/session-query'

export const SESSION_QUERY_SQLITE_PATH_KEY = 'launcherSessionQueryPath'

declare module '@ejunz/cordis' {
  interface Context {
    /** Launcher-owned absolute path to this process's disposable derived query index. */
    launcherSessionQueryPath?: string
  }
}

export const SESSION_QUERY_SQLITE_DEFAULT_LIMIT = 20

export const SESSION_QUERY_SQLITE_MAX_LIMIT = 100

export const SESSION_QUERY_SQLITE_SNIPPET_CHARS = 240

const STABLE_OBSERVATION_ATTEMPTS = 2

export type OpenAt = 'startup' | 'first-search' | 'never'

export interface Config extends SessionQueryConfig {
  /**
   * Dedicated derived-index path; `:memory:` is supported for ephemeral
   * indexes. Missing directories and database files are created owner-only on
   * POSIX filesystems; existing modes are preserved.
   */
  path: string
  /**
   * Open the SQLite module and handle at service activation or the first
   * search, or `never` to disable full-text search: the inherited exact
   * reads, filters, and traces stay available, while `searchSessions` and
   * `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` and SQLite is
   * never imported or opened. Defaults to `startup`.
   */
  openAt?: OpenAt
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Page size when a request omits `limit`. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 20. */
  defaultLimit?: number
  /** Largest accepted page size. At most `Number.MAX_SAFE_INTEGER - 1`; defaults to 100. */
  maxLimit?: number
  /** Maximum snippet length in Unicode code points. Defaults to 240. */
  snippetChars?: number
  /** Maximum concurrent persisted-log inspections in one inherited batch read. Defaults to 4. */
  persistedInspectConcurrency?: number
}

interface ResolvedConfig {
  path: string
  openAt: OpenAt
  journalMode: JournalMode
  defaultLimit: number
  maxLimit: number
  snippetChars: number
  readWindowMax: number
  persistedInspectConcurrency: number
}

interface ObservedSession {
  header: SessionHeader
  documents: SessionEventSearchDocument[]
  fingerprint: string
}

interface ObservedPersistedSession {
  header: SessionHeader
  revision: SessionPersistenceRevision
  loaded?: ObservedSession
}

interface PersistenceBinding {
  readonly identity: symbol
  readonly service?: SessionPersistence
}

interface Observation {
  persistenceBinding: PersistenceBinding
  persisted: Map<SessionId, ObservedPersistedSession>
  live: Map<SessionId, ObservedSession>
}

interface IndexedPersistedRow {
  id: string
  revision: string
  generation: number
}

interface IndexedLiveRow {
  id: string
  fingerprint: string
  persisted: number
  generation: number
}

interface SessionHeaderRow {
  session_id: string
  version: number
  created_at: number
  cwd: string | null
  parent_session: string | null
  seed_length: number | null
  delegation_depth: number | null
  agent_preset: string | null
}

interface SearchRow extends SessionHeaderRow {
  live: number
  persisted: number
  seq: number
  type: string
  time: number
  surface: string
  marked_text: string
  match_count: number
  document_length: number
}

interface CursorPayload {
  version: 1
  instance: string
  scope: 'sessions' | 'events'
  fingerprint: string
  generation: string
  offset: number
}

export class SqliteSessionQueryEngine extends SessionQueryEngine {
  static override inject = ['sessions']

  static Config: z<Config> = z.object({
    path: z.string().required(),
    openAt: z.union(['startup', 'first-search', 'never'] as const).default('startup'),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    defaultLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_DEFAULT_LIMIT),
    maxLimit: z.number().step(1).min(1).max(SQLITE_MAX_PAGE_LIMIT).default(SESSION_QUERY_SQLITE_MAX_LIMIT),
    snippetChars: z.number().step(1).min(1).default(SESSION_QUERY_SQLITE_SNIPPET_CHARS),
    readWindowMax: z.number().step(1).min(0).default(SESSION_QUERY_READ_WINDOW_MAX),
    persistedInspectConcurrency: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY),
  })

  /** Validated and defaulted backend configuration. */
  readonly config: ResolvedConfig

  private readonly _instance = randomUUID()
  private _ready: Promise<void> | undefined
  private _db: DatabaseSync | undefined
  private _persistenceBinding: PersistenceBinding = { identity: Symbol() }
  private _lastPersistenceIdentity: symbol | undefined
  private _persistenceEpoch = 0
  private _globalGeneration = 0
  private _localGeneration = 0
  private _tail: Promise<void> = Promise.resolve()
  private _closed = false
  private _closePromise: Promise<void> | undefined
  private readonly _optionalPersistenceFiber: Fiber

  constructor(ctx: Context, config: Config) {
    // The assignment expression resolves before the base constructor can
    // register `ctx.sessionQuery`; keep that same validated value afterward.
    super(ctx, config = resolveConfig(config))
    this.config = config as ResolvedConfig
    this._optionalPersistenceFiber = ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      const binding = { identity: Symbol(), service }
      this._persistenceBinding = binding
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistenceBinding !== binding) return
        this._persistenceBinding = { identity: Symbol() }
      }, 'sessionQuerySqlite.persistenceBinding')
    })
    ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuerySqlite.optionalPersistence')
    ctx.effect(() => async () => this.close(), 'sessionQuerySqlite.close')
  }

  /** Open eagerly only when activation owns the configured readiness boundary. */
  protected async [Service.init](): Promise<void> {
    if (this.config.openAt === 'startup') await this._ensureReady(undefined)
  }

  override async searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    this._assertSearchEnabled()
    const normalized = normalizeSessionRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const generation = String(this._globalGeneration)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'sessions', fingerprint, generation)
      const rows = this._querySessions(normalized, offset, persistenceBinding)
      return page(rows, normalized.limit, row => this._sessionHit(row), cursorOffset => encodeCursor({
        version: 1,
        instance: this._instance,
        scope: 'sessions',
        fingerprint,
        generation,
        offset: cursorOffset,
      }), offset)
    })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    this._assertSearchEnabled()
    const normalized = normalizeEventRequest(request, this.config)
    const signal = exec?.signal
    return this._serialized(signal, async () => {
      await this._ensureReady(signal)
      const persistenceBinding = await this._reconcile(signal)
      assertNotAborted(signal)
      const target = this._targetObservation(normalized.sessionId, persistenceBinding)
      const fingerprint = requestFingerprint(normalized)
      const offset = normalized.cursor === undefined
        ? 0
        : decodeCursor(normalized.cursor, this._instance, 'events', fingerprint, target.generation)
      const rows = this._queryEvents(normalized, offset, persistenceBinding)
      return {
        session: target.header,
        ...page(rows, normalized.limit, row => this._eventHit(row), cursorOffset => encodeCursor({
          version: 1,
          instance: this._instance,
          scope: 'events',
          fingerprint,
          generation: target.generation,
          offset: cursorOffset,
        }), offset),
      }
    })
  }

  /** Close the database after every accepted operation reaches quiescence. */
  close(): Promise<void> {
    this._closePromise ??= this._close()
    return this._closePromise
  }

  /**
   * Refuse full-text calls under `openAt: 'never'` before any request
   * normalization or SQLite work, so a disabled deployment never imports
   * node:sqlite, opens the index, or observes sources.
   */
  private _assertSearchEnabled(): void {
    if (this.config.openAt !== 'never') return
    throw new SessionQueryError(
      'session search is disabled: this deployment configures the session-query index with openAt "never"',
      'SESSION_QUERY_SEARCH_DISABLED',
    )
  }

  private async _close(): Promise<void> {
    this._closed = true
    await this._tail
    if (this._ready !== undefined) {
      try {
        await this._ready
      } catch {
        // Opening already closed a partially-created handle; disposal only waits.
      }
    }
    this._db?.close()
    this._db = undefined
  }

  private async _open(): Promise<void> {
    this._db = await openSearchDatabase(this.config.path, this.config.journalMode)
    const state = this._db.prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    this._globalGeneration = state.global_generation
    this._localGeneration = state.global_generation
  }

  private async _ensureReady(signal: AbortSignal | undefined): Promise<void> {
    this._ready ??= this._open()
    try {
      await waitWithAbort(this._ready, signal)
    } catch (error: unknown) {
      if (isAbort(error)) throw error
      throw new SessionQueryError(
        `session-search SQLite index failed to open: ${errorMessage(error)}`,
        'SESSION_QUERY_INDEX_FAILED',
        { cause: error },
      )
    }
  }

  private async _serialized<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (this._isClosed()) throw indexClosed()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const prior = this._tail
    this._tail = prior.then(() => gate)
    try {
      await waitWithAbort(prior, signal)
    } catch (error: unknown) {
      release()
      throw error
    }
    if (this._isClosed()) {
      release()
      throw indexClosed()
    }
    try {
      assertNotAborted(signal)
      return await operation()
    } finally {
      release()
    }
  }

  private async _reconcile(signal: AbortSignal | undefined): Promise<PersistenceBinding> {
    assertNotAborted(signal)
    const db = this._requireDb()
    const persistedRows = db.prepare(
      'SELECT id, revision, generation FROM persisted_sessions',
    ).all() as unknown as IndexedPersistedRow[]
    const liveRows = db.prepare(
      'SELECT id, fingerprint, persisted, generation FROM temp.live_sessions',
    ).all() as unknown as IndexedLiveRow[]
    const persistedById = new Map(persistedRows.map(row => [row.id as SessionId, row]))
    const liveById = new Map(liveRows.map(row => [row.id as SessionId, row]))
    const observation = await this._observeStable(persistedById, signal)
    assertNotAborted(signal)
    const persistentChanges = observation.persistenceBinding.service === undefined
      ? []
      : [...observation.persisted.values()].filter(entry => entry.loaded !== undefined)
    const persistentDeletes = observation.persistenceBinding.service === undefined
      ? []
      : persistedRows.filter(row => !observation.persisted.has(row.id as SessionId))
    const liveChanges = [...observation.live.values()].filter((entry) => {
      const indexed = liveById.get(entry.header.id)
      const persisted = observation.persisted.has(entry.header.id) ? 1 : 0
      return indexed?.fingerprint !== entry.fingerprint || indexed.persisted !== persisted
    })
    const liveDeletes = liveRows.filter(row => !observation.live.has(row.id as SessionId))
    const pointerChanged = this._lastPersistenceIdentity !== undefined
      && this._lastPersistenceIdentity !== observation.persistenceBinding.identity
    const hasWrites = persistentChanges.length > 0
      || persistentDeletes.length > 0
      || liveChanges.length > 0
      || liveDeletes.length > 0

    let nextMainGeneration = this._mainGeneration()
    let nextLocalGeneration = this._localGeneration
    if (persistentChanges.length > 0 || persistentDeletes.length > 0) nextMainGeneration += 1
    const liveReplacements = liveChanges.map((entry) => {
      nextLocalGeneration = Math.max(nextLocalGeneration, nextMainGeneration) + 1
      return {
        entry,
        generation: nextLocalGeneration,
        persisted: observation.persisted.has(entry.header.id),
      }
    })

    if (hasWrites) {
      let began = false
      try {
        db.exec('BEGIN IMMEDIATE')
        began = true
        for (const row of persistentDeletes) this._deleteSession('persisted', row.id as SessionId)
        for (const entry of persistentChanges) {
          /* v8 ignore next -- observation loads every entry whose revision differs */
          if (entry.loaded === undefined) throw new Error(`missing loaded revision for session "${entry.header.id}"`)
          this._replacePersistedSession(entry.loaded, entry.revision, nextMainGeneration)
        }
        if (persistentChanges.length > 0 || persistentDeletes.length > 0) {
          db.prepare('UPDATE search_state SET global_generation = ? WHERE singleton = 1').run(nextMainGeneration)
        }
        for (const row of liveDeletes) this._deleteSession('live', row.id as SessionId)
        for (const { entry, generation, persisted } of liveReplacements) {
          this._replaceLiveSession(entry, generation, persisted)
        }
        db.exec('COMMIT')
      } catch (error: unknown) {
        /* v8 ignore next -- a BEGIN failure has no transaction to roll back; the common wrapper still reports it. */
        if (began) {
          /* v8 ignore next 5 -- ROLLBACK failure requires a SQLite double fault; the original failure remains actionable. */
          try {
            db.exec('ROLLBACK')
          } catch {
            // The original SQLite failure remains the actionable cause.
          }
        }
        throw new SessionQueryError(
          `session-search reconciliation failed: ${errorMessage(error)}`,
          'SESSION_QUERY_INDEX_FAILED',
          { cause: error },
        )
      }
    }

    if (hasWrites || pointerChanged) this._globalGeneration += 1
    if (pointerChanged) this._persistenceEpoch += 1
    this._localGeneration = nextLocalGeneration
    this._lastPersistenceIdentity = observation.persistenceBinding.identity
    return observation.persistenceBinding
  }

  private async _observeStable(
    indexed: ReadonlyMap<SessionId, IndexedPersistedRow>,
    signal: AbortSignal | undefined,
  ): Promise<Observation> {
    for (let attempt = 0; attempt < STABLE_OBSERVATION_ATTEMPTS; attempt += 1) {
      assertNotAborted(signal)
      const persistenceBinding = this._persistenceBinding
      const persistence = persistenceBinding.service
      const initiallyLive = new Set(this.ctx.sessions.list().map(session => session.id))
      let persisted = new Map<SessionId, ObservedPersistedSession>()
      if (persistence !== undefined) {
        try {
          const canReuseIndexed = this._lastPersistenceIdentity === undefined
            || this._lastPersistenceIdentity === persistenceBinding.identity
          const before = await persistence.listSnapshots(signal)
          assertNotAborted(signal)
          persisted = materializePersistenceSnapshots(before)
          for (const entry of persisted.values()) {
            if (canReuseIndexed && indexed.get(entry.header.id)?.revision === entry.revision) continue
            // Skip work already shadowed by a live owner. `inspect()` is
            // non-mutating, so an owner attaching after this check cannot cause
            // crash-repair side effects; the live-membership retry below makes
            // the returned observation live-preferred.
            if (initiallyLive.has(entry.header.id) || this.ctx.sessions.get(entry.header.id) !== undefined) continue
            assertNotAborted(signal)
            const loaded = await persistence.inspect(entry.header.id, signal)
            assertNotAborted(signal)
            assertSessionHeadersCompatible(entry.header, loaded.meta)
            entry.loaded = observeSession(loaded.meta, loaded.events)
          }
          assertNotAborted(signal)
          const afterSnapshots = await persistence.listSnapshots(signal)
          assertNotAborted(signal)
          const after = materializePersistenceSnapshots(afterSnapshots)
          if (!samePersistenceSnapshots(persisted, after)) continue
          if (this._persistenceBinding !== persistenceBinding) continue
        } catch (error: unknown) {
          if (isAbort(error) || signal?.aborted) {
            throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED', {
              cause: error,
            })
          }
          if (this._persistenceBinding !== persistenceBinding) continue
          if (error instanceof SessionQueryError) throw error
          throw new SessionQueryError(
            `session-search persistence observation failed: ${errorMessage(error)}`,
            'SESSION_QUERY_PERSISTENCE_FAILED',
            { cause: error },
          )
        }
      }
      const live = new Map<SessionId, ObservedSession>()
      for (const session of this.ctx.sessions.list()) {
        const observed = observeLive(session)
        const durable = persisted.get(session.id)
        if (durable !== undefined) assertSessionHeadersCompatible(observed.header, durable.header)
        live.set(session.id, observed)
      }
      if (!sameSessionIds(initiallyLive, live)) continue
      return { persistenceBinding, persisted, live }
    }
    throw new SessionQueryError(
      'session-search persistence observation did not stabilize after one retry',
      'SESSION_QUERY_PERSISTENCE_FAILED',
    )
  }

  private _mainGeneration(): number {
    const row = this._requireDb().prepare(
      'SELECT global_generation FROM search_state WHERE singleton = 1',
    ).get() as { global_generation: number }
    return row.global_generation
  }

  private _deleteSession(source: 'persisted' | 'live', id: SessionId): void {
    const db = this._requireDb()
    if (source === 'persisted') {
      db.prepare('DELETE FROM persisted_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM persisted_sessions WHERE id = ?').run(id)
    } else {
      db.prepare('DELETE FROM temp.live_docs WHERE session_id = ?').run(id)
      db.prepare('DELETE FROM temp.live_sessions WHERE id = ?').run(id)
    }
  }

  private _replacePersistedSession(
    entry: ObservedSession,
    revision: SessionPersistenceRevision,
    generation: number,
  ): void {
    this._deleteSession('persisted', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO persisted_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, revision, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header),
      revision,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO persisted_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _replaceLiveSession(entry: ObservedSession, generation: number, persisted: boolean): void {
    this._deleteSession('live', entry.header.id)
    const db = this._requireDb()
    db.prepare(`
      INSERT INTO temp.live_sessions
        (id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, fingerprint, persisted, generation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ...headerBindings(entry.header),
      entry.fingerprint,
      persisted ? 1 : 0,
      generation,
    )
    const insert = db.prepare(`
      INSERT INTO temp.live_docs (text, session_id, seq, type, time, surface, codepoint_length)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const document of entry.documents) {
      const text = sanitizeFtsText(document.text)
      insert.run(
        text,
        document.sessionId,
        document.seq,
        document.type,
        document.time,
        document.surface,
        Array.from(text).length,
      )
    }
  }

  private _querySessions(
    request: NormalizedSessionRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const sessionWhere = buildSessionWhere(request.sessionFilters)
    const eventWhere = buildEventWhere(request.eventFilters)
    assertFts5OuterPredicateCount(sessionWhere.predicateCount + eventWhere.predicateCount)
    const where = [sessionWhere.sql, eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      ...sessionWhere.params,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    // The browser fixture mirrors these rank keys in
    // `packages/profile-web/src/client/connection/src/client/fixture.ts`; update both together.
    return this._requireDb().prepare(`
      ${selected.sql},
      filtered AS (
        SELECT * FROM matched ${where.length === 0 ? '' : `WHERE ${where}`}
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
        ) AS event_rank
        FROM filtered
      )
      SELECT * FROM ranked
      WHERE event_rank = 1
      ORDER BY match_count DESC, document_length ASC, time DESC, session_id ASC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _queryEvents(
    request: NormalizedEventRequest,
    offset: number,
    persistenceBinding: PersistenceBinding,
  ): SearchRow[] {
    const selected = selectedDocumentsSql()
    const eventWhere = buildEventWhere(request.filters)
    assertFts5OuterPredicateCount(1 + eventWhere.predicateCount)
    const where = ['session_id = ?', eventWhere.sql].filter(Boolean).join(' AND ')
    const bindings = [
      ...selectedDocumentsParams(request.query, persistenceBinding.service !== undefined),
      request.sessionId,
      ...eventWhere.params,
      request.limit + 1,
      offset,
    ]
    assertPortableBindingCount(bindings.length)
    return this._requireDb().prepare(`
      ${selected.sql}
      SELECT * FROM matched
      WHERE ${where}
      ORDER BY match_count DESC, document_length ASC, time DESC, seq DESC
      LIMIT ? OFFSET ?
    `).all(...bindings) as unknown as SearchRow[]
  }

  private _targetObservation(
    sessionId: SessionId,
    persistenceBinding: PersistenceBinding,
  ): { header: SessionHeader; generation: string } {
    const db = this._requireDb()
    const live = db.prepare(
      `SELECT
        id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
      FROM temp.live_sessions
      WHERE id = ?`,
    ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
    if (live !== undefined) {
      return { header: rowHeader(live), generation: `live:${live.generation}` }
    }
    if (persistenceBinding.service !== undefined) {
      const persisted = db.prepare(
        `SELECT
          id AS session_id, version, created_at, cwd, parent_session, seed_length, delegation_depth, agent_preset, generation
        FROM persisted_sessions
        WHERE id = ?`,
      ).get(sessionId) as (SessionHeaderRow & { generation: number }) | undefined
      if (persisted !== undefined) {
        return {
          header: rowHeader(persisted),
          generation: `persisted:${this._persistenceEpoch}:${persisted.generation}`,
        }
      }
    }
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  private _sessionHit(row: SearchRow): SessionSearchHit {
    return {
      header: rowHeader(row),
      live: row.live === 1,
      persisted: row.persisted === 1,
      bestMatch: this._eventHit(row),
    }
  }

  private _eventHit(row: SearchRow): SessionEventSearchHit {
    return {
      sessionId: row.session_id as SessionId,
      seq: row.seq,
      type: row.type as SessionEventSearchHit['type'],
      time: row.time,
      surface: row.surface as SessionEventSearchHit['surface'],
      snippet: makeSnippet(row.marked_text, this.config.snippetChars),
    }
  }

  private _requireDb(): DatabaseSync {
    /* v8 ignore next -- callers await `_ready`; this guards lifecycle misuse */
    if (this._db === undefined) throw indexClosed()
    return this._db
  }

  private _isClosed(): boolean {
    return this._closed
  }
}

function headerBindings(header: SessionHeader): (string | number | null)[] {
  return [
    header.id,
    header.version,
    header.createdAt,
    header.cwd ?? null,
    header.parentSession ?? null,
    header.seedLength ?? null,
    header.delegationDepth ?? null,
    header.agentPreset ?? null,
  ]
}

function selectedDocumentsSql(): { sql: string } {
  return {
    sql: `WITH candidates AS (
      SELECT
        pd.session_id AS session_id,
        ps.version AS version,
        ps.created_at AS created_at,
        ps.cwd AS cwd,
        ps.parent_session AS parent_session,
        ps.seed_length AS seed_length,
        ps.delegation_depth AS delegation_depth,
        ps.agent_preset AS agent_preset,
        0 AS live,
        1 AS persisted,
        CAST(pd.seq AS INTEGER) AS seq,
        pd.type AS type,
        CAST(pd.time AS INTEGER) AS time,
        pd.surface AS surface,
        highlight(persisted_docs, 0, ?, ?) AS marked_text,
        CAST(pd.codepoint_length AS INTEGER) AS document_length
      FROM persisted_docs AS pd
      JOIN persisted_sessions AS ps ON ps.id = pd.session_id
      WHERE persisted_docs MATCH ?
        AND ? = 1
        AND NOT EXISTS (SELECT 1 FROM temp.live_sessions AS ls WHERE ls.id = pd.session_id)
      UNION ALL
      SELECT
        ld.session_id AS session_id,
        ls.version AS version,
        ls.created_at AS created_at,
        ls.cwd AS cwd,
        ls.parent_session AS parent_session,
        ls.seed_length AS seed_length,
        ls.delegation_depth AS delegation_depth,
        ls.agent_preset AS agent_preset,
        1 AS live,
        CASE WHEN ? = 1 THEN ls.persisted ELSE 0 END AS persisted,
        CAST(ld.seq AS INTEGER) AS seq,
        ld.type AS type,
        CAST(ld.time AS INTEGER) AS time,
        ld.surface AS surface,
        highlight(live_docs, 0, ?, ?) AS marked_text,
        CAST(ld.codepoint_length AS INTEGER) AS document_length
      FROM temp.live_docs AS ld
      JOIN temp.live_sessions AS ls ON ls.id = ld.session_id
      WHERE live_docs MATCH ?
    ), matched AS (
      SELECT *,
        (
          length(CAST(marked_text AS BLOB))
          - length(CAST(replace(marked_text, ?, '') AS BLOB))
        ) / ? AS match_count
      FROM candidates
    )`,
  }
}

function selectedDocumentsParams(query: string, persistenceVisible: boolean): Array<string | number> {
  const expression = quoteFtsData(query)
  const visible = persistenceVisible ? 1 : 0
  return [
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    visible,
    visible,
    FTS_HIGHLIGHT_START,
    FTS_HIGHLIGHT_END,
    expression,
    FTS_HIGHLIGHT_START,
    Buffer.byteLength(FTS_HIGHLIGHT_START, 'utf8'),
  ]
}

function observeLive(session: Session): ObservedSession {
  return observeSession(session.header, session.events)
}

function observeSession(header: SessionHeader, events: readonly SessionEvent[]): ObservedSession {
  const detachedHeader = structuredClone(header)
  const detachedEvents = events.map(event => structuredClone(event))
  return {
    header: detachedHeader,
    documents: buildSessionEventSearchDocuments(detachedHeader.id, detachedEvents),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ header: detachedHeader, events: detachedEvents }))
      .digest('base64url'),
  }
}

function materializePersistenceSnapshots(
  snapshots: readonly SessionPersistenceSnapshot[],
): Map<SessionId, ObservedPersistedSession> {
  if (!isRuntimeArray(snapshots)) throw new Error('persistence snapshots must be an array')
  const result = new Map<SessionId, ObservedPersistedSession>()
  for (const snapshot of snapshots) {
    if (typeof snapshot.revision !== 'string') {
      throw new Error('persistence snapshot revision must be a string')
    }
    const header = structuredClone(snapshot.header)
    if (result.has(header.id)) {
      throw new Error(`persistence listed duplicate session "${header.id}"`)
    }
    result.set(header.id, { header, revision: snapshot.revision })
  }
  return result
}

function samePersistenceSnapshots(
  before: ReadonlyMap<SessionId, ObservedPersistedSession>,
  after: ReadonlyMap<SessionId, ObservedPersistedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const [id, first] of before) {
    const second = after.get(id)
    if (
      second === undefined
      || first.revision !== second.revision
      || !sameHeader(first.header, second.header)
    ) return false
  }
  return true
}

function sameSessionIds(
  before: ReadonlySet<SessionId>,
  after: ReadonlyMap<SessionId, ObservedSession>,
): boolean {
  if (before.size !== after.size) return false
  for (const id of before) {
    if (!after.has(id)) return false
  }
  return true
}

function sameHeader(a: SessionHeader, b: SessionHeader): boolean {
  return a.version === b.version
    && a.id === b.id
    && a.createdAt === b.createdAt
    && a.cwd === b.cwd
    && a.parentSession === b.parentSession
    && a.seedLength === b.seedLength
    && (a.delegationDepth ?? 0) === (b.delegationDepth ?? 0)
    && a.agentPreset === b.agentPreset
}

function rowHeader(row: SessionHeaderRow): SessionHeader {
  return {
    version: row.version,
    id: row.session_id as SessionId,
    createdAt: row.created_at,
    ...row.cwd === null ? {} : { cwd: row.cwd },
    ...row.parent_session === null ? {} : { parentSession: row.parent_session as SessionId },
    ...row.seed_length === null ? {} : { seedLength: row.seed_length },
    ...row.delegation_depth === null ? {} : { delegationDepth: row.delegation_depth },
    ...row.agent_preset === null ? {} : { agentPreset: row.agent_preset },
  }
}

function page<Row, Item>(
  rows: readonly Row[],
  limit: number,
  convert: (row: Row) => Item,
  nextCursor: (offset: number) => SessionSearchCursorValue,
  offset: number,
): SessionSearchPage<Item> {
  const hasMore = rows.length > limit
  return {
    items: rows.slice(0, limit).map(convert),
    ...hasMore ? { nextCursor: nextCursor(offset + limit) } : {},
  }
}

function encodeCursor(payload: CursorPayload): SessionSearchCursorValue {
  return SessionSearchCursor(Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'))
}

function decodeCursor(
  cursor: SessionSearchCursorValue,
  instance: string,
  scope: CursorPayload['scope'],
  fingerprint: string,
  generation: string,
): number {
  let decoded: Partial<CursorPayload>
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
  } catch (error: unknown) {
    throw invalidCursor(error)
  }
  if (
    decoded.version !== 1
    || decoded.instance !== instance
    || decoded.scope !== scope
    || decoded.fingerprint !== fingerprint
    || !Number.isSafeInteger(decoded.offset)
    || decoded.offset === undefined
    || decoded.offset < 0
  ) {
    throw invalidCursor(new Error('cursor does not belong to this normalized request'))
  }
  if (decoded.generation !== generation) {
    throw new SessionQueryError(
      'session-search cursor is stale because its relevant corpus changed',
      'SESSION_QUERY_STALE_CURSOR',
    )
  }
  return decoded.offset
}

function invalidCursor(cause: unknown): SessionQueryError {
  return new SessionQueryError(
    'session-search cursor is invalid',
    'SESSION_QUERY_INVALID_CURSOR',
    { cause },
  )
}

function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    path: config.path,
    openAt: config.openAt ?? 'startup',
    journalMode: config.journalMode ?? 'wal',
    defaultLimit: config.defaultLimit ?? SESSION_QUERY_SQLITE_DEFAULT_LIMIT,
    maxLimit: config.maxLimit ?? SESSION_QUERY_SQLITE_MAX_LIMIT,
    snippetChars: config.snippetChars ?? SESSION_QUERY_SQLITE_SNIPPET_CHARS,
    readWindowMax: config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX,
    persistedInspectConcurrency: config.persistedInspectConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  }
  if (typeof resolved.path !== 'string' || resolved.path.trim().length === 0) {
    throw invalidConfig('path must not be blank')
  }
  const openPhases: readonly string[] = ['startup', 'first-search', 'never']
  if (!openPhases.includes(resolved.openAt)) throw invalidConfig('openAt is not supported')
  assertPageLimit('defaultLimit', resolved.defaultLimit)
  assertPageLimit('maxLimit', resolved.maxLimit)
  assertPositiveInteger('snippetChars', resolved.snippetChars)
  if (!Number.isInteger(resolved.readWindowMax) || resolved.readWindowMax < 0) {
    throw invalidConfig('readWindowMax must be a non-negative integer')
  }
  if (
    !Number.isSafeInteger(resolved.persistedInspectConcurrency)
    || resolved.persistedInspectConcurrency < 1
  ) {
    throw invalidConfig('persistedInspectConcurrency must be a positive safe integer')
  }
  if (resolved.defaultLimit > resolved.maxLimit) {
    throw invalidConfig('defaultLimit must be less than or equal to maxLimit')
  }
  const journalModes: readonly string[] = ['wal', 'delete', 'truncate', 'persist']
  if (!journalModes.includes(resolved.journalMode)) throw invalidConfig('journalMode is not supported')
  return resolved
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw invalidConfig(`${name} must be a positive integer`)
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_MAX_PAGE_LIMIT) {
    throw invalidConfig(`${name} must be an integer between 1 and ${SQLITE_MAX_PAGE_LIMIT}`)
  }
}

function invalidConfig(detail: string): SessionQueryError {
  return new SessionQueryError(
    `session-search SQLite config: ${detail}`,
    'SESSION_QUERY_INVALID_CONFIG',
  )
}

function indexClosed(): SessionQueryError {
  return new SessionQueryError('session-search SQLite index is closed', 'SESSION_QUERY_INDEX_FAILED')
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED')
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new SessionQueryError('session-search aborted', 'SESSION_QUERY_ABORTED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(asError(error))
      },
    )
  })
}

function isAbort(error: unknown): boolean {
  return error instanceof SessionQueryError && error.code === 'SESSION_QUERY_ABORTED'
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('session-search dependency rejected with a non-Error value', { cause: error })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

export default SqliteSessionQueryEngine

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/session-query'
  export const name = 'session-query-sqlite-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
