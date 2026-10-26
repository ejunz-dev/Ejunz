#!/usr/bin/env node
/**
 * ea — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @ejunz/ea/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { loadLayeredEnv } from '@ejunz/app-boot'
import { cliManifestPath } from '../lib/cli-paths.ts'
import { installHostToolBridge } from '../service/host-tools.ts'
import { parseEaArgs } from '../commands/args.ts'

/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(readFileSync(cliManifestPath(), 'utf8')) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseEaArgs(process.argv.slice(2), readVersion())

switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('../service/profile-boot.ts')
    await runProfile({
      environment: loadLayeredEnv('ea'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      args: invocation.args,
      prepare: async (ctx) => {
        const origin = process.env.EJUNZ_AGENT_DATA_ORIGIN
        const token = process.env.EJUNZ_AGENT_DATA_TOKEN
        if (origin && token) await installHostToolBridge(ctx, { origin, token })
        else console.warn(`[host-tools] bridge unavailable origin=${origin ? 'set' : 'missing'} token=${token ? 'set' : 'missing'}`)
      },
    })
    break
  }
  case 'node': {
    const { runNode, parseNodeArgs } = await import('./node.ts')
    const { surfaceLogger } = await import('../service/surface-log.ts')
    try {
      await runNode(parseNodeArgs(invocation.args))
    } catch (error) {
      const logger = surfaceLogger('ea-node')
      if (error instanceof Error) logger.error(error.stack ?? error.message)
      else logger.error(String(error))
      process.exitCode = 1
    }
    break
  }
  case 'plugin': {
    const { runPlugin } = await import('../commands/plugin.ts')
    process.exit(runPlugin(invocation.profile, invocation.args))
    break
  }
  case 'dump-config': {
    const { runDumpConfig } = await import('../commands/dump-config.ts')
    runDumpConfig(invocation.profile, invocation.defaultOnly, invocation.patches)
    break
  }
  default:
    invocation satisfies never
    throw new Error(`ea: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
