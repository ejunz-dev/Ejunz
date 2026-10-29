import type { ContentBlock, Message } from '@ejunz/ea-core/llm'

import type { EpochHeader } from '@ejunz/ea-core/session'

const CHARS_PER_TOKEN = 4

const BLOCK_OVERHEAD = 4

export const ROLE_OVERHEAD = 4

export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

export function estimateMessage(message: Message): number {
  return estimateContent(message.content) + ROLE_OVERHEAD
}

export function estimateSystemTokens(header: EpochHeader | undefined): number {
  if (header?.system === undefined) return 0
  return Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

export function estimateHeader(header: EpochHeader | undefined): number {
  return estimateSystemTokens(header) + estimateToolsTokens(header)
}

import { deriveEventMessage, isSurfaceEvent } from '@ejunz/ea-core/session'

import type { SessionEvent } from '@ejunz/ea-core/session'

import type {} from '@ejunz/ea-core/compaction'

export interface ShadowPriceClaim {
  /** Declared inclusive first surface-node seq of the priced range. */
  start: number
  /** Declared inclusive last surface-node seq of the priced range. */
  end: number
  /** Heuristic tokens of the priced range under the fixed estimator. */
  tokens: number
}

export interface SurfaceTokensFold {
  /** Signed change in the surface total; 0 for events off the surface. */
  readonly deltaTokens: number
  /** Claim to carry into the next event; undefined when none survives. */
  readonly claim: ShadowPriceClaim | undefined
}

export function foldSurfaceProjection(
  claim: ShadowPriceClaim | undefined,
  event: SessionEvent,
): SurfaceTokensFold {
  if (event.type === 'compaction/summary' || event.type === 'compaction/prune') {
    const { shadowedRange, shadowedTokenCount } = event.data
    return {
      deltaTokens: 0,
      claim: { start: shadowedRange.start, end: shadowedRange.end, tokens: shadowedTokenCount },
    }
  }
  if (!isSurfaceEvent(event)) return { deltaTokens: 0, claim: undefined }
  const message = deriveEventMessage(event)
  const tokens = message === null ? 0 : estimateMessage(message)
  const op = event.surfaceOp
  if (op === 'append') return { deltaTokens: tokens, claim: undefined }
  // Sessions recorded before the shadow-price protocol log replacements with
  // no adjacent metering event; the bounded state cannot reconstruct the
  // replaced range's price, so fold those neutrally — historical replay
  // degrades to drift instead of failing.
  if (claim === undefined) return { deltaTokens: 0, claim: undefined }
  if (claim.start !== op.start || claim.end !== op.end) {
    throw new Error(
      `token surface: replace at seq ${event.seq} over range ${op.start}-${op.end} has no adjacent shadow price`
      + ` (armed claim covers ${claim.start}-${claim.end})`,
    )
  }
  return { deltaTokens: tokens - claim.tokens, claim: undefined }
}

export interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface ContextPressureProjection {
  /**
   * Provider-reported prompt size of the most recent request: uncached input
   * plus cache reads and writes. Response output is excluded, so this does not
   * grow as the current turn streams. Absent until a provider reports usage.
   */
  pressureTokens?: number
  /**
   * What the NEXT request's prompt would cost: {@link pressureTokens} plus the
   * heuristic repricing of everything the surface gained or lost since that
   * sample. Only the delta is estimated, so the figure stays anchored to the
   * provider while still reacting the moment a compaction shadows a span —
   * which `pressureTokens` alone cannot do, since compaction reports no usage
   * of its own. Absent until a provider reports usage.
   */
  projectedTokens?: number
  /** Newest recorded route capacity; absent when no adapter advertised one. */
  contextWindow?: number
}

export interface ContextBreakdownProjection {
  /** Heuristic tokens of the newest request envelope's system prompt; 0 before any request. */
  systemTokens: number
  /** Heuristic tokens of the newest request envelope's tool schemas; 0 before any request. */
  toolsTokens: number
  /** Heuristic tokens of the current model-visible conversation surface. */
  messageTokens: number
}

declare module '@ejunz/ea-core/session-projection/types' {
  interface SessionProjectionMap {
    /** Provider-reported usage accumulated across the complete durable log. */
    tokenUsage: TokenUsageProjection
    /** Newest request pressure paired with the newest known route capacity. */
    contextPressure: ContextPressureProjection
    /** Heuristic system/tools/message composition of the next request. */
    contextBreakdown: ContextBreakdownProjection
  }
}

import { z } from 'zod'

import { canonicalHeader } from '@ejunz/ea-core/session'

import type { ProjectionDefinition } from '@ejunz/ea-core/session-projection'

interface ContextBreakdownState {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
  /** Shadow price armed by the immediately preceding metering event. */
  claim?: ShadowPriceClaim
}

const breakdownSchema = z.object({
  systemTokens: z.number().int().nonnegative(),
  toolsTokens: z.number().int().nonnegative(),
  messageTokens: z.number().int().nonnegative(),
}).strict()

export const contextBreakdownProjectionDefinition:
ProjectionDefinition<'contextBreakdown', ContextBreakdownState> = {
  key: 'contextBreakdown',
  schema: breakdownSchema,
  init: () => ({ systemTokens: 0, toolsTokens: 0, messageTokens: 0 }),
  apply: (state, event) => {
    const fold = foldSurfaceProjection(state.claim, event)
    let systemTokens = state.systemTokens
    let toolsTokens = state.toolsTokens
    if (event.type === 'request/header') {
      const header = canonicalHeader(event.data.header)
      systemTokens = estimateSystemTokens(header)
      toolsTokens = estimateToolsTokens(header)
    }
    if (systemTokens === state.systemTokens
      && toolsTokens === state.toolsTokens
      && fold.deltaTokens === 0
      && fold.claim === undefined
      && state.claim === undefined) return state
    return {
      systemTokens,
      toolsTokens,
      messageTokens: state.messageTokens + fold.deltaTokens,
      ...fold.claim === undefined ? {} : { claim: fold.claim },
    }
  },
  view: ({ systemTokens, toolsTokens, messageTokens }) => ({ systemTokens, toolsTokens, messageTokens }),
  stateVersion: 2,
}

import type { TokenUsage } from '@ejunz/ea-core/llm'

export type TokenMeterConfig = Record<string, never>

export type TokenMeasurementBaseline =
  | { readonly kind: 'none'; readonly tokens: 0 }
  | { readonly kind: 'estimated'; readonly tokens: number }
  | { readonly kind: 'usage'; readonly tokens: number; readonly usage: Readonly<TokenUsage> }

export interface TokenMeasurement {
  /** Number of durable events consumed; equal to the next unread event seq. */
  readonly logRevision: number
  /** Provider or heuristic anchor used for this measurement. */
  readonly baseline: TokenMeasurementBaseline
  /** Signed repricing of current surface content relative to the baseline anchor. */
  readonly surfaceDeltaTokens: number
  /** Non-negative current request-and-response pressure. */
  readonly totalTokens: number
  /** Total heuristic tokens across the current surface. */
  readonly surfaceTokens: number
  /** Current surface nodes in positional head-to-tail order. */
  readonly nodes: readonly TokenSurfaceNode[]
}

export interface TokenSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Heuristic tokens for the exact message projected by this node. */
  readonly tokens: number
}

