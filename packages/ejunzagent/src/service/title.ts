export {}

declare module '@ejunz/ea/session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current normalized title — the latest `session/title`
     * event's text (last-wins), or `null` before the first title lands. A
     * plain string: the shape the client list rows consume.
     */
    title: string | null
  }
}

const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu

const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu

const ESC_SEQUENCE = /\u001B[@-_]/gu

const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu

const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

function cleanTitleText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function truncateTitleUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes)
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

export function normalizeSessionTitle(input: string, maxBytes: number): string {
  return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd()
}

export function fallbackSessionTitle(input: string, maxWords: number, maxBytes: number): string {
  assertPositiveInteger('maxWords', maxWords)
  const words = cleanTitleText(input).split(' ').filter(Boolean).slice(0, maxWords)
  return truncateTitleUtf8(words.join(' '), maxBytes).trimEnd()
}

import { Context, Service, type Fiber } from '@ejunz/cordis'

/** Runtime mirror: FiberState is a cordis const enum with no runtime export. */
const FiberState = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

import z from '@ejunz/schemastery'

import { z as zod } from 'zod'

import type { Branded } from '@ejunz/ea/brand'

import { assertNever, deepFreeze, isAgentLoopRequest } from '@ejunz/ea/llm'

import type { GenerateOptions } from '@ejunz/ea/llm'

import type {
  Session,
  SessionEvent,
} from '@ejunz/ea/session'

import type {} from '@ejunz/ea/session-projection'

export type SessionTitleProviderId = Branded<'SessionTitleProviderId'>

export function SessionTitleProviderId(id: string): SessionTitleProviderId {
  return id as SessionTitleProviderId
}

export interface SessionTitleModelProvenance {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

export type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | {
    readonly kind: 'provider'
    readonly provider: SessionTitleProviderId
    readonly model?: SessionTitleModelProvenance
  }
  | {
    /** Explicit user rename: pins the title — automatic generation stops scheduling. */
    readonly kind: 'user'
  }

export interface SessionTitleEventData {
  /** Normalized non-empty title text. */
  readonly title: string
  /** Exact human `user/message` seqs used to derive this title; empty for an explicit user rename. */
  readonly messageSeqs: number[]
  /** Whether the built-in fallback, a registered provider, or the user supplied the title. */
  readonly source: SessionTitleSource
}

export interface SessionTitleSnapshot extends SessionTitleEventData {
  /** Seq of the latest `session/title` event. */
  readonly eventSeq: number
  /** Timestamp of the latest `session/title` event. */
  readonly updatedAt: number
}

export interface Config {
  /** Maximum whitespace-delimited words in the built-in fallback. */
  readonly fallbackMaxWords: number
  /** Maximum UTF-8 bytes in the built-in fallback. */
  readonly fallbackMaxBytes: number
  /** Maximum UTF-8 bytes in any accepted title. */
  readonly maxTitleBytes: number
}

declare module '@ejunz/cordis' {
  interface Context {
    sessionTitle: SessionTitleService
  }
}

declare module '@ejunz/ea/session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins session title snapshot. Log-only: it never enters the model
     * surface or derived history.
     */
    'session/title': SessionTitleEventData
  }
}

export class SessionTitleInvalidError extends Error {
  override readonly name = 'SessionTitleInvalidError'
}

export interface SessionTitleUserMessage {
  /** Source `user/message` event seq. */
  readonly seq: number
  /** Exact concatenated text-block content. */
  readonly text: string
}

export type SessionTitleAutomaticMode = 'first-prompt' | 'all-prompts'

export interface SessionTitleProviderRequest {
  /** Live session being titled. */
  readonly session: Session
  /** All eligible human messages through this generation revision. */
  readonly messages: readonly SessionTitleUserMessage[]
  /** Exact current logged main-request route, when one has been recorded. */
  readonly route?: SessionTitleModelProvenance
  /** Cancellation for supersession, disposal, timeout composition, or the explicit caller. */
  readonly signal: AbortSignal
}

export interface SessionTitleProviderResult {
  /** Proposed title text. */
  readonly title: string
  /** Exact seqs from `request.messages` used by this result. */
  readonly messageSeqs: readonly number[]
  /** Auxiliary LLM route, when generation used a model. */
  readonly model?: SessionTitleModelProvenance
}

