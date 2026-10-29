import { readFile } from 'node:fs/promises'

import { join } from 'node:path'

import yaml from 'js-yaml'

export const METADATA_FILE = 'preset.yml'

export interface PresetMetadata {
  /** Human-facing name; falls back to the preset id when absent. */
  readonly name?: string
  /** One sentence on what this preset is for. */
  readonly description?: string
  /**
   * Position within its group; lower comes first. A preset that declares
   * none sorts after every preset that does, then by id — so the shipped set
   * can read in capability order while authored ones stay alphabetical.
   */
  readonly order?: number
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

export async function readPresetMetadata(directory: string): Promise<PresetMetadata> {
  let raw: string
  try {
    raw = await readFile(join(directory, METADATA_FILE), 'utf8')
  } catch {
    // Absent is the common case: metadata is optional and most presets,
    // including every one authored by duplicating another, carry none.
    return {}
  }
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch {
    // Malformed display text is not worth failing discovery over; the picker
    // falls back to the id, and the composition still mounts.
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const name = text(record.name)
  const description = text(record.description)
  const order = typeof record.order === 'number' && Number.isFinite(record.order)
    ? record.order
    : undefined
  return {
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
  }
}

export function renderPresetMetadata(metadata: PresetMetadata): string | undefined {
  const name = text(metadata.name)
  const description = text(metadata.description)
  const { order } = metadata
  if (name === undefined && description === undefined && order === undefined) return undefined
  return yaml.dump({
    ...name === undefined ? {} : { name },
    ...description === undefined ? {} : { description },
    ...order === undefined ? {} : { order },
  }, { lineWidth: -1 })
}

export type PresetTrust = 'system' | 'user'

export const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

export interface AgentPreset {
  /** Stable identifier; the preset directory's name. */
  readonly id: string
  /** Trust recorded from the root this preset was discovered under. */
  readonly trust: PresetTrust
  /** Absolute path of the preset's agent composition file. */
  readonly path: string
  /** Display name from the preset's own metadata; absent falls back to {@link id}. */
  readonly name?: string
  /** One sentence on what this preset is for, when it published one. */
  readonly description?: string
  /** Declared position within its group; absent sorts after those that declare one. */
  readonly order?: number
  /**
   * Why this preset cannot compose a session, absent when it can. A broken
   * preset stays on the roster — hiding it would leave its directory blocking
   * the id with nothing to see or delete — but every mounting path refuses it
   * up front with this reason instead of failing deep inside the loader.
   */
  readonly broken?: string
}

export interface PresetRoot {
  /** Directory holding one subdirectory per preset; a leading `~` expands. */
  path: string
  /** Trust recorded on every preset discovered under this root. */
  trust: PresetTrust
}

export interface Config {
  /** Preset id mounted when a caller names none. Missing at mount time fails loud. */
  default: string
  /** Scanned roots in precedence order; an earlier root wins a duplicate id. */
  roots: PresetRoot[]
  /**
   * Append the ejunzAgent home's `USER_PRESET_DIR` as a `user` root, after every
   * configured root. False mounts a roster over `roots` alone.
   */
  includeUserRoot: boolean
}

export class UnknownPresetError extends Error {
  constructor(
    /** The id that was requested. */
    readonly presetId: string,
    /** Ids the roster does supply, for the caller to offer instead. */
    readonly available: readonly string[],
  ) {
    super(`agent-presets: preset "${presetId}" not found (available: ${available.join(', ') || 'none'})`)
  }
}

export class PresetMountError extends Error {
  constructor(
    /** The preset whose composition failed. */
    readonly presetId: string,
    /** Why it failed, without this package's own message prefix. */
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`agent-presets: preset "${presetId}" failed to mount: ${reason}`, options)
  }
}

import { chmod, cp, readdir, readFile, rm, stat } from 'node:fs/promises'

import { dirname, isAbsolute, join, resolve } from 'node:path'

import { writeFileAtomic } from '@ejunz/ea-core/atomic-write'

import { expandHomePath } from '@ejunz/ea-core/home-paths'

export class InvalidPresetIdError extends Error {
  constructor(
    /** The rejected id. */
    readonly presetId: string,
  ) {
    super(
      `agent-presets: preset id ${JSON.stringify(presetId)} must match ${String(PRESET_ID)} — `
      + 'the id is a directory name, so anything else could escape the preset root',
    )
  }
}

export class PresetExistsError extends Error {
  constructor(
    /** The id that is already taken. */
    readonly presetId: string,
  ) {
    super(
      `agent-presets: preset "${presetId}" already exists — `
      + 'a copy never overwrites; delete the existing preset first or choose another id',
    )
  }
}

export class PresetNotWritableError extends Error {
  constructor(
    /** What the caller tried to change, for the diagnostic. */
    readonly presetId: string,
    reason: string,
  ) {
    super(`agent-presets: preset "${presetId}" cannot be written: ${reason}`)
  }
}

export function writableRoot(roots: readonly PresetRoot[]): string {
  const root = roots.find(candidate => candidate.trust === 'user')
  if (root === undefined) {
    throw new PresetNotWritableError('', 'this deployment configures no user-writable preset root')
  }
  return resolve(expandHomePath(root.path))
}

export async function readComposition(preset: AgentPreset): Promise<string> {
  return await readFile(preset.path, 'utf8')
}

async function occupied(path: string): Promise<boolean> {
  let present = true
  try {
    await stat(path)
  } catch {
    // Every stat failure means the same thing here: nothing usable occupies
    // the path, so the copy may claim it.
    present = false
  }
  return present
}

async function tightenModes(dir: string): Promise<void> {
  await chmod(dir, 0o700)
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) {
      await tightenModes(target)
    } else {
      /* v8 ignore next -- Windows exposes no POSIX owner-execute bit; the POSIX lane covers both file modes. */
      await chmod(target, ((await stat(target)).mode & 0o100) === 0 ? 0o600 : 0o700)
    }
  }
}

