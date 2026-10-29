import type { Branded } from '@ejunz/ea/brand'

export type CompactionId = Branded<'CompactionId'>

export function CompactionId(id: string): CompactionId {
  return id as CompactionId
}

import type { MessageSource } from '@ejunz/ea/llm/message'

import type { CommandId } from '@ejunz/ea/commands/brand'

const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: 'plugin', plugin: 'compact' } as const)

export type CompactionCheckpointSource = typeof COMPACT_CHECKPOINT_MARKER & {
  readonly compactionId: CompactionId
  readonly sourceCommandId?: CommandId
}

export function compactCheckpointSource(
  compactionId: CompactionId,
  sourceCommandId?: CommandId,
): CompactionCheckpointSource {
  return Object.freeze({
    ...COMPACT_CHECKPOINT_MARKER,
    compactionId,
    ...sourceCommandId === undefined ? {} : { sourceCommandId },
  })
}

export function isCompactCheckpointSource(source: MessageSource): boolean {
  return source.kind === 'plugin' && source.plugin === COMPACT_CHECKPOINT_MARKER.plugin
}

import type { ContentBlock, TokenUsage } from '@ejunz/ea/llm'

import type { CommandId } from '@ejunz/ea/commands/brand'

export type { CompactionId }

declare module '@ejunz/ea/session/types' {
  interface SessionEventMap {
    /**
     * Marks the start of a compaction — log-only, holds the lock until
     * `compaction/end`. A numbered owner is strictly enclosed by that open turn;
     * `null` identifies a standalone manual transaction between turns.
     */
    'compaction/start': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null }
    /**
     * Completed summary, its inputs, and its model call facts — log-only, no surfaceOp.
     * The summary content is in `data.summary`; the actual surface replacement
     * is performed by the immediately following `user/message` event that
     * shadows the compacted range. That adjacency is contractual — the
     * shadowed pricing fields are the replacement's shadow price, so a
     * consumer may pair a replacement with the metering event directly
     * before it (`compaction/prune` documents the shared protocol).
     */
    'compaction/summary': {
      compactionId: CompactionId
      sourceCommandId?: CommandId
      summary: ContentBlock[]
      shadowedRange: { start: number; end: number }
      shadowedSeqs: number[]
      shadowedTokenCount: number
      /** The provider route that wrote the summary. */
      provider: string
      /**
       * The model that wrote the summary — the summarize call's envelope,
       * reported by the backend that made the call, logged so the one-shot
       * request is reconstructable from log + code and "which model wrote
       * this summary" has a durable answer (the reconstructability Agent Note).
       */
      model: string
      /** The generation cap the summarize call sent, when one applied. */
      maxTokens?: number
      /** Provider-reported token usage for the summarization request, when emitted. */
      usage?: TokenUsage
    } & (
      | {
        /** Complete provider output before the backend's safe summary projection. */
        rawOutput: ContentBlock[]
        /** Identifies exactly one call through this context's `ctx.llm.stream()`. */
        llmStreamCall: true
      }
      | {
        /** Optional complete output from an unmarked template, remote, or other summarizer. */
        rawOutput?: ContentBlock[]
        /** An unmarked summary does not identify a call through this context's LLM seam. */
        llmStreamCall?: never
      }
    )
    /**
     * Marks the end of a compaction — log-only, releases the lock. Its owner
     * matches `compaction/start`; `error` records an unsuccessful attempt.
     */
    'compaction/end': { compactionId: CompactionId; sourceCommandId?: CommandId; turn: number | null; error?: string }
    /**
     * Shadow price of one model-free prune replacement — log-only, no
     * surfaceOp. The shared shadow-price protocol: a surface `replace` event
     * is priced by the metering event immediately before it (`compaction/summary`
     * for a summarizing compaction, this event for a prune), which states the
     * heuristic token price of the exact replaced range so a pure consumer
     * can subtract it without retaining per-node prices. The replacement MUST
     * be appended synchronously right after this event.
     */
    'compaction/prune': {
      /** The replaced range's first and last surface-node seqs (a surface-position span, like {@link CompactionResult.shadowedRange}). */
      shadowedRange: { start: number; end: number }
      /** The seqs of all shadowed surface nodes, in surface order. */
      shadowedSeqs: number[]
      /** Heuristic price of the shadowed content under the token-meter's fixed estimator. */
      shadowedTokenCount: number
    }
  }
}

