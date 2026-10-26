import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const sourceAppDirectory = join(moduleDirectory, '../..')
const bundledAppDirectory = join(moduleDirectory, '..')

/** Resolve an asset owned by the CLI package from source or bundled execution. */
export function cliAssetPath(relativePath: string): string {
  const sourcePath = join(sourceAppDirectory, relativePath)
  if (existsSync(sourcePath)) return sourcePath

  const bundledPath = join(bundledAppDirectory, relativePath)
  if (existsSync(bundledPath)) return bundledPath

  return sourcePath
}

/** Resolve the CLI package manifest from source or bundled execution. */
export function cliManifestPath(): string {
  return cliAssetPath('package.json')
}
