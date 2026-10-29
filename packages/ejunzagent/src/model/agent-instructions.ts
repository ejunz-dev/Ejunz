import { relative } from 'node:path'

import z from '@ejunz/schemastery'

import { resolveEaHome } from '@ejunz/ea/home-paths'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const

const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const

const DEFAULT_MAX_SOURCE_BYTES = 1_048_576

const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

export interface Config {
  /** EjunzAgent home containing the fixed user-global `AGENTS.md`; defaults to `$EA_HOME` or `~/.ea`. */
  eaHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** UTF-8 byte cap for one rendered baseline or dynamic batch; non-positive or non-finite disables loading. */
  maxBytes: number
  /** Maximum UTF-8 bytes read from one instruction file; larger files are ignored. */
  maxSourceBytes?: number
  /**
   * Ordered same-directory project candidates; every existing file loads, with
   * per-directory trimmed-content duplicates collapsed to the earliest candidate.
   */
  instructionFileCandidates?: string[]
  /**
   * Ordered same-directory local-overlay candidates loaded after the base files
   * under the same per-directory trimmed-content dedup; empty disables the overlay.
   */
  localInstructionFileCandidates?: string[]
}

export const Config: z<Config> = z.object({
  eaHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
  localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
})

export interface ResolvedDiscoveryConfig {
  eaHome: string
  projectRootMarkers: string[]
  instructionFileCandidates: string[]
  localInstructionFileCandidates: string[]
}

export interface ResolvedConfig extends ResolvedDiscoveryConfig {
  maxBytes: number
  maxSourceBytes: number
}

export function workspaceBaselineIdentity(
  config: ResolvedConfig,
  cwd: string,
  projectRoot: string,
): string {
  return JSON.stringify({
    projectRoot: relative(cwd, projectRoot),
    projectRootMarkers: config.projectRootMarkers,
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes,
    instructionFileCandidates: config.instructionFileCandidates,
    localInstructionFileCandidates: config.localInstructionFileCandidates,
  })
}

export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...resolveDiscoveryConfig(config),
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
  }
}

export function resolveDiscoveryConfig(
  config: Pick<Config, 'eaHome' | 'projectRootMarkers' | 'instructionFileCandidates' | 'localInstructionFileCandidates'>,
): ResolvedDiscoveryConfig {
  return {
    eaHome: resolveEaHome(config.eaHome),
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    instructionFileCandidates: resolveInstructionFileCandidates(
      config.instructionFileCandidates,
      DEFAULT_INSTRUCTION_FILE_CANDIDATES,
    ),
    localInstructionFileCandidates: resolveInstructionFileCandidates(
      config.localInstructionFileCandidates,
      DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
    ),
  }
}