import { z } from 'zod'

import type { TokenUsage } from '@ejunz/ea-core/llm'

import type { SessionEvent } from '@ejunz/ea-core/session'

import type { ProjectionDefinition } from '@ejunz/ea-core/session-projection'

interface UsageSample {
  turn: number
  step: number
  buckets: TokenUsageProjection
}

interface TokenUsageState {
  totals: TokenUsageProjection
  last: UsageSample | null
}

const zeroBuckets = (): TokenUsageProjection => ({
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

const bucketsFrom = (usage: TokenUsage): TokenUsageProjection => ({
  uncachedInputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: TokenUsageProjection, right: TokenUsageProjection): boolean =>
  left.uncachedInputTokens === right.uncachedInputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

const addReplacing = (
  totals: TokenUsageProjection,
  previous: TokenUsageProjection | undefined,
  next: TokenUsageProjection,
): TokenUsageProjection => ({
  uncachedInputTokens: totals.uncachedInputTokens - (previous?.uncachedInputTokens ?? 0) + next.uncachedInputTokens,
  outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
  cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
  cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
})

const projectionSchema = z.object({
  uncachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

const pressureSchema = z.object({
  pressureTokens: z.number().int().nonnegative().optional(),
  projectedTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
}).strict() as unknown as z.ZodType<ContextPressureProjection>

const pressureFrom = (usage: TokenUsage): number =>
  usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)

const usageOf = (event: SessionEvent): TokenUsage | undefined =>
  event.type === 'assistant/chunk' && event.data.chunk.type === 'usage'
    ? event.data.chunk.usage
    : event.type === 'assistant/message'
      ? event.data.usage
      : undefined

interface ContextPressureState {
  contextWindow?: number
  pressureTokens?: number
  /** Running heuristic total over the current surface ({@link foldSurfaceProjection}). */
  surfaceTokens: number
  /** {@link surfaceTokens} at the newest usage sample; absent until one lands. */
  sampledSurfaceTokens?: number
  /** Shadow price armed by the immediately preceding metering event. */
  claim?: ShadowPriceClaim
}

export const tokenUsageProjectionDefinition:
ProjectionDefinition<'tokenUsage', TokenUsageState> = {
  key: 'tokenUsage',
  schema: projectionSchema,
  init: () => ({ totals: zeroBuckets(), last: null }),
  apply: (state, event) => {
    let turn: number
    let step: number
    let usage: TokenUsage
    if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
      ;({ turn, step } = event.data)
      usage = event.data.chunk.usage
    } else if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      ;({ turn, step, usage } = event.data)
    } else {
      return state
    }

    const buckets = bucketsFrom(usage)
    const previous = state.last !== null
      && state.last.turn === turn
      && state.last.step === step
      ? state.last.buckets
      : undefined
    if (previous !== undefined && bucketsEqual(previous, buckets)) return state

    return {
      totals: addReplacing(state.totals, previous, buckets),
      last: { turn, step, buckets },
    }
  },
  view: state => state.totals,
  stateVersion: 1,
}

export const contextPressureProjectionDefinition:
ProjectionDefinition<'contextPressure', ContextPressureState> = {
  key: 'contextPressure',
  schema: pressureSchema,
  init: () => ({ surfaceTokens: 0 }),
  apply: (state, event) => {
    const fold = foldSurfaceProjection(state.claim, event)
    let next = state
    if (event.type === 'request/context') {
      const contextWindow = event.data.contextWindow
      if (contextWindow !== state.contextWindow) {
        if (contextWindow !== undefined) {
          next = { ...next, contextWindow }
        } else {
          const { contextWindow: _removed, ...withoutContextWindow } = next
          next = withoutContextWindow
        }
      }
    }
    const usage = usageOf(event)
    if (usage !== undefined) {
      const pressureTokens = pressureFrom(usage)
      if (pressureTokens !== next.pressureTokens || next.sampledSurfaceTokens !== next.surfaceTokens) {
        next = { ...next, pressureTokens, sampledSurfaceTokens: next.surfaceTokens }
      }
    }
    if (fold.deltaTokens !== 0) {
      next = { ...next, surfaceTokens: next.surfaceTokens + fold.deltaTokens }
    }
    // A defined fold.claim is always freshly built, so presence decides claim
    // bookkeeping: no claim before or after this event leaves `next` as is.
    if (state.claim === undefined && fold.claim === undefined) return next
    const { claim: _expired, ...withoutClaim } = next
    return fold.claim === undefined ? withoutClaim : { ...withoutClaim, claim: fold.claim }
  },
  view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
    ...contextWindow === undefined ? {} : { contextWindow },
    ...pressureTokens === undefined ? {} : { pressureTokens },
    ...pressureTokens === undefined || sampledSurfaceTokens === undefined
      ? {}
      : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) },
  }),
  stateVersion: 4,
}

