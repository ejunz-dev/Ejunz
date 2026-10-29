/**
 * Base profile-bundle module. The patch artifact is declared by the root EA
 * package's `ea.bundle.patch` manifest field; this module carries no runtime API.
 * @module @ejunz/ea/base
 */

import type { Context } from '@ejunz/cordis'
import type { InvariantInstaller } from '@ejunz/ea/invariants'

export {}

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea'
  export const name = 'base-bundle-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: Context): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