export interface CompactionResult {
  /** Stable identity shared by this compaction's complete durable lifecycle. */
  compactionId: CompactionId
  /** Human command that initiated this compaction, when it was manual. */
  sourceCommandId?: CommandId
  /** The seq of the appended `compaction/start` event. */
  startSeq: number
  /** The seq of the appended `compaction/summary` event. */
  summarySeq: number
  /** The seq of the appended `compaction/end` event. */
  endSeq: number
  /** The summary content blocks produced by the backend. */
  summary: ContentBlock[]
  /**
   * The surface-boundary pair that was shadowed: the seqs of the first
   * (`start`) and last (`end`) surface nodes of the replaced range. A
   * surface-POSITION span, not a numeric seq interval — after a prior replace
   * lands a fresh high-seq summary node at an older range's position, `start`
   * can be GREATER than `end`. {@link CompactionResult.shadowedSeqs} is the
   * authoritative set of shadowed nodes, in surface order.
   */
  shadowedRange: { start: number; end: number }
  /** The seqs of all shadowed surface nodes, in surface order. */
  shadowedSeqs: number[]
  /** Estimated token count of the shadowed content. */
  shadowedTokenCount: number
}

import type { Session, SessionEvent } from '@ejunz/ea/session'

interface BalanceCache {
  /** Surface rewrite generation this state describes. */
  generation: number
  /**
   * Balance of every surface cut in current order: a surface of N sequences has
   * N + 1 cuts, entry `i` being the cut before sequence `i` and the final entry
   * the cut after the surface tail.
   */
  cutBalanced: readonly boolean[]
  /** Current surface position of each event seq, indexing {@link cutBalanced}. */
  indexBySeq: Map<number, number>
  /** In-progress tool-call count after the processed surface tail. */
  inProgressToolCalls: number
}

const balanceCacheBySession = new WeakMap<Session, BalanceCache>()

function eventDelta(event: SessionEvent): number {
  switch (event.type) {
    case 'assistant/message':
      return event.data.message.content.filter(block => block.type === 'tool-call').length
    case 'tool/result':
      return -1
    default:
      return 0
  }
}

function eventForSeq(events: readonly SessionEvent[], seq: number): SessionEvent {
  const event = events[seq]
  if (event === undefined || event.seq !== seq) {
    throw new Error(`tool-pairing balance: surface seq ${seq} has no matching session event (corrupt surface)`)
  }
  return event
}

function extendCache(
  session: Session,
  cache: BalanceCache,
  seqs: readonly number[],
): BalanceCache {
  const processed = cache.cutBalanced.length - 1
  const tail = seqs.slice(processed)
  // Validate the unseen tail before mutating the live cache, so a corrupt
  // append cannot leave a partially advanced state behind.
  const events = session.events
  const pendingCuts: boolean[] = []
  let inProgressToolCalls = cache.inProgressToolCalls
  for (const seq of tail) {
    inProgressToolCalls += eventDelta(eventForSeq(events, seq))
    if (inProgressToolCalls < 0) {
      throw new Error(`tool-pairing balance: tool/result at surface seq ${seq} has no matching tool-call (corrupt surface)`)
    }
    pendingCuts.push(inProgressToolCalls === 0)
  }

  tail.forEach((seq, offset) => cache.indexBySeq.set(seq, processed + offset))
  cache.cutBalanced = cache.cutBalanced.concat(pendingCuts)
  cache.inProgressToolCalls = inProgressToolCalls
  return cache
}

function balanceCache(session: Session): BalanceCache {
  const surface = session.surface
  const seqs = surface.nodes
  const generation = surface.replaceGeneration
  const cached = balanceCacheBySession.get(session)

  if (cached === undefined || cached.generation !== generation || cached.cutBalanced.length - 1 > seqs.length) {
    // A rebuild is the same fold started from the empty-surface state, whose
    // single leading cut is trivially balanced.
    const rebuilt = extendCache(session, {
      generation,
      cutBalanced: [true],
      indexBySeq: new Map(),
      inProgressToolCalls: 0,
    }, seqs)
    balanceCacheBySession.set(session, rebuilt)
    return rebuilt
  }
  if (cached.cutBalanced.length - 1 < seqs.length) return extendCache(session, cached, seqs)
  return cached
}

function cutBalance(cache: BalanceCache, seq: number, offset: 0 | 1): boolean {
  const index = cache.indexBySeq.get(seq)
  const balanced = index === undefined ? undefined : cache.cutBalanced[index + offset]
  if (balanced === undefined) {
    throw new Error(`tool-pairing balance: surface seq ${seq} not found`)
  }
  return balanced
}

export function toolPairingBalancedBefore(session: Session, seq: number): boolean {
  return cutBalance(balanceCache(session), seq, 0)
}

