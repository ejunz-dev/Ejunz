import type { Branded } from '@ejunz/ea-core/brand'

import type { MessageId } from '@ejunz/ea-core/llm/brand'

import type { SessionId } from '@ejunz/ea-core/session/types'

export type MessageFeedbackVersion = Branded<'MessageFeedbackVersion'>

export type MessageFeedbackRating = 'positive' | 'negative'

export interface MessageFeedbackItem {
  /** Stable identity of the assistant message inside the owning Session. */
  readonly messageId: MessageId
  /** Overall positive or negative judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional explanation, preserved verbatim after validation. */
  readonly note?: string
  /** Equality-only token replaced by every material create or update. */
  readonly version: MessageFeedbackVersion
  /** Host-assigned creation time in Unix epoch milliseconds. */
  readonly createdAt: number
  /** Host-assigned time of the most recent material update. */
  readonly updatedAt: number
}

export interface MessageFeedbackListRequest {
  /** Persisted Session whose sidecar should be read. */
  readonly sessionId: SessionId
}

export interface MessageFeedbackListValue {
  /** Fresh immutable item snapshots. */
  readonly items: readonly MessageFeedbackItem[]
}

export interface MessageFeedbackPutRequest {
  /** Persisted Session that owns the target message. */
  readonly sessionId: SessionId
  /** Target assistant-message identity. */
  readonly messageId: MessageId
  /** Desired overall judgment. */
  readonly rating: MessageFeedbackRating
  /** Optional non-blank explanation. */
  readonly note?: string
  /** Observed item version, or `null` to require that no item exists. */
  readonly ifVersion: MessageFeedbackVersion | null
}

export interface MessageFeedbackDeleteRequest {
  /** Persisted Session that owns the sidecar. */
  readonly sessionId: SessionId
  /** Message whose feedback should be absent after this operation. */
  readonly messageId: MessageId
  /** Observed item version; ignored when the item is already absent. */
  readonly ifVersion: MessageFeedbackVersion
}

export interface MessageFeedbackDeleteValue {
  /** Stable postcondition shared by the first deletion and every retry. */
  readonly absent: true
}

export interface MessageFeedbackSessionNotFound {
  readonly code: 'session-not-found'
  readonly sessionId: SessionId
}

export interface MessageFeedbackTargetNotFound {
  readonly code: 'target-not-found'
  readonly sessionId: SessionId
  readonly messageId: MessageId
}

export interface MessageFeedbackVersionConflict {
  readonly code: 'version-conflict'
  /** Authoritative current item, or `null` when it does not exist. */
  readonly current: MessageFeedbackItem | null
}

export interface MessageFeedbackNoteBlank {
  readonly code: 'note-blank'
}

export interface MessageFeedbackNoteTooLarge {
  readonly code: 'note-too-large'
  readonly maxBytes: number
  readonly actualBytes: number
}

export type MessageFeedbackFailure =
  | MessageFeedbackSessionNotFound
  | MessageFeedbackTargetNotFound
  | MessageFeedbackVersionConflict
  | MessageFeedbackNoteBlank
  | MessageFeedbackNoteTooLarge

export interface MessageFeedbackSuccess<T> {
  readonly ok: true
  readonly value: T
}

export interface MessageFeedbackRejected<E extends MessageFeedbackFailure> {
  readonly ok: false
  readonly error: E
}

export type MessageFeedbackListResult =
  | MessageFeedbackSuccess<MessageFeedbackListValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>

export type MessageFeedbackPutResult =
  | MessageFeedbackSuccess<MessageFeedbackItem>
  | MessageFeedbackRejected<
    | MessageFeedbackSessionNotFound
    | MessageFeedbackTargetNotFound
    | MessageFeedbackVersionConflict
    | MessageFeedbackNoteBlank
    | MessageFeedbackNoteTooLarge
  >

export type MessageFeedbackDeleteResult =
  | MessageFeedbackSuccess<MessageFeedbackDeleteValue>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>

import { z } from 'zod'

import type { MessageId } from '@ejunz/ea-core/llm/brand'

import type { SessionId } from '@ejunz/ea-core/session/types'

import { defineDomain, domainTable } from '@ejunz/ea-core/storage'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

export const messageFeedbackRatingSchema = z.union([
  z.literal('positive'),
  z.literal('negative'),
]) satisfies z.ZodType<MessageFeedbackRating>