export async function copyComposition(
  roots: readonly PresetRoot[],
  source: AgentPreset,
  id: string,
  name?: string,
): Promise<string> {
  if (!PRESET_ID.test(id)) throw new InvalidPresetIdError(id)
  const dir = join(writableRoot(roots), id)
  // The roster check upstream only sees discovered presets; a directory with
  // no composition file still occupies the name and deserves a readable
  // refusal rather than a filesystem error code.
  if (await occupied(dir)) throw new PresetExistsError(id)
  try {
    await cp(dirname(source.path), dir, {
      recursive: true, dereference: true, force: false, errorOnExist: true,
    })
    await tightenModes(dir)
    const rendered = renderPresetMetadata({
      ...name === undefined ? {} : { name },
      ...source.description === undefined ? {} : { description: source.description },
    })
    const metadataPath = join(dir, METADATA_FILE)
    if (rendered === undefined) {
      await rm(metadataPath, { force: true })
    } else {
      await writeFileAtomic(metadataPath, rendered, { mode: 0o600, dirMode: 0o700 })
    }
  } catch (error) {
    // A half-copied directory would be invisible to discovery at best and a
    // mountable-but-incomplete preset at worst; a failed copy leaves nothing.
    await rm(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

export async function deleteComposition(
  roots: readonly PresetRoot[],
  preset: AgentPreset,
): Promise<void> {
  if (preset.trust !== 'user') {
    throw new PresetNotWritableError(preset.id, 'it ships with the deployment')
  }
  const dir = join(writableRoot(roots), preset.id)
  // Belt and braces over the id pattern: the resolved directory must still be
  // the one the writable root owns, whatever discovery reported.
  if (!isAbsolute(preset.path) || !preset.path.startsWith(dir)) {
    throw new PresetNotWritableError(preset.id, 'it does not live under the writable preset root')
  }
  await rm(dir, { recursive: true, force: true })
}

import { readdir, readFile, stat } from 'node:fs/promises'

import { join, resolve } from 'node:path'

import { load } from 'js-yaml'

import { entryListSchema } from '@ejunz/cordis-plugin-include'

import { expandHomePath } from '@ejunz/ea-core/home-paths'

export const COMPOSITION_FILE = 'agent.cordis.yml'

export const USER_PRESET_DIR = '.agent-presets'

function entryListProblem(rows: unknown, at = ''): string | undefined {
  if (!Array.isArray(rows)) {
    return at === ''
      ? 'the composition must be a top-level list of plugin rows'
      : `group ${at} must hold a list of plugin rows`
  }
  for (const [index, row] of rows.entries()) {
    const label = at === '' ? `row ${String(index + 1)}` : `${at} row ${String(index + 1)}`
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return `${label} is not a plugin row (expected a map with a "name")`
    }
    const { name, group, config } = row as { name?: unknown; group?: unknown; config?: unknown }
    if (typeof name !== 'string' || name === '') {
      return `${label} names no plugin (a "name" string is required)`
    }
    if (group === true) {
      const nested = entryListProblem(config, label)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function compositionProblem(path: string): Promise<string | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    // The caller statted this file moments ago; any read failure now —
    // deleted in between, permissions — is the same answer as unparsable.
    return `the composition file ${COMPOSITION_FILE} cannot be read`
  }
  let rows: unknown
  try {
    rows = load(content, { schema: entryListSchema })
  } catch (error) {
    /* v8 ignore next -- js-yaml throws YAMLException (an Error) for every parse failure; the fallback keeps a hostile value readable */
    const full = error instanceof Error ? error.message : String(error)
    // First line only: js-yaml appends a multi-line code-frame snippet, and
    // the reason is displayed on a roster card, not in a terminal.
    return `the composition is not valid YAML: ${full.replace(/\n[\s\S]*$/, '')}`
  }
  return entryListProblem(rows)
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // Any stat failure — absent, unreadable, a dangling link — means this
    // directory does not present a composition, which is not an error: the
    // directory simply is not a preset.
    return false
  }
}

export async function scanRoot(root: PresetRoot): Promise<AgentPreset[]> {
  const dir = resolve(expandHomePath(root.path))
  let children
  try {
    children = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`agent-presets: cannot read preset root ${dir}: ${String(error)}`, { cause: error })
  }
  const found: AgentPreset[] = []
  for (const child of children) {
    if (!child.isDirectory() || !PRESET_ID.test(child.name)) continue
    const directory = join(dir, child.name)
    const path = join(directory, COMPOSITION_FILE)
    const broken = await isFile(path)
      ? await compositionProblem(path)
      : `the composition file ${COMPOSITION_FILE} is missing — the directory still occupies the id; delete it or restore the file`
    // Display text only, and never fatal: a preset with unreadable metadata
    // still mounts, it just shows its id.
    const metadata = await readPresetMetadata(directory)
    found.push({
      id: child.name, trust: root.trust, path, ...metadata,
      ...broken === undefined ? {} : { broken },
    })
  }
  // Declared order first so the shipped set reads by capability; everything
  // else falls back to the id, which keeps authored presets stable.
  return found.sort((left, right) => {
    const byOrder = (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY)
    return byOrder === 0 ? left.id.localeCompare(right.id) : byOrder
  })
}

export async function discoverPresets(roots: readonly PresetRoot[]): Promise<AgentPreset[]> {
  const byId = new Map<string, AgentPreset>()
  for (const root of roots) {
    for (const preset of await scanRoot(root)) {
      if (byId.has(preset.id)) continue
      byId.set(preset.id, preset)
    }
  }
  return [...byId.values()]
}

import { isAbsolute } from 'node:path'

import { pathToFileURL } from 'node:url'

import { Context, type Fiber } from '@ejunz/cordis'

import { Include } from '@ejunz/cordis-plugin-include'

import type { EntryTree } from '@ejunz/cordis-plugin-loader'

import { scopeOf, scopeParentOf, type ScopeKey } from '@ejunz/ea-core/scope'

interface MountedTree {
  /** The rows the composition created. */
  readonly tree: EntryTree
  /**
   * The subtree's own fiber. Captured here rather than taken from
   * `ctx.plugin()`, which hands back a thenable `Object.create(fiber)` wrapper
   * that is never identical to the fiber appearing in a parent chain.
   */
  readonly fiber: Fiber
}

const mounted = new WeakMap<object, MountedTree>()

const ejunzAgentBase = new WeakMap<object, string>()

class PresetTree extends Include {
  constructor(ctx: Context, config: Include.Config) {
    super(ctx, config)
    mounted.set(config, { tree: this, fiber: ctx.fiber })
  }

  /**
   * Resolve a bare specifier from the ejunzAgent rather than from the preset.
   *
   * `EntryTree.import()` resolves against the tree's own `baseUrl`, which
   * `Include` sets to the composition's directory. That is right for a
   * relative specifier — a preset's own files travel with it — and wrong for
   * a package name: a locally authored preset lives under the user's home,
   * where Node's upward `node_modules` walk never reaches the ejunzAgent's own
   * dependencies, so every `@ejunz/*` row would fail to import. The
   * mount records the host composition's base instead, which is inside the
   * installed ejunzAgent, and bare names resolve from there. An absolute
   * filesystem path names neither base and becomes a file URL before Node's
   * ESM loader receives it, which is required for drive-letter paths on
   * Windows.
   * @param name - the module specifier from the row.
   * @param getOuterStack - the loader's stack composer for import diagnostics.
   * @returns the imported module, or the `cordis:` builtin.
   */
  override import(name: string, getOuterStack?: () => string[]): unknown {
    const specifier = isAbsolute(name) ? pathToFileURL(name).href : name
    const base = ejunzAgentBase.get(this.config)
    /* v8 ignore next -- every PresetTree is constructed by `mountPreset`, which records the base first */
    if (base === undefined) return super.import(specifier, getOuterStack)
    if (name.startsWith('.') || name.startsWith('cordis:')) return super.import(name, getOuterStack)
    const internal = this.ctx.loader.internal
    /* v8 ignore next -- Node always supplies the internal module loader; the branch keeps a
       hypothetical embedder from losing the row's name in a resolution error. */
    if (internal === undefined) return super.import(specifier, getOuterStack)
    return internal.import(specifier, base, {})
  }

  /**
   * A preset is an input, never a persistence target.
   *
   * The Loader writes a tree back through this method whenever it decides the
   * config changed — a plugin self-disposing is enough, and tearing an agent
   * down disposes its whole subtree. Inherited, that rewrites the preset file
   * with whatever the dying tree held, which in practice means truncating a
   * shipped composition to `[]` the first time a session ends. Persisting a
   * preset is also meaningless: nothing here is user state, and the same file
   * backs every session that names it.
   *
   * Dropping the write drops the `loader/config-update` the inherited method
   * emits with it. Nothing observes one for a preset subtree today, and a
   * future "edit your preset while it runs" flow needs a deliberate
   * persistence path rather than this method's return.
   */
  override write(): void {
  }
}

export interface PresetMount {
  /** The preset the subtree was composed from. */
  readonly presetId: string
  /** The mounted subtree's fiber. */
  readonly fiber: Fiber
  /** The standing scope key agents are parented to (undefined only in torn-down records). */
  readonly key: ScopeKey | undefined
}

const mounts = new Set<PresetMount>()

function pruneDisposedMounts(): void {
  for (const mount of mounts) {
    if (mount.fiber.uid === null) mounts.delete(mount)
  }
}

export function livePresetMounts(): PresetMount[] {
  pruneDisposedMounts()
  return [...mounts]
}

function withinFiber(fiber: Fiber, root: Fiber): boolean {
  let current = fiber
  while (true) {
    if (current === root) return true
    const parent = current.parent.fiber
    if (parent === current) return false
    current = parent
  }
}

export function leakedServices(ctx: Context, mount: Fiber): string[] {
  const store = ctx.reflect.store
  const rootIsolate = ctx.root[Context.isolate]
  const leaked: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than
       clearing it, so an own symbol always resolves; the guard exists only
       because the store's index signature is optional. */
    if (impl === undefined) continue
    if (!withinFiber(impl.fiber, mount)) continue
    if (rootIsolate[impl.name] === key) leaked.push(impl.name)
  }
  return leaked.sort((left, right) => left.localeCompare(right))
}

