import type { SessionId } from '@ejunz/ea/session'

export interface SpillPolicyExec {
  /** The agent on whose behalf the call runs, when there is one. */
  agent?: {
    session: {
      header: {
        /** The canonical session identity — the spill owner. */
        id: SessionId
      }
    }
  }
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import type { ContentBlock } from '@ejunz/ea/llm'

import { TextRetainer, describeOmitted } from '@ejunz/ea/output-retention'

import type { Omitted } from '@ejunz/ea/output-retention'

import type { SaveTextSpill, SpillRef } from '@ejunz/ea/spill'

import type { SessionId } from '@ejunz/ea/session'

import type { CallId } from '@ejunz/ea/llm'

import type { PostToolDecision, ToolExecution } from '@ejunz/ea/tools'

export interface Config {
  /**
   * The model-facing context cap for a plain-text tool result, in UTF-8 bytes.
   * Omitted disables the policy entirely (no-op). When set, a result larger than
   * this is spilled and replaced with a preview derived from this same budget.
   */
  maxInlineBytes?: number
}

export const name = 'spill-policy'

export const inject = ['tools']

export const Config: z<Config> = z.object({
  maxInlineBytes: z.number(),
})

function flattenPlainText(content: ContentBlock[]): string | undefined {
  let text = ''
  for (const block of content) {
    if (block.type !== 'text') return undefined
    text += block.text
  }
  return text
}

function ownerSessionId(exec: ToolExecution): SessionId | undefined {
  return (exec as SpillPolicyExec).agent?.session.header.id
}

function preview(text: string, budget: number): { text: string; omitted: Omitted } {
  const headBytes = Math.ceil(budget / 2)
  const tailBytes = Math.floor(budget / 2)
  const retainer = new TextRetainer({ kind: 'headTail', headBytes, tailBytes })
  retainer.push(text)
  const kept = retainer.finish()
  return { text: kept.text, omitted: kept.omittedBytes }
}

function spillNotice(omitted: Omitted, ref: SpillRef): string {
  const omission = describeOmitted(omitted, 'bytes')
  return `(${omission} Full formatted result stored at: ${ref.locator}. ${ref.retrievalHint})`
}

export function apply(ctx: Context, config: Config): void {
  const maxInlineBytes = config.maxInlineBytes
  // Omitted ⇒ no automatic spill policy: register nothing at all.
  if (maxInlineBytes === undefined) return
  // Validate at LOAD, not per call: a negative/fractional cap would reach
  // TextRetainer's assertBudget and throw, turning every oversized-result call
  // into an isError. A bad config must fail the deployment, not the tool.
  if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 0) {
    throw new Error(`spill-policy: maxInlineBytes must be a non-negative integer (got ${maxInlineBytes})`)
  }
  // Narrowed once for the nested arms (closure narrowing does not survive awaits).
  const cap: number = maxInlineBytes

  /**
   * Spill `text` and build the bounded replacement (preview + notice), or
   * return `undefined` when the policy must keep the original (no session
   * owner, no backend, storage failure, or no within-cap replacement).
   * Shared verbatim by the model-facing post-execute arm and the durable
   * dispatch-log arm so both produce byte-identical projections.
   */
  async function spillReplacement(
    text: string,
    totalBytes: number,
    sessionId: SessionId | undefined,
    toolName: string,
    callId: CallId,
    label: 'result' | 'dispatch',
  ): Promise<string | undefined> {
    if (sessionId === undefined) {
      ctx.logger.warn(`spill-policy: no session owner for ${toolName} ${label}; keeping the inline content`)
      return undefined
    }
    const spillStore = ctx.get('spillStore')
    if (!spillStore) {
      ctx.logger.warn('spill-policy: no ctx.spillStore backend loaded; keeping the inline content')
      return undefined
    }
    const save: SaveTextSpill = {
      owner: { sessionId },
      source: { toolName, callId, label },
      suggestedName: `${toolName}.txt`,
      content: text,
    }
    let ref: SpillRef
    try {
      ref = await spillStore.saveText(save)
    } catch (error: unknown) {
      // Best-effort: a storage failure (permissions, ENOSPC, backend down) must
      // never fail the call or hide the content — keep the original inline.
      ctx.logger.warn(`spill-policy: saveText failed for ${toolName}: ${String(error)}; keeping the inline content`)
      return undefined
    }

    // Reserve the notice's byte cost INSIDE maxInlineBytes so the replacement
    // (preview + blank line + notice) never exceeds the documented cap — a naive
    // preview that spent the whole budget then appended the notice could be
    // larger than the cap, and for a marginally-over result even larger than the
    // original. The reservation uses a notice priced at the worst-case omission
    // count (the full byte total): its digit count bounds the real count's, so
    // the reserved size is a safe upper bound and the final notice is never
    // longer than what we reserved. `\n\n` is the 2-byte join.
    const reserve = Buffer.byteLength(spillNotice({ kind: 'exact', count: totalBytes }, ref), 'utf8') + 2
    const previewBudget = Math.max(0, cap - reserve)
    const { text: previewText, omitted } = preview(text, previewBudget)
    const notice = spillNotice(omitted, ref)
    const replacedText = previewText.length > 0 ? `${previewText}\n\n${notice}` : notice
    // Invariant: the policy NEVER emits a replacement larger than the cap. When
    // the notice alone exceeds maxInlineBytes (a tiny cap or a long spill root),
    // there is no within-cap replacement, so keep the inline content — spilling
    // would break the advertised cap. (A within-cap replacement is always
    // smaller than the original, which is > cap by the entry condition, so this
    // one check subsumes "not smaller than the original" too. The spill file
    // already written is a harmless orphan; cleanup is deferred.)
    if (Buffer.byteLength(replacedText, 'utf8') > cap) {
      ctx.logger.warn(`spill-policy: spill notice for ${toolName} exceeds maxInlineBytes; keeping the inline content`)
      return undefined
    }
    return replacedText
  }

  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    // Delegate first so a downstream listener (e.g. a hook) settles the result;
    // we bound whatever it accepted. A block passes through — spill only shapes
    // accepted plain-text results, never corrective feedback.
    const decision = await next()
    // Skip `read` to avoid a read → spill → read again loop.
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value')
      || exec.name === 'read') return decision

    const content = decision.content ?? result.content
    const text = flattenPlainText(content)
    if (text === undefined) return decision
    const totalBytes = Buffer.byteLength(text, 'utf8')
    if (totalBytes <= maxInlineBytes) return decision

    const replacedText = await spillReplacement(text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, 'result')
    if (replacedText === undefined) return decision
    const replaced: ContentBlock[] = [{ type: 'text', text: replacedText }]
    return { kind: 'accept', content: replaced, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
  }, { prepend: true })

}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/spill-policy'
  export const name = 'spill-policy-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
