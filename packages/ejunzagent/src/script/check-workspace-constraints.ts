/**
 * Workspace package invariant checks for package-manager-independent quality
 * gates.
 *
 * Run: `tsx src/script/check-workspace-constraints.ts`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { hasTypertRemoteNavigation, isForbiddenPublicationFile } from './publication-payload.ts'
import { collectProjectReferenceFaceViolations } from './project-reference-faces.ts'

const root = resolve(import.meta.dirname, '../..')
// Vendored packages are one level below src/vendor; source packages nest three levels.
const workspaceGlobs = [
  { dir: 'src/vendor', depth: 1 },
  { dir: 'src', depth: 3 },
] as const
const vendoredPackages = new Set([
  '@ejunz/cordis',
  '@ejunz/cosmokit',
  '@ejunz/schemastery',
  '@ejunz/cordis-plugin-loader',
  '@ejunz/cordis-plugin-include',
  '@ejunz/cordis-plugin-group',
  '@ejunz/cordis-plugin-timer',
  '@ejunz/cordis-plugin-hmr',
  '@ejunz/cordis-plugin-logger-console',
])
/** Source home the published packages point consumers at. */
const publishedRepositoryUrl = 'git+https://github.com/ejunz-dev/ejunz-agent.git'
/** Directories whose packages this repository publishes: one release member each. */
const releaseMemberDirectory = /^(?:\.|src\/[^/]+\/[^/]+\/[^/]+|src\/vendor\/[^/]+)$/

const localArtifactDirs = new Set(['node_modules'])
const appPackageFiles: Readonly<Record<string, readonly string[]>> = {
  '@ejunz/ea': ['bin/ea.js', 'bin/postinstall.js', 'lib/*.js', 'config'],
  // The Web build emits sourcemaps for browser debugging; publishing them is
  // what the payload policy forbids, so the bundle ships without them.
  '@ejunz/web-frontend': ['dist', '!dist/**/*.map'],
  '@ejunz/agent-desktop': ['electron/**', 'landing/**'],
}

/** The subset of package.json fields this constraint check cares about. */
interface PackageManifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: Record<
    string,
    | string
    | {
      types?: string
      default?: string
    }
    | null
    | undefined
  >
  files?: string[]
  publishConfig?: { access?: string }
  repository?: { type?: string; url?: string; directory?: string }
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** One workspace manifest and its repo-relative path. */
interface WorkspaceManifest {
  dir: string
  manifest: PackageManifest
}

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

const rootManifest = readJson(join(root, 'package.json'))
const repositoryVersion = rootManifest.version

/** Repo-relative dirs holding a package.json, walked to the configured depth. */
function packageDirs(base: string, depth: number): string[] {
  if (depth === 1) {
    return readdirSync(join(root, base), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .filter(entry => !localArtifactDirs.has(entry.name))
      .filter(entry => existsSync(join(root, base, entry.name, 'package.json')))
      .map(entry => `${base}/${entry.name}`)
  }
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => !localArtifactDirs.has(entry.name))
    .filter(entry => base !== 'src' || entry.name !== 'vendor')
    .flatMap(group => packageDirs(`${base}/${group.name}`, depth - 1))
}

function workspaceManifests(): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [
    { dir: '.', manifest: rootManifest },
  ]

  for (const { dir: base, depth } of workspaceGlobs) {
    for (const dir of packageDirs(base, depth)) {
      manifests.push({ dir, manifest: readJson(join(root, dir, 'package.json')) })
    }
  }

  return manifests
}

const packageFileExtras: Readonly<Record<string, readonly string[]>> = {
  // The published bin shim delegates to this built CLI entry.
  '@ejunz/ea': ['bin/postinstall.js', 'lib/bin.js'],
  // Profile bundles publish their ea.bundle.patch layer beside the lib.
  '@ejunz/base': ['cordis.patch.yml'],
  '@ejunz/web-app': ['cordis.patch.yml'],
  '@ejunz/headless': ['cordis.patch.yml'],
  // The Python runtime uses a distinct closed-resolution bin; the public bin
  // shim delegates to lib/bin.js for config-owned bare-package resolution.
  '@ejunz/sdk-jsonrpc-demo': ['lib/packaged-bin.js'],
  '@ejunz/skill-badge': ['assets'],
}

