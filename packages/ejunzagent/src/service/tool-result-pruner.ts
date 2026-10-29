import type { CallId } from '@ejunz/ea-core/llm'

export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
}

export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}

export interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: number
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: number
  /** Tool call shared by the original and replacement. */
  readonly callId: CallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
}

export interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}

import { deepFreeze } from '@ejunz/ea-core/llm'

export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

export const DEFAULTS: ResolvedConfig = deepFreeze({
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'thresholdChars',
  'headChars',
  'tailChars',
])

export function codePointLength(text: string): number {
  return Array.from(text).length
}

export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(
        `ToolResultPruneConfig: unknown key "${key}" `
        + '(allowed: thresholdChars, headChars, tailChars)',
      )
    }
  }

  const resolved: ResolvedConfig = {
    thresholdChars: config.thresholdChars ?? DEFAULTS.thresholdChars,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
  }
  assertPositiveInteger('thresholdChars', resolved.thresholdChars)
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)

  const emittedChars = resolved.headChars
    + codePointLength(PRUNE_MARKER)
    + resolved.tailChars
  if (emittedChars > resolved.thresholdChars) {
    throw new Error(
      `ToolResultPruneConfig: headChars + marker + tailChars (${emittedChars}) `
      + `must be at most thresholdChars (${resolved.thresholdChars})`,
    )
  }
  return deepFreeze(structuredClone(resolved))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a positive integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${value}) must be a non-negative integer`)
  }
}

import { Context, Service } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { freezeMessage } from '@ejunz/ea-core/llm'

import type { ContentBlock } from '@ejunz/ea-core/llm'

import type { Session, SessionEvent, ToolResultMessage } from '@ejunz/ea-core/session'

import type {} from '@ejunz/ea-core/compaction'

import type {} from '@ejunz/ea-core/token-meter'

declare module '@ejunz/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface SnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'tool/result'>
}

export class ToolResultPruner extends Service {
  // The token meter prices each shadowed node for its logged shadow-price
  // event, so pruning genuinely requires the pricing capability.
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  })

  /** Resolved and immutable character budgets. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    this.config = resolveConfig(config)
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  /**
   * Replace an over-budget text middle while retaining rich-block order.
   * Text slicing is by Unicode code point, not UTF-16 code unit, so a retained
   * boundary cannot split a surrogate pair. Grapheme clusters may still split.
   * @param blocks - original tool-result content.
   * @returns pruned content, or `null` when the text is within budget.
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const removedStart = this.config.headChars
    const removedEnd = totalChars - this.config.tailChars
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false

    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }

      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : ''
      if (marker.length > 0) markerInserted = true
      const text = points.slice(0, headEnd).join('')
        + marker
        + points.slice(tailStart).join('')
      if (text.length > 0) pruned.push({ ...block, text })
      consumed = blockEnd
    }

    /* v8 ignore next -- totalChars > threshold and valid budgets guarantee a removed text span. */
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span')
    const charsAfter = this.measureContent(pruned)
    /* v8 ignore next -- config validation fixes the emitted head + marker + tail budget. */
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold')
    }
    return pruned
  }

  /**
   * Prune every over-budget tool result from one stable current-surface snapshot.
   * Each replacement preserves the complete event data except for `content`,
   * cites the shadowed node so replay can recover the replacement input, and is
   * immediately preceded by a `compaction/prune` shadow-price event pricing the
   * shadowed node through the injected token meter, so pure consumers can
   * subtract it without per-node state.
   * @param session - session whose current surface is rewritten.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   * @throws when the session rejects a replacement; replacements committed
   * earlier in the pass remain durable.
   */
  pruneSession(session: Session): PruneResult {
    const candidates: SnapshotCandidate[] = []
    for (const seq of [...session.surface.nodes]) {
      const event = session.events[seq]
      /* v8 ignore next -- surface seqs are validated contiguous log references. */
      if (event?.type === 'tool/result') candidates.push({ seq, event })
    }

    const pruned: PrunedEntry[] = []
    let charsRemoved = 0
    for (const { seq, event } of candidates) {
      const result = event.data.message.content[0]
      const content = this.pruneContent(result.content)
      if (content === null) continue
      const charsBefore = this.measureContent(result.content)
      const charsAfter = this.measureContent(content)
      const message = freezeMessage<ToolResultMessage>({
        ...event.data.message,
        content: [{
          ...result,
          content,
        }] as [typeof result],
      })
      // Shadow-price protocol: the metering event and its replacement are
      // appended synchronously adjacent, so pure consumers subtract the
      // shadowed node's heuristic price without retaining per-node state.
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message),
      })
      const replacement = session.append('tool/result', {
        ...event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: seq, end: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        callId: event.data.message.source.callId,
        charsBefore,
        charsAfter,
      })
      charsRemoved += charsBefore - charsAfter
    }
    return { pruned, charsRemoved }
  }
}

export default ToolResultPruner

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/compaction-tool-result-pruner'
  export const name = 'compaction-tool-result-pruner-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