import { deriveEventMessage } from '@ejunz/ea-core/session'

import type { SurfaceEvent } from '@ejunz/ea-core/session'

export interface SurfaceTokenFold {
  /** Heuristic price of the event's own message; 0 when it derives none. */
  readonly tokens: number
  /** The surface after the event, detached from the input. */
  readonly nodes: TokenSurfaceNode[]
  /** Signed change in the surface total: `tokens` minus anything shadowed. */
  readonly deltaTokens: number
}

export function foldSurfaceTokens(
  nodes: readonly TokenSurfaceNode[],
  event: SurfaceEvent,
): SurfaceTokenFold {
  const message = deriveEventMessage(event)
  const tokens = message === null ? 0 : estimateMessage(message)
  const op = event.surfaceOp
  if (op === 'append') {
    return { tokens, nodes: [...nodes, { seq: event.seq, tokens }], deltaTokens: tokens }
  }
  const startIdx = nodes.findIndex(node => node.seq === op.start)
  const endIdx = nodes.findIndex(node => node.seq === op.end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(
      `token surface: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`,
    )
  }
  const removed = nodes
    .slice(startIdx, endIdx + 1)
    .reduce((total, node) => total + node.tokens, 0)
  const next = [...nodes]
  next.splice(startIdx, endIdx - startIdx + 1, { seq: event.seq, tokens })
  return { tokens, nodes: next, deltaTokens: tokens - removed }
}