export type JoinedPresetMount = PresetMount & {
  /** The standing key, definite because it is what the lookup matched on. */
  readonly key: ScopeKey
}

export function standingMountFor(agentCtx: Context): JoinedPresetMount | undefined {
  const agentKey = scopeOf(agentCtx)
  if (agentKey === undefined) return undefined
  const standingKey = scopeParentOf(agentKey)
  if (standingKey === undefined) return undefined
  return livePresetMounts().find(
    (candidate): candidate is JoinedPresetMount => candidate.key === standingKey,
  )
}

export function serviceForAgent<K extends string & keyof Context>(
  ctx: Context,
  agent: { ctx: Context },
  name: K,
): Context[K] | undefined {
  const mount = standingMountFor(agent.ctx)
  if (mount === undefined) return undefined
  const store = ctx.reflect.store
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    /* v8 ignore next -- cordis deletes a store slot on disposal rather than clearing it */
    if (impl === undefined) continue
    if (impl.name !== name) continue
    if (withinFiber(impl.fiber, mount.fiber)) return impl.value as Context[K]
  }
  return undefined
}

export function inactiveRows(tree: EntryTree): string[] {
  const lines: string[] = []
  for (const entry of tree.entries()) {
    if (entry.disabled) continue
    const fiber = entry.fiber
    /* v8 ignore next 4 -- the loader rejects an entry whose module or plugin failed,
       so a settled tree never holds an enabled fiber-less entry; the branch exists
       only because `Entry.fiber` is declared optional. */
    if (fiber === undefined) {
      lines.push(`${entry.options.id} (${entry.options.name}): never started`)
      continue
    }
    const missing = Object.keys(fiber.inject).filter(name => fiber.ctx.get(name) === undefined)
    if (missing.length > 0) {
      lines.push(`${entry.options.id} (${entry.options.name}): waiting for ${missing.join(', ')}`)
    }
  }
  return lines
}