export const messageFeedbackVersionSchema = z.uuid()
  .transform(value => value as MessageFeedbackVersion)

export const messageFeedbackItemSchema = z.object({
  messageId: z.string().min(1).transform(value => value as MessageId),
  rating: messageFeedbackRatingSchema,
  note: z.string().refine(note => note.trim().length > 0, {
    message: 'message feedback note must contain a non-whitespace character',
  }).optional(),
  version: messageFeedbackVersionSchema,
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}).refine(item => item.updatedAt >= item.createdAt, {
  path: ['updatedAt'],
  message: 'message feedback updatedAt must not precede createdAt',
}) as unknown as z.ZodType<MessageFeedbackItem>

export const messageFeedbackSessionIdentitySchema = z.object({
  createdAt: nonNegativeSafeInteger,
  cwd: z.string().optional(),
})

export type MessageFeedbackSessionIdentity = z.infer<typeof messageFeedbackSessionIdentitySchema>

export const messageFeedbackRowSchema = z.object({
  session: messageFeedbackSessionIdentitySchema,
  items: z.array(messageFeedbackItemSchema),
}).superRefine((row, ctx) => {
  const messageIds = new Set<string>()
  const versions = new Set<string>()
  row.items.forEach((item, index) => {
    if (messageIds.has(item.messageId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'messageId'],
        message: `duplicate message feedback id '${item.messageId}'`,
      })
    }
    messageIds.add(item.messageId)
    if (versions.has(item.version)) {
      ctx.addIssue({
        code: 'custom',
        path: ['items', index, 'version'],
        message: `duplicate message feedback version '${item.version}'`,
      })
    }
    versions.add(item.version)
  })
})

export type MessageFeedbackRow = z.infer<typeof messageFeedbackRowSchema>

export const messageFeedbackDomainSpec = defineDomain({
  name: 'message_feedback',
  version: 0,
  tables: {
    sessions: domainTable<SessionId, MessageFeedbackRow>(messageFeedbackRowSchema),
  },
})

import { Buffer } from 'node:buffer'

import { randomUUID } from 'node:crypto'

import { Context, Service } from '@ejunz/cordis'

import s from '@ejunz/schemastery'

import { deriveEventMessage, isAppendSurfaceEvent } from '@ejunz/ea-core/session/surface'

import type { SessionHeader, SessionId } from '@ejunz/ea-core/session/types'

import type { SessionInspection } from '@ejunz/ea-core/session-persistence'

import type { KvTable } from '@ejunz/ea-core/storage'

import { TypertRemoteService, Remote } from '@ejunz/ea-core/typert-protocol'

export interface Config {
  /** Maximum UTF-8 byte length accepted for one note. */
  readonly maxNoteBytes: number
}

declare module '@ejunz/cordis' {
  interface Context {
    messageFeedback: MessageFeedbackService
  }
}

const EMPTY_ITEMS: readonly MessageFeedbackItem[] = Object.freeze([])

function resolveMaxNoteBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `message-feedback: maxNoteBytes must be a positive safe integer, got ${String(value)}`,
    )
  }
  return value
}

function snapshotItem(item: MessageFeedbackItem): MessageFeedbackItem {
  return Object.freeze({
    messageId: item.messageId,
    rating: item.rating,
    ...(item.note === undefined ? {} : { note: item.note }),
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  })
}

function snapshotList(items: readonly MessageFeedbackItem[]): MessageFeedbackListValue {
  return Object.freeze({ items: Object.freeze(items.map(snapshotItem)) })
}

function success<T>(value: T): MessageFeedbackSuccess<T> {
  return Object.freeze({ ok: true, value })
}

