import { EjunzAgentError } from '@ejunz/ea/llm'

export const SESSION_QUERY_READ_WINDOW_MAX = 50

export const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4

export interface Config {
  /** Maximum accepted raw read context on either side. Defaults to 50. */
  readWindowMax?: number
  /** Maximum concurrent persisted-log inspections in one batch read. Defaults to 4. */
  persistedInspectConcurrency?: number
}

export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'

export class SessionQueryError extends EjunzAgentError {
  declare readonly code: SessionQueryErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: SessionQueryErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}

import type { Branded } from '@ejunz/ea/brand'

export type SessionSearchCursor = Branded<'SessionSearchCursor'>

export function SessionSearchCursor(value: string): SessionSearchCursor {
  return value as SessionSearchCursor
}

import type {
  SessionEvent,
  SessionEventType,
  SessionHeader,
  SessionId,
  SurfaceEvent,
} from '@ejunz/ea/session'

import type { SessionTitleSnapshot } from '@ejunz/ea/session-title'

export type SessionEventSurface = 'current' | 'shadowed' | 'log-only'

export interface SessionRecord {
  /** Cloned session header selected from the live-preferred corpus. */
  header: SessionHeader
  /** Whether the id currently exists in `ctx.sessions`. */
  live: boolean
  /** Whether the active persistence backend currently materializes the id. */
  persisted: boolean
}

export interface SessionSurfaceSnapshot {
  /** Cloned session header selected from the same corpus observation as `events`. */
  session: SessionHeader
  /** Highest raw-log seq included in the observation, or `null` for an empty log. */
  capturedThroughSeq: number | null
  /** Cloned current surface events in model-history order. */
  events: SurfaceEvent[]
}

export interface SessionLogSnapshot {
  /** Cloned session header selected from the same observation as `events`. */
  session: SessionHeader
  /** Cloned contiguous raw events after persistence repair and replay validation. */
  events: SessionEvent[]
}

export interface SessionEventRecord {
  /** Session that owns the event. */
  sessionId: SessionId
  /** Monotonic event seq within the session. */
  seq: number
  /** Discriminant of the session event. */
  type: SessionEventType
  /** Event timestamp in Unix epoch milliseconds. */
  time: number
  /** Event placement in the folded session surface. */
  surface: SessionEventSurface
}

export interface SessionLineageNode {
  /** Detached logical-corpus record for this descendant. */
  session: SessionRecord
  /** Direct children, each carrying its own recursive descendants. */
  descendants: SessionLineageNode[]
}

export type SessionLineageTrace = {
  /** Detached record for the session that was traced. */
  target: SessionRecord
  /** Known parents from the immediate parent outward. */
  ancestors: SessionRecord[]
  /** Complete known descendant trees rooted at the target's direct children. */
  descendants: SessionLineageNode[]
} & (
  | {
    /** The complete parent chain is present in the logical corpus. */
    complete: true
    /** Detached record at the top of the complete lineage. */
    root: SessionRecord
  }
  | {
    /** The parent chain leaves the visible logical corpus. */
    complete: false
    /** First parent id that is not present in the logical corpus. */
    unresolvedParentId: SessionId
  }
)

export interface SessionEventTraceRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: number
}

export interface SessionEventTrace {
  /** Lightweight target record. */
  target: SessionEventRecord
  /** Immediate positional replacement event, when the target was shadowed. */
  replacedBy?: number
  /** Positional replacers from the immediate replacement to the final replacement. */
  replacementChain: number[]
  /** Surface nodes directly removed when the target itself performed a replacement. */
  replacedEventSeqs: number[]
  /** Earlier events cited directly as sources, in their recorded order. */
  sourceEventSeqs: number[]
  /** Later events that directly cite the target as a source, in log order. */
  derivedEventSeqs: number[]
}

export interface SessionEventTraceObservation extends SessionEventTrace {
  /** Cloned header selected with the event log used for the trace. */
  session: SessionHeader
}

export interface SessionEventReadRequest {
  /** Session that owns the target event. */
  sessionId: SessionId
  /** Target event seq. */
  seq: number
  /** Number of preceding raw events to include. */
  before?: number
  /** Number of following raw events to include. */
  after?: number
}

export interface SessionEventWindow {
  /** Cloned header for the live-preferred source read. */
  session: SessionHeader
  /** Full cloned target event. */
  target: SessionEvent
  /** Full cloned events from `startSeq` through `endSeq`. */
  events: SessionEvent[]
  /** First seq included in `events`. */
  startSeq: number
  /** Last seq included in `events`. */
  endSeq: number
}

export interface SessionTitleObservation {
  /** Cloned header selected with the event log used for the title fold. */
  session: SessionHeader
  /** Latest title snapshot, absent when the observed log has no title. */
  title?: SessionTitleSnapshot
}

export type SessionTitleObservationResult =
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Successful atomic header/title observation. */
    status: 'fulfilled'
    /** Header and optional latest title from one logical source. */
    value: SessionTitleObservation
  }
  | {
    /** Requested session id. */
    sessionId: SessionId
    /** Operational failure isolated to this session. */
    status: 'rejected'
    /** Original failure from logical-source resolution or title folding. */
    reason: unknown
  }

export interface SessionResultRange {
  /** Inclusive lower bound. */
  from?: number
  /** Inclusive upper bound. */
  to?: number
}

export type SessionAvailability = 'live' | 'persisted'

export type SessionResultFilter =
  | { kind: 'id'; values: readonly SessionId[] }
  | { kind: 'cwd'; values: readonly (string | null)[] }
  | ({ kind: 'created-at' } & SessionResultRange)
  | { kind: 'parent'; values: readonly (SessionId | null)[] }
  | { kind: 'availability'; values: readonly SessionAvailability[] }

