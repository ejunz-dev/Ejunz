import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { clientBundle } from '../../src/service/client/tsdown.client.ts'

interface WebClientEntry {
  id: string
  entry: string
  clientFile: string
  platform: string
}

const packageDir = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8')) as {
  ea?: { clients?: WebClientEntry[] }
}
const clients = manifest.ea?.clients?.filter(client => client.platform === 'web') ?? []

/** Build every browser entrypoint declared by the consolidated Web package. */
export default defineConfig(({ env }) => clients.flatMap((client) => {
  const clientTypesEntry = client.entry
    .replace(/^src\//, 'lib/types/client/')
    .replace(/\.tsx?$/, '.js')
  return clientBundle(client.id, [], {
    clientOnly: true,
    clientSourceEntry: client.entry,
    clientTypesEntry,
    clientFile: client.clientFile,
    clientOutDir: 'lib/client',
  })({ env })
}))
