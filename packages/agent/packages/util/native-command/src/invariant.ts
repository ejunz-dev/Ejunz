/**
 * Package-owned invariant companion for `@ejunz/native-command`.
 * @module @ejunz/native-command/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@ejunz/cordis'
import type { InvariantInstaller } from '@ejunz/invariants'

const PACKAGE_NAME = '@ejunz/native-command'

/** Cordis companion plugin name. */
export const name = 'native-command-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: each run is one stateless child-process round trip
 * with no owned event stream or mutable runtime data; behavior is enforced by
 * unit tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
