import { defineConfig } from 'tsdown'

/**
 * The CLI bin and embed surface each need a Node-runtime entry.
 * Build from source so `@ejunz/ea-core/*` stays a package subpath.
 * `@ejunz/profile-web` and `@ejunz/profile-ejunz` are inlined: this release
 * does not publish those packages, and consumers only install `@ejunz/ea-core`.
 */
export default defineConfig({
  entry: {
    bin: 'src/entry/bin.ts',
    embed: 'src/entry/embed.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  deps: {
    neverBundle: [/^@ejunz\/(?!profile-web(?:\/|$)|profile-ejunz(?:\/|$))/],
  },
  fixedExtension: false,
  dts: false,
  clean: false,
})
