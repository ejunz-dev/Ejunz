/** Standalone Ejunz profile configuration file. */

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const EXAMPLE_PATH = fileURLToPath(new URL('../config.agent.example.yaml', import.meta.url))

/** The HTTP data-bridge connection selected for one standalone profile. */
export interface EjunzAgentBridgeConfig {
  origin: string
  token: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Create config.agent.yaml from the shipped example, then validate its bridge values. */
export function loadEjunzAgentConfig(cwd: string = process.cwd()): EjunzAgentBridgeConfig {
  const configPath = resolve(cwd, 'config.agent.yaml')
  if (!existsSync(configPath)) {
    copyFileSync(EXAMPLE_PATH, configPath)
    console.info(`Created ${configPath} from ${EXAMPLE_PATH}; fill bridge.origin and bridge.token, then retry.`)
  }

  let document: unknown
  try {
    document = load(readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`profile-ejunz: ${configPath} is not valid YAML: ${String(error)}`)
  }
  const bridge = record(record(document)?.bridge)
  const origin = typeof bridge?.origin === 'string' ? bridge.origin.trim() : ''
  const token = typeof bridge?.token === 'string' ? bridge.token.trim() : ''
  if (origin === '' || token === '') {
    throw new Error(`profile-ejunz: fill bridge.origin and bridge.token in ${configPath}`)
  }
  return { origin, token }
}