function mountDetail(error: unknown): string {
  /* v8 ignore next -- every path into the mount's catch throws an Error: the loader
     wraps a row's thrown value before it propagates, and this module's own
     rejections are Errors. The fallback keeps a hostile value readable. */
  if (!(error instanceof Error)) return String(error)
  if (!(error instanceof AggregateError)) return error.message
  return [error.message, ...error.errors.map(cause => `- ${mountDetail(cause)}`)].join('\n')
}

export async function mountPreset(agentCtx: Context, preset: AgentPreset): Promise<void> {
  const scope = scopeOf(agentCtx)
  if (scope === undefined) {
    throw new Error(
      `agent-presets: refusing to mount preset "${preset.id}" into an unscoped context; `
      + 'its registrations would apply to every agent in the process',
    )
  }
  const config: Include.Config = { path: pathToFileURL(preset.path).href }
  // Captured before the subtree exists: the standing scope context still
  // carries the host composition's base, which is inside the installed
  // ejunzAgent and is therefore where a row's package name has to resolve from.
  /* v8 ignore next -- the Loader sets `baseUrl` on the root before any scoped context derives from it */
  if (agentCtx.baseUrl !== undefined) ejunzAgentBase.set(config, agentCtx.baseUrl)
  // Before the record this mount is about to add: standing mounts are one per
  // preset and live until whole-tree teardown, so pruning here only sweeps
  // records of torn-down runtimes (tests; an HMR reload of the roster).
  pruneDisposedMounts()
  const handle = agentCtx.plugin(PresetTree, config)
  try {
    await handle.await()
    const subtree = mounted.get(config)
    /* v8 ignore next -- the subclass constructor runs before `await()` settles for every mounted tree */
    if (subtree === undefined) throw new Error('mounted subtree did not publish its entry tree')
    const { tree, fiber } = subtree
    const unusable = inactiveRows(tree)
    if (unusable.length > 0) {
      throw new Error(`${String(unusable.length)} row(s) did not activate:\n${unusable.join('\n')}`)
    }
    const leaked = leakedServices(agentCtx, fiber)
    if (leaked.length > 0) {
      throw new Error(
        `row(s) published process-global service(s) [${leaked.join(', ')}]; `
        + 'a preset service must sit behind an `isolate` realm or move to the host composition',
      )
    }
    mounts.add({ presetId: preset.id, fiber, key: scopeOf(agentCtx) })
  } catch (error) {
    try {
      await handle.dispose()
    /* v8 ignore next 5 -- teardown of a subtree nothing else references has no
       observed failure mode; the guard exists so a teardown error cannot
       replace the mount diagnostic the caller needs. */
    } catch {
      // Swallows only this subtree's teardown failure. The mount error below is
      // the actionable one, and the discarded fiber is unreachable either way.
    }
    throw new PresetMountError(preset.id, `${mountDetail(error)} (${preset.path})`, { cause: error })
  }
}