function resolveInstructionFileCandidates(candidates: string[] | undefined, fallback: readonly string[]): string[] {
  return (candidates ?? [...fallback]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}

import { createHash } from 'node:crypto'

export function instructionContentSha1(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

export function trimmedInstructionDigest(content: string): string {
  return instructionContentSha1(content.trim())
}

import { basename, dirname } from 'node:path'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'

const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

const WORKSPACE_CONTEXT_INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.'

const REPLACEMENT_WORKSPACE_CONTEXT_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + WORKSPACE_CONTEXT_INTRO

const EMPTY_REPLACEMENT_WORKSPACE_CONTEXT_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + 'No workspace instructions are currently active.'

const COMPACT_WORKSPACE_CONTEXT_INTRO = 'Workspace instructions were omitted or truncated to fit the configured byte budget.'

export interface TruncatedInstruction {
  displayPath: string
  originalBytes: number
  includedBytes: number
}

export interface RenderedWorkspaceContext {
  text: string
  omitted: InstructionFile[]
  truncated: TruncatedInstruction[]
}

interface RenderedInstructionContext extends RenderedWorkspaceContext {
  /**
   * Original files semantically represented by rendered section text. This is
   * not the complement of `omitted`: a truncated file may be represented here
   * and in `truncated`, while a notice-only file appears in neither. A genuinely
   * empty file counts when its heading survives because that heading conveys
   * that the instruction exists and has no content.
   */
  represented: LoadedInstructionFile[]
}

export interface AgentInstructionChange {
  action: 'set' | 'replace' | 'remove'
  scope: string
  path: string
  digest?: string
}

export interface ChangeRenderItem {
  change: AgentInstructionChange
  file: LoadedInstructionFile
}

interface RenderStyle {
  intro: string
  section(file: LoadedInstructionFile): string
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  // If the first excluded byte is a UTF-8 continuation byte, the budget cut
  // through that code point. Back up to its lead byte and exclude it too.
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

export const USER_GLOBAL_DIRECTORY = 'user-global'

export const USER_GLOBAL_FILE = 'AGENTS.md'

export function scopeForDisplayPath(displayPath: string): string {
  if (displayPath === '~/.ea/AGENTS.md' || displayPath === '$EA_HOME/AGENTS.md') return USER_GLOBAL_DIRECTORY
  return dirname(displayPath)
}

const SCOPE_SEPARATOR = '\u0000'

export function candidateScopeKey(directory: string, candidateName: string): string {
  return `${directory}${SCOPE_SEPARATOR}${candidateName}`
}

export function instructionScopeKey(displayPath: string): string {
  return candidateScopeKey(scopeForDisplayPath(displayPath), basename(displayPath))
}

export function decodeScopeKey(scope: string): { directory: string; candidateName: string } {
  const separator = scope.indexOf(SCOPE_SEPARATOR)
  /* v8 ignore next -- every scope key is produced by candidateScopeKey, which always inserts the separator. */
  if (separator < 0) return { directory: scope, candidateName: '' }
  return { directory: scope.slice(0, separator), candidateName: scope.slice(separator + 1) }
}

function additionalSectionText(file: LoadedInstructionFile): string {
  const scope = scopeForDisplayPath(file.displayPath)
  return [
    `Additional instructions from: ${file.displayPath}`,
    '',
    `These instructions apply to work under \`${scope}\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.`,
    '',
    file.content,
  ].join('\n')
}

const BASELINE_RENDER_STYLE: RenderStyle = { intro: WORKSPACE_CONTEXT_INTRO, section: sectionText }

function baselineRenderStyle(files: LoadedInstructionFile[], replacePreviousBaseline: boolean | undefined): RenderStyle {
  if (replacePreviousBaseline !== true) return BASELINE_RENDER_STYLE
  return {
    ...BASELINE_RENDER_STYLE,
    intro: files.length === 0
      ? EMPTY_REPLACEMENT_WORKSPACE_CONTEXT_INTRO
      : REPLACEMENT_WORKSPACE_CONTEXT_INTRO,
  }
}

function changedSectionText(item: ChangeRenderItem): string {
  const { change, file } = item
  if (change.action === 'set') return additionalSectionText(file)
  if (change.action === 'remove') {
    return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`
  }
  return [
    `Updated instructions from: ${change.path}`,
    '',
    'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
    '',
    file.content,
  ].join('\n')
}

export function renderInstructionChanges(
  items: ChangeRenderItem[],
  maxBytes: number,
): { text: string; changes: AgentInstructionChange[] } {
  const byAbsolutePath = new Map(items.map(item => [item.file.absolutePath, item]))
  const style: RenderStyle = {
    intro: '',
    section(file) {
      const item = byAbsolutePath.get(file.absolutePath)
      /* v8 ignore next -- the renderer receives exactly the files used to construct this map. */
      return item === undefined ? '' : changedSectionText({ ...item, file })
    },
  }
  const rendered = renderInstructionContext(items.map(item => item.file), maxBytes, style)
  const represented = new Set(rendered.represented.map(file => file.absolutePath))
  return {
    text: rendered.text,
    changes: items
      .filter(item => represented.has(item.file.absolutePath))
      .map(item => item.change),
  }
}

function markerText(maxBytes: number, omitted: InstructionFile[], truncated: TruncatedInstruction[]): string {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts: string[] = []
  if (omitted.length > 0) {
    parts.push(`omitted ${omitted.map(file => file.displayPath).join(', ')}`)
  }
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map(item => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`)
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildInstructionText(
  files: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  truncated: TruncatedInstruction[],
  style: RenderStyle,
): string {
  const marker = markerText(maxBytes, omitted, truncated)
  const body = [marker, style.intro, ...files.map(file => style.section(file))].filter(block => block.length > 0)
  // Caller-owned framing: the plugin bakes the complete `<system-reminder>`
  // frame into the message content. The session surface projects context
  // verbatim and does not wrap it, so any framing must live here in the
  // producer's content (the pattern a future `meta`-driven renderer would
  // generalize — see the deferred note in
  // ../../../../.agents/notes/implemented/simplification/2026-07-20-unwrap-injected-content-envelopes.md).
  return [SYSTEM_REMINDER_OPEN, escapeInstructionFrameBody(body.join('\n\n')), SYSTEM_REMINDER_CLOSE].join('\n')
}

function withTruncatedContent(file: LoadedInstructionFile, includedBytes: number): LoadedInstructionFile {
  return { ...file, content: truncateUtf8(file.content, includedBytes) }
}

function truncateToFit(
  file: LoadedInstructionFile,
  includedFiles: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  style: RenderStyle,
): LoadedInstructionFile {
  const originalBytes = byteLength(file.content)
  let low = 0
  let high = originalBytes
  let best = withTruncatedContent(file, 0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = withTruncatedContent(file, mid)
    const truncated = [{ displayPath: file.displayPath, originalBytes, includedBytes: byteLength(candidate.content) }]
    const text = buildInstructionText([...includedFiles, candidate], maxBytes, omitted, truncated, style)
    if (byteLength(text) <= maxBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function renderInstructionContext(
  files: LoadedInstructionFile[],
  maxBytes: number,
  style: RenderStyle,
): RenderedInstructionContext {
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) {
    return { text: '', omitted: files, truncated: [], represented: [] }
  }

  const fullText = buildInstructionText(files, maxBytes, [], [], style)
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, omitted: [], truncated: [], represented: files }
  }

  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const omitted = files.slice(0, start).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
    const suffixText = buildInstructionText(included, maxBytes, omitted, [], style)
    if (byteLength(suffixText) <= maxBytes) return { text: suffixText, omitted, truncated: [], represented: included }
  }

  const mostSpecific = files.at(-1)
  /* v8 ignore next -- callers only reach this after a non-empty fullText was built. */
  if (mostSpecific === undefined) return { text: '', omitted: [], truncated: [], represented: [] }
  const omitted = files.slice(0, -1).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }))
  const originalBytes = byteLength(mostSpecific.content)

  for (const candidateStyle of [style, { ...style, intro: COMPACT_WORKSPACE_CONTEXT_INTRO }]) {
    const truncatedFile = truncateToFit(mostSpecific, [], maxBytes, omitted, candidateStyle)
    const includedBytes = byteLength(truncatedFile.content)
    const truncated = [{
      displayPath: mostSpecific.displayPath,
      originalBytes,
      includedBytes,
    }]
    const text = buildInstructionText([truncatedFile], maxBytes, omitted, truncated, candidateStyle)
    if (byteLength(text) <= maxBytes) {
      const represented = includedBytes > 0 || originalBytes === 0 ? [mostSpecific] : []
      return { text, omitted, truncated, represented }
    }
  }

  const truncated = [{
    displayPath: mostSpecific.displayPath,
    originalBytes,
    includedBytes: 0,
  }]
  const compactNotice = escapeInstructionFrameBody(markerText(maxBytes, omitted, truncated))
  const compactWithHeading = escapeInstructionFrameBody(
    [compactNotice, style.section(withTruncatedContent(mostSpecific, 0))].join('\n\n'),
  )
  if (byteLength(compactWithHeading) <= maxBytes) {
    const represented = originalBytes === 0 ? [mostSpecific] : []
    return { text: compactWithHeading, omitted, truncated, represented }
  }
  const text = byteLength(compactNotice) <= maxBytes ? compactNotice : truncateUtf8(compactNotice, maxBytes)
  return { text, omitted, truncated, represented: [] }
}

