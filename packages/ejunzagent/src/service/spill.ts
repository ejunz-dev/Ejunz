import type { Branded } from '@ejunz/ea-core/brand'

import type { CallId } from '@ejunz/ea-core/llm'

import type { SessionId } from '@ejunz/ea-core/session'

export type SpillLocator = Branded<'SpillLocator'>

export function SpillLocator(locator: string): SpillLocator {
  return locator as SpillLocator
}

export interface SpillOwner {
  sessionId: SessionId
}

export interface SpillSource {
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: CallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
}

export interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}

export interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}

import { Context, Service } from '@ejunz/cordis'

declare module '@ejunz/cordis' {
  interface Context {
    spillStore: SpillStore
  }
}

export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * Persist `input.content` to a session-scoped spill artifact.
   * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
   * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>
}

export default SpillStore

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/spill'
  export const name = 'spill-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