import type { SessionId } from '@ejunz/ea-core/session/types'

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * One session committed a different agent preset to its durable log.
     * Consumers invalidate only state derived from that session's composition.
     * @mode emit
     * @param sessionId - the session whose composition changed.
     * @param agentPreset - the preset recorded by the committed selection.
     */
    'agent-preset/selected'(sessionId: SessionId, agentPreset: string): void
  }
}

export {}

import type { SessionEvent, SessionHeader } from '@ejunz/ea-core/session'

declare module '@ejunz/ea-core/session/types' {
  interface SessionEventMap {
    /**
     * The session's agent preset was chosen after creation, while the session
     * was still blank. Log-only: it records the composition later turns ran
     * under, so a resumed or forked session rebuilds the same one instead of
     * the header's creation-time value.
     */
    'agent-preset/selected': { agentPreset: string }
  }
}

export interface PresetBearingSession {
  /** The session's creation header. */
  readonly header: SessionHeader
  /** The session's event log, oldest first. */
  readonly events: readonly SessionEvent[]
}

export function resolveSessionPreset(session: PresetBearingSession): string | undefined {
  for (let index = session.events.length - 1; index >= 0; index -= 1) {
    const event = session.events[index]
    if (event?.type === 'agent-preset/selected') return event.data.agentPreset
  }
  return session.header.agentPreset
}

import { stat } from 'node:fs/promises'