export interface SessionTitleProvider {
  /** Stable id of the provider recorded with the title. */
  readonly id: SessionTitleProviderId
  /** When new human prompts start automatic generation. */
  readonly automatic: SessionTitleAutomaticMode
  /**
   * Produce one title revision.
   * @param request - message snapshot, current route, session, and cancellation.
   * @returns proposed title plus exact input seqs and the optional provider/model route used to generate it.
   */
  generate(request: SessionTitleProviderRequest): Promise<SessionTitleProviderResult>
}

export function collectSessionTitleMessages(
  events: readonly SessionEvent[],
  throughSeq?: number,
): SessionTitleUserMessage[] {
  const messages: SessionTitleUserMessage[] = []
  for (const event of events) {
    if (throughSeq !== undefined && event.seq > throughSeq) break
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const content = event.data.content
    const text = content
      .filter((block): block is Extract<(typeof content)[number], { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    if (normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER).length === 0) continue
    messages.push({ seq: event.seq, text })
  }
  return messages
}

export function foldSessionTitle(events: readonly SessionEvent[]): SessionTitleSnapshot | undefined {
  const event = events.findLast(item => item.type === 'session/title')
  if (event === undefined) return undefined
  return deepFreeze({
    title: event.data.title,
    messageSeqs: [...event.data.messageSeqs],
    source: copySessionTitleSource(event.data.source),
    eventSeq: event.seq,
    updatedAt: event.time,
  })
}

function copySessionTitleSource(source: SessionTitleSource): SessionTitleSource {
  switch (source.kind) {
    case 'fallback': return { kind: 'fallback' }
    case 'provider': return {
      kind: 'provider',
      provider: source.provider,
      ...(source.model === undefined ? {} : { model: { ...source.model } }),
    }
    case 'user': return { kind: 'user' }
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(source, 'SessionTitleSource')
  }
}

interface ResolvedConfig {
  readonly fallbackMaxWords: number
  readonly fallbackMaxBytes: number
  readonly maxTitleBytes: number
}

interface ProviderRegistration {
  readonly provider: SessionTitleProvider
  readonly active: Set<Promise<unknown>>
  closing: boolean
}

interface PendingAutomaticWork {
  readonly registration: ProviderRegistration
  readonly revision: number
  readonly throughSeq: number
}

interface ActiveProviderWork extends PendingAutomaticWork {
  readonly controller: AbortController
  readonly signal: AbortSignal
}

interface SessionTitleWorkState {
  revision: number
  fallback?: Promise<SessionTitleSnapshot | undefined>
  pending?: PendingAutomaticWork
  active?: ActiveProviderWork
}

function assertPositiveInteger(name: keyof Config, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title: ${name} must be a positive integer`)
  }
}

export class SessionTitleService extends Service {
  static inject = ['sessions']
  static Config: z<Config> = z.object({
    fallbackMaxWords: z.number().step(1).min(1).required(),
    fallbackMaxBytes: z.number().step(1).min(1).required(),
    maxTitleBytes: z.number().step(1).min(1).required(),
  })

  private readonly config: ResolvedConfig
  private readonly ownerFiber: Fiber
  private registration: ProviderRegistration | undefined
  private readonly work = new Map<Session, SessionTitleWorkState>()
  private readonly lifetime = new AbortController()
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionTitle')
    this.ownerFiber = ctx.fiber
    const candidate: unknown = config
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error('session-title: configuration is required')
    }
    const value = candidate as Config
    assertPositiveInteger('fallbackMaxWords', value.fallbackMaxWords)
    assertPositiveInteger('fallbackMaxBytes', value.fallbackMaxBytes)
    assertPositiveInteger('maxTitleBytes', value.maxTitleBytes)
    if (value.fallbackMaxBytes > value.maxTitleBytes) {
      throw new Error('session-title: fallbackMaxBytes must not exceed maxTitleBytes')
    }
    this.config = deepFreeze({ ...value })

    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('session-title service disposed'))
      if (this.registration !== undefined) this.registration.closing = true
      this.registration = undefined
      for (const state of this.work.values()) {
        delete state.pending
        state.active?.controller.abort(new Error('session-title service disposed'))
      }
      await this.drain(this.inFlight)
      this.work.clear()
    }, 'sessionTitle lifecycle')

    // The title projection unit: pure last-wins fold of session/title events
    // (the same events foldSessionTitle consumes), serving the plain title
    // string clients list rows read. The unit child activates only when a
    // projection registry is composed (headless assemblies stay unaffected).
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'title', string | null>({
        key: 'title',
        schema: zod.union([zod.string().min(1), zod.null()]),
        init: () => null,
        apply: (state, event) => (event.type === 'session/title' ? event.data.title : state),
        view: state => state,
        stateVersion: 1,
      })
    })

    ctx.on('session/event', (session, event) => {
      switch (event.type) {
        case 'user/message':
          this.onUserMessage(session, event)
          break
        case 'request/header':
          this.onRequestHeader(session, event)
          break
        default:
          break
      }
    })
    ctx.on('llm/stream', (options, next) => {
      this.onMainRequest(options)
      return next()
    }, { global: true, prepend: true })
    ctx.on('session/disposed', (session) => {
      const state = this.work.get(session)
      if (state === undefined) return
      state.active?.controller.abort(new Error('session disposed during title generation'))
      this.work.delete(session)
    })
  }

  /**
   * Read the latest folded title from one live or replayed session.
   * @param session - session whose log is the title source of truth.
   * @returns latest title snapshot, or `undefined` before eligible input.
   */
  get(session: Session): SessionTitleSnapshot | undefined {
    return foldSessionTitle(session.events)
  }

  /**
   * Accept an explicit user title. Appends a `session/title` event with the
   * `user` source, which pins the title: in-flight automatic generation is
   * superseded and later user messages schedule none (an explicit
   * {@link SessionTitleService.refresh} remains the deliberate unpin).
   * @param session - exact live session to rename.
   * @param title - raw user input; normalized before acceptance.
   * @returns the accepted title snapshot.
   * @throws {SessionTitleInvalidError} when the title normalizes to empty.
   * @throws {Error} when the session is not live or the service is disposed.
   */
  rename(session: Session, title: string): SessionTitleSnapshot {
    this.assertServiceActive()
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const normalized = normalizeSessionTitle(title, this.config.maxTitleBytes)
    if (normalized.length === 0) {
      throw new SessionTitleInvalidError('session title must contain visible characters')
    }
    const state = this.stateFor(session)
    this.supersede(state, 'user rename superseded automatic title generation')
    session.append('session/title', {
      title: normalized,
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const snapshot = this.get(session)
    /* v8 ignore next -- unreachable: the append above just committed a session/title event. */
    if (snapshot === undefined) throw new Error('renamed title failed to fold')
    return snapshot
  }

  /**
   * Explicitly retry the registered provider, or materialize the built-in
   * fallback when no provider is registered.
   * @param session - exact live session to refresh.
   * @param signal - optional caller cancellation.
   * @returns latest accepted title, or `undefined` when no eligible text exists.
   */
  async refresh(session: Session, signal?: AbortSignal): Promise<SessionTitleSnapshot | undefined> {
    signal?.throwIfAborted()
    this.assertServiceActive()
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const registration = this.registration
    const messages = collectSessionTitleMessages(session.events)
    const latest = messages.at(-1)
    if (registration === undefined || registration.closing || latest === undefined) {
      // Explicit refresh is the unpin even without a provider: a standing
      // user title must not short-circuit ensureFallback into a no-op, so
      // re-derive and append the fallback over it when one is derivable.
      const current = this.get(session)
      const [first] = messages
      if (current?.source.kind === 'user' && first !== undefined) {
        this.appendFallback(session, first)
        signal?.throwIfAborted()
        return this.get(session)
      }
      const fallback = await this.ensureFallback(session)
      signal?.throwIfAborted()
      return fallback
    }
    const state = this.stateFor(session)
    const revision = this.supersede(state, 'explicit title refresh superseded older generation')
    const work = this.activate({
      registration,
      revision,
      throughSeq: latest.seq,
    }, state, signal)
    const config = session.requestHeader()?.config
    const route = config === undefined ? undefined : { provider: config.provider, model: config.model }
    return this.startProvider(session, work, route)
  }

  /**
   * Register the sole optional title provider. Disposal aborts its pending and
   * active work before another provider may register.
   * @param provider - provider identity, cadence, and generation function.
   * @returns exact Cordis effect disposer, which settles after active calls quiesce.
   */
  register(provider: SessionTitleProvider): () => Promise<void> {
    this.validateProvider(provider)
    if (this.registration !== undefined) {
      throw new Error(`session-title provider "${this.registration.provider.id}" is already registered`)
    }
    const registration: ProviderRegistration = {
      provider,
      active: new Set(),
      closing: false,
    }
    const dispose = this.ctx.effect(function* (this: SessionTitleService) {
      this.registration = registration
      yield async () => {
        registration.closing = true
        for (const state of this.work.values()) {
          if (state.pending?.registration === registration) delete state.pending
          if (state.active?.registration === registration) {
            state.active.controller.abort(new Error(`session-title provider "${provider.id}" was disposed`))
          }
        }
        await this.drain(registration.active)
        if (this.registration === registration) this.registration = undefined
      }
    }.bind(this), 'sessionTitle.register()')
    return dispose
  }

  /** Schedule fallback creation and any provider cadence for one eligible event. */
  private onUserMessage(session: Session, event: Extract<SessionEvent, { type: 'user/message' }>): void {
    if (!this.serviceActive()) return
    if (event.data.source.kind !== 'user' || collectSessionTitleMessages([event]).length === 0) return
    // A user rename pins the title: no automatic revision may override it.
    if (this.get(session)?.source.kind === 'user') return
    const registration = this.registration
    if (registration !== undefined && !registration.closing) {
      const messages = collectSessionTitleMessages(session.events, event.seq)
      const shouldSchedule = registration.provider.automatic === 'all-prompts'
        || (session.header.parentSession === undefined && messages.length === 1 && this.get(session) === undefined)
      if (shouldSchedule) {
        const state = this.stateFor(session)
        const revision = this.supersede(state, 'newer user message superseded title generation')
        state.pending = { registration, revision, throughSeq: event.seq }
      }
    }
    this.defer(async () => {
      try {
        await this.ensureFallback(session)
      } catch (error: unknown) {
        if (!this.serviceActive()) return
        this.ctx.logger.warn(`session "${session.id}": fallback title update failed: ${String(error)}`)
      }
    })
  }

  /** Start pending automatic work only after its exact main-request route is logged. */
  private onRequestHeader(session: Session, event: Extract<SessionEvent, { type: 'request/header' }>): void {
    if (!this.serviceActive()) return
    const state = this.work.get(session)
    const pending = state?.pending
    if (state === undefined || pending === undefined || pending.throughSeq >= event.seq) return
    const route = {
      provider: event.data.header.config.provider,
      model: event.data.header.config.model,
    }
    this.startPending(session, state, pending, route)
  }

  /** Start unchanged-route work from the marked loop request after its header fold is current. */
  private onMainRequest(options: GenerateOptions): void {
    if (!this.serviceActive() || options.sessionId === undefined || !isAgentLoopRequest(options)) return
    const session = this.ctx.sessions.get(options.sessionId)
    const state = session === undefined ? undefined : this.work.get(session)
    const pending = state?.pending
    if (session === undefined || state === undefined || pending === undefined) return
    const boundary = session.events.findLast(event => event.type === 'step/start' || event.type === 'step/end')
    const route = session.requestHeader()?.config
    if (boundary?.type !== 'step/start'
      || boundary.seq <= pending.throughSeq
      || route?.provider !== options.provider
      || route.model !== options.model) return
    this.startPending(session, state, pending, { provider: options.provider, model: options.model })
  }

  /** Consume one pending revision and schedule its non-blocking provider call. */
  private startPending(
    session: Session,
    state: SessionTitleWorkState,
    pending: PendingAutomaticWork,
    route: SessionTitleModelProvenance,
  ): void {
    delete state.pending
    this.defer(async () => {
      if (this.registration !== pending.registration
        || pending.registration.closing
        || this.work.get(session) !== state
        || state.revision !== pending.revision) return
      const work = this.activate(pending, state)
      try {
        await this.startProvider(session, work, route)
      } catch (error: unknown) {
        if (work.signal.aborted || !this.serviceActive()) return
        this.ctx.logger.warn(`session "${session.id}": automatic title generation failed: ${String(error)}`)
      }
    })
  }

  /** Start one tracked provider call after publishing its active revision. */
  private startProvider(
    session: Session,
    work: ActiveProviderWork,
    route?: SessionTitleModelProvenance,
  ): Promise<SessionTitleSnapshot | undefined> {
    const run = Promise.resolve().then(() => this.runProvider(session, work, route))
    return this.track(run, work.registration)
  }

  /** Execute and accept one current provider revision. */
  private async runProvider(
    session: Session,
    work: ActiveProviderWork,
    route?: SessionTitleModelProvenance,
  ): Promise<SessionTitleSnapshot | undefined> {
    try {
      this.assertCurrent(session, work)
      await this.ensureFallback(session)
      this.assertCurrent(session, work)
      const messages = collectSessionTitleMessages(session.events, work.throughSeq)
      const result = await work.registration.provider.generate({
        session,
        messages,
        ...route === undefined ? {} : { route },
        signal: work.signal,
      })
      this.assertCurrent(session, work)
      const accepted = this.validateResult(result, messages)
      session.append('session/title', {
        title: accepted.title,
        messageSeqs: [...accepted.messageSeqs],
        source: {
          kind: 'provider',
          provider: work.registration.provider.id,
          ...accepted.model === undefined ? {} : { model: accepted.model },
        },
      })
      return this.get(session)
    } finally {
      const state = this.work.get(session)
      if (state?.active === work) delete state.active
    }
  }

  /** Validate and normalize provider output against the supplied message snapshot. */
  private validateResult(
    result: unknown,
    messages: readonly SessionTitleUserMessage[],
  ): SessionTitleProviderResult {
    if (result === null || typeof result !== 'object') {
      throw new Error('session-title provider returned an invalid result')
    }
    const candidate = result as Record<string, unknown>
    if (typeof candidate.title !== 'string') throw new Error('session-title provider title must be a string')
    const title = normalizeSessionTitle(candidate.title, this.config.maxTitleBytes)
    if (title.length === 0) throw new Error('session-title provider returned an empty title')
    if (!Array.isArray(candidate.messageSeqs) || candidate.messageSeqs.length === 0) {
      throw new Error('session-title provider must identify at least one source message seq')
    }
    const messageSeqs: number[] = []
    const order = new Map(messages.map((message, index) => [message.seq, index]))
    let previous = -1
    for (const seq of candidate.messageSeqs as unknown[]) {
      if (typeof seq !== 'number') {
        throw new Error('session-title provider messageSeqs must be unique, ordered seqs from the request')
      }
      const index = order.get(seq)
      if (!Number.isSafeInteger(seq) || seq < 0 || index === undefined || index <= previous) {
        throw new Error('session-title provider messageSeqs must be unique, ordered seqs from the request')
      }
      messageSeqs.push(seq)
      previous = index
    }
    const modelCandidate = candidate.model
    let model: SessionTitleModelProvenance | undefined
    if (modelCandidate !== undefined) {
      if (modelCandidate === null || typeof modelCandidate !== 'object') {
        throw new Error('session-title provider result model must contain non-empty provider and model strings')
      }
      const record = modelCandidate as Record<string, unknown>
      if (typeof record.provider !== 'string' || record.provider.length === 0
        || typeof record.model !== 'string' || record.model.length === 0) {
        throw new Error('session-title provider result model must contain non-empty provider and model strings')
      }
      model = { provider: record.provider, model: record.model }
    }
    return {
      title,
      messageSeqs,
      ...(model === undefined ? {} : { model }),
    }
  }

  /** Fail a completion whose provider, revision, session, or signal is stale. */
  private assertCurrent(session: Session, work: ActiveProviderWork): void {
    this.assertServiceActive()
    work.signal.throwIfAborted()
    const state = this.work.get(session)
    /* v8 ignore next -- every supported supersession, provider disposal, and session disposal aborts
     * the work signal before changing this state. */
    if (this.registration !== work.registration
      || state?.active !== work
      || state.revision !== work.revision
      || this.ctx.sessions.get(session.id) !== session) {
      throw new Error('session title generation state changed without cancellation')
    }
  }

  /** Create and publish an active provider call from one fixed revision. */
  private activate(
    pending: PendingAutomaticWork,
    state: SessionTitleWorkState,
    upstream?: AbortSignal,
  ): ActiveProviderWork {
    const controller = new AbortController()
    const signal = upstream === undefined
      ? AbortSignal.any([controller.signal, this.lifetime.signal])
      : AbortSignal.any([controller.signal, this.lifetime.signal, upstream])
    const work: ActiveProviderWork = { ...pending, controller, signal }
    state.active = work
    return work
  }

  /** Abort older active work and reserve the next session-local revision. */
  private supersede(state: SessionTitleWorkState, reason: string): number {
    state.active?.controller.abort(new Error(reason))
    delete state.pending
    state.revision += 1
    return state.revision
  }

  /** Return mutable work state for one session. */
  private stateFor(session: Session): SessionTitleWorkState {
    let state = this.work.get(session)
    if (state === undefined) {
      state = { revision: 0 }
      this.work.set(session, state)
    }
    return state
  }

  /** Queue detached service work and retain it through service disposal. */
  private defer(task: () => Promise<void>): void {
    const run = Promise.resolve().then(async () => {
      if (!this.serviceActive()) return
      await task()
    })
    void this.track(run)
  }

  /** Retain one promise until settlement for service and optional provider teardown. */
  private track<T>(run: Promise<T>, registration?: ProviderRegistration): Promise<T> {
    this.inFlight.add(run)
    registration?.active.add(run)
    const settled = (): void => {
      this.inFlight.delete(run)
      registration?.active.delete(run)
    }
    void run.then(settled, settled)
    return run
  }

  /** Await every current and settling promise in one lifecycle registry. */
  private async drain(active: Set<Promise<unknown>>): Promise<void> {
    while (active.size > 0) await Promise.allSettled([...active])
  }

  /** Whether the owning plugin fiber can still start or commit title work. */
  private serviceActive(): boolean {
    return !this.lifetime.signal.aborted
      && this.ownerFiber.uid !== null
      && this.ownerFiber.state === FiberState.ACTIVE
  }

  /** Reject work once the owning plugin fiber has begun unloading. */
  private assertServiceActive(): void {
    if (!this.serviceActive()) throw new Error('session-title service disposed')
  }

  /** Reject malformed provider registrations before publishing an effect. */
  private validateProvider(provider: unknown): asserts provider is SessionTitleProvider {
    if (provider === null || typeof provider !== 'object') {
      throw new Error('session-title provider must be an object')
    }
    const candidate = provider as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('session-title provider id must be a non-empty string')
    }
    if (candidate.automatic !== 'first-prompt' && candidate.automatic !== 'all-prompts') {
      throw new Error('session-title provider automatic mode is invalid')
    }
    if (typeof candidate.generate !== 'function') {
      throw new Error(`session-title provider "${candidate.id}" requires generate()`)
    }
  }

  /**
   * Derive and append the deterministic fallback title over whatever stands
   * (the refresh unpin path: overwriting a pinned user title is the point).
   * Synchronous on purpose — no await may separate derivation from append, so
   * it needs neither ensureFallback's in-flight dedup nor its liveness
   * re-check. An underivable fallback (empty after the caps) appends nothing.
   */
  private appendFallback(session: Session, first: SessionTitleUserMessage): void {
    const title = fallbackSessionTitle(first.text, this.config.fallbackMaxWords, this.config.fallbackMaxBytes)
    if (title.length === 0) return
    session.append('session/title', {
      title,
      messageSeqs: [first.seq],
      source: { kind: 'fallback' },
    })
  }

  /** Create the first deterministic fallback if the session still lacks a title. */
  private async ensureFallback(session: Session): Promise<SessionTitleSnapshot | undefined> {
    this.assertServiceActive()
    const current = this.get(session)
    if (current !== undefined) return current
    const [first] = collectSessionTitleMessages(session.events)
    if (first === undefined) return undefined
    const title = fallbackSessionTitle(
      first.text,
      this.config.fallbackMaxWords,
      this.config.fallbackMaxBytes,
    )
    if (title.length === 0) return undefined
    const state = this.stateFor(session)
    if (state.fallback !== undefined) return state.fallback
    const fallback = Promise.resolve().then(() => {
      this.assertServiceActive()
      if (this.ctx.sessions.get(session.id) !== session) {
        throw new Error(`session "${session.id}" is not live in this store`)
      }
      const accepted = this.get(session)
      if (accepted !== undefined) return accepted
      session.append('session/title', {
        title,
        messageSeqs: [first.seq],
        source: { kind: 'fallback' },
      })
      return this.get(session)
    })
    state.fallback = fallback
    try {
      return await fallback
    } finally {
      delete state.fallback
    }
  }
}

export default SessionTitleService

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/session-title'
  export const name = 'session-title-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
