import type { Branded } from '@ejunz/ea-core/brand'

export type CredentialRef = Branded<'CredentialRef'>

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * Committed change to a provider-managed credential source: a `set`, an
     * `unset`, or an external edit observed in storage. Ambient
     * process-environment changes are not observable and never emit. Listener
     * failures are contained and logged — a sync throw and an async rejection
     * alike — without changing the committed operation's outcome, except
     * `INVARIANT`-coded failures, which rethrow after every listener ran;
     * that rethrow reaches the emitter only from synchronous listeners, so
     * invariant checks on this event must not be async functions.
     * @param ref - the reference whose stored value changed.
     * @mode emit
     */
    'credentials/updated'(ref: CredentialRef): void
  }
}

import { Context, Service } from '@ejunz/cordis'

const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function credentialRef(value: string): CredentialRef {
  if (!REF_PATTERN.test(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(REF_PATTERN)}`)
  }
  return value as CredentialRef
}

export interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
}

export interface CredentialInfo {
  /** Whether {@link CredentialProvider.resolve} would currently return a value. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
}

declare module '@ejunz/cordis' {
  interface Context {
    credentials: CredentialProvider
  }
}

export abstract class CredentialProvider extends Service {
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Resolve one reference to its current value. Resolution is per call:
   * consumers re-resolve at each operation and must not cache across
   * operations — that per-operation read is what makes a changed credential
   * reach the next operation without a restart.
   * @param ref - the reference to resolve.
   * @returns the value and its source, or `undefined` while unconfigured.
   */
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /**
   * Describe one reference for configuration surfaces without exposing the
   * value.
   * @param ref - the reference to describe.
   * @returns configured state, supplying source, and writability.
   */
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>

  /**
   * Durably store one value in the provider-managed writable source. Rejects
   * while a read-only source shadows the reference — the write would appear
   * to succeed while resolution keeps returning the shadowing value — and
   * rejects an empty value (use {@link unset}).
   * @param ref - the reference to store.
   * @param value - the non-empty secret value.
   */
  abstract set(ref: CredentialRef, value: string): Promise<void>

  /**
   * Remove one reference from the provider-managed writable source; removing
   * an absent reference is a no-op. Rejects while a read-only source shadows
   * the reference, like {@link set}.
   * @param ref - the reference to remove.
   */
  abstract unset(ref: CredentialRef): Promise<void>

  /* jscpd:ignore-start -- deliberate symmetry with the settings seam's commit
     fan-out: the contained-dispatch shape is the reviewed listener-lifecycle
     contract, and extracting it would couple the two seams' event semantics. */
  /**
   * Fan `credentials/updated` out with contained listener failures: every
   * listener runs, and a sync throw or async rejection is logged without
   * changing the committed operation's outcome — except `INVARIANT`-coded
   * failures, which rethrow after every listener ran (the rethrow reaches the
   * caller only from synchronous listeners, so invariant checks on this event
   * must not be async functions). Providers call this only after the write or
   * reload actually committed, so a broken observer can never make a durable
   * change look failed.
   * @param ref - the reference whose stored value changed.
   */
  protected notifyUpdated(ref: CredentialRef): void {
    let invariantFailure: unknown
    const args = ['credentials/updated', ref]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(ref)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(ref, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(ref, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }
  /* jscpd:ignore-end */

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ref: CredentialRef, error: unknown): void {
    this.ctx.logger.warn('credentials: a credentials/updated listener for "%s" failed', ref)
    this.ctx.logger.warn(error)
  }
}

export default CredentialProvider

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/credentials'
  export const name = 'credentials-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
