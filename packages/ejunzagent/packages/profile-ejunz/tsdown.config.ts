import { defineConfig } from 'tsdown'

/** The bundle carrier emits its Node entrypoints during the Host pass only. */
export default defineConfig(({ env }) => {
  if (env?.EA_BUILD_FACE === 'client') return { entry: '' }
  return {
    entry: {
      index: 'lib/types/index.js',
      invariant: 'lib/types/invariant.js',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
})