export function toolPairingBalancedAfter(session: Session, seq: number): boolean {
  return cutBalance(balanceCache(session), seq, 1)
}

import { Context, Service } from '@ejunz/cordis'

import type { Session } from '@ejunz/ea/session'

import type { CommandId } from '@ejunz/ea/commands/brand'

export type CompactionTrigger = 'pressure' | 'context-overflow'

export type ManualCompactionErrorCode =
  | 'busy'
  | 'cancelled'
  | 'changed'
  | 'summary'
  | 'commit'
  | 'persistence'

export class ManualCompactionError extends Error {
  override readonly name = 'ManualCompactionError'

  /**
   * Create one classified compaction failure.
   * @param code - stable failure class; `busy` may originate from any compaction entry path.
   * @param message - backend diagnostic retained as the Error message.
   * @param options - optional original failure.
   */
  constructor(
    readonly code: ManualCompactionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export interface CompactionAgentContext {
  session: Session
  options: { provider?: string; model?: string }
}

export interface ManualCompactAgentContext extends CompactionAgentContext {
  /**
   * Run a non-turn maintenance operation only while the agent is idle, withholding later
   * waking input until it settles.
   * @param task - operation whose fulfillment or rejection is preserved, with an agent-owned cancellation signal.
   * @throws synchronously when the agent is already active.
   * @returns the task promise.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

declare module '@ejunz/cordis' {
  interface Context {
    compaction: CompactionEngine
  }
}

export abstract class CompactionEngine extends Service {
  constructor(ctx: Context) {
    super(ctx, 'compaction')
  }

  /**
   * Consider automatic compaction for one explicit trigger. Pressure policy
   * uses the latest durable routed request, while context-overflow policy may
   * force a useful balanced reduction even below the normal threshold. Return
   * `null` when no safe range can be compacted. A single oversized retained
   * unit or request envelope cannot be repaired through surface compaction.
   *
   * @param agent - agent context owning the session surface and routing options.
   * @param trigger - normal pressure or provider-confirmed context overflow.
   * @param signal - cancellation signal; model-backed implementations must forward it.
   * @returns the compaction result, or `null` if no compaction was needed.
   */
  abstract compactIfNeeded(
    agent: CompactionAgentContext,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null>

  /**
   * Explicitly compact useful history even below automatic pressure thresholds.
   * Implementations synchronously start an idle task before any asynchronous
   * work, select a useful range without writing on a no-op, then
   * append a standalone `compaction/start` before summarization. That durable
   * marker is the compaction lock until one `compaction/end` attempt. Later waking
   * prompts remain accepted in FIFO order and start only after the optional
   * durability checkpoint and idle-task settlement. Context injected while the
   * summary runs may sit between the marker pair; only the selected span must
   * remain stable.
   *
   * @param agent - idle agent whose durable history should be compacted.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for a manual compaction.
   * @returns the compaction result, or `null` when no safe useful range exists.
   * @throws {@link ManualCompactionError} for expected busy, agent-cancellation,
   * changed-span, summarization/shrink, commit-stage, or persistence failures;
   * an aborted request preserves its exact abort reason. Failed attempts remain
   * visible in the log.
   */
  abstract compactNow(
    agent: ManualCompactAgentContext,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null>

  /**
   * Forcibly compact a range of surface nodes into a single summary node.
   * `start` and `end` name an inclusive span by surface position, not numeric seq
   * order; replacements can make visible seqs non-monotonic. Both edges must be
   * balanced so assistant tool calls remain paired with their results. A model-
   * backed implementation forwards cancellation and rejects active, missing,
   * reversed, or unbalanced ranges. The target session is `agent.session`.
   * Its replacement user message must use {@link compactCheckpointSource} with
   * the transaction's `CompactionId`.
   * Use {@link toolPairingBalancedBefore} and {@link toolPairingBalancedAfter}
   * for the edge checks.
   *
   * @param start - first surface seq, inclusive.
   * @param end - last surface seq, inclusive.
   * @param agent - context whose session is mutated and whose routing options guide summarization.
   * @param signal - optional cancellation; model-backed implementations must forward it.
   * @throws when compaction is active or the range is missing, reversed, or unbalanced.
   * @returns the appended event seqs, summary, replaced range, and token accounting.
   */
  abstract compactRegion(
    start: number,
    end: number,
    agent: CompactionAgentContext,
    signal?: AbortSignal,
  ): Promise<CompactionResult>
}

export default CompactionEngine

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/compaction'
  export const name = 'compaction-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