function sameStringList(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return !!actual && actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function binFiles(bin: PackageManifest['bin']): string[] {
  if (typeof bin === 'string') return [bin]
  return bin ? Object.values(bin) : []
}

function expectedEaPackageFiles(manifest: PackageManifest): readonly string[] {
  const extras = manifest.name ? packageFileExtras[manifest.name] ?? []
  return [
    'lib/index.js',
    // Every package publishes its invariant ownership companion as a separate
    // bundle; the package-invariant gate validates the companion itself.
    'lib/invariant.js',
    ...binFiles(manifest.bin),
    ...manifest.exports?.['./worker'] ? ['lib/worker.cjs'] : [],
    // UI plugin packages ship their browser bundle beside the node lib
    // (single-artifact ruling: dist/ retired, ./client resolves lib/client.js).
    // Keyed on the artifact path, not the subpath name: apiproxy's ./client is
    // a browser-safe source channel, not a bundle.
    ...exportDefault(manifest, './client') === './lib/client.js' ? ['lib/client.js'] : [],
    // Runtime's loader subpath ships as its own bundle beside the client half.
    ...exportDefault(manifest, './loader') === './lib/loader.js' ? ['lib/loader.js'] : [],
    // web-react's store subpath ships its own bundle (single-entry builds; no shared chunk).
    ...exportDefault(manifest, './store') === './lib/store/index.js' ? ['lib/store/index.js'] : [],
    // A surface bundle's startup row is its own bundle: the Loader imports it
    // as a row module, so it cannot ride inside the package entry.
    ...exportDefault(manifest, './startup') === './lib/startup.js' ? ['lib/startup.js'] : [],
    ...extras,
    // Subpaths whose runtime default is the tsc-emitted tree (lib/types/*.js —
    // browser-safe source channels rehomed off src so plain Node can import
    // them without type stripping) publish the emitted JS alongside the
    // declarations.
    ...usesEmittedTreeDefaults(manifest) ? ['lib/types/**/*.js'] : [],
    'lib/types/**/*.d.ts',
    ...hasExportPair(manifest, './typert', './lib/typert.host.d.ts', './lib/typert.host.js')
      ? ['lib/typert.host.js', 'lib/typert.host.d.ts']
      : [],
    ...hasExportPair(manifest, './client/typert', './lib/typert.client.d.ts', './lib/typert.client.js')
      ? ['lib/typert.client.js', 'lib/typert.client.d.ts']
      : [],
    ...hasTypertRemoteNavigation(manifest)
      ? ['lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts']
      : [],
  ]
}

/** Whether one conditional export exactly names the generated runtime and declaration pair. */
function hasExportPair(
  manifest: PackageManifest,
  subpath: string,
  types: string,
  runtime: string,
): boolean {
  const entry = manifest.exports?.[subpath]
  return typeof entry === 'object'
    && entry !== null
    && entry.types === types
    && entry.default === runtime
}

/** Runtime target of an export entry: conditional `default`, or the bare-string shorthand. */
function exportDefault(manifest: PackageManifest, subpath: string): string | undefined {
  const entry = manifest.exports?.[subpath]
  if (typeof entry === 'string') return entry
  if (typeof entry === 'object' && entry !== null) return entry.default
  return undefined
}

/** Whether any export's runtime default points into the tsc-emitted lib/types tree. */
function usesEmittedTreeDefaults(manifest: PackageManifest): boolean {
  return Object.keys(manifest.exports ?? {}).some(subpath =>
    exportDefault(manifest, subpath)?.startsWith('./lib/types/') === true)
}

function checkWorkspace({ dir, manifest }: WorkspaceManifest): string[] {
  const errors: string[] = []
  const label = manifest.name ?? dir

  if (releaseMemberDirectory.test(dir)) {
    // Release members state that they are publishable: npm refuses a private
    // package, and the repository field is how a consumer finds the source of
    // the package it installed.
    //
    // Access is per release sequence, not per scope: the vendored framework and
    // the Landlock packages publish publicly because outside consumers install
    // them, while the ea family stays restricted until its own sequence goes
    // public. A mixed scope is why no publish path passes `--access` — one flag
    // cannot serve both, so each packed manifest decides
    // ([rationale](../.agents/notes/implemented/process/2026-08-13-public-vendor-and-native-sequences.md)).
    if (manifest.private === true) {
      errors.push(`${label}: release member must not set "private": true`)
    }
    if (manifest.publishConfig?.access !== 'public') {
      errors.push(`${label}: release member must set publishConfig.access to "public"`)
    }
    if (manifest.repository?.type !== 'git'
      || manifest.repository.url !== publishedRepositoryUrl
      || manifest.repository.directory !== dir) {
      errors.push(`${label}: release member repository must use ${publishedRepositoryUrl} with directory ${dir}`)
    }
  } else if (manifest.private !== true) {
    errors.push(`${label}: package.json must set "private": true`)
  }

  if (manifest.name && vendoredPackages.has(manifest.name)) {
    return errors
  }

  if (manifest.name?.startsWith('@ejunz/')) {
    for (const file of manifest.files ?? []) {
      if (isForbiddenPublicationFile(file)) {
        errors.push(`${label}: package.json files must not publish ${JSON.stringify(file)}`)
      }
    }
  }

  if (dir === '.' && manifest.name?.startsWith('@ejunz/')) {
    const expectedFiles = appPackageFiles[manifest.name]
    if (expectedFiles === undefined) {
      errors.push(`${label}: CLI package has no publication files policy`)
    } else if (!sameStringList(manifest.files, expectedFiles)) {
      errors.push(`${label}: package.json files must be ${JSON.stringify(expectedFiles)}`)
    }
  }

  if (dir.startsWith('src/') && manifest.name?.startsWith('@ejunz/')) {
    const peer = manifest.peerDependencies?.['@ejunz/cordis']
    const dev = manifest.devDependencies?.['@ejunz/cordis']

    if (!peer) errors.push(`${label}: @ejunz/cordis must be a peerDependency`)
    if (!dev) errors.push(`${label}: @ejunz/cordis must also be a devDependency`)
    if (peer && dev && peer !== dev) {
      errors.push(`${label}: @ejunz/cordis peer (${peer}) and dev (${dev}) ranges must match`)
    }
    if (manifest.version !== repositoryVersion) {
      errors.push(`${label}: package.json version must match root version ${repositoryVersion ?? '(missing)'}`)
    }
    if (manifest.type !== 'module') {
      errors.push(`${label}: package.json must set "type": "module"`)
    }
    if (manifest.main !== 'lib/index.js') {
      errors.push(`${label}: package.json must set "main": "lib/index.js"`)
    }
    if (manifest.types !== 'lib/types/index.d.ts') {
      errors.push(`${label}: package.json must set "types": "lib/types/index.d.ts"`)
    }
    const rootExport = manifest.exports?.['.']
    const rootEntry = typeof rootExport === 'object' && rootExport !== null ? rootExport : undefined
    if (rootEntry?.types !== './lib/types/index.d.ts') {
      errors.push(`${label}: package.json exports["."].types must be "./lib/types/index.d.ts"`)
    }
    if (rootEntry?.default !== './lib/index.js') {
      errors.push(`${label}: package.json exports["."].default must be "./lib/index.js"`)
    }
    const invariantRaw = manifest.exports?.['./invariant']
    const invariantExport = typeof invariantRaw === 'object' && invariantRaw !== null ? invariantRaw : undefined
    if (invariantExport?.types !== undefined && invariantExport.types !== './lib/types/invariant.d.ts') {
      errors.push(`${label}: package.json exports["./invariant"].types must be "./lib/types/invariant.d.ts"`)
    }
    if (invariantExport?.default !== undefined && invariantExport.default !== './lib/invariant.js') {
      errors.push(`${label}: package.json exports["./invariant"].default must be "./lib/invariant.js"`)
    }
    if (invariantExport && (invariantExport.types === undefined || invariantExport.default === undefined)) {
      errors.push(`${label}: package.json exports["./invariant"] must declare both types and default targets`)
    }
    const expectedFiles = expectedEaPackageFiles(manifest)
    if (!sameStringList(manifest.files, expectedFiles)) {
      errors.push(`${label}: package.json files must be ${JSON.stringify(expectedFiles)}`)
    }
  }

  return errors.map(error => `${relative(root, join(root, dir, 'package.json'))}: ${error}`)
}

/**
 * Enforce `src/<layer>/<group>/<pkg>`: groups are open-named containers without a
 * package.json, and packages may be neither flat nor more deeply nested.
 */
function checkHierarchyShape(): string[] {
  const errors: string[] = []
  const sourceRoot = join(root, 'src')
  for (const layer of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!layer.isDirectory() || ['script', 'tools'].includes(layer.name)) continue
    const layerRoot = join(sourceRoot, layer.name)
    for (const group of readdirSync(layerRoot, { withFileTypes: true })) {
      if (!group.isDirectory() || localArtifactDirs.has(group.name)) continue
      const groupRoot = join(layerRoot, group.name)
      if (existsSync(join(groupRoot, 'package.json'))) {
        errors.push(`${relative(root, groupRoot)}: a family directory must not contain a package.json — packages live at src/<layer>/<family>/<package>`)
        continue
      }
      for (const pkg of readdirSync(groupRoot, { withFileTypes: true })) {
        if (!pkg.isDirectory() || localArtifactDirs.has(pkg.name)) continue
        const pkgRoot = join(groupRoot, pkg.name)
        if (!existsSync(join(pkgRoot, 'package.json'))) {
          errors.push(`${relative(root, pkgRoot)}: expected a package here (no package.json found) — the hierarchy is exactly src/<layer>/<family>/<package>`)
        }
      }
    }
  }
  return errors
}