export function renderWorkspaceInstructionSet(
  files: LoadedInstructionFile[],
  options: { maxBytes: number; replacePreviousBaseline?: boolean },
): { rendered: RenderedWorkspaceContext; included: LoadedInstructionFile[] } {
  const style = baselineRenderStyle(files, options.replacePreviousBaseline)
  const { represented, ...rendered } = renderInstructionContext(files, options.maxBytes, style)
  return { rendered, included: represented }
}

export function renderWorkspaceContext(
  files: LoadedInstructionFile[],
  options: { maxBytes: number; replacePreviousBaseline?: boolean },
): RenderedWorkspaceContext {
  return renderWorkspaceInstructionSet(files, options).rendered
}

import { createReadStream } from 'node:fs'

import { stat } from 'node:fs/promises'

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { FileSystem, FsInfo, FsTarget, FsVersion } from '@ejunz/ea/fs'

import { assertNever } from '@ejunz/ea/llm'

import { eaHomeDisplay } from '@ejunz/ea/home-paths'

export interface InstructionFile {
  absolutePath: string
  displayPath: string
}

export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** Provider freshness token when the file was loaded through `ctx.fs`. */
  version?: FsVersion
}

interface DiscoveredInstructionFile extends InstructionFile {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

export interface ProbedInstructionFile extends InstructionFile {
  target: FsTarget
  version: FsVersion
  size?: number
}

interface DiscoverOptions {
  cwd: string
  eaHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
  projectRoot?: string
  signal?: AbortSignal
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  maxSourceBytes?: number
  replacePreviousBaseline?: boolean
}

export interface RenderedInstructionSet {
  rendered: RenderedWorkspaceContext
  /** Successfully read candidates before content deduplication and byte budgeting. */
  observed: LoadedInstructionFile[]
  /** Candidates retained by content deduplication and byte budgeting. */
  included: LoadedInstructionFile[]
}

export type ScopeInstructionProbe =
  | { kind: 'present'; file: ProbedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

interface StatFileInfo {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

type StatFileProbe =
  | { kind: 'present'; info: StatFileInfo }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function signalOptions(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

async function nodeStatFile(path: string, signal?: AbortSignal): Promise<StatFileProbe> {
  try {
    signal?.throwIfAborted()
    // stat (not lstat) follows a final-component symlink so a link to a regular
    // file loads; a broken link surfaces as ENOENT and is treated as absent below.
    const info = await stat(path)
    signal?.throwIfAborted()
    if (!info.isFile()) return { kind: 'absent' }
    return { kind: 'present', info: { size: info.size } }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unavailable' }
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  // resolve() follows a final-component symlink to its target's stable identity;
  // stat then classifies that target. A link to a regular file loads, while a
  // missing path or non-file target (including a link to a directory) is absent.
  try {
    const target = await fileSystem.resolve(path, signalOptions(signal))
    signal?.throwIfAborted()
    const info = await fileSystem.stat(target, signal)
    signal?.throwIfAborted()
    if (info?.type !== 'file') return { kind: 'absent' }
    return {
      kind: 'present',
      info: { target, version: info.version, ...info.size === undefined ? {} : { size: info.size } },
    }
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  return fileSystem === undefined ? nodeStatFile(path, signal) : fsStatFile(path, fileSystem, signal)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signalOptions(signal))
      return await fileSystem.stat(target, signal) !== undefined
    } catch {
      signal?.throwIfAborted()
      // TODO(root-marker-unavailable): preserve provider failure separately from
      // absence and stop discovery; continuing upward can cross into an ancestor project.
      return false
    }
  }
  try {
    signal?.throwIfAborted()
    await stat(path)
    signal?.throwIfAborted()
    return true
  } catch {
    signal?.throwIfAborted()
    return false
  }
}

export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- discovery always supplies cwd or an ancestor root. */
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const targetPath = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(targetPath)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

export function relativeDisplay(root: string, path: string): string {
  return relative(root, path)
}

async function allExistingInstructionFiles(
  dir: string,
  root: string,
  instructionFileCandidates: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<DiscoveredInstructionFile[]> {
  const found: DiscoveredInstructionFile[] = []
  for (const candidate of instructionFileCandidates) {
    const path = join(dir, candidate)
    const probe = await statFile(path, fileSystem, signal)
    switch (probe.kind) {
      case 'present':
        found.push({ absolutePath: path, displayPath: relativeDisplay(root, path), ...probe.info })
        continue
      // A missing candidate is skipped; a transient provider failure skips only
      // that candidate so the remaining independent candidates still load.
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }
  return found
}

async function discoverInstructionFiles(
  options: DiscoverOptions,
  fileSystem?: FileSystem,
): Promise<DiscoveredInstructionFile[]> {
  const config = resolveDiscoveryConfig(options)
  const files: DiscoveredInstructionFile[] = []
  const seen = new Set<string>()
  const addFile = (file: DiscoveredInstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  const userGlobal = join(config.eaHome, USER_GLOBAL_FILE)
  const userGlobalProbe = await statFile(userGlobal, fileSystem, options.signal)
  switch (userGlobalProbe.kind) {
    case 'present':
      addFile({
        absolutePath: userGlobal,
        displayPath: userGlobalDisplayPath(config.eaHome),
        ...userGlobalProbe.info,
      })
      break
    case 'absent':
    case 'unavailable':
      break
    /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
    default:
      assertNever(userGlobalProbe, 'StatFileProbe')
  }

  const cwd = resolve(options.cwd)
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, options.signal)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidates of [config.instructionFileCandidates, config.localInstructionFileCandidates]) {
      for (const file of await allExistingInstructionFiles(dir, projectRoot, candidates, fileSystem, options.signal)) {
        addFile(file)
      }
    }
  }
  return files
}

export async function discoverBaselineInstructionFiles(options: DiscoverOptions): Promise<InstructionFile[]> {
  return (await discoverInstructionFiles(options)).map(({ absolutePath, displayPath }) => ({ absolutePath, displayPath }))
}

async function* nodeTextChunks(path: string, signal?: AbortSignal): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  for await (const chunk of stream) yield String(chunk)
}

async function readBounded(
  file: { absolutePath: string; target?: FsTarget; size?: number },
  maxSourceBytes: number,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // TODO(total-instruction-read-bound): enforce an aggregate source budget
  // across a complete baseline or reconciliation batch; the render budget is
  // applied only after every accepted file has been read under this per-file cap.
  signal?.throwIfAborted()
  if (file.size !== undefined && file.size > maxSourceBytes) return undefined
  try {
    const chunks = fileSystem === undefined || file.target === undefined
      ? nodeTextChunks(file.absolutePath, signal)
      : await fileSystem.streamText(file.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxSourceBytes) return undefined
      parts.push(chunk)
    }
    signal?.throwIfAborted()
    return parts.join('')
  } catch {
    signal?.throwIfAborted()
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

export function dedupInstructionFilesByDirectory(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const keptDigestsByDir = new Map<string, Set<string>>()
  const kept: LoadedInstructionFile[] = []
  for (const file of files) {
    const dir = dirname(file.displayPath)
    let digests = keptDigestsByDir.get(dir)
    if (digests === undefined) {
      digests = new Set()
      keptDigestsByDir.set(dir, digests)
    }
    const digest = trimmedInstructionDigest(file.content)
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(file)
  }
  return kept
}

export async function loadBaselineInstructions(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedWorkspaceContext | undefined> {
  return (await loadBaselineInstructionSet(options, fileSystem))?.rendered
}

export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  if (config.maxSourceBytes <= 0 || !Number.isFinite(config.maxSourceBytes)) return undefined
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered) {
    const content = await readBounded(file, config.maxSourceBytes, fileSystem, options.signal)
    if (content !== undefined) {
      loaded.push({
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        content,
        ...file.version === undefined ? {} : { version: file.version },
      })
    }
  }
  const deduped = dedupInstructionFilesByDirectory(loaded)
  if (deduped.length === 0) {
    if (options.replacePreviousBaseline !== true) return undefined
    const { rendered, included } = renderWorkspaceInstructionSet([], {
      maxBytes: config.maxBytes,
      replacePreviousBaseline: true,
    })
    return {
      rendered,
      observed: [],
      included,
    }
  }
  const { rendered, included } = renderWorkspaceInstructionSet(deduped, {
    maxBytes: config.maxBytes,
    ...options.replacePreviousBaseline === undefined
      ? {}
      : { replacePreviousBaseline: options.replacePreviousBaseline },
  })
  return {
    rendered,
    observed: loaded,
    included,
  }
}

export async function probeScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<ScopeInstructionProbe> {
  const { directory, candidateName } = decodeScopeKey(scope)
  const dir = directory === USER_GLOBAL_DIRECTORY
    ? resolved.eaHome
    : directory === '.' ? projectRoot : join(projectRoot, directory)
  const absolutePath = join(dir, candidateName)
  // resolve() follows a final-component symlink; stat then classifies the target.
  // A non-file target (missing, or a link to a directory) is a confirmed absence;
  // only a provider exception is reported as unavailable.
  let target: FsTarget
  let info: FsInfo | undefined
  try {
    target = await fileSystem.resolve(absolutePath, signalOptions(signal))
    info = await fileSystem.stat(target, signal)
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
  if (info?.type !== 'file') return { kind: 'absent' }
  const file: ProbedInstructionFile = {
    absolutePath,
    displayPath: directory === USER_GLOBAL_DIRECTORY ? userGlobalDisplayPath(resolved.eaHome) : relativeDisplay(projectRoot, absolutePath),
    target,
    version: info.version,
    ...info.size === undefined ? {} : { size: info.size },
  }
  return { kind: 'present', file }
}

export async function readScopeInstruction(
  file: ProbedInstructionFile,
  maxSourceBytes: number,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile | undefined> {
  const content = await readBounded(file, maxSourceBytes, fileSystem, signal)
  if (content === undefined) return undefined
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    content,
    version: file.version,
  }
}

function userGlobalDisplayPath(eaHome: string): string {
  return `${eaHomeDisplay(eaHome)}/AGENTS.md`
}

import type { Agent } from '@ejunz/ea/agent'

import { createUserMessage } from '@ejunz/ea/llm'

import type { Message } from '@ejunz/ea/llm'

import type { Session, UserMessage } from '@ejunz/ea/session'

import type { FileSystem, FsVersion } from '@ejunz/ea/fs'

export const name = 'agent-instructions'

export interface AgentInstructionSource {
  kind: 'agent-instructions'
  /** Every workspace context carries instructions read out of a file (the `instructions` context form). */
  form: 'instructions'
  /** Marks the complete startup/resume baseline rather than a later delta. */
  baseline?: true
  /** Discovery, precedence, and budget identity used to validate a resumed baseline. */
  baselineIdentity?: string
  changes: AgentInstructionChange[]
}

declare module '@ejunz/ea/llm' {
  interface MessageSourceMap {
    'agent-instructions': AgentInstructionSource
  }
}

export interface InstructionVersionState {
  path: string
  version: FsVersion
  digest: string
  /**
   * Trimmed-content identity ({@link trimmedInstructionDigest}) used to suppress
   * per-directory duplicates on the metadata fast path without re-reading a sibling.
   */
  trimmedDigest: string
}

export type InstructionVersionCache = WeakMap<Session, Map<string, InstructionVersionState>>

export interface InstructionVersionUpdate {
  change: AgentInstructionChange
  state?: InstructionVersionState
}

export interface ReconciledInstructionContext {
  context: UserMessage
  versionUpdates: InstructionVersionUpdate[]
}

function workspaceContextHook(text: string, changes: AgentInstructionChange[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'agent-instructions', form: 'instructions', changes },
  })
}

export function workspaceContextMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  })
}