function rejected<E extends MessageFeedbackFailure>(error: E): MessageFeedbackRejected<E> {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

function identityOf(header: SessionHeader): MessageFeedbackSessionIdentity {
  return Object.freeze({
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  })
}

function sameIdentity(row: MessageFeedbackRow, header: SessionHeader): boolean {
  return row.session.createdAt === header.createdAt && row.session.cwd === header.cwd
}

function sameHeaderIdentity(left: SessionHeader, right: SessionHeader): boolean {
  return left.id === right.id && left.createdAt === right.createdAt && left.cwd === right.cwd
}

function rowSnapshot(
  session: MessageFeedbackSessionIdentity,
  items: readonly MessageFeedbackItem[],
): MessageFeedbackRow {
  const copiedItems = items.map(snapshotItem)
  Object.freeze(copiedItems)
  return Object.freeze({
    session,
    items: copiedItems,
  })
}

function nextVersion(): MessageFeedbackVersion {
  return randomUUID() as MessageFeedbackVersion
}

type KnownSession =
  | MessageFeedbackSuccess<SessionInspection>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>

type ResolvedNote =
  | MessageFeedbackSuccess<string | undefined>
  | MessageFeedbackRejected<MessageFeedbackNoteBlank | MessageFeedbackNoteTooLarge>

export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']

  /** Loader validation for the required note-size policy. */
  static Config: s<Config> = s.object({
    maxNoteBytes: s.number().step(1).min(1).required(),
  })

  private readonly maxNoteBytes: number
  private table?: KvTable<SessionId, MessageFeedbackRow>
  private readonly operationTails = new Map<SessionId, Promise<void>>()
  private mutationAdmissionOpen = true

  /**
   * @param ctx - Host context carrying persistence and the storage-domain form.
   * @param config - Required note-size policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    this.maxNoteBytes = resolveMaxNoteBytes(config.maxNoteBytes)
  }

  /** Open and own the one message-feedback sidecar domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await Promise.all(this.operationTails.values())
      await domain.close()
    }, 'message-feedback.domainClose')
    this.table = domain.table('sessions')
  }

  /**
   * Read feedback belonging to the current persisted Session lifecycle.
   * A stale row from a reused Session id is invisible.
   * @param request - Session identity to inspect and list.
   * @returns current immutable items or `session-not-found`.
   */
  @Remote('list')
  async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
    const known = await this.inspectSession(request.sessionId)
    if (!known.ok) return known
    const row = this.requireTable().get(request.sessionId)
    const items = row !== undefined && sameIdentity(row, known.value.meta) ? row.items : EMPTY_ITEMS
    return success(snapshotList(items))
  }

  /**
   * Create or replace feedback for one derived append-origin assistant
   * message. Every request must match the addressed item's current version;
   * a matching no-op returns the stored item without changing its revision.
   * @param request - target, desired value, and observed item version.
   * @returns the committed item or an explicit business failure.
   */
  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
    const note = this.resolveNote(request.note)
    if (!note.ok) return Promise.resolve(note)
    return this.enqueue(request.sessionId, async () => {
      const known = await this.inspectSession(request.sessionId)
      if (!known.ok) return known
      if (!this.hasFeedbackTarget(known.value, request.messageId)) {
        return rejected({
          code: 'target-not-found',
          sessionId: request.sessionId,
          messageId: request.messageId,
        })
      }

      const durable = await this.ensureTargetDurable(known.value)
      if (!sameHeaderIdentity(durable.meta, known.value.meta)
        || !this.hasFeedbackTarget(durable, request.messageId)) {
        return rejected({
          code: 'target-not-found',
          sessionId: request.sessionId,
          messageId: request.messageId,
        })
      }

      const table = this.requireTable()
      const stored = table.get(request.sessionId)
      const current = stored !== undefined && sameIdentity(stored, durable.meta) ? stored : undefined
      const items = current?.items ?? EMPTY_ITEMS
      const index = items.findIndex(item => item.messageId === request.messageId)
      const existing = items[index]
      if (request.ifVersion !== (existing?.version ?? null)) {
        return rejected(this.versionConflict(existing ?? null))
      }
      if (existing !== undefined
        && existing.rating === request.rating
        && existing.note === note.value) {
        return success(snapshotItem(existing))
      }

      const now = Date.now()
      const item = snapshotItem({
        messageId: request.messageId,
        rating: request.rating,
        ...(note.value === undefined ? {} : { note: note.value }),
        version: nextVersion(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing === undefined ? now : Math.max(now, existing.updatedAt),
      })
      const nextItems = [...items]
      if (index === -1) nextItems.push(item)
      else nextItems[index] = item
      await table.put(
        request.sessionId,
        rowSnapshot(identityOf(durable.meta), nextItems),
      )
      return success(snapshotItem(item))
    })
  }

  /**
   * Delete one feedback item. Absence is successful regardless of the
   * supplied version; an existing item requires an exact version match.
   * @param request - Session, message, and observed item version.
   * @returns the stable absent postcondition, or an explicit failure.
   */
  @Remote('delete')
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> {
    return this.enqueue(request.sessionId, async () => {
      const known = await this.inspectSession(request.sessionId)
      if (!known.ok) return known

      const table = this.requireTable()
      const stored = table.get(request.sessionId)
      const current = stored !== undefined && sameIdentity(stored, known.value.meta) ? stored : undefined
      const items = current?.items ?? EMPTY_ITEMS
      const existing = items.find(item => item.messageId === request.messageId)
      if (existing === undefined) {
        return success<MessageFeedbackDeleteValue>(Object.freeze({ absent: true }))
      }
      if (request.ifVersion !== existing.version) {
        return rejected(this.versionConflict(existing))
      }

      await table.put(
        request.sessionId,
        rowSnapshot(identityOf(known.value.meta), items.filter(item => item !== existing)),
      )
      return success<MessageFeedbackDeleteValue>(Object.freeze({ absent: true }))
    })
  }

  /**
   * Resolve a live owner directly; otherwise use the storage catalog as the
   * existence authority before inspecting the log. Inspection failures for a
   * catalogued Session remain infrastructure failures rather than being
   * guessed into the business `session-not-found` branch.
   */
  private async inspectSession(sessionId: SessionId): Promise<KnownSession> {
    if (this.ctx.sessions.get(sessionId) === undefined) {
      const snapshots = await this.ctx.sessionPersistence.listSnapshots()
      if (!snapshots.some(snapshot => snapshot.header.id === sessionId)
        && this.ctx.sessions.get(sessionId) === undefined) {
        return rejected({ code: 'session-not-found', sessionId })
      }
    }
    return success(await this.ctx.sessionPersistence.inspect(sessionId))
  }

  /** Require the exact finalized append-origin assistant message projection. */
  private hasFeedbackTarget(inspection: SessionInspection, messageId: MessageFeedbackItem['messageId']): boolean {
    return inspection.events.some((event) => {
      if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) return false
      const message = deriveEventMessage(event)
      return message?.role === 'assistant' && message.id === messageId
    })
  }

  /**
   * Put the target log prefix behind a durability barrier before its sidecar.
   * A live owner flushes through the SessionStore's canonical checkpoint; a
   * cold owner is re-read from the physical durable prefix.
   */
  private async ensureTargetDurable(inspection: SessionInspection): Promise<SessionInspection> {
    const live = this.ctx.sessions.get(inspection.meta.id)
    if (live !== undefined && sameHeaderIdentity(live.header, inspection.meta)) {
      if (!(await this.ctx.sessions.flush(live))) {
        throw new Error(
          `message-feedback: no durability listener participated for live session '${inspection.meta.id}'`,
        )
      }
      return await this.ctx.sessionPersistence.readFrom(inspection.meta.id, 0)
    }
    return await this.ctx.sessionPersistence.readFrom(inspection.meta.id, 0)
  }

  /** Validate optional-note semantics and the configured complete UTF-8 byte bound. */
  private resolveNote(note: string | undefined): ResolvedNote {
    if (note === undefined) return success(undefined)
    if (note.trim().length === 0) return rejected({ code: 'note-blank' })
    const actualBytes = Buffer.byteLength(note, 'utf8')
    if (actualBytes > this.maxNoteBytes) {
      return rejected({ code: 'note-too-large', maxBytes: this.maxNoteBytes, actualBytes })
    }
    return success(note)
  }

  /** Return the authoritative item needed to reconcile one failed comparison. */
  private versionConflict(current: MessageFeedbackItem | null): MessageFeedbackVersionConflict {
    return {
      code: 'version-conflict',
      current: current === null ? null : snapshotItem(current),
    }
  }

  /** Queue a complete read/compare/write mutation behind this Session's prior mutation. */
  private enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    if (!this.mutationAdmissionOpen) {
      return Promise.reject(new Error('message-feedback: service is disposing'))
    }
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(sessionId, tail)
    return result.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId)
    })
  }

  /** Resolve the initialized durable table or fail a broken service lifecycle. */
  private requireTable(): KvTable<SessionId, MessageFeedbackRow> {
    if (this.table === undefined) {
      throw new Error('message-feedback: durable domain is not initialized')
    }
    return this.table
  }
}

export default MessageFeedbackService

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/message-feedback'
  export const name = 'message-feedback-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