export type SessionEventResultFilter =
  | ({ kind: 'seq' } & SessionResultRange)
  | ({ kind: 'time' } & SessionResultRange)
  | { kind: 'type'; values: readonly SessionEventType[] }
  | { kind: 'surface'; values: readonly SessionEventSurface[] }
  | { kind: 'text'; text: string }

export type SessionEventMetadataFilter = Exclude<SessionEventResultFilter, { kind: 'text' }>

export interface SessionEventSearchDocument extends SessionEventRecord {
  /** First-party semantic text used by scan filters and full-text indexes. */
  text: string
}

export interface SessionSearchPage<T> {
  /** Results for this page in contract-defined order. */
  items: readonly T[]
  /** Opaque continuation cursor, absent on the final page. */
  nextCursor?: SessionSearchCursor
}

export interface SessionEventSearchPage extends SessionSearchPage<SessionEventSearchHit> {
  /** Cloned target header from the same indexed generation as `items`. */
  session: SessionHeader
}

export interface SessionSearchExecContext {
  /** Abort caller waiting and interrupt provider work where supported. */
  signal?: AbortSignal
}

export interface SessionSearchRequest {
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Logical-session predicates applied before event ranking. */
  sessionFilters?: readonly SessionResultFilter[]
  /** Event predicates applied before event ranking. */
  eventFilters?: readonly SessionEventMetadataFilter[]
  /** Maximum sessions in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}

export interface SessionEventSearchRequest {
  /** Session whose live-preferred logical log is searched. */
  sessionId: SessionId
  /** Full-text query interpreted as data, never executable FTS syntax. */
  query: string
  /** Event predicates applied before ranking. */
  filters?: readonly SessionEventMetadataFilter[]
  /** Maximum events in this page. */
  limit?: number
  /** Opaque cursor returned for the identical normalized request. */
  cursor?: SessionSearchCursor
}

export interface SessionEventSearchHit extends SessionEventRecord {
  /** Plain text excerpt selected around the match. */
  snippet: string
}

export interface SessionSearchHit extends SessionRecord {
  /** Strongest matching event for this session. */
  bestMatch: SessionEventSearchHit
}

import type { SessionHeader } from '@ejunz/ea/session'

export function assertSessionHeadersCompatible(a: SessionHeader, b: SessionHeader): void {
  if (
    a.version !== b.version
    || a.id !== b.id
    || a.createdAt !== b.createdAt
    || a.cwd !== b.cwd
    || a.parentSession !== b.parentSession
    || a.seedLength !== b.seedLength
    || (a.delegationDepth ?? 0) !== (b.delegationDepth ?? 0)
  ) {
    throw new SessionQueryError(
      `session source headers conflict for session "${a.id}"`,
      'SESSION_QUERY_SOURCE_CONFLICT',
    )
  }
}

import type { Context, Fiber } from '@ejunz/cordis'

import type { Session, SessionEvent, SessionHeader, SessionId } from '@ejunz/ea/session'

import SessionPersistence, { SessionPersistenceCorruptionError } from '@ejunz/ea/session-persistence'

export interface LogicalSession {
  /** Cloned source header. */
  header: SessionHeader
  /** Cloned raw event log. */
  events: SessionEvent[]
}

export interface LogicalSessionSource {
  /** Header selected with `events`; callers must clone retained output. */
  readonly header: SessionHeader
  /** Raw events selected with `header`; valid only for the projection call. */
  readonly events: readonly SessionEvent[]
}

export type LogicalProjectionResult<Value> =
  | { sessionId: SessionId; status: 'fulfilled'; value: Value }
  | { sessionId: SessionId; status: 'rejected'; reason: unknown }

export class SessionCorpus {
  private _persistence: SessionPersistence | undefined
  private readonly _optionalPersistenceFiber: Fiber

  constructor(
    private readonly _ctx: Context,
    private readonly _persistedInspectConcurrency: number,
  ) {
    this._optionalPersistenceFiber = _ctx.inject(['sessionPersistence'], (childCtx: Context) => {
      const service = childCtx.sessionPersistence
      this._persistence = service
      childCtx.effect(() => () => {
        /* v8 ignore next -- a stale optional-service disposer cannot clear a replacement */
        if (this._persistence === service) this._persistence = undefined
      }, 'sessionQuery.persistenceBinding')
    })
    _ctx.effect(() => {
      return () => this._optionalPersistenceFiber.dispose()
    }, 'sessionQuery.optionalPersistence')
  }