function isWorkspaceContextSource(
  source: unknown,
): source is { kind: 'agent-instructions'; changes: unknown[] } {
  return typeof source === 'object' && source !== null
    && 'kind' in source && source.kind === 'agent-instructions'
    && 'changes' in source && Array.isArray(source.changes)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function workspaceInstructionChanges(source: { changes: unknown[] }): AgentInstructionChange[] {
  const changes: AgentInstructionChange[] = []
  for (const value of source.changes) {
    if (!isRecord(value)) continue
    if (value.action !== 'set' && value.action !== 'replace' && value.action !== 'remove') continue
    if (typeof value.scope !== 'string' || typeof value.path !== 'string') continue
    if (value.digest !== undefined && typeof value.digest !== 'string') continue
    changes.push({
      action: value.action,
      scope: value.scope,
      path: value.path,
      ...value.digest !== undefined ? { digest: value.digest } : {},
    })
  }
  return changes
}

function sameInstructionChange(a: AgentInstructionChange, b: AgentInstructionChange): boolean {
  return a.action === b.action
    && a.scope === b.scope
    && a.path === b.path
    && a.digest === b.digest
}

function visibleInstructionChanges(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): Map<string, AgentInstructionChange> {
  const visibleSeqs = new Set(agent.session.surface.nodes)
  const visible = new Map<string, AgentInstructionChange>()
  for (const [seq, event] of agent.session.events.entries()) {
    if (event.type !== 'user/message' || !isWorkspaceContextSource(event.data.source)) continue
    const changes = workspaceInstructionChanges(event.data.source)
    for (const change of changes) {
      if (visibleSeqs.has(seq)) visible.set(change.scope, change)
    }
  }
  for (const message of authorityMessages) {
    if (!isWorkspaceContextSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      visible.set(change.scope, change)
    }
  }
  return visible
}

export function baselineInstructionState(files: LoadedInstructionFile[]): {
  changes: Map<string, AgentInstructionChange>
  versions: Map<string, InstructionVersionState>
} {
  const changes = new Map<string, AgentInstructionChange>()
  const versions = new Map<string, InstructionVersionState>()
  for (const file of files) {
    const digest = instructionContentSha1(file.content)
    const change: AgentInstructionChange = {
      action: 'set',
      scope: instructionScopeKey(file.displayPath),
      path: file.displayPath,
      digest,
    }
    changes.set(change.scope, change)
    if (file.version !== undefined) {
      versions.set(change.scope, {
        path: file.displayPath,
        version: file.version,
        digest,
        trimmedDigest: trimmedInstructionDigest(file.content),
      })
    }
  }
  return { changes, versions }
}

function versionStatesFor(session: Session, cache: InstructionVersionCache): Map<string, InstructionVersionState> {
  let states = cache.get(session)
  if (states === undefined) {
    states = new Map()
    cache.set(session, states)
  }
  return states
}

export function retainedInstructionVersionUpdates(
  updates: readonly InstructionVersionUpdate[],
  renderedChanges: readonly AgentInstructionChange[],
): InstructionVersionUpdate[] {
  return updates.filter(update => renderedChanges.some(change => sameInstructionChange(update.change, change)))
}

export function applyInstructionVersionUpdates(
  session: Session,
  updates: readonly InstructionVersionUpdate[],
  cache: InstructionVersionCache,
): void {
  if (updates.length === 0) return
  const states = versionStatesFor(session, cache)
  for (const update of updates) {
    if (update.state === undefined) states.delete(update.change.scope)
    else states.set(update.change.scope, update.state)
  }
  if (states.size === 0) cache.delete(session)
}

function relativeScope(projectRoot: string, dir: string): string {
  const scope = relativeDisplay(projectRoot, dir)
  return scope.length === 0 ? '.' : scope
}

export async function reconcileInstructionContext(
  agent: Agent,
  resolved: ResolvedConfig,
  versionCache: InstructionVersionCache,
  fileSystem: FileSystem,
  options: {
    authorityMessages: readonly UserMessage[]
    scopeMessages: readonly UserMessage[]
    touchedPaths: readonly string[]
    includeBaselineScopes: boolean
    excludedBaselineScopes?: ReadonlySet<string>
    projectRoot?: string
    signal?: AbortSignal
  },
): Promise<ReconciledInstructionContext | undefined> {
  const session = agent.session
  const effective = visibleInstructionChanges(agent, options.authorityMessages)
  /* v8 ignore next -- normal agents carry an absolute session cwd. */
  const cwd = session.header.cwd ?? process.cwd()
  // TODO(frozen-project-root): retain the baseline root for the loop instance;
  // recomputing it after marker edits reinterprets the existing relative scope keys.
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, options.signal)
  const scopes = new Set<string>()
  const baselineScopes = new Set<string>()
  const addDirScopes = (target: Set<string>, directory: string): void => {
    for (const candidate of resolved.instructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
    for (const candidate of resolved.localInstructionFileCandidates) target.add(candidateScopeKey(directory, candidate))
  }
  const addProjectScopes = (target: Set<string>, dir: string): void => {
    addDirScopes(target, relativeScope(projectRoot, dir))
  }
  baselineScopes.add(candidateScopeKey(USER_GLOBAL_DIRECTORY, USER_GLOBAL_FILE))
  for (const dir of ancestorChain(projectRoot, cwd)) addProjectScopes(baselineScopes, dir)
  if (options.includeBaselineScopes) {
    for (const scope of baselineScopes) scopes.add(scope)
  }
  for (const message of options.scopeMessages) {
    /* v8 ignore next -- the plugin passes its workspace-only pending projection. */
    if (!isWorkspaceContextSource(message.source)) continue
    for (const change of workspaceInstructionChanges(message.source)) {
      if (!options.includeBaselineScopes && baselineScopes.has(change.scope)) continue
      scopes.add(change.scope)
    }
  }
  for (const scope of effective.keys()) {
    if (!options.includeBaselineScopes && baselineScopes.has(scope)) continue
    const { directory } = decodeScopeKey(scope)
    if (directory === USER_GLOBAL_DIRECTORY) scopes.add(candidateScopeKey(USER_GLOBAL_DIRECTORY, USER_GLOBAL_FILE))
    else addDirScopes(scopes, directory)
  }
  for (const touchedPath of options.touchedPaths) {
    for (const dir of descendantDirsBetween(cwd, touchedPath)) addProjectScopes(scopes, dir)
  }

  const versions = versionStatesFor(session, versionCache)
  const seenAbsolutePaths = new Set<string>()
  // Per-directory trimmed-content identities kept so far this pass, iterated in
  // candidate order (base before local); a later sibling matching an earlier one
  // is a duplicate and is dropped or removed rather than rendered twice.
  const keptTrimmedByDir = new Map<string, Set<string>>()
  const registerKeptTrimmed = (directory: string, digest: string): boolean => {
    let digests = keptTrimmedByDir.get(directory)
    if (digests === undefined) {
      digests = new Set()
      keptTrimmedByDir.set(directory, digests)
    }
    if (digests.has(digest)) return true
    digests.add(digest)
    return false
  }
  const items: ChangeRenderItem[] = []
  const versionUpdates: InstructionVersionUpdate[] = []
  const pushRemoval = (scope: string, path: string): void => {
    const change: AgentInstructionChange = { action: 'remove', scope, path }
    items.push({ change, file: { absolutePath: `removed:${scope}`, displayPath: path, content: '' } })
    versionUpdates.push({ change })
  }
  const scopesByDirectory = new Map<string, string[]>()
  for (const scope of scopes) {
    const { directory } = decodeScopeKey(scope)
    const directoryScopes = scopesByDirectory.get(directory)
    if (directoryScopes === undefined) scopesByDirectory.set(directory, [scope])
    else directoryScopes.push(scope)
  }
  for (const [directory, directoryScopes] of scopesByDirectory) {
    const probedScopes: string[] = []
    for (const scope of directoryScopes) {
      if (options.excludedBaselineScopes !== undefined
        && baselineScopes.has(scope)
        && options.excludedBaselineScopes.has(scope)) {
        const previous = effective.get(scope)
        if (previous === undefined || previous.action === 'remove') versions.delete(scope)
        else pushRemoval(scope, previous.path)
      } else {
        probedScopes.push(scope)
      }
    }
    const itemStart = items.length
    const versionUpdateStart = versionUpdates.length
    const addedAbsolutePaths: string[] = []
    const priorVersions = new Map(probedScopes.map(scope => [scope, versions.get(scope)]))
    for (const scope of probedScopes) {
      const previous = effective.get(scope)
      const probe = await probeScopeInstruction(scope, projectRoot, resolved, fileSystem, options.signal)
      if (probe.kind === 'unavailable') {
        if (previous === undefined || previous.action === 'remove') continue
        // Same-directory candidates form one deduplicated authority group. If an
        // active member cannot be observed, preserve the entire last-good group;
        // cache warmth must never decide whether a sibling transition is emitted.
        items.splice(itemStart)
        versionUpdates.splice(versionUpdateStart)
        for (const [candidateScope, prior] of priorVersions) {
          if (prior === undefined) versions.delete(candidateScope)
          else versions.set(candidateScope, prior)
        }
        for (const absolutePath of addedAbsolutePaths) seenAbsolutePaths.delete(absolutePath)
        keptTrimmedByDir.delete(directory)
        break
      }
      if (probe.kind === 'absent') {
        if (previous === undefined || previous.action === 'remove') versions.delete(scope)
        else pushRemoval(scope, previous.path)
        continue
      }
      const { file: probedFile } = probe
      if (seenAbsolutePaths.has(probedFile.absolutePath)) continue
      seenAbsolutePaths.add(probedFile.absolutePath)
      addedAbsolutePaths.push(probedFile.absolutePath)
      const cached = versions.get(scope)
      if (
        cached !== undefined
        && cached.path === probedFile.displayPath
        && cached.version === probedFile.version
        && previous !== undefined
        && previous.action !== 'remove'
        && previous.path === cached.path
        && previous.digest === cached.digest
      ) {
        // Unchanged and previously rendered: keep it, but an earlier sibling that
        // now matches its trimmed content makes this the duplicate to remove.
        if (registerKeptTrimmed(directory, cached.trimmedDigest)) pushRemoval(scope, previous.path)
        continue
      }

      const file = await readScopeInstruction(probedFile, resolved.maxSourceBytes, fileSystem, options.signal)
      if (file === undefined) continue
      const currentDigest = instructionContentSha1(file.content)
      const trimmedDigest = trimmedInstructionDigest(file.content)
      if (registerKeptTrimmed(directory, trimmedDigest)) {
        // A distinct file whose trimmed content already appeared earlier in this
        // directory: drop it, removing any copy that was previously rendered.
        if (previous !== undefined && previous.action !== 'remove') pushRemoval(scope, previous.path)
        else versions.delete(scope)
        continue
      }
      const nextVersion: InstructionVersionState = {
        path: file.displayPath,
        version: probedFile.version,
        digest: currentDigest,
        trimmedDigest,
      }
      if (previous !== undefined && previous.action !== 'remove' && previous.path === file.displayPath && previous.digest === currentDigest) {
        versions.set(scope, nextVersion)
        continue
      }
      const action = previous === undefined || previous.action === 'remove' ? 'set' : 'replace'
      const change: AgentInstructionChange = {
        action,
        scope,
        path: file.displayPath,
        digest: currentDigest,
      }
      items.push({ change, file })
      versionUpdates.push({ change, state: nextVersion })
    }
  }
  if (items.length === 0) return undefined
  const rendered = renderInstructionChanges(items, resolved.maxBytes)
  // When no transition survived rendering (tiny budgets render notice-only
  // text), emit nothing and commit nothing — the uncommitted versions make the
  // next pass retry instead of spamming notice-only contexts.
  if (rendered.text.length === 0 || rendered.changes.length === 0) return undefined
  return {
    context: workspaceContextHook(rendered.text, rendered.changes),
    versionUpdates: retainedInstructionVersionUpdates(versionUpdates, rendered.changes),
  }
}

import type { Context } from '@ejunz/cordis'

import { isDeepStrictEqual } from 'node:util'

import type { Agent, PreStepDecision } from '@ejunz/ea/agent'

import { createUserMessage } from '@ejunz/ea/llm'

import type { Session, UserMessage } from '@ejunz/ea/session'

import type { ToolExecution, ToolExecutionResult, ToolExecutionToken } from '@ejunz/ea/tools'

export { Config, name }

function visibleBaselineSource(
  agent: Agent,
  authorityMessages: readonly UserMessage[],
): AgentInstructionSource | undefined {
  for (const message of authorityMessages.toReversed()) {
    if (message.source.kind === 'agent-instructions' && message.source.baseline === true) {
      return message.source
    }
  }
  for (const seq of agent.session.surface.nodes.toReversed()) {
    const event = agent.session.events[seq]
    if (event?.type === 'user/message'
      && event.data.source.kind === 'agent-instructions'
      && event.data.source.baseline === true) return event.data.source
  }
  return undefined
}

function isWorkspaceContext(message: UserMessage): boolean {
  return message.source.kind === 'agent-instructions'
}

function sameContextPayload(left: UserMessage, right: UserMessage): boolean {
  return isDeepStrictEqual(left.content, right.content)
    && isDeepStrictEqual(left.source, right.source)
}

const FILE_TOUCH_TOOL_NAMES = new Set(['read', 'write', 'edit'])

function filePathFromExecution(exec: ToolExecution): string | undefined {
  if (!FILE_TOUCH_TOOL_NAMES.has(exec.name)) return undefined
  if (typeof exec.arguments !== 'object' || exec.arguments === null) return undefined
  if (!('file_path' in exec.arguments) || typeof exec.arguments.file_path !== 'string') return undefined
  const filePath = exec.arguments.file_path.trim()
  return filePath.length > 0 ? filePath : undefined
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = resolveConfig(config)
  const instructionVersions: InstructionVersionCache = new WeakMap()
  const baselinePreparations = new WeakMap<Session, {
    identity: string
    excludedScopes: ReadonlySet<string>
  }>()
  const projectionLifecycle = new AbortController()
  type ProjectionTouch = { agent: Agent; path: string }
  const executionTouches = new Map<ToolExecutionToken, ProjectionTouch[]>()
  ctx.effect(
    () => () => {
      projectionLifecycle.abort(new Error('agent-instructions disposed'))
      executionTouches.clear()
    },
    'agent-instructions.projectionLifecycle',
  )
  // Emit listeners are not awaited, so each projection must compose against the
  // inbox produced by earlier file results for the same agent.
  const projectionTails = new WeakMap<Agent, Promise<void>>()
  // The enclosing durable step is the commit boundary before an asynchronous
  // projection may mutate the agent inbox.
  const openSteps = new WeakMap<Session, boolean>()
  const stepTouches = new WeakMap<Session, ProjectionTouch[]>()

  const compose = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    pending: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<UserMessage | undefined> => {
    signal.throwIfAborted()
    if (resolved.maxBytes <= 0 || !Number.isFinite(resolved.maxBytes)) {
      return undefined
    }
    const fileSystem = ctx.get('fs')
    if (fileSystem === undefined) return undefined
    if (touchedPaths.length === 0 && pending.length > 0) return pending[0]
    const content: UserMessage['content'][number][] = []
    const changes: AgentInstructionChange[] = []
    let desiredBaseline = false
    const authorityMessages = [...claimed]
    /* v8 ignore next -- normal agents carry an absolute session cwd. */
    const cwd = agent.session.header.cwd ?? process.cwd()
    const projectRoot = await findProjectRoot(cwd, resolved.projectRootMarkers, fileSystem, signal)
    const identity = workspaceBaselineIdentity(resolved, cwd, projectRoot)
    const visibleBaseline = visibleBaselineSource(agent, authorityMessages)
    const baselinePresent = visibleBaseline !== undefined
    const keepVisibleBaseline = visibleBaseline?.baselineIdentity === identity
    const prepared = baselinePreparations.get(agent.session)
    let excludedBaselineScopes = keepVisibleBaseline && prepared?.identity === identity
      ? prepared.excludedScopes
      : undefined
    let nextPreparation: { identity: string; excludedScopes: ReadonlySet<string> } | undefined
    if (!baselinePresent || !keepVisibleBaseline || excludedBaselineScopes === undefined) {
      const replacePreviousBaseline = baselinePresent && !keepVisibleBaseline
      const instructions = await loadBaselineInstructionSet({
        cwd,
        eaHome: resolved.eaHome,
        projectRootMarkers: resolved.projectRootMarkers,
        maxBytes: resolved.maxBytes,
        maxSourceBytes: resolved.maxSourceBytes,
        instructionFileCandidates: resolved.instructionFileCandidates,
        localInstructionFileCandidates: resolved.localInstructionFileCandidates,
        projectRoot,
        replacePreviousBaseline,
        signal,
      }, fileSystem)
      const baseline = baselineInstructionState(instructions?.included ?? [])
      const observedBaseline = baselineInstructionState(instructions?.observed ?? [])
      const excludedScopes = new Set(observedBaseline.changes.keys())
      for (const scope of baseline.changes.keys()) excludedScopes.delete(scope)
      excludedBaselineScopes = excludedScopes
      nextPreparation = { identity, excludedScopes }
      let versionStates = instructionVersions.get(agent.session)
      if (versionStates === undefined && baseline.versions.size > 0) {
        versionStates = new Map()
        instructionVersions.set(agent.session, versionStates)
      }
      for (const [scope, state] of baseline.versions) versionStates?.set(scope, state)
      if (!keepVisibleBaseline && instructions !== undefined && instructions.rendered.text.length > 0) {
        const baselineContent = workspaceContextMessage(instructions.rendered.text).content
        content.push(...baselineContent)
        const replacementScopes = new Set(baseline.changes.keys())
        const replacementRemovals = replacePreviousBaseline
          ? visibleBaseline.changes.flatMap(change => (
            change.action === 'remove' || replacementScopes.has(change.scope)
              ? []
              : [{ action: 'remove' as const, scope: change.scope, path: change.path }]
          ))
          : []
        const baselineChanges = [...replacementRemovals, ...baseline.changes.values()]
        changes.push(...baselineChanges)
        authorityMessages.push(createUserMessage({
          content: baselineContent,
          source: {
            kind: 'agent-instructions',
            form: 'instructions',
            baseline: true,
            baselineIdentity: identity,
            changes: baselineChanges,
          },
        }))
        desiredBaseline = true
      }
    }
    const update = await reconcileInstructionContext(
      agent,
      resolved,
      instructionVersions,
      fileSystem,
      {
        authorityMessages,
        scopeMessages: pending,
        includeBaselineScopes: keepVisibleBaseline,
        ...keepVisibleBaseline ? { excludedBaselineScopes } : {},
        touchedPaths,
        projectRoot,
        signal,
      },
    )
    if (update !== undefined) {
      content.push(...update.context.content)
      /* v8 ignore next -- reconciliation constructs only agent-instructions contexts. */
      if (update.context.source.kind === 'agent-instructions') {
        changes.push(...update.context.source.changes)
      }
      applyInstructionVersionUpdates(agent.session, update.versionUpdates, instructionVersions)
    }
    if (nextPreparation !== undefined) baselinePreparations.set(agent.session, nextPreparation)
    if (content.length === 0) return undefined
    return createUserMessage({
      content,
      source: {
        kind: 'agent-instructions',
        form: 'instructions',
        ...desiredBaseline ? { baseline: true } : {},
        ...desiredBaseline ? { baselineIdentity: identity } : {},
        changes,
      },
    })
  }

  const syncInbox = (agent: Agent, claimed: readonly UserMessage[], desired: UserMessage | undefined): void => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const alreadySupplied = desired !== undefined && (
      claimed.some(message => sameContextPayload(message, desired))
      || agent.session.surface.nodes.some((seq) => {
        const event = agent.session.events[seq]
        return event?.type === 'user/message' && sameContextPayload(event.data, desired)
      })
    )
    if (desired === undefined || alreadySupplied) {
      for (const message of pending) agent.inbox.remove(message.id)
      return
    }
    const reusable = pending.find(message => sameContextPayload(message, desired))
    if (reusable !== undefined) {
      for (const message of pending) {
        if (message !== reusable) agent.inbox.remove(message.id)
      }
      return
    }
    const replaced = pending[0]
    if (replaced === undefined) agent.inbox.prepend('next-step', desired)
    else agent.inbox.replace(replaced.id, desired)
    for (const message of pending.slice(1)) agent.inbox.remove(message.id)
  }

  const composeAndSync = async (
    agent: Agent,
    signal: AbortSignal,
    claimed: readonly UserMessage[],
    touchedPaths: readonly string[] = [],
  ): Promise<void> => {
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const desired = await compose(agent, signal, claimed, pending, touchedPaths)
    signal.throwIfAborted()
    syncInbox(agent, claimed, desired)
  }

  const queueProjection = (
    agent: Agent,
    touchedPath: string,
  ): void => {
    const previous = projectionTails.get(agent) ?? Promise.resolve()
    const current = previous.then(() => composeAndSync(agent, projectionLifecycle.signal, [], [touchedPath]))
      .catch((error: unknown) => {
        if (!projectionLifecycle.signal.aborted) ctx.logger.warn('workspace instruction refresh failed: %o', error)
      })
    projectionTails.set(agent, current)
    void current.then(() => {
      if (projectionTails.get(agent) === current) projectionTails.delete(agent)
    })
  }

  const waitForProjections = async (agent: Agent): Promise<void> => {
    let projection: Promise<void> | undefined
    while ((projection = projectionTails.get(agent)) !== undefined) await projection
  }

  const stepIsOpen = (session: Session): boolean => {
    const known = openSteps.get(session)
    if (known !== undefined) return known
    let open = false
    for (const event of session.events) {
      if (event.type === 'step/start') open = true
      else if (event.type === 'step/end' || event.type === 'turn/end') open = false
    }
    openSteps.set(session, open)
    return open
  }

  const projectTouch = (touch: ProjectionTouch): void => {
    const session = touch.agent.session
    if (!stepIsOpen(session)) {
      queueProjection(touch.agent, touch.path)
      return
    }
    const pending = stepTouches.get(session)
    if (pending === undefined) stepTouches.set(session, [touch])
    else pending.push(touch)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      openSteps.set(session, true)
      return
    }
    if (event.type === 'turn/end') {
      openSteps.set(session, false)
      return
    }
    if (event.type !== 'step/end') return
    openSteps.set(session, false)
    const pending = stepTouches.get(session)
    if (pending === undefined) return
    stepTouches.delete(session)
    for (const touch of pending) queueProjection(touch.agent, touch.path)
  })

  ctx.on('agent/pre-step', async (
    { agent, messages, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    await waitForProjections(agent)
    const pending = agent.inbox.nextStep.filter(isWorkspaceContext)
    const desired = await compose(agent, signal, messages, pending)
    signal.throwIfAborted()
    // An empty first entry owns a no-step turn; keep context pending instead
    // of turning it into a standalone request. Later entries may be tool continuations.
    if (decision.kind === 'reject' || (step === 1 && decision.messages.length === 0)) {
      syncInbox(agent, messages, desired)
      return decision
    }
    // A proceeding step settles the pending context: it either enters below as
    // `desired`, or its payload is already covered by the batch, so nothing stays pending.
    for (const message of pending) agent.inbox.remove(message.id)
    if (desired === undefined || decision.messages.some(message => sameContextPayload(message, desired))) {
      return decision
    }
    // Fold the context right after the claimed batch, so the direct prompt
    // precedes it and the driver-appended runtime context follows it.
    const lastClaimedIndex = decision.messages.findLastIndex(message => messages.includes(message))
    const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
    return { kind: 'enter', messages: entered }
  })

  ctx.on('tools/result', (exec: ToolExecution, result: ToolExecutionResult) => {
    const touches = executionTouches.get(exec.token) ?? []
    executionTouches.delete(exec.token)
    if (!result.isError && exec.agent !== undefined && !exec.signal.aborted) {
      const ownPath = filePathFromExecution(exec)
      if (ownPath !== undefined) touches.push({ agent: exec.agent, path: ownPath })
    }
    for (const touch of touches) projectTouch(touch)
  })
}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/agent-instructions'
  export const name = 'workspace-context-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