function checkRepositoryVersion(): string[] {
  // The root carries the ea release family's version, so a prerelease such as
  // 0.0.1-rc.1 is a valid state between `release:ea` and its publication.
  if (repositoryVersion && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(repositoryVersion)) return []
  return ['package.json: version must be X.Y.Z with an optional prerelease segment']
}

/** Dependency sections whose ranges reach a published tarball or a local install. */
const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/**
 * Require the `workspace:` protocol for every reference to a workspace member.
 *
 * A hand-written range says nothing about the version the workspace actually
 * carries, and `yarn pack` leaves it alone: `^0.0.1` published from version
 * `0.0.2` names a version that does not exist. The protocol makes pack
 * substitute the member's real version, so no release step rewrites ranges.
 * @param manifests - every workspace manifest.
 * @returns One error per reference that names a workspace member without the protocol.
 */
function checkWorkspaceProtocol(manifests: readonly WorkspaceManifest[]): string[] {
  const members = new Set(manifests.map(entry => entry.manifest.name).filter(name => name !== undefined))
  const errors: string[] = []
  for (const { dir, manifest } of manifests) {
    for (const section of dependencySections) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (!members.has(name) || range.startsWith('workspace:')) continue
        errors.push(`${manifest.name ?? dir}: ${section}.${name} must use the workspace: protocol, got ${range}`)
      }
    }
  }
  return errors
}

const manifests = workspaceManifests()
const errors = [
  ...checkRepositoryVersion(),
  ...manifests.flatMap(checkWorkspace),
  ...checkWorkspaceProtocol(manifests),
  ...checkHierarchyShape(),
  ...collectProjectReferenceFaceViolations(root),
]
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