  /**
   * List the complete logical corpus with live precedence and cloned headers.
   * @param signal - optional cancellation for persistence listing.
   * @returns records in deterministic newest-first order.
   */
  async listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    signal?.throwIfAborted()
    const persistence = this._persistence
    const persisted = persistence === undefined ? [] : await listPersisted(persistence, signal)
    signal?.throwIfAborted()
    const records = new Map<SessionId, SessionRecord>()
    for (const header of persisted) {
      records.set(header.id, { header: structuredClone(header), live: false, persisted: true })
    }
    for (const session of this._ctx.sessions.list()) {
      const durable = records.get(session.id)
      if (durable !== undefined) assertSessionHeadersCompatible(session.header, durable.header)
      records.set(session.id, {
        header: structuredClone(session.header),
        live: true,
        persisted: durable !== undefined,
      })
    }
    return [...records.values()].sort(compareSessions)
  }

  /**
   * Load one logical source, preferring a detached live snapshot.
   *
   * A known live target never consults persistence, so an optional backend's
   * failure cannot make current in-memory history unreadable.
   * @param sessionId - session to resolve.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns detached live-preferred header and events.
   */
  async load(sessionId: SessionId, signal?: AbortSignal): Promise<LogicalSession> {
    signal?.throwIfAborted()
    const live = this._ctx.sessions.get(sessionId)
    if (live !== undefined) {
      const snapshot = snapshotLive(live)
      signal?.throwIfAborted()
      return snapshot
    }
    const persistence = this._persistence
    if (persistence === undefined) throw notFound(sessionId)
    const listed = (await listPersisted(persistence, signal)).find(header => header.id === sessionId)
    signal?.throwIfAborted()
    if (listed === undefined) throw notFound(sessionId)
    const loaded = await inspectPersisted(persistence, sessionId, signal)
    signal?.throwIfAborted()
    const attached = this._ctx.sessions.get(sessionId)
    if (attached !== undefined) {
      const snapshot = snapshotLive(attached)
      signal?.throwIfAborted()
      return snapshot
    }
    assertSessionHeadersCompatible(loaded.meta, listed)
    const snapshot = {
      header: structuredClone(loaded.meta),
      events: loaded.events.map(event => structuredClone(event)),
    }
    signal?.throwIfAborted()
    return snapshot
  }

  /**
   * Project unique logical sources immediately from one persistence listing.
   *
   * The synchronous projector runs before a persisted worker claims its next id.
   * Full logs are borrowed only for that call and never retained by the batch.
   * @param sessionIds - sessions to resolve in first-occurrence order.
   * @param project - synchronous fold that owns/clones every retained value.
   * @param signal - cancellation shared by listing and every persisted inspection.
   * @returns one fulfilled or rejected projected result per unique requested id.
   */
  async projectMany<Value>(
    sessionIds: readonly SessionId[],
    project: (source: LogicalSessionSource) => Value,
    signal?: AbortSignal,
  ): Promise<LogicalProjectionResult<Value>[]> {
    const ids = [...new Set(sessionIds)]
    signal?.throwIfAborted()
    const resolved = new Map<SessionId, LogicalProjectionResult<Value>>()
    const unresolved: SessionId[] = []
    for (const id of ids) {
      const session = this._ctx.sessions.get(id)
      if (session === undefined) {
        unresolved.push(id)
      } else {
        resolved.set(id, projectSource(id, sourceLive(session), project, signal))
      }
    }
    if (unresolved.length === 0) return orderedResults(ids, resolved)

    const persistence = this._persistence
    if (persistence === undefined) {
      for (const sessionId of unresolved) {
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: notFound(sessionId) })
      }
      return orderedResults(ids, resolved)
    }

    let persisted: SessionHeader[]
    try {
      persisted = await listPersisted(persistence, signal)
      signal?.throwIfAborted()
    } catch (error: unknown) {
      if (signal?.aborted) signal.throwIfAborted()
      for (const sessionId of unresolved) {
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: error })
      }
      return orderedResults(ids, resolved)
    }
    const persistedById = new Map(persisted.map(header => [header.id, header]))
    const resolvePersisted = async (sessionId: SessionId): Promise<void> => {
      const listed = persistedById.get(sessionId)
      if (listed === undefined) {
        const attached = this._ctx.sessions.get(sessionId)
        resolved.set(sessionId, attached === undefined
          ? { sessionId, status: 'rejected', reason: notFound(sessionId) }
          : projectSource(sessionId, sourceLive(attached), project, signal))
        return
      }
      try {
        signal?.throwIfAborted()
        const loaded = await inspectPersisted(persistence, sessionId, signal)
        signal?.throwIfAborted()
        const attached = this._ctx.sessions.get(sessionId)
        if (attached !== undefined) {
          resolved.set(sessionId, projectSource(sessionId, sourceLive(attached), project, signal))
          return
        }
        assertSessionHeadersCompatible(loaded.meta, listed)
        resolved.set(sessionId, projectSource(sessionId, {
          header: loaded.meta,
          events: loaded.events,
        }, project, signal))
      } catch (error: unknown) {
        if (signal?.aborted) signal.throwIfAborted()
        resolved.set(sessionId, { sessionId, status: 'rejected', reason: error })
      }
    }
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        signal?.throwIfAborted()
        const index = cursor
        if (index >= unresolved.length) return
        cursor += 1
        await resolvePersisted(unresolved[index] as SessionId)
      }
    }
    const workerCount = Math.min(this._persistedInspectConcurrency, unresolved.length)
    const settlements = await Promise.allSettled(
      Array.from({ length: workerCount }, () => worker()),
    )
    if (signal?.aborted) signal.throwIfAborted()
    /* v8 ignore start -- per-id failures settle inside resolvePersisted; workers reject only on abort above */
    for (const settlement of settlements) {
      if (settlement.status === 'rejected') {
        const reason: unknown = settlement.reason
        throw reason
      }
    }
    /* v8 ignore stop */
    signal?.throwIfAborted()
    return orderedResults(ids, resolved)
  }
}

function projectSource<Value>(
  sessionId: SessionId,
  source: LogicalSessionSource,
  project: (source: LogicalSessionSource) => Value,
  signal?: AbortSignal,
): LogicalProjectionResult<Value> {
  try {
    signal?.throwIfAborted()
    const value = project(source)
    signal?.throwIfAborted()
    return { sessionId, status: 'fulfilled', value }
  } catch (reason: unknown) {
    /* v8 ignore next -- the synchronous projector has no external cancellation yield */
    if (signal?.aborted) signal.throwIfAborted()
    return { sessionId, status: 'rejected', reason }
  }
}

