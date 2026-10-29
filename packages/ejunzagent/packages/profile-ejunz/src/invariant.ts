/**
 * Package-owned invariant companion for `@ejunz/profile-ejunz`.
 * @module @ejunz/profile-ejunz/invariant
 */

import type { Context } from '@ejunz/cordis'
import type { InvariantInstaller } from '@ejunz/ea-core/invariants'

const PACKAGE_NAME = '@ejunz/profile-ejunz'

/** Cordis companion plugin name. */
export const name = 'profile-ejunz-bundle-invariant'
/** Service required before the companion can register. */
export const inject = ['invariants']

// No runtime invariant: this package is a static profile patch carrier.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
