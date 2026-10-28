#!/usr/bin/env node
/**
 * ea — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @ejunz/ea/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { loadEjunzAgentConfig } from '@ejunz/profile-ejunz'
import { loadLayeredEnv, loadProfile } from '@ejunz/app-boot'
import { cliManifestPath } from '../lib/cli-paths.ts'
import { installHostToolBridge } from '../service/host-tools.ts'
import { parseEaArgs } from '../commands/args.ts'

function configText(config: unknown, key: string): string | undefined {
  if (typeof config !== 'object' || config === null) return undefined
  const value = (config as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(readFileSync(cliManifestPath(), 'utf8')) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const invocation = parseEaArgs(process.argv.slice(2), readVersion())

switch (invocation.mode) {
  case 'profile': {
    const { runProfile } = await import('../service/profile-boot.ts')
    const profile = loadProfile('ea', invocation.profile, cliManifestPath())
    const hasEjunzBundle = profile.layers.some(layer => layer.packageName === '@ejunz/profile-ejunz')
    const ejunzConfig = hasEjunzBundle ? loadEjunzAgentConfig() : undefined
    const profileConfigPatches = ejunzConfig === undefined ? [] : [
      { id: 'storage-ejunz', config: ejunzConfig },
      { id: 'session-persistence-ejunz', config: ejunzConfig },
    ]
    await runProfile({
      environment: loadLayeredEnv('ea'),
      profile: invocation.profile,
      patchFiles: invocation.patches,
      profileConfigPatches,
      args: invocation.args,
      debug: invocation.debug,
      prepare: async (ctx, composed) => {
        const hasEjunzBridge = ['storage-ejunz', 'session-persistence-ejunz'].some((id) => {
          const row = composed.rows.get(id)
          return row !== undefined && row.disabled !== true
        })
        if (!hasEjunzBridge) return
        const storageConfig = composed.rows.get('storage-ejunz')?.config
        const persistenceConfig = composed.rows.get('session-persistence-ejunz')?.config
        const origin = configText(storageConfig, 'origin')
        const token = configText(storageConfig, 'token')
        const persistenceOrigin = configText(persistenceConfig, 'origin')
        const persistenceToken = configText(persistenceConfig, 'token')
        if (!origin || !token || !persistenceOrigin || !persistenceToken) {
          throw new Error('ea: config.agent.yaml must provide the Ejunz bridge for storage-ejunz and session-persistence-ejunz')
        }
        if (origin !== persistenceOrigin || token !== persistenceToken) {
          throw new Error('ea: storage-ejunz and session-persistence-ejunz must use the same Ejunz bridge origin and token')
        }
        await installHostToolBridge(ctx, { origin, token })
      },
    })
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
