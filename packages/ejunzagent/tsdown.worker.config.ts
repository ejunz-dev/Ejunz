import { resolve } from 'node:path'
import { defineConfig } from 'tsdown'

const root = import.meta.dirname

/**
 * Worker entry for the worker-thread workflow engine. It is loaded by path
 * from inside a `Worker`, so it is a separate build: CommonJS (the packaged
 * runtime's VFS Worker hook compiles that format) and fully self-contained.
 *
 * The vendored packages ship declarations only in this checkout (`lib/` has no
 * runtime JS), so their sources are aliased in and bundled rather than left as
 * runtime imports the worker could not resolve.
 */
export default defineConfig({
  entry: { 'modules/worker': 'src/service/worker.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'node',
  target: 'es2024',
  alias: {
    '@ejunz/cordis': resolve(root, 'src/vendor/cordis/src/index.ts'),
    '@ejunz/cosmokit': resolve(root, 'src/vendor/cosmokit/src/index.ts'),
    '@ejunz/schemastery': resolve(root, 'src/vendor/schemastery/src/index.ts'),
    '@ejunz/cordis-plugin-group': resolve(root, 'src/vendor/group/src/index.ts'),
    '@ejunz/cordis-plugin-hmr': resolve(root, 'src/vendor/hmr/src/index.ts'),
    '@ejunz/cordis-plugin-include': resolve(root, 'src/vendor/include/src/index.ts'),
    '@ejunz/cordis-plugin-loader': resolve(root, 'src/vendor/loader/src/index.ts'),
    '@ejunz/cordis-plugin-logger-console': resolve(root, 'src/vendor/logger-console/src/index.ts'),
    '@ejunz/cordis-plugin-timer': resolve(root, 'src/vendor/timer/src/index.ts'),
  },
  deps: {
    alwaysBundle: [/^@ejunz\//],
  },
  fixedExtension: true,
  dts: false,
  clean: false,
})