function sourceLive(session: Session): LogicalSessionSource {
  return { header: session.header, events: session.events }
}

function orderedResults<Value>(
  ids: readonly SessionId[],
  resolved: ReadonlyMap<SessionId, LogicalProjectionResult<Value>>,
): LogicalProjectionResult<Value>[] {
  return ids.map(sessionId => resolved.get(sessionId) as LogicalProjectionResult<Value>)
}

async function listPersisted(
  persistence: SessionPersistence,
  signal?: AbortSignal,
): Promise<SessionHeader[]> {
  try {
    return await persistence.list(signal)
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted()
    throw new SessionQueryError(
      `session persistence listing failed: ${errorMessage(error)}`,
      'SESSION_QUERY_PERSISTENCE_FAILED',
      { cause: error },
    )
  }
}

async function inspectPersisted(
  persistence: SessionPersistence,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<SessionPersistence['inspect']>>> {
  try {
    return await persistence.inspect(sessionId, signal)
  } catch (error: unknown) {
    if (signal?.aborted) signal.throwIfAborted()
    if (error instanceof SessionPersistenceCorruptionError) {
      throw new SessionQueryError(
        `stored session "${sessionId}" is corrupt: ${errorMessage(error)}`,
        'SESSION_QUERY_CORRUPT_SESSION',
        { cause: error },
      )
    }
    throw new SessionQueryError(
      `failed to inspect session "${sessionId}": ${errorMessage(error)}`,
      'SESSION_QUERY_PERSISTENCE_FAILED',
      { cause: error },
    )
  }
}

function snapshotLive(session: Session): LogicalSession {
  return {
    header: structuredClone(session.header),
    events: session.events.map(event => structuredClone(event)),
  }
}

function compareSessions(a: SessionRecord, b: SessionRecord): number {
  return b.header.createdAt - a.header.createdAt || a.header.id.localeCompare(b.header.id)
}

function notFound(sessionId: SessionId): SessionQueryError {
  return new SessionQueryError(`session "${sessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error'
}

import type { SessionEvent } from '@ejunz/ea/session'

export function extractSessionEventText(event: SessionEvent): string {
  switch (event.type) {
    case 'user/message':
      return contentText(event.data.content)
    case 'assistant/message':
      return contentText(event.data.message.content)
    case 'tool/call':
      return joinText([event.data.name, event.data.arguments])
    case 'tool/result':
      return joinText([
        contentText(event.data.message.content),
        event.data.error?.name ?? '',
        event.data.error?.code ?? '',
      ])
    case 'todo/write':
      return joinText(event.data.todos.flatMap(todo => [todo.status, todo.content]))
    case 'turn/end':
      return turnEndText(event.data.reason)
    case 'turn/start':
    case 'step/start':
    case 'step/end':
    case 'assistant/chunk':
    case 'request/header':
      return ''
    // SessionEventMap is merge-extensible. Unknown events remain
    // non-searchable until a concrete first-party consumer defines semantics.
    default:
      return ''
  }
}

function turnEndText(reason: SessionEvent<'turn/end'>['data']['reason']): string {
  switch (reason.kind) {
    case 'error':
      return joinText(['error', reason.error.message])
    case 'aborted':
      return 'aborted'
    case 'max-tokens':
    case 'interrupted':
      return reason.kind
    case 'completed':
      return ''
    // TurnEndReasonMap is merge-extensible. Unknown outcomes stay out until
    // their owner defines which detail is semantic rather than structural.
    default:
      return ''
  }
}

type SessionContentBlock = SessionEvent<'user/message'>['data']['content'][number]

function contentText(content: readonly SessionContentBlock[]): string {
  return joinText(content.flatMap(blockText))
}

function blockText(block: SessionContentBlock): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'reasoning':
      return []
    case 'tool-call':
      return [block.name, block.arguments]
    case 'tool-result':
      return block.content.flatMap(blockText)
    // ContentBlockMap is merge-extensible. Unknown blocks do not become
    // searchable merely because their payload happens to contain strings.
    default:
      return []
  }
}

function joinText(parts: readonly string[]): string {
  return parts.map(part => part.trim()).filter(Boolean).join('\n')
}

import { foldSurface } from '@ejunz/ea/session'

import type { SessionEvent, SessionId } from '@ejunz/ea/session'

export function buildSessionEventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  const surfaceBySeq = classifySurface(events)
  return events.map(event => ({
    sessionId,
    seq: event.seq,
    type: event.type,
    time: event.time,
    surface: surfaceBySeq.get(event.seq) ?? 'log-only',
  }))
}

export function buildSessionEventSearchDocuments(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventSearchDocument[] {
  const surfaceBySeq = classifySurface(events)
  const documents: SessionEventSearchDocument[] = []
  for (const event of events) {
    const text = extractSessionEventText(event)
    if (text.length === 0) continue
    documents.push({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: surfaceBySeq.get(event.seq) ?? 'log-only',
      text,
    })
  }
  return documents
}

function classifySurface(events: readonly SessionEvent[]): Map<number, SessionEventSurface> {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface throws Error instances */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
  const result = new Map<number, SessionEventSurface>()
  for (const seq of folded.nodes) result.set(seq, 'current')
  for (const replacement of folded.replacements) {
    for (const seq of replacement.shadowedSeqs) result.set(seq, 'shadowed')
  }
  return result
}

export function filterSessionResults<T extends SessionRecord>(
  records: readonly T[],
  filters: readonly SessionResultFilter[] = [],
): T[] {
  const predicates = filters.map(sessionPredicate)
  return records.filter(record => predicates.every(predicate => predicate(record)))
}

export function filterSessionEventDocuments<T extends SessionEventSearchDocument>(
  documents: readonly T[],
  filters: readonly SessionEventResultFilter[] = [],
): T[] {
  const predicates = filters.map(eventPredicate)
  return documents.filter(document => predicates.every(predicate => predicate(document)))
}

export function materializeSessionResultFilters(
  filters: readonly SessionResultFilter[],
): SessionResultFilter[] {
  assertArray(filters)
  return filters.map((filter) => {
    switch (filter.kind) {
      case 'id':
        return { kind: filter.kind, values: copyStrings(filter.kind, filter.values) }
      case 'cwd':
        return { kind: filter.kind, values: copyNullableStrings(filter.kind, filter.values) }
      case 'created-at':
        return copyRange(filter.kind, filter)
      case 'parent':
        return { kind: filter.kind, values: copyNullableStrings(filter.kind, filter.values) }
      case 'availability': {
        const values = copyStrings(filter.kind, filter.values)
        assertAllowedValues(filter.kind, values, ['live', 'persisted'])
        return { kind: filter.kind, values }
      }
      default:
        return unknownFilter(filter)
    }
  })
}

export function materializeSessionEventResultFilters(
  filters: readonly SessionEventResultFilter[],
): SessionEventResultFilter[] {
  assertArray(filters)
  return filters.map((filter) => {
    switch (filter.kind) {
      case 'seq':
      case 'time':
        return copyRange(filter.kind, filter)
      case 'type':
        return { kind: filter.kind, values: copyStrings(filter.kind, filter.values) }
      case 'surface': {
        const values = copyStrings(filter.kind, filter.values)
        assertAllowedValues(filter.kind, values, ['current', 'shadowed', 'log-only'])
        return { kind: filter.kind, values }
      }
      case 'text':
        if (typeof filter.text !== 'string') throw invalidFilter('text filter text must be a string')
        return { kind: filter.kind, text: filter.text }
      default:
        return unknownFilter(filter)
    }
  })
}

export function compileSessionTextFilter(text: string): RegExp {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    throw new SessionQueryError(
      'session text filter must contain non-whitespace text',
      'SESSION_QUERY_INVALID_FILTER',
    )
  }
  const pattern = trimmed
    .split(/\s+/u)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('\\s+')
  return new RegExp(pattern, 'iu')
}

function sessionPredicate(filter: SessionResultFilter): (record: SessionRecord) => boolean {
  switch (filter.kind) {
    case 'id':
      return record => filter.values.includes(record.header.id)
    case 'cwd':
      return record => filter.values.includes(record.header.cwd ?? null)
    case 'created-at': {
      const range = validateRange(filter.kind, filter)
      return record => matchesRange(record.header.createdAt, range)
    }
    case 'parent':
      return record => filter.values.includes(record.header.parentSession ?? null)
    case 'availability':
      assertAllowedValues(filter.kind, filter.values, ['live', 'persisted'])
      return record => filter.values.some(value => value === 'live' ? record.live : record.persisted)
    default:
      return unknownFilter(filter)
  }
}

function eventPredicate(filter: SessionEventResultFilter): (document: SessionEventSearchDocument) => boolean {
  switch (filter.kind) {
    case 'seq': {
      const range = validateRange(filter.kind, filter)
      return document => matchesRange(document.seq, range)
    }
    case 'time': {
      const range = validateRange(filter.kind, filter)
      return document => matchesRange(document.time, range)
    }
    case 'type':
      return document => filter.values.includes(document.type)
    case 'surface':
      assertAllowedValues(filter.kind, filter.values, ['current', 'shadowed', 'log-only'])
      return document => filter.values.includes(document.surface)
    case 'text': {
      const pattern = compileSessionTextFilter(filter.text)
      return document => pattern.test(document.text)
    }
    default:
      return unknownFilter(filter)
  }
}

function copyStrings<T extends string>(name: string, values: readonly T[]): T[] {
  if (!isRuntimeArray(values) || values.some(value => typeof value !== 'string')) {
    throw invalidFilter(`${name} filter values must be an array of strings`)
  }
  return [...values]
}

function assertArray(value: unknown): void {
  if (!Array.isArray(value)) throw invalidFilter('filters must be an array')
}

function copyNullableStrings<T extends string>(name: string, values: readonly (T | null)[]): Array<T | null> {
  if (!isRuntimeArray(values) || values.some(value => value !== null && typeof value !== 'string')) {
    throw invalidFilter(`${name} filter values must be an array of strings or null`)
  }
  return [...values]
}

function copyRange<K extends 'created-at' | 'seq' | 'time'>(
  kind: K,
  range: SessionResultRange,
): { kind: K } & SessionResultRange {
  const copy = {
    kind,
    ...range.from === undefined ? {} : { from: range.from },
    ...range.to === undefined ? {} : { to: range.to },
  }
  validateRange(kind, copy)
  return copy
}

function unknownFilter(filter: never): never {
  const kind = (filter as { kind?: unknown }).kind
  throw invalidFilter(`unknown filter kind ${typeof kind === 'string' ? `"${kind}"` : '(missing)'}`)
}

function assertAllowedValues(
  name: string,
  values: readonly string[],
  allowed: readonly string[],
): void {
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw new SessionQueryError(
        `session ${name} filter contains unknown value "${value}"`,
        'SESSION_QUERY_INVALID_FILTER',
      )
    }
  }
}

function validateRange(name: string, range: SessionResultRange): SessionResultRange {
  if (range.from !== undefined && !Number.isFinite(range.from)) {
    throw invalidRange(name, 'from must be finite')
  }
  if (range.to !== undefined && !Number.isFinite(range.to)) {
    throw invalidRange(name, 'to must be finite')
  }
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw invalidRange(name, 'from must be less than or equal to to')
  }
  return range
}

function matchesRange(value: number, range: SessionResultRange): boolean {
  return (range.from === undefined || value >= range.from)
    && (range.to === undefined || value <= range.to)
}

function invalidRange(name: string, detail: string): SessionQueryError {
  return invalidFilter(`${name} filter ${detail}`)
}

function invalidFilter(detail: string): SessionQueryError {
  return new SessionQueryError(`session ${detail}`, 'SESSION_QUERY_INVALID_FILTER')
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

import { foldSurface, isSurfaceEvent, snapshotSessionEvent } from '@ejunz/ea/session'

import type { SessionEvent, SessionId, SurfaceEvent, SurfaceEventType } from '@ejunz/ea/session'

interface EventLogAnalysis {
  records: SessionEventRecord[]
  replacedBy: Map<number, number>
  replacedEventSeqs: Map<number, number[]>
  currentSeqs: number[]
}

export function eventRecords(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SessionEventRecord[] {
  return analyzeEventLog(sessionId, events).records
}

export function currentSurfaceEvents(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): SurfaceEvent[] {
  const analysis = analyzeEventLog(sessionId, events)
  return analysis.currentSeqs.map((seq) => {
    const event = events[seq]
    /* v8 ignore next 6 -- analyzeEventLog validated contiguous seqs and foldSurface returned only surface-event seqs. */
    if (event === undefined || event.seq !== seq || !isSurfaceEvent(event)) {
      throw new SessionQueryError(
        `invalid session surface: current node ${seq} is not a surface event`,
        'SESSION_QUERY_INVALID_SURFACE',
      )
    }
    return snapshotSessionEvent(event)
  })
}

export function traceEvent(
  sessionId: SessionId,
  events: readonly SessionEvent[],
  seq: number,
): SessionEventTrace {
  const target = events[seq]
  if (target === undefined || target.seq !== seq) {
    throw new SessionQueryError(
      `session "${sessionId}" has no event at seq ${seq}`,
      'SESSION_QUERY_EVENT_NOT_FOUND',
    )
  }

  const analysis = analyzeEventLog(sessionId, events)

  const replacementChain: number[] = []
  let replacement = analysis.replacedBy.get(seq)
  while (replacement !== undefined) {
    replacementChain.push(replacement)
    replacement = analysis.replacedBy.get(replacement)
  }

  const derivedEventSeqs: number[] = []
  for (const event of events) {
    if (event.seq <= seq) continue
    if (eventSources(event).includes(seq)) derivedEventSeqs.push(event.seq)
  }

  // The target check above proves the parallel record exists at this index.
  // oxlint-disable-next-line typescript/no-non-null-assertion
  const targetRecord = analysis.records[seq]!
  const replacedBy = analysis.replacedBy.get(seq)
  return {
    target: targetRecord,
    ...replacedBy === undefined ? {} : { replacedBy },
    replacementChain,
    replacedEventSeqs: analysis.replacedEventSeqs.get(seq) ?? [],
    sourceEventSeqs: [...eventSources(target)],
    derivedEventSeqs,
  }
}

export function traceSession(
  records: readonly SessionRecord[],
  sessionId: SessionId,
): SessionLineageTrace {
  const byId = new Map(records.map(record => [record.header.id, record]))
  const target = byId.get(sessionId)
  if (target === undefined) {
    throw new SessionQueryError(
      `session "${sessionId}" not found`,
      'SESSION_QUERY_SESSION_NOT_FOUND',
    )
  }

  const ancestors: SessionRecord[] = []
  const ancestrySeen = new Set<SessionId>([sessionId])
  let unresolvedParentId: SessionId | undefined
  let parentId = target.header.parentSession
  while (parentId !== undefined) {
    if (ancestrySeen.has(parentId)) {
      throw new SessionQueryError(
        `session lineage contains a cycle at "${parentId}"`,
        'SESSION_QUERY_INVALID_LINEAGE',
      )
    }
    ancestrySeen.add(parentId)
    const parent = byId.get(parentId)
    if (parent === undefined) {
      unresolvedParentId = parentId
      break
    }
    ancestors.push(parent)
    parentId = parent.header.parentSession
  }

  const childrenByParent = new Map<SessionId, SessionRecord[]>()
  for (const record of records) {
    const parent = record.header.parentSession
    if (parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(record)
    childrenByParent.set(parent, children)
  }
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id))
  }

  const descendants = buildDescendants(childrenByParent, sessionId)
  const common = {
    target: cloneRecord(target),
    ancestors: ancestors.map(cloneRecord),
    descendants,
  }
  if (unresolvedParentId !== undefined) {
    return { ...common, complete: false, unresolvedParentId }
  }
  return {
    ...common,
    complete: true,
    root: cloneRecord(ancestors.at(-1) ?? target),
  }
}

function analyzeEventLog(
  sessionId: SessionId,
  events: readonly SessionEvent[],
): EventLogAnalysis {
  let folded: ReturnType<typeof foldSurface>
  try {
    folded = foldSurface(events)
  } catch (error: unknown) {
    throw new SessionQueryError(
      /* v8 ignore next -- foldSurface throws Error instances */
      `invalid session surface: ${error instanceof Error ? error.message : 'unknown error'}`,
      'SESSION_QUERY_INVALID_SURFACE',
      { cause: error },
    )
  }
  const current = new Set(folded.nodes)
  const replacedBy = new Map<number, number>()
  const replacedEventSeqs = new Map<number, number[]>()
  for (const replacement of folded.replacements) {
    const removed = replacement.shadowedSeqs
    replacedEventSeqs.set(replacement.seq, removed)
    for (const removedSeq of removed) {
      replacedBy.set(removedSeq, replacement.seq)
    }
  }
  return {
    records: events.map(event => ({
      sessionId,
      seq: event.seq,
      type: event.type,
      time: event.time,
      surface: current.has(event.seq)
        ? 'current'
        : replacedBy.has(event.seq) ? 'shadowed' : 'log-only',
    })),
    replacedBy,
    replacedEventSeqs,
    currentSeqs: [...folded.nodes],
  }
}

function eventSources(event: SessionEvent): readonly number[] {
  return (event as SessionEvent<SurfaceEventType>).sourceEventSeqs ?? []
}

function buildDescendants(
  childrenByParent: ReadonlyMap<SessionId, readonly SessionRecord[]>,
  sessionId: SessionId,
): SessionLineageNode[] {
  const descendants: SessionLineageNode[] = []
  const stack = [{ sessionId, descendants }]
  while (stack.length > 0) {
    // The length guard proves a frame exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const frame = stack.pop()!
    const nodes: SessionLineageNode[] = []
    for (const child of childrenByParent.get(frame.sessionId) ?? []) {
      const node = { session: cloneRecord(child), descendants: [] }
      nodes.push(node)
      frame.descendants.push(node)
    }
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      // The loop bounds prove this indexed node exists.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const node = nodes[index]!
      stack.push({ sessionId: node.session.header.id, descendants: node.descendants })
    }
  }
  return descendants
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return { ...record, header: structuredClone(record.header) }
}

import { Context, Service } from '@ejunz/cordis'

import { Session, snapshotSessionEvent, type SessionId } from '@ejunz/ea/session'

import { foldSessionTitle } from '@ejunz/ea/session-title'

import type { SessionTitleSnapshot } from '@ejunz/ea/session-title'

declare module '@ejunz/cordis' {
  interface Context {
    sessionQuery: SessionQueryEngine
  }
}

export abstract class SessionQueryEngine extends Service {
  static inject = ['sessions']

  private readonly _readWindowMax: number
  private readonly _corpus: SessionCorpus

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessionQuery')
    this._readWindowMax = config.readWindowMax ?? SESSION_QUERY_READ_WINDOW_MAX
    if (!Number.isInteger(this._readWindowMax) || this._readWindowMax < 0) {
      throw new SessionQueryError(
        'session-query: readWindowMax must be a non-negative integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    const persistedInspectConcurrency = config.persistedInspectConcurrency
      ?? SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY
    if (!Number.isSafeInteger(persistedInspectConcurrency) || persistedInspectConcurrency < 1) {
      throw new SessionQueryError(
        'session-query: persistedInspectConcurrency must be a positive safe integer',
        'SESSION_QUERY_INVALID_CONFIG',
      )
    }
    this._corpus = new SessionCorpus(ctx, persistedInspectConcurrency)
  }

  /**
   * Search the live-preferred logical corpus and group by session.
   * @param request - query text, metadata filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns session hits ranked by their strongest matching event.
   */
  abstract searchSessions(
    request: SessionSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>>

  /**
   * Search events within one live-preferred logical session.
   * @param request - target session, query text, filters, page size, and cursor.
   * @param exec - optional cancellation control.
   * @returns matching event hits and their target header from one indexed generation.
   */
  abstract searchEvents(
    request: SessionEventSearchRequest,
    exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage>

  /**
   * List the complete logical corpus using live-preferred records.
   * @param signal - optional cancellation for persistence listing.
   * @returns deterministic newest-first cloned session records.
   */
  listSessions(signal?: AbortSignal): Promise<SessionRecord[]> {
    return this._corpus.listSessions(signal)
  }

  /**
   * Read and replay-validate one complete logical session log without making it live.
   * @param sessionId - live or persisted session id to read.
   * @returns cloned header and complete raw event log from one observation.
   * @throws when persistence, header compatibility, or replay validation fails.
   */
  async readSession(sessionId: SessionId): Promise<SessionLogSnapshot> {
    const loaded = await this._corpus.load(sessionId)
    Session.create(sessionId, loaded.events, loaded.header)
    return {
      session: structuredClone(loaded.header),
      events: loaded.events.map(snapshotSessionEvent),
    }
  }

  /**
   * Filter the complete logical corpus with provider-independent predicates.
   * @param filters - ANDed session metadata and availability clauses.
   * @param signal - optional cancellation for persistence listing.
   * @returns matching cloned records in deterministic newest-first order.
   */
  async filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    const ownedFilters = materializeSessionResultFilters(filters)
    return this._filterSessions(ownedFilters, signal)
  }

  /**
   * Fold the latest log-backed title from one live-preferred logical session.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns latest title snapshot, or `undefined` when the log has no title event.
   */
  async readTitle(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleSnapshot | undefined> {
    return (await this.readTitleSnapshot(sessionId, signal)).title
  }

  /**
   * Fold the latest title and return its source header from one corpus observation.
   * @param sessionId - live or persisted session id to read.
   * @param signal - optional cancellation for source resolution and title folding.
   * @returns cloned source header and optional latest title snapshot.
   */
  async readTitleSnapshot(
    sessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionTitleObservation> {
    const result = (await this.readTitleSnapshots([sessionId], signal))[0] as SessionTitleObservationResult
    if (result.status === 'rejected') throw result.reason
    return result.value
  }

  /**
   * Fold titles for unique sessions from one cancellable corpus observation.
   *
   * Results preserve first-occurrence input order. Operational failures stay
   * isolated per session, while cancellation rejects the complete operation.
   * @param sessionIds - live or persisted session ids to observe.
   * @param signal - optional cancellation shared by all source reads.
   * @returns one fulfilled or rejected result per unique requested id.
   */
  async readTitleSnapshots(
    sessionIds: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<SessionTitleObservationResult[]> {
    return this._corpus.projectMany(sessionIds, (source): SessionTitleObservation => {
      const title = foldSessionTitle(source.events)
      return {
        session: structuredClone(source.header),
        ...title === undefined ? {} : { title },
      }
    }, signal)
  }

  /**
   * List lightweight raw-log event records for one logical session.
   * @param sessionId - live-preferred session id to read.
   * @returns event records in ascending seq order.
   */
  async listEvents(sessionId: SessionId): Promise<SessionEventRecord[]> {
    const loaded = await this._corpus.load(sessionId)
    return tracing.eventRecords(sessionId, loaded.events)
  }

  /**
   * Scan first-party semantic event documents with provider-independent filters.
   * @param sessionId - live-preferred session id to scan.
   * @param filters - ANDed metadata and literal-text predicates.
   * @returns matching semantic documents in ascending seq order.
   */
  async filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const ownedFilters = materializeSessionEventResultFilters(filters)
    return this._filterEvents(sessionId, ownedFilters)
  }

  private async _filterSessions(
    filters: readonly SessionResultFilter[],
    signal?: AbortSignal,
  ): Promise<SessionRecord[]> {
    return filterSessionResults(await this._corpus.listSessions(signal), filters)
  }

  private async _filterEvents(
    sessionId: SessionId,
    filters: readonly SessionEventResultFilter[],
  ): Promise<SessionEventSearchDocument[]> {
    const loaded = await this._corpus.load(sessionId)
    const documents = buildSessionEventSearchDocuments(sessionId, loaded.events)
    return filterSessionEventDocuments(documents, filters)
  }

  /**
   * Read one session's complete current model surface from one corpus observation.
   * @param sessionId - live-preferred session id to read.
   * @returns cloned header, current surface, and the last sequence number included in the raw-log capture.
   * @throws when source resolution fails or the session surface is invalid.
   */
  async readSurface(sessionId: SessionId): Promise<SessionSurfaceSnapshot> {
    const loaded = await this._corpus.load(sessionId)
    return {
      session: structuredClone(loaded.header),
      capturedThroughSeq: loaded.events.at(-1)?.seq ?? null,
      events: tracing.currentSurfaceEvents(sessionId, loaded.events),
    }
  }

  /**
   * Trace known ancestry and descendants from one corpus observation.
   * @param sessionId - logical session id to trace.
   * @param signal - optional cancellation for persistence listing.
   * @returns a complete lineage or the first parent that could not be resolved.
   * @throws when corpus resolution fails, the target is absent, or its known ancestry cycles.
   */
  async traceSession(sessionId: SessionId, signal?: AbortSignal): Promise<SessionLineageTrace> {
    const records = await this._corpus.listSessions(signal)
    signal?.throwIfAborted()
    return tracing.traceSession(records, sessionId)
  }

  /**
   * Trace one event's direct positional replacements and cited source events.
   * @param request - target session id and event seq.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns source header, direct links, and the target's positional replacement chain.
   * @throws when source resolution fails, the target is absent, or surface/source-event validation fails.
   */
  async traceEvent(request: SessionEventTraceRequest, signal?: AbortSignal): Promise<SessionEventTraceObservation> {
    const loaded = await this._corpus.load(request.sessionId, signal)
    signal?.throwIfAborted()
    return {
      session: loaded.header,
      ...tracing.traceEvent(request.sessionId, loaded.events, request.seq),
    }
  }

  /**
   * Read one full event plus a bounded raw-log context window.
   * @param request - target session/seq and context sizes.
   * @param signal - optional cancellation for persisted source resolution.
   * @returns cloned target and neighboring events.
   */
  async readEvent(request: SessionEventReadRequest, signal?: AbortSignal): Promise<SessionEventWindow> {
    const before = this._readWindow('before', request.before)
    const after = this._readWindow('after', request.after)
    const sessionId = request.sessionId
    const seq = request.seq
    return this._readEvent(sessionId, seq, before, after, signal)
  }

  private async _readEvent(
    sessionId: SessionId,
    seq: number,
    before: number,
    after: number,
    signal?: AbortSignal,
  ): Promise<SessionEventWindow> {
    const loaded = await this._corpus.load(sessionId, signal)
    signal?.throwIfAborted()
    const target = loaded.events[seq]
    if (target === undefined || target.seq !== seq) {
      throw new SessionQueryError(
        `session "${sessionId}" has no event at seq ${seq}`,
        'SESSION_QUERY_EVENT_NOT_FOUND',
      )
    }
    const startSeq = Math.max(0, seq - before)
    const endSeq = Math.min(loaded.events.length - 1, seq + after)
    const targetSnapshot = snapshotSessionEvent(target)
    const events = loaded.events.slice(startSeq, endSeq + 1)
      .map(event => event === target
        ? targetSnapshot
        : snapshotSessionEvent(event))
    return {
      session: structuredClone(loaded.header),
      target: targetSnapshot,
      events,
      startSeq,
      endSeq,
    }
  }

  private _readWindow(name: 'before' | 'after', value: number | undefined): number {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > this._readWindowMax) {
      throw new SessionQueryError(
        `${name} must be an integer between 0 and ${this._readWindowMax}`,
        'SESSION_QUERY_INVALID_WINDOW',
      )
    }
    return value
  }
}

export default SessionQueryEngine

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/session-query'
  export const name = 'session-query-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