import { Context, Service } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { bindScopeParent, createScope, scopeOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@ejunz/ea-core/scope'

import type {} from '@ejunz/ea-core/agent'

import { settingsNamespace, type SettingsScope, type default as SettingsService } from '@ejunz/ea-core/settings'

import { eaHomePath } from '@ejunz/ea-core/home-paths'

export const SETTINGS_NAMESPACE = 'agent-presets'

export interface AgentPresetSettings {
  /** Preset mounted when a session names none. */
  default?: string
}

export const AgentPresetSettingsSchema: z<AgentPresetSettings> = z.object({
  default: z.string(),
})

declare module '@ejunz/cordis' {
  interface Context {
    agentPresets: AgentPresets
  }
}

export class AgentPresets extends Service {
  static inject = ['loader']

  /** Runtime schema for the preset roster. */
  static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeUserRoot: z.boolean().default(true),
  }) as z<Config>

  /**
   * The roots discovery and authoring actually scan: every configured root in
   * order, then the ejunzAgent-home user root unless `includeUserRoot` is false.
   *
   * Derived once, because a root set that changed between `list()` and the
   * `copy()` acting on its answer would author into a directory the caller
   * never saw. Appending rather than prepending keeps an earlier configured
   * root winning a duplicate id, so a shipped preset still shadows a
   * locally authored directory that claimed its name.
   */
  private readonly resolvedRoots: readonly PresetRoot[]

  /**
   * The user layer over `config.default`, present only while a settings
   * provider is composed. Held rather than snapshotted so a hot-reloaded
   * document takes effect without a restart.
   */
  private settings: SettingsScope<AgentPresetSettings> | undefined

  /**
   * The settings service behind {@link settings}, held for the one write this
   * service makes: clearing a user default it has just deleted.
   */
  private settingsService: SettingsService | undefined

  /**
   * The service's own untraced context. Methods invoked through the traceable
   * proxy see `this.ctx` rebound to the CALLER's context, which carries a
   * shadow; a subtree minted from it resolves every service through that
   * shadow's fiber instead of each entry's own inject store, so preset rows
   * would fail on the very services they declare. Standing mounts must hang
   * off the untraced original (the `jobs-local` selfCtx precedent).
   */
  private readonly selfCtx: Context

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.selfCtx = ctx
    this.resolvedRoots = config.includeUserRoot
      ? [...config.roots, { path: eaHomePath(USER_PRESET_DIR), trust: 'user' }]
      : [...config.roots]
    // Deliberately not `installSettingsSection`: that helper exists to re-judge
    // what a consumer DERIVED from the source — memoized resolutions,
    // registration-level facts — across attach, detach, and change. Nothing
    // here is derived. `defaultId` reads through on every call, so both of its
    // hooks would be no-ops and the source thunk would restate this field.
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        settingsNamespace(SETTINGS_NAMESPACE),
        AgentPresetSettingsSchema,
        { base: { default: config.default } },
      )
      this.settingsService = settingsCtx.settings
      settingsCtx.effect(() => () => {
        this.settings = undefined
        this.settingsService = undefined
      }, 'agentPresets.settings()')
    })

    // Advisory, not fatal: a synchronous `agent/created` listener that throws
    // VETOES publication, and this service must not, because composing an agent
    // outside the roster is legal — `recompose` binds exactly such a bare agent
    // below, and the ACP and SDK-server entry points both create one.
    // The invariant companion is the check that fails loud, at assembly. Why an
    // unjoined agent matters at all has one home: the [Agent
    // Note](../../../../.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md).
    //
    // Known false positive: a session created bare and bound later by
    // `recompose` is warned about once, before its first bind. No shipped flow
    // does that today — the Web surface mounts in `setup` and children join
    // through `composeFrom` before publication.
    ctx.on('agent/created', ({ agent }) => {
      if (this.resolvedRoots.length === 0) return
      if (this.composedPreset(agent.ctx) !== undefined) return
      ctx.logger.warn(
        `agent "${agent.id}" was published without joining an agent preset; `
        + 'its tools, prompt sections, and skill catalog resolve against the empty global layer '
        + '(join through AgentPresets.mount() or composeFrom() in the agent factory setup)',
      )
    })

    // The durable record is the commit point. Its public notification carries
    // only the stable identity needed by clients, never the live Session.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /**
   * The preset id mounted when a caller names none.
   *
   * Read per call rather than cached: the settings document is hot-reloaded, so
   * changing the default takes effect on the next session created and leaves
   * every running session on the preset it was composed from.
   */
  get defaultId(): string {
    return this.settings?.get().default ?? this.config.default
  }

  /**
   * Every preset the configured roots currently supply.
   * @returns the presets, first-root-wins per id.
   */
  async list(): Promise<AgentPreset[]> {
    return await discoverPresets(this.resolvedRoots)
  }

  /**
   * Resolve one preset by id.
   *
   * A broken preset resolves — deleting one, reading one, and reporting one
   * all need the row — and the mounting paths refuse it AFTER resolution
   * through {@link resolveMountable}.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved preset.
   * @throws when no configured root supplies that id.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const presets = await this.list()
    const found = presets.find(preset => preset.id === wanted)
    if (found === undefined) {
      throw new UnknownPresetError(wanted, presets.map(preset => preset.id))
    }
    return found
  }

  /**
   * Resolve one preset that is about to compose an agent, refusing a broken
   * one with its discovery-reported reason. Failing here rather than inside
   * the loader keeps the answer the same for every unloadable shape — ghost
   * directory, unparsable YAML, rowless list — and spends no mount attempt
   * on a composition discovery already read as unusable.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved, mountable preset.
   * @throws when the preset is unknown or discovery reports it broken.
   */
  private async resolveMountable(id?: string): Promise<AgentPreset> {
    const preset = await this.resolve(id)
    if (preset.broken !== undefined) {
      throw new PresetMountError(preset.id, preset.broken)
    }
    return preset
  }

  /**
   * Standing mounts by preset id, single-flight so two agents racing the
   * first use of one preset share one composition. A settled failure is
   * removed so a later session retries a preset whose file has been fixed; a
   * settled success serves until the composition FILE visibly changes — each
   * generation records its file stamp, and a stale stamp starts the next
   * generation for sessions created afterwards. Sessions already joined keep
   * the generation they run on; a superseded one is never disposed while the
   * process lives (reclaimed only by whole-tree teardown), so editing files
   * is bounded by how often compositions change, not by session count.
   */
  private readonly standing = new Map<string, Promise<StandingMount>>()

  /**
   * Parent bindings of the agents this roster composed, keyed by the agent's
   * scope key. The binding is ea-scope's only re-link capability; holding it
   * here makes this service the sole authority that can move an agent between
   * standing compositions. WeakMap: entries die with their agents.
   */
  private readonly bindings = new WeakMap<ScopeKey, ScopeParentBinding>()

  /**
   * Compose one agent from a preset: ensure the preset's standing mount, then
   * parent the agent's scope key to it so the mount's registrations and
   * listeners cover this agent.
   *
   * Call from the agent factory's `setup(agentCtx)`; a rejection there rolls
   * the agent creation back, so a broken preset never yields a half-composed
   * session.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the preset that was composed, for the caller to record.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async mount(agentCtx: Context, id?: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    // The one bind of this agent's ancestry. The binding is the only re-link
    // authority, held privately so nothing outside this roster can move a
    // composed agent to another preset; a later recompose layer re-links
    // through it under the caller-owned blank-session contract.
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return preset
  }

  /**
   * Join one agent to the SAME standing composition another already runs on.
   *
   * This is how a child agent inherits its parent's capabilities. It is a bind,
   * not a mount: the parent's generation is already composed, so the child gets
   * that exact instance — the same plugin objects, the same tool registrations,
   * the same prompt sections. Re-resolving the parent's preset by id instead
   * would re-read the roster, and a composition file edited since the parent
   * started would hand the child a DIFFERENT generation than the one its
   * parent's history was produced under (and a preset deleted since would fail
   * the child outright while its parent keeps running).
   *
   * Synchronous, and with no composition failure mode of its own — it reads no
   * roster, mounts nothing, and touches no file — which is what lets a child
   * creation window use it: the two in-process subagent drivers compose their
   * children inside a synchronous `setup`. It still rejects a caller error, as
   * the `@throws` below record.
   *
   * A parent that joined no preset — a rosterless deployment — yields no join
   * and no error: there, the model-facing rows sit in the host composition and
   * the child already sees them through the global layer.
   * @param agentCtx - the joining agent's scope context.
   * @param parentCtx - the scope context of the agent whose composition to join.
   * @returns the preset id joined, or undefined when the parent joined none.
   * @throws when `agentCtx` carries no scope, or has already joined a preset.
   */
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const standing = standingMountFor(parentCtx)
    if (standing === undefined) return undefined
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return standing.presetId
  }

  /**
   * The preset one live agent runs on.
   *
   * Read from the live scope chain rather than from the session, so it answers
   * for an agent whose session has not recorded a preset yet — a child agent
   * whose durable header is being built from its parent's composition.
   * @param agentCtx - the agent's scope context.
   * @returns the preset id, or undefined when the agent joined none.
   */
  composedPreset(agentCtx: Context): string | undefined {
    return standingMountFor(agentCtx)?.presetId
  }

  /**
   * The roots this roster scans, which is not `config.roots`: it is every
   * configured root in order, then the ejunzAgent-home user root unless
   * `includeUserRoot` is false. Read this — not the config field — to answer
   * whether a roster is composed at all, so one derivation decides it.
   */
  get roots(): readonly PresetRoot[] {
    return this.resolvedRoots
  }

  /** Whether this deployment has a root locally authored presets go to. */
  get authorable(): boolean {
    return this.resolvedRoots.some(root => root.trust === 'user')
  }

  /**
   * Read one preset's composition text.
   * @param id - the preset id.
   * @returns the composition exactly as stored.
   * @throws when no configured root supplies that id.
   */
  async read(id: string): Promise<string> {
    return await readComposition(await this.resolve(id))
  }

  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * Copy is the only authoring write. Composition text never crosses this
   * seam: the source is named by id and its directory is copied as it stands,
   * so the copy is exactly as loadable as its source and authoring grants no
   * capability the roster did not already carry. The copy is NOT mounted to
   * validate — a source that mounts today yields a copy that mounts today.
   * @param from - the preset the copy starts from; shipped presets are the
   * primary source, so any trust is accepted.
   * @param id - the new preset's id, which becomes its directory name.
   * @param name - display name for the copy; absent falls back to the id.
   * @throws when the source is unknown, the id is unusable or already taken,
   * or the deployment configures no writable root.
   */
  async copy(from: string, id: string, name?: string): Promise<void> {
    const source = await this.resolve(from)
    // The roster check refuses ids any root supplies — shipped ones included,
    // since a user directory named like a shipped preset is shadowed by it.
    // The disk check inside copyComposition only sees the writable root.
    if ((await this.list()).some(preset => preset.id === id)) {
      throw new PresetExistsError(id)
    }
    await copyComposition(this.resolvedRoots, source, id, name)
    // A settled mount under this id can only be stale (its preset was deleted
    // from disk outside `remove`); the new preset must not inherit it. Every
    // session already joined keeps the generation it runs on regardless.
    this.standing.delete(id)
  }

  /**
   * Delete a locally authored preset.
   * @param id - the preset id.
   * @throws when the preset is unknown or ships with the deployment.
   */
  async remove(id: string): Promise<void> {
    await deleteComposition(this.resolvedRoots, await this.resolve(id))
    // Sessions on the deleted preset keep their standing mount; only new
    // sessions see the roster without it.
    this.standing.delete(id)
    // Storing a default that does not exist YET is deliberate — the roster is a
    // live directory, so a name absent now may exist by the time a session asks
    // for it, and `resolve` reports it then. A default this call just deleted is
    // not that case: nothing will ever supply it again, and left in place every
    // session created without an explicit pick would fail to start. Clearing it
    // exposes the deployment's own default underneath, which is the layering.
    if (this.settings?.get().default !== id) return
    await this.settingsService?.mutate(
      settingsNamespace(SETTINGS_NAMESPACE),
      [{ op: 'unset', path: ['default'] }],
    )
  }

  /**
   * One agent's instance of a service its preset mounted.
   *
   * A preset publishes services behind `isolate` realms, which are invisible
   * outside the group that declares them — including to the host. This is how a
   * caller holding the agent reads one anyway: a request that is ABOUT a
   * session but arrives from outside it, which is every browser RPC.
   *
   * Read addressing only. A host row that `inject`s a service cannot use this,
   * because injection resolves before any session exists and has no agent to
   * key by; such a service belongs on the host plane instead.
   * @param agent - the agent whose composition to look inside.
   * @param name - the service name as the preset's rows resolve it.
   * @returns the agent's instance, or undefined when its preset mounts none.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.ctx, agent, name)
  }

  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * Only valid while the agent has produced nothing: swapping tools mid
   * conversation would leave logged tool calls the new composition cannot
   * make. The CALLER owns that check — this method does not read session
   * history.
   *
   * The swap is a parent re-link, not an unmount: standing mounts are shared
   * and permanent, so the old composition stays for its other agents and the
   * new one is ensured BEFORE the link moves. An unknown or unusable preset
   * therefore throws with the agent exactly as it was — there is no torn-down
   * state to restore. The re-link runs through the binding this roster kept
   * from the agent's mount — ea-scope's only re-link authority. An agent
   * that never composed one has nothing to re-link: the switch is then the
   * agent's first bind, exactly a mount.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset to compose the agent from instead.
   * @returns the preset now installed.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to recompose an unscoped context')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    const binding = this.bindings.get(agentKey)
    if (binding === undefined) {
      this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    } else {
      binding.rebind(standing.key)
    }
    return preset
  }

  /**
   * The standing scope key of one preset, for a host reader with no agent.
   *
   * A cold transcript read resolves tool presenters against the composition
   * the session recorded, and the standing mount makes that possible without
   * resuming anything: ensuring the mount composes plugins but starts no
   * agent, no session, and no turn.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the standing scope key readers pass as a registry view scope.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async standingKeyFor(id?: string): Promise<ScopeKey> {
    const preset = await this.resolveMountable(id)
    return (await this.ensureStanding(preset)).key
  }

  /** Resolve (or create, single-flight) the standing mount of one preset. */
  private async ensureStanding(preset: AgentPreset): Promise<StandingMount> {
    const pending = this.standing.get(preset.id)
    if (pending !== undefined) {
      const mounted = await pending
      // Files are the only composition editor (authoring is copy/delete), so
      // the stamp is what notices an edit: a changed file starts the next
      // generation here, for this and later sessions. An unreadable stamp
      // serves the current generation — a mount must survive its file
      // disappearing, and failing the session over a stat would not.
      const current = await compositionStamp(preset.path)
      if (current === undefined || sameStamp(mounted.stamp, current)) return mounted
      // TODO: reclaim the superseded generation once the last agent joined to
      // it is gone. The subtree is not inert — `ea-skill-filesystem` watches its
      // roots — and the settings-page authoring flow turns "a composition
      // changed" into a per-save event. This needs a joined-agent count on
      // StandingMount, incremented in `mount`/`composeFrom`/`recompose` and
      // decremented when the agent's scope key dies.
      // Guarded delete: a caller that raced this one may have already started
      // the next generation, and dropping THAT pointer would fork a third.
      if (this.standing.get(preset.id) === pending) this.standing.delete(preset.id)
      return this.ensureStanding(preset)
    }
    const created = (async (): Promise<StandingMount> => {
      const key: ScopeKey = { agentPreset: preset.id }
      const scope = createScope(this.selfCtx, key)
      try {
        // Stamped before the file is read: an edit racing the mount makes the
        // stamp stale rather than silently current, so the next session
        // refreshes instead of trusting a composition older than its stamp.
        const stamp = await compositionStamp(preset.path)
        if (stamp === undefined) {
          throw new PresetMountError(preset.id, `composition file is unreadable: ${preset.path}`)
        }
        await mountPreset(scope.ctx, preset)
        return { key, scope, stamp }
      } catch (error) {
        this.standing.delete(preset.id)
        await scope.dispose()
        throw error
      }
    })()
    this.standing.set(preset.id, created)
    return created
  }
}

interface CompositionStamp {
  /** Modification time in milliseconds, as `stat` reports it. */
  readonly mtimeMs: number
  /** File size in bytes, the tiebreak for edits within one mtime tick. */
  readonly size: number
}

async function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  try {
    const { mtimeMs, size } = await stat(path)
    return { mtimeMs, size }
  } catch {
    // Deleted, replaced by an unreadable entry, or otherwise unstattable all
    // mean the same to the caller: the file offers no identity to compare.
    return undefined
  }
}

function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

interface StandingMount {
  /** Scope key agents are parented to; also the mount's registration scope. */
  readonly key: ScopeKey
  /** Disposal boundary; held for whole-tree teardown, never per-session. */
  readonly scope: Scope
  /** Stamp of the composition file this generation was mounted from. */
  readonly stamp: CompositionStamp
}

export default AgentPresets

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/agent-presets'
  export const name = 'agent-presets-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
