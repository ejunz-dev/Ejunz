import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const root = import.meta.dirname
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  ea?: { modules?: Record<string, string> }
}
const entries = Object.fromEntries(
  Object.entries(manifest.ea?.modules ?? {}).map(([name, source]) => [`modules/${name}`, source]),
)

export default defineConfig({
  entry: entries,
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  deps: {
    alwaysBundle: ['@ejunz/cordis-plugin-include'],
    neverBundle: [/^@ejunz\/(?!cordis-plugin-include$)/],
  },
  fixedExtension: false,
  dts: false,
  clean: false,
})