import { Context, Service } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { BlockAssembler, deepFreeze } from '@ejunz/ea-core/llm'

import type { Message, TokenUsage } from '@ejunz/ea-core/llm'

import type { EpochHeader, Session, SessionEvent } from '@ejunz/ea-core/session'

import { canonicalHeader, headerEquals, isSurfaceEvent } from '@ejunz/ea-core/session'

import type {} from '@ejunz/ea-core/session-projection'

interface MeasurementAnchor {
  readonly header: EpochHeader | undefined
  readonly surfaceTokens: number
  readonly baseline: Exclude<TokenMeasurementBaseline, { kind: 'none' }>
}

interface ReplayState {
  consumedEvents: number
  header: EpochHeader | undefined
  surface: TokenSurfaceNode[]
  surfaceTokens: number
  stepStart: { turn: number; step: number; surfaceTokens: number } | undefined
  anchor: MeasurementAnchor | undefined
}

function usageTokens(usage: TokenUsage): number {
  return usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
}

function optionalHeaderEquals(
  left: EpochHeader | undefined,
  right: EpochHeader | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return headerEquals(left, right)
}

function validateConfigKeys(config: TokenMeterConfig): void {
  for (const key of Object.keys(config)) {
    throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`)
  }
}

declare module '@ejunz/cordis' {
  interface Context {
    tokenMeter: TokenMeter
  }
}

export class TokenMeter extends Service {
  // Schemastery preserves untrusted loader keys on an empty object schema;
  // the public type excludes settings while validateConfigKeys rejects them.
  static Config: z<TokenMeterConfig> = z.object({}) as unknown as z<TokenMeterConfig>

  private readonly states = new WeakMap<Session, ReplayState>()

  constructor(ctx: Context, config: TokenMeterConfig = {}) {
    super(ctx, 'tokenMeter')
    validateConfigKeys(config)

    // Projection registration is an optional child: compositions without the
    // generic registry keep the meter's standalone read shape.
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(tokenUsageProjectionDefinition)
      projectionCtx.sessionProjections.register(contextPressureProjectionDefinition)
      projectionCtx.sessionProjections.register(contextBreakdownProjectionDefinition)
    })

    // Readers catch up independently, while eager observation bounds ordinary
    // read latency without creating state for sessions no consumer has read.
    ctx.on('session/event', (session) => {
      if (this.states.has(session)) this._sync(session)
    })
  }

  /**
   * Measure current request pressure and surface through the durable tail.
   *
   * Provider usage is reused only when the latest successful call's canonical
   * request envelope matches `requestHeader` and its total is no lower than
   * that call's full heuristic anchor; otherwise the complete envelope and
   * surface are heuristically repriced.
   *
   * `requestHeader` affects request pressure only; surface fields always
   * describe the current session surface. Every call clones those positional
   * nodes, so measurement is O(surface).
   *
   * @param session - session to replay through its current durable tail.
   * @param requestHeader - optional effective request envelope replacing the latest logged header.
   * @returns a detached deeply immutable pressure and surface measurement.
   */
  measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement {
    const state = this._sync(session)
    const header = requestHeader === undefined
      ? state.header
      : canonicalHeader(requestHeader)
    const anchor = state.anchor

    let baseline: TokenMeasurementBaseline
    let surfaceDeltaTokens: number
    if (anchor !== undefined && optionalHeaderEquals(anchor.header, header)) {
      baseline = anchor.baseline
      surfaceDeltaTokens = state.surfaceTokens - anchor.surfaceTokens
    } else if (header === undefined && state.surfaceTokens === 0) {
      baseline = { kind: 'none', tokens: 0 }
      surfaceDeltaTokens = 0
    } else {
      baseline = {
        kind: 'estimated',
        tokens: estimateHeader(header) + state.surfaceTokens,
      }
      surfaceDeltaTokens = 0
    }

    return deepFreeze(structuredClone({
      logRevision: state.consumedEvents,
      baseline,
      surfaceDeltaTokens,
      totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
      surfaceTokens: state.surfaceTokens,
      nodes: state.surface,
    }))
  }

  /**
   * Heuristically price one model-visible message (instance face of the pure
   * `estimateMessage` export from `estimate.ts`).
   * @param message - message to price without mutation.
   * @returns content and role-framing tokens under the fixed service heuristic.
   */
  estimateMessage(message: Message): number {
    return estimateMessage(message)
  }

  /** Catch one session's fold up to the current durable tail. */
  private _sync(session: Session): ReplayState {
    let state = this.states.get(session)
    if (state === undefined) {
      state = {
        consumedEvents: 0,
        header: undefined,
        surface: [],
        surfaceTokens: 0,
        stepStart: undefined,
        anchor: undefined,
      }
      this.states.set(session, state)
    }

    while (state.consumedEvents < session.events.length) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- contiguous session seqs index the durable log
      const event = session.events[state.consumedEvents]!
      this._foldEvent(session, state, event)
      state.consumedEvents += 1
    }
    return state
  }

  /**
   * Validate and prepare every fallible part before mutating replay state.
   * A malformed event remains unread on every retry instead of partially
   * applying the same mutation more than once.
   */
  private _foldEvent(session: Session, state: ReplayState, event: SessionEvent): void {
    let nextHeader = state.header
    let nextStepStart = state.stepStart
    let nextAnchor = state.anchor

    switch (event.type) {
      case 'request/header':
        nextHeader = canonicalHeader(event.data.header)
        break
      case 'step/start':
        if (state.stepStart !== undefined) {
          throw new Error(
            `token meter: step/start at seq ${event.seq} arrived before turn ${state.stepStart.turn}/step ${state.stepStart.step} ended`,
          )
        }
        nextStepStart = { ...event.data, surfaceTokens: state.surfaceTokens }
        break
      case 'step/end':
        if (state.stepStart === undefined
          || state.stepStart.turn !== event.data.turn
          || state.stepStart.step !== event.data.step) {
          throw new Error(`token meter: step/end at seq ${event.seq} has no matching step/start event`)
        }
        nextStepStart = undefined
        break
      default:
        break
    }

    const surface = isSurfaceEvent(event)
      ? foldSurfaceTokens(state.surface, event)
      : undefined

    if (event.type === 'assistant/message') {
      const stepStart = state.stepStart
      if (stepStart === undefined
        || stepStart.turn !== event.data.turn
        || stepStart.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} has no matching step/start event`)
      }

      // assistant/message is surface-mandatory at every append/seed boundary.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const eventTokens = surface!.tokens
      if (event.data.usage !== undefined && nextHeader !== undefined) {
        const providerAssistantTokens = this._estimateProviderAssistant(
          session,
          event,
          eventTokens,
        )
        const anchorSurfaceTokens = stepStart.surfaceTokens + providerAssistantTokens
        const providerTokens = usageTokens(event.data.usage)
        const estimatedAnchorTokens = estimateHeader(nextHeader) + anchorSurfaceTokens
        nextAnchor = {
          header: nextHeader,
          surfaceTokens: anchorSurfaceTokens,
          // Signed heuristic deltas remain conservative only from an anchor
          // that is at least as large as the matching full heuristic price.
          baseline: providerTokens >= estimatedAnchorTokens
            ? { kind: 'usage', tokens: providerTokens, usage: event.data.usage }
            : { kind: 'estimated', tokens: estimatedAnchorTokens },
        }
      } else {
        const anchorSurfaceTokens = stepStart.surfaceTokens + eventTokens
        nextAnchor = {
          header: nextHeader,
          surfaceTokens: anchorSurfaceTokens,
          baseline: {
            kind: 'estimated',
            tokens: estimateHeader(nextHeader) + anchorSurfaceTokens,
          },
        }
      }
    }

    state.header = nextHeader
    state.stepStart = nextStepStart
    if (surface !== undefined) {
      state.surface = surface.nodes
      state.surfaceTokens += surface.deltaTokens
    }
    state.anchor = nextAnchor
  }

  /**
   * Reassemble provider output from the exact cited chunk seqs for a usage anchor.
   * Missing legacy source seqs conservatively treat the durable output as the
   * provider output; an explicit empty list prices a known empty stream.
   */
  private _estimateProviderAssistant(
    session: Session,
    event: SessionEvent<'assistant/message'>,
    durableEventTokens: number,
  ): number {
    const sourceSeqs = event.sourceEventSeqs
    if (sourceSeqs === undefined) return durableEventTokens

    const assembler = new BlockAssembler()
    const seen = new Set<number>()
    for (const seq of sourceSeqs) {
      if (seq >= event.seq) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not earlier`)
      }
      if (seen.has(seq)) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} repeats source seq ${seq}`)
      }
      seen.add(seq)
      // Session construction validates contiguous seqs, and the explicit
      // earlier-than-assistant check above therefore guarantees existence.
      const source = session.events[seq]
      // oxlint-disable-next-line typescript/no-non-null-assertion
      const sourceEvent = source!
      if (sourceEvent.type !== 'assistant/chunk') {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} is not assistant/chunk`)
      }
      if (sourceEvent.data.turn !== event.data.turn || sourceEvent.data.step !== event.data.step) {
        throw new Error(`token meter: assistant/message at seq ${event.seq} source seq ${seq} belongs to another step`)
      }
      assembler.push(sourceEvent.data.chunk)
    }
    const providerContent = assembler.blocks()
    return providerContent.length === 0 ? 0 : estimateContent(providerContent) + ROLE_OVERHEAD
  }
}

export default TokenMeter

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/token-meter'
  export const name = 'token-meter-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
