import { timeoutOf } from '@ejunz/ea-core/timeout'

export function abortError(signal: AbortSignal): Error {
  const timeout = timeoutOf(signal)
  if (timeout !== undefined) return timeout
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  return new Error('LSP query aborted')
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  if (signal.aborted) return Promise.reject(abortError(signal))
  const canceled = Promise.withResolvers<never>()
  const onAbort = (): void => { canceled.reject(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  const normalized = work.catch((error: unknown) => {
    /* v8 ignore next -- owned LSP promises reject with Error; coercion defends the generic helper. */
    throw error instanceof Error ? error : new Error(String(error))
  })
  return Promise.race([normalized, canceled.promise])
    .finally(() => { signal.removeEventListener('abort', onAbort) })
}

const HEADER_SEPARATOR = '\r\n\r\n'

const MAX_HEADER_BYTES = 1 << 16

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

export class MessageDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly maxMessageBytes: number

  /**
   * @param maxMessageBytes - reject any single framed body larger than this (guards memory).
   */
  constructor(maxMessageBytes: number) {
    this.maxMessageBytes = maxMessageBytes
  }

  /**
   * Append a chunk and return every message body that is now complete.
   * @param chunk - raw bytes from the server's stdout.
   * @returns the parsed JSON bodies, in arrival order (possibly empty).
   * @throws Error when a header is malformed or a body exceeds `maxMessageBytes`.
   */
  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    for (;;) {
      const step = this.next()
      if (!step.ready) break
      messages.push(step.message)
    }
    return messages
  }

  /** Parse and consume the next complete message, or report that more bytes are needed. */
  private next(): { ready: false } | { ready: true; message: unknown } {
    const separator = this.buffer.indexOf(HEADER_SEPARATOR)
    if (separator < 0) {
      if (this.buffer.length > MAX_HEADER_BYTES) {
        throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes without a terminator`)
      }
      return { ready: false }
    }
    if (separator > MAX_HEADER_BYTES) {
      throw new Error(`LSP header exceeded ${MAX_HEADER_BYTES} bytes`)
    }
    const headerText = this.buffer.toString('ascii', 0, separator)
    const contentLength = parseContentLength(headerText)
    if (contentLength > this.maxMessageBytes) {
      throw new Error(`LSP message length ${contentLength} exceeds the ${this.maxMessageBytes}-byte limit`)
    }
    const bodyStart = separator + HEADER_SEPARATOR.length
    const bodyEnd = bodyStart + contentLength
    if (this.buffer.length < bodyEnd) return { ready: false }
    const body = this.buffer.toString('utf8', bodyStart, bodyEnd)
    this.buffer = this.buffer.subarray(bodyEnd)
    try {
      return { ready: true, message: JSON.parse(body) }
    } catch (error) {
      /* v8 ignore next -- JSON.parse throws a SyntaxError (an Error); the String() fallback is defensive. */
      throw new Error(`LSP message body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function parseContentLength(headerText: string): number {
  for (const line of headerText.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue
    const value = Number(line.slice(colon + 1).trim())
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`invalid Content-Length header: ${JSON.stringify(line)}`)
    }
    return value
  }
  throw new Error(`LSP header block missing Content-Length: ${JSON.stringify(headerText)}`)
}

import type { Writable } from 'node:stream'

import type { SubprocessHandle, SubprocessSpawnSpec } from '@ejunz/ea-core/subprocess'

export interface ConnectionSpec {
  /** The resolved absolute executable path (no shell). */
  readonly command: string
  /** Arguments passed to the executable. */
  readonly args: readonly string[]
  /** The child's working directory (the canonical workspace). */
  readonly cwd: string
  /** Explicit child environment overrides; the subprocess provider owns its ambient scrub. */
  readonly env: Record<string, string>
  /** Largest single framed message accepted from the server. */
  readonly maxMessageBytes: number
  /** Largest stderr tail retained for diagnostics. */
  readonly maxStderrBytes: number
  /**
   * The subprocess spec's `graceMs`: the SIGTERM→SIGKILL window of
   * {@link LspConnection.terminate}'s escalation, and the bound for draining
   * pipes a surviving helper still holds after the server exits.
   */
  readonly killGraceMs: number
  /** Static answer to every `workspace/configuration` item. */
  readonly configuration: unknown
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export type ConnectionWriter = (
  stdin: Writable,
  message: unknown,
  done: (error?: Error | null) => void,
) => void

export type ConnectionSpawner = (spec: SubprocessSpawnSpec) => SubprocessHandle

const writeConnectionMessage: ConnectionWriter = (stdin, message, done) => {
  stdin.write(encodeMessage(message), done)
}

export class LspConnection {
  private readonly handle: SubprocessHandle
  private readonly stdin: Writable
  private readonly decoder: MessageDecoder
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closeReason: Error | undefined
  /** Set once the process has fully exited; the instance awaits it during teardown. */
  readonly closed: Promise<void>

  /**
   * @param spec - how to launch the server and answer its config requests.
   * @param spawner - the subprocess seam's spawn (the provider passes `ctx.subprocess.spawn`).
   * @param onServerRequest - answers a server→client request; rejects to send an error response.
   * @param writer - message writer; tests inject callback failures without relying on OS pipe races.
   */
  constructor(
    spec: ConnectionSpec,
    spawner: ConnectionSpawner,
    private readonly onServerRequest: (method: string, params: unknown) => Promise<unknown>,
    private readonly writer: ConnectionWriter = writeConnectionMessage,
  ) {
    this.decoder = new MessageDecoder(spec.maxMessageBytes)
    // stdin/stdout are piped protocol streams this endpoint frames itself;
    // stderr is a collected diagnostic tail (no spill — the bounded tail IS
    // the contract). The seam owns detachment and tree-scoped signalling.
    this.handle = spawner({
      argv: [spec.command, ...spec.args],
      cwd: spec.cwd,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: spec.maxStderrBytes },
      },
      graceMs: spec.killGraceMs,
      // The seam merges explicit config entries after its ambient scrub, so a
      // configured credential or EA_* fact reaches the child deliberately.
      env: spec.env,
    })
    /* v8 ignore start -- 'pipe' dispositions expose both streams by the seam contract; defensive. */
    if (this.handle.stdin === undefined || this.handle.stdout === undefined) {
      throw new Error('lsp-stdio: subprocess implementation dropped a piped protocol stream')
    }
    /* v8 ignore stop */
    this.stdin = this.handle.stdin
    this.closed = new Promise<void>((resolve) => {
      const close = (): void => {
        const reason = this.closeReason ?? new Error(this.exitMessage())
        // Record the reason so any request issued AFTER close rejects immediately instead of hanging
        // (a closed process sends no further responses).
        this.closeReason = reason
        this.failAll(reason)
        resolve()
      }
      this.handle.done.then(close, (error: unknown) => {
        // A spawn-level failure never produces a close event; the rejection is
        // the fatal cause and the close boundary at once.
        this.fail(asError(error))
        close()
      })
    })
    // Child stdin can fail while the process itself remains alive (for example, a server closes fd
    // 0). Treat that as a fatal connection error so pending requests reject immediately instead of
    // waiting for a process-close event that may never arrive.
    this.stdin.on('error', (error) => { this.fail(error) })
    this.handle.stdout.on('data', (chunk: Buffer) => { this.onStdout(chunk) })
  }

  /** The child's pid, or `-1` when the spawn produced no pid (so signalling is a no-op). */
  get pid(): number {
    return this.handle.pid
  }

  /** The retained stderr tail, for diagnostics on a failed server. */
  get stderrTail(): string {
    /* v8 ignore next -- the collect disposition always exposes a stderr reader; defensive. */
    return this.handle.collected.stderr?.readFrom(0).text ?? ''
  }

  /** Whether the transport has failed even if the child close event has not arrived yet. */
  get failed(): boolean {
    return this.closeReason !== undefined
  }

  /**
   * Test whether a caught error is this connection's retained fatal transport cause.
   * @param error - error caught by the instance or provider.
   * @returns `true` only when this connection produced that exact failure.
   */
  failedWith(error: unknown): boolean {
    return this.closeReason === error
  }

  /**
   * Send a request and await its result.
   * @param method - the JSON-RPC method.
   * @param params - the request params.
   * @returns the response result; rejects on an error response, write failure, or close.
   */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const promise = new Promise<unknown>((resolve, reject) => {
      if (this.closeReason !== undefined) {
        reject(this.closeReason)
        return
      }
      this.pending.set(id, { resolve, reject })
      // `write()` records either synchronous or callback-delivered failures on the connection and
      // rejects every pending request. This handler only consumes the write promise itself.
      void this.write({ jsonrpc: '2.0', id, method, params }).catch(() => {})
    })
    // A caller that stops awaiting (e.g. an aborted query) can leave this promise to reject later
    // when the process closes; a benign no-op handler keeps that from surfacing as an unhandled
    // rejection. The returned promise still delivers the rejection to the caller's own await/catch.
    promise.catch(() => {})
    return promise
  }

  /**
   * Send a notification (no id, no response).
   * @param method - the JSON-RPC method.
   * @param params - the notification params.
   * @returns a promise that settles when the framed notification has been written.
   */
  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Send a `$/cancelRequest` for an in-flight request id (best-effort; ignores write failure).
   * @param requestId - the numeric id of the request to cancel.
   */
  cancel(requestId: number): void {
    // The server is already gone or unwritable when this rejects; `write()` has recorded the fatal
    // connection failure and rejected the pending request, so cancellation remains best-effort.
    void this.write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: requestId } }).catch(() => {})
  }

  /**
   * The id the NEXT `request()` will use, so the instance can pre-arm a cancel.
   * @returns the numeric id the next request will be assigned.
   */
  peekNextId(): number {
    return this.nextId
  }

  /** Terminate the server's process tree (the seam's SIGTERM→grace→SIGKILL escalation; idempotent). */
  terminate(): void {
    this.handle.terminate()
  }

  /**
   * Wait until the owned process tree has exited.
   * @param signal - optional bound for the wait.
   * @returns `true` when the tree exited, or `false` when the signal aborted first.
   */
  async waitForProcessTreeExit(signal?: AbortSignal): Promise<boolean> {
    return await this.handle.waitForExit(signal)
  }

  private onStdout(chunk: Buffer): void {
    let messages: unknown[]
    try {
      messages = this.decoder.push(chunk)
    } catch (error) {
      // A framing/JSON failure corrupts the stream position irrecoverably: fail the instance and
      // terminate the whole group so helper processes don't outlive the leader (SIGTERM first, then
      // the kill grace's SIGKILL — a misbehaving server still gets its bounded flush window).
      this.fail(asError(error))
      this.handle.terminate()
      return
    }
    for (const message of messages) this.dispatch(message)
  }

  private dispatch(message: unknown): void {
    if (message === null || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if (typeof method === 'string' && (typeof id === 'number' || typeof id === 'string')) {
      // A response-write failure has already invalidated the connection in `write()`.
      /* v8 ignore next -- protocol tests exercise response writes; only a simultaneous connection
         failure makes this consumption handler run. */
      void this.handleServerRequest(id, method, frame.params).catch(() => {})
      return
    }
    if (typeof method === 'string') {
      // A server→client notification (e.g. diagnostics, logs): ignored by this MVP host.
      return
    }
    if (typeof id === 'number') this.handleResponse(id, frame)
  }

  private async handleServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onServerRequest(method, params)
      await this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      await this.write({ jsonrpc: '2.0', id, error: { code: -32601, message: asError(error).message } })
    }
  }

  private handleResponse(id: number, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const error = frame.error
    if (error !== null && typeof error === 'object') {
      const record = error as Record<string, unknown>
      pending.reject(new Error(typeof record.message === 'string' ? record.message : 'LSP error response'))
      return
    }
    pending.resolve(frame.result)
  }

  private write(message: unknown): Promise<void> {
    if (this.closeReason !== undefined) return Promise.reject(this.closeReason)
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error | null): void => {
        if (error === undefined || error === null) {
          resolve()
          return
        }
        this.fail(error)
        reject(error)
      }
      try {
        this.writer(this.stdin, message, done)
      /* v8 ignore start -- Node stream write failures are callback-delivered; this guards a
         nonconforming Writable implementation throwing synchronously. */
      } catch (error) {
        const failure = asError(error)
        this.fail(failure)
        reject(failure)
      }
      /* v8 ignore stop */
    })
  }

  /** The exit-close error message, appending the retained stderr tail when the server wrote any. */
  private exitMessage(): string {
    const tail = this.stderrTail.trim()
    return tail === '' ? 'language server exited' : `language server exited; stderr: ${tail}`
  }

  private fail(error: Error): void {
    /* v8 ignore next -- the second arm (closeReason already set) needs two fail() calls before close; defensive. */
    if (this.closeReason === undefined) this.closeReason = error
    this.failAll(error)
  }

  private failAll(error: Error): void {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const pending of waiting) pending.reject(error)
  }
}

function asError(value: unknown): Error {
  /* v8 ignore next -- the non-Error branch guards against a non-Error throw, which our paths never produce. */
  return value instanceof Error ? value : new Error(String(value))
}

import { Buffer } from 'node:buffer'

import type { FileSystem, FsTarget } from '@ejunz/ea-core/fs'

export interface HostWorkspace {
  /** Stable filesystem identity used for provider pooling. */
  readonly target: FsTarget
  /** Canonical absolute path accepted as a subprocess cwd. */
  readonly canonicalPath: string
  /** Canonical file URI sent during LSP initialization. */
  readonly fileUrl: string
}

export interface HostSource {
  /** Canonical file URI in the execution world's platform syntax. */
  readonly fileUrl: string
  /** Current complete UTF-8 text. */
  readonly text: string
}

export async function canonicalizeWorkspace(
  fs: FileSystem,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<HostWorkspace> {
  throwIfAborted(signal)
  let target: FsTarget
  try {
    target = await fs.resolve(workspaceRoot, signal === undefined ? {} : { signal })
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`workspace root "${workspaceRoot}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  const info = await fs.stat(target, signal).catch((error: unknown) => {
    throwIfAborted(signal)
    throw error
  })
  throwIfAborted(signal)
  if (info?.type !== 'directory') {
    throw new Error(`workspace root "${workspaceRoot}" is not a directory`)
  }
  return {
    target,
    canonicalPath: fs.processPath(target),
    fileUrl: fs.fileUrl(target),
  }
}

export async function readHostSource(
  fs: FileSystem,
  filePath: string,
  workspace: HostWorkspace,
  maxDocumentBytes: number,
  signal?: AbortSignal,
): Promise<HostSource> {
  throwIfAborted(signal)
  let target: FsTarget
  try {
    target = await fs.resolve(filePath, {
      cwd: workspace.canonicalPath,
      ...signal === undefined ? {} : { signal },
    })
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" cannot be resolved: ${messageOf(error)}`, { cause: error })
  }
  throwIfAborted(signal)
  if (!fs.contains(workspace.target, target)) {
    throw new Error(`source "${filePath}" resolves outside the workspace`)
  }
  const chunks: string[] = []
  let bytes = 0
  try {
    // XXX(lsp-source-replacement): Revisit stable-handle identity only if a real query observes
    // replacement between canonical containment and the provider opening this stream.
    const stream = await fs.streamText(target, signal)
    for await (const chunk of stream) {
      throwIfAborted(signal)
      bytes += Buffer.byteLength(chunk)
      if (bytes > maxDocumentBytes) break
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    throwIfAborted(signal)
    throw new Error(`source "${filePath}" could not be read: ${messageOf(error)}`, { cause: error })
  }
  if (bytes > maxDocumentBytes) {
    throw new Error(
      `source "${filePath}" exceeds the ${maxDocumentBytes}-byte limit; reading stopped after ${bytes} bytes`,
    )
  }
  throwIfAborted(signal)
  return {
    fileUrl: fs.fileUrl(target),
    text: chunks.join(''),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface WirePosition {
  readonly line: number
  readonly character: number
}

export interface WireRange {
  readonly start: WirePosition
  readonly end: WirePosition
}

export interface WireLocation {
  readonly uri: string
  readonly range: WireRange
}

export interface WireLocationLink {
  readonly targetUri: string
  readonly targetSelectionRange: WireRange
  readonly targetRange?: WireRange
}

export interface WireMarkupContent {
  readonly kind: 'markdown' | 'plaintext'
  readonly value: string
}

export interface WireMarkedStringObject {
  readonly language: string
  readonly value: string
}

export type WireMarkedString = string | WireMarkedStringObject

export interface WireHover {
  readonly contents: WireMarkupContent | WireMarkedString | readonly WireMarkedString[]
  readonly range?: WireRange
}

export type WireTextDocumentSyncKind = 0 | 1 | 2

export interface WireTextDocumentSyncOptions {
  readonly openClose?: boolean
  readonly change?: WireTextDocumentSyncKind
}

export type WireProviderCapability = boolean | Record<string, unknown> | undefined

export interface WireServerCapabilities {
  readonly positionEncoding?: string
  readonly textDocumentSync?: WireTextDocumentSyncKind | WireTextDocumentSyncOptions
  readonly definitionProvider?: WireProviderCapability
  readonly referencesProvider?: WireProviderCapability
  readonly implementationProvider?: WireProviderCapability
  readonly hoverProvider?: WireProviderCapability
}

export interface WireInitializeResult {
  readonly capabilities: WireServerCapabilities
}

import type {
  LspHover,
  LspLocation,
  LspOperation,
  LspRange,
} from '@ejunz/ea-core/lsp'

import { LspError } from '@ejunz/ea-core/lsp'

import { assertNever } from '@ejunz/ea-core/llm'

export function requestMethod(operation: LspOperation): string {
  switch (operation) {
    case 'goToDefinition': return 'textDocument/definition'
    case 'findReferences': return 'textDocument/references'
    case 'goToImplementation': return 'textDocument/implementation'
    case 'hover': return 'textDocument/hover'
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'requestMethod')
  }
}

function capabilityValue(capabilities: WireServerCapabilities, operation: LspOperation): WireProviderCapability {
  switch (operation) {
    case 'goToDefinition': return capabilities.definitionProvider
    case 'findReferences': return capabilities.referencesProvider
    case 'goToImplementation': return capabilities.implementationProvider
    case 'hover': return capabilities.hoverProvider
    /* v8 ignore next -- exhaustive over the closed LspOperation union; unreachable. */
    default: return assertNever(operation, 'capabilityValue')
  }
}

function supportsCapability(value: WireProviderCapability): boolean {
  if (value === undefined) return false
  if (typeof value === 'boolean') return value
  return true
}

export function supportsOperation(capabilities: WireServerCapabilities, operation: LspOperation): boolean {
  return supportsCapability(capabilityValue(capabilities, operation))
}

export function supportsTransientOpen(sync: WireServerCapabilities['textDocumentSync']): boolean {
  if (sync === undefined) return false
  if (typeof sync === 'number') return isOpenCloseKind(sync)
  return sync.openClose === true
}

function isOpenCloseKind(kind: WireTextDocumentSyncKind): boolean {
  return kind === 1 || kind === 2
}

export function negotiatePositionEncoding(encoding: string | undefined): 'utf-16' {
  if (encoding === undefined || encoding === 'utf-16') return 'utf-16'
  throw new Error(`server negotiated unsupported position encoding "${encoding}"; this host requires utf-16`)
}

function toRange(range: WireRange): LspRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

function isLocationLink(value: Record<string, unknown>): boolean {
  return typeof value.targetUri === 'string' && isRange(value.targetSelectionRange)
}

function isLocation(value: Record<string, unknown>): boolean {
  return typeof value.uri === 'string' && isRange(value.range)
}

function isRange(value: unknown): value is WireRange {
  if (value === null || typeof value !== 'object') return false
  const range = value as Record<string, unknown>
  return isPosition(range.start) && isPosition(range.end)
}

function isPosition(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const position = value as Record<string, unknown>
  return isProtocolCoordinate(position.line) && isProtocolCoordinate(position.character)
}

function isProtocolCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function normalizeLocations(payload: unknown): LspLocation[] {
  if (payload === null) return []
  if (payload === undefined) throw malformedResponse('LSP navigation result was missing')
  const elements = Array.isArray(payload) ? payload : [payload]
  const locations: LspLocation[] = []
  for (const element of elements) {
    if (element === null || typeof element !== 'object') {
      throw malformedResponse('LSP navigation result contained a non-object entry')
    }
    const record = element as Record<string, unknown>
    if (isLocationLink(record)) {
      const link = record as unknown as WireLocationLink
      locations.push({ uri: link.targetUri, range: toRange(link.targetSelectionRange) })
    } else if (isLocation(record)) {
      const location = record as unknown as WireLocation
      locations.push({ uri: location.uri, range: toRange(location.range) })
    } else {
      throw malformedResponse('LSP navigation result contained neither a Location nor a LocationLink')
    }
  }
  return locations
}

function renderMarkedString(value: WireMarkedString): string {
  if (typeof value === 'string') return value
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``
}

export function normalizeHover(payload: unknown): LspHover | null {
  if (payload === null) return null
  if (payload === undefined) throw malformedResponse('LSP hover result was missing')
  if (typeof payload !== 'object') throw malformedResponse('LSP hover result was not an object')
  const hover = payload as unknown as WireHover
  const contents = renderHoverContents(hover.contents)
  if (contents === '') return null
  const range = hover.range
  if (range === undefined) return { contents }
  if (!isRange(range)) throw malformedResponse('LSP hover result contained a malformed range')
  return { contents, range: toRange(range) }
}

function renderHoverContents(contents: unknown): string {
  if (contents === null || contents === undefined) {
    throw malformedResponse('LSP hover result had no contents')
  }
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((value) => {
      if (isMarkedString(value)) return renderMarkedString(value)
      throw malformedResponse('LSP hover contents contained a malformed MarkedString')
    }).join('\n\n')
  }
  if (typeof contents !== 'object') {
    throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
  }
  const record = contents as Record<string, unknown>
  if (record.kind === 'markdown' || record.kind === 'plaintext') {
    if (typeof record.value !== 'string') {
      throw malformedResponse('LSP hover MarkupContent value was not a string')
    }
    return record.value
  }
  if (typeof record.language === 'string' && typeof record.value === 'string') {
    return renderMarkedString({ language: record.language, value: record.value })
  }
  throw malformedResponse('LSP hover contents were not MarkupContent, MarkedString, or an array')
}

function isMarkedString(value: unknown): value is WireMarkedString {
  if (typeof value === 'string') return true
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.language === 'string' && typeof record.value === 'string'
}

function malformedResponse(message: string): LspError {
  return new LspError(message, 'LSP_MALFORMED_RESPONSE')
}

import { LspError } from '@ejunz/ea-core/lsp'

import type {
  LspOperation,
  LspProviderQuery,
  LspQueryResult,
} from '@ejunz/ea-core/lsp'

import { deadline } from '@ejunz/ea-core/timeout'

export interface InstanceSpec extends ConnectionSpec {
  /** Canonical workspace file URI supplied by the filesystem provider. */
  readonly workspaceUri: string
  /** Static `initialize` options forwarded to the server. */
  readonly initializationOptions: unknown
  /** Graceful `shutdown`/`exit` budget before escalation (ms). */
  readonly shutdownTimeoutMs: number
}

export class LspInstance {
  private readonly connection: LspConnection
  private capabilities: WireServerCapabilities | undefined
  /** The serialization tail: each query awaits the prior one, so lifecycles never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private disposed = false
  /** The one teardown transaction shared by abort, failure, and explicit disposal. */
  private teardownPromise: Promise<void> | undefined
  /** Set once the process closes, so the pool can synchronously skip a dead instance. */
  private processClosed = false
  /** Populated once `initialize` succeeds; a failed handshake rejects every query. */
  private readonly ready: Promise<void>

  /**
   * @param spec - the launch, initialize, and teardown parameters.
   * @param spawner - the subprocess seam's spawn function.
   * @param writer - optional connection writer used by transport conformance tests.
   */
  constructor(private readonly spec: InstanceSpec, spawner: ConnectionSpawner, writer?: ConnectionWriter) {
    this.connection = new LspConnection(spec, spawner, (method, params) => this.answerServerRequest(method, params), writer)
    this.ready = this.initialize()
    // A handshake rejection must not surface as an unhandled rejection before the first query awaits
    // it; queries attach the real handler.
    this.ready.catch(() => {})
    void this.connection.closed.then(() => { this.processClosed = true })
  }

  /** Synchronous liveness check: true once the process has closed or the instance was disposed. */
  get dead(): boolean {
    return this.processClosed || this.disposed || this.connection.failed
  }

  /**
   * Test whether a caught query error came from this instance's transport.
   * @param error - error caught by the provider.
   * @returns `true` only for the connection's retained fatal transport cause.
   */
  isTransportFailure(error: unknown): boolean {
    return this.connection.failedWith(error)
  }

  /**
   * Run one query through the serialized queue.
   * @param request - the resolved provider query.
   * @param source - the pre-validated, already-read host source (the provider reads before spawning).
   * @param signal - optional cancellation for this query's full lifecycle.
   * @returns the normalized result.
   */
  query(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    // Serialize behind prior work, but observe abort DURING the queue wait too: if an earlier query
    // hangs (e.g. a signal-less service caller), a later tool's timeout must still be able to give up
    // rather than block on the shared tail forever.
    const run = abortable(this.queue, signal)
      .then(() => this.runQuery(request, source, signal))
      .catch(async (error: unknown) => {
        if (this.isTransportFailure(error)) await this.startTeardown()
        throw error
      })
    // Keep the tail alive regardless of this query's outcome so the next caller still serializes. The
    // tail follows the ACTUAL prior work (this.queue), not the abortable view, so a caller giving up
    // on the wait does not deserialize the queue.
    this.queue = this.queue.then(() => run).then(() => undefined, () => undefined)
    return run
  }

  private async initialize(): Promise<void> {
    const initializeResult = await this.connection.request('initialize', {
      // A subprocess provider may run in another PID namespace or machine;
      // the host PID would let the server monitor an unrelated process.
      processId: null,
      rootUri: this.spec.workspaceUri,
      workspaceFolders: [{ uri: this.spec.workspaceUri, name: 'workspace' }],
      capabilities: CLIENT_CAPABILITIES,
      initializationOptions: this.spec.initializationOptions,
    }) as WireInitializeResult
    const capabilities = initializeResult.capabilities
    // An omitted encoding defaults to utf-16; any other value is a protocol error we reject here.
    negotiatePositionEncoding(capabilities.positionEncoding)
    this.capabilities = capabilities
    await this.connection.notify('initialized', {})
  }

  private async runQuery(request: LspProviderQuery, source: HostSource, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new LspError('LSP instance was disposed', 'LSP_DISPOSED')
    /* v8 ignore next -- the abortable queue wait rejects a pre-aborted signal before runQuery; this is a belt-and-suspenders guard. */
    if (signal?.aborted) throw abortError(signal)
    // Observe abort during the handshake wait, and never pool a poisoned instance: if the wait ends
    // in failure — an abort on a still-pending handshake, OR `initialize` rejecting (utf-8
    // negotiation, malformed result) without the process exiting — tear the instance down so a
    // permanently-rejecting/pending `ready` can't make every later query for this workspace fail.
    try {
      await abortable(this.ready, signal)
    } catch (error) {
      if (!this.dead) {
        await this.startTeardown()
      }
      throw error
    }
    const capabilities = this.capabilities
    /* v8 ignore next -- `ready` resolves only after capabilities are set, else it rejects above; defensive. */
    if (capabilities === undefined) throw new Error('LSP instance is not initialized')
    if (!supportsOperation(capabilities, request.operation)) {
      throw new LspError(`server does not support ${request.operation}`, 'LSP_UNSUPPORTED_OPERATION')
    }
    if (!supportsTransientOpen(capabilities.textDocumentSync)) {
      throw new LspError('server does not support the transient textDocument/didOpen this host requires', 'LSP_UNSUPPORTED_OPERATION')
    }

    const uri = source.fileUrl
    let opened = false
    try {
      /* v8 ignore next -- guards an abort landing between the ready wait and didOpen; not deterministically reproducible. */
      if (signal?.aborted) throw abortError(signal)
      try {
        await abortable(this.connection.notify('textDocument/didOpen', {
          textDocument: { uri, languageId: request.languageId, version: 1, text: source.text },
        }), signal)
      } catch (error) {
        // A canceled backpressured write or failed stdin leaves the protocol stream unusable before
        // `opened` can arm the didClose cleanup. Teardown here makes the pool evict the instance.
        await this.startTeardown()
        throw error
      }
      opened = true
      const payload = await this.sendRequest(request.operation, uri, request.position, signal)
      return this.normalize(request.operation, payload)
    } finally {
      // A disposed or closed instance (e.g. an aborted request whose server ignored
      // `$/cancelRequest`) is already tearing down; sending didClose would race that teardown and let
      // the next queued query's document lifecycle overlap the still-active request.
      if (opened && !this.dead) {
        try {
          await this.connection.notify('textDocument/didClose', { textDocument: { uri } })
        } catch {
          // A close-write failure does not replace the settled result/error, but the instance can no
          // longer be trusted: invalidate it and await bounded process termination.
          try {
            await this.startTeardown()
          } catch {
            /* v8 ignore next -- teardown owns all expected process races; this only preserves the
               already-settled query outcome if an unexpected cleanup primitive itself rejects. */
          }
        }
      }
    }
  }

  private async sendRequest(
    operation: LspOperation,
    uri: string,
    position: LspProviderQuery['position'],
    signal?: AbortSignal,
  ): Promise<unknown> {
    const params = {
      textDocument: { uri },
      position: { line: position.line, character: position.character },
      // findReferences always includes declarations: the caller gets no flag and impact analysis
      // never omits the defining site.
      ...(operation === 'findReferences' ? { context: { includeDeclaration: true } } : {}),
    }
    const requestId = this.connection.peekNextId()
    const send = this.connection.request(requestMethod(operation), params)
    if (signal === undefined) return send
    return this.raceAbort(send, requestId, signal)
  }

  /**
   * Race a pending request against abort. On abort, send `$/cancelRequest` and give the server a
   * bounded grace to acknowledge; if it does not settle in time, invalidate and tear down the
   * instance so the still-active request cannot overlap the next queued query's document lifecycle.
   */
  private async raceAbort(send: Promise<unknown>, requestId: number, signal: AbortSignal): Promise<unknown> {
    try {
      return await abortable(send, signal)
    } catch (error) {
      if (!signal.aborted) throw error
      this.connection.cancel(requestId)
      // Wait, bounded, for the server to honor the cancellation. If it does not, the request is still
      // running: terminate the instance (disposal awaits process close) so nothing outlives the query.
      const grace = deadline(undefined, this.spec.killGraceMs, 'LSP_CANCEL_GRACE')
      try {
        // `settled` is true if the request finished (either outcome) before the grace elapsed.
        const settled = await Promise.race([
          send.then(markSettled, markSettled),
          new Promise<boolean>((resolve) => {
            /* v8 ignore next -- the cancel-grace deadline signal is freshly armed and not yet aborted here; defensive. */
            if (grace.signal.aborted) { resolve(false); return }
            grace.signal.addEventListener('abort', () => { resolve(false) }, { once: true })
          }),
        ])
        if (!settled) await this.startTeardown()
      } finally {
        grace[Symbol.dispose]()
      }
      throw error
    }
  }

  private normalize(operation: LspOperation, payload: unknown): LspQueryResult {
    if (operation === 'hover') {
      return { kind: 'hover', hover: normalizeHover(payload) }
    }
    // The filesystem provider owns URI syntax for the execution platform, which may differ from the
    // ejunzAgent host. Preserve that coordinate through rendering instead of reparsing `spec.cwd` there.
    return { kind: 'locations', locations: normalizeLocations(payload), resolvedWorkspaceUri: this.spec.workspaceUri }
  }

  private answerServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === 'workspace/configuration') {
      // Answer every requested item with the one static configuration value.
      const record = params as { items?: unknown[] } | null
      /* v8 ignore next -- a configuration request always carries an items array; the empty fallback is defensive. */
      const items = Array.isArray(record?.items) ? record.items : []
      return Promise.resolve(items.map(() => this.spec.configuration))
    }
    if (LIFECYCLE_NOOP_METHODS.has(method)) {
      // Accept lifecycle bookkeeping requests with an empty result; we register nothing dynamic.
      return Promise.resolve(null)
    }
    if (method === 'workspace/applyEdit') {
      // This host never applies edits or runs commands.
      return Promise.reject(new Error('workspace/applyEdit is not permitted by this host'))
    }
    return Promise.reject(new Error(`unsupported server request: ${method}`))
  }

  /**
   * Reject queued work, attempt graceful `shutdown`/`exit`, then escalate SIGTERM→SIGKILL, awaiting
   * process close so nothing outlives disposal.
   */
  async dispose(): Promise<void> {
    await this.startTeardown()
  }

  /** Publish disposal once and make every caller await the same quiescence boundary. */
  private startTeardown(): Promise<void> {
    this.disposed = true
    this.teardownPromise ??= this.tearDown()
    return this.teardownPromise
  }

  private async tearDown(): Promise<void> {
    const shutdownDeadline = deadline(undefined, this.spec.shutdownTimeoutMs, 'LSP_SHUTDOWN')
    try {
      await this.gracefulShutdown(shutdownDeadline.signal)
    } catch {
      // Graceful shutdown failed or timed out; process-tree cleanup below remains authoritative.
    } finally {
      shutdownDeadline[Symbol.dispose]()
    }
    await this.forceTerminate()
  }

  /** Best-effort LSP `shutdown`/`exit`, including process close, bounded by `signal`. */
  private async gracefulShutdown(signal: AbortSignal): Promise<void> {
    await abortable(this.connection.request('shutdown', null), signal)
    await this.connection.notify('exit', null)
    await abortable(this.connection.closed, signal)
  }

  /**
   * Terminate the tree (the seam escalates SIGTERM→`killGraceMs`→SIGKILL),
   * then await leader and helper exit. The awaits are unbounded on purpose:
   * the seam's escalation already committed to SIGKILL, so quiescence — not
   * another timer — is the postcondition disposal owes its callers.
   */
  private async forceTerminate(): Promise<void> {
    this.connection.terminate()
    await Promise.all([
      this.connection.closed,
      this.connection.waitForProcessTreeExit(),
    ])
  }
}

const LIFECYCLE_NOOP_METHODS = new Set([
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
])

function markSettled(): boolean {
  return true
}

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ['utf-16'] },
  workspace: { workspaceFolders: true, configuration: true },
  textDocument: {
    synchronization: { dynamicRegistration: false },
    hover: { contentFormat: ['markdown', 'plaintext'] },
    definition: { linkSupport: true },
    implementation: { linkSupport: true },
    references: {},
  },
} as const

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { LspError, LspProviderId } from '@ejunz/ea-core/lsp'

import type {
  LspProvider,
  LspProviderQuery,
  LspQueryResult,
} from '@ejunz/ea-core/lsp'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea-core/timeout'

export const name = 'lsp-stdio'

export const inject = ['fs', 'lsp', 'subprocess']

const DEFAULT_MAX_MESSAGE_BYTES = 16_000_000

const DEFAULT_MAX_STDERR_BYTES = 1_000_000

const DEFAULT_MAX_DOCUMENT_BYTES = 4_000_000

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000

const DEFAULT_KILL_GRACE_MS = 2_000

export interface LspLocalServerConfig {
  /** Executable to spawn (absolute, or resolved on PATH at load). */
  command: string
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  extensionToLanguage: Record<string, string>
  /** Arguments passed to the executable (no shell). Default `[]`. */
  args?: string[]
  /** Extra env vars merged on top of the scrubbed ambient env. Default `{}`. */
  env?: Record<string, string>
  /** Static `initialize` options forwarded to the server. Default `null`. */
  initializationOptions?: unknown
  /** Static answer to every `workspace/configuration` item. Default `null`. */
  configuration?: unknown
  /** Largest single framed message accepted from the server (bytes). Default 16000000. */
  maxMessageBytes?: number
  /** Largest stderr tail retained for diagnostics (bytes). Default 1000000. */
  maxStderrBytes?: number
  /** Largest source file this host will open (bytes). Default 4000000. */
  maxDocumentBytes?: number
  /** Graceful `shutdown`/`exit` budget before escalation (ms). Default 5000. */
  shutdownTimeoutMs?: number
  /** Request-cancel and SIGTERM→SIGKILL grace (ms). Default 2000. */
  killGraceMs?: number
}

export interface Config {
  /** Non-empty table of stable provider ids to independent local server configurations. */
  servers: Record<string, LspLocalServerConfig>
}

type ResolvedServerConfig = Required<LspLocalServerConfig>

type WorkspaceKey = HostWorkspace['target']['targetKey']

const LspLocalServerConfig: z<LspLocalServerConfig> = z.object({
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  extensionToLanguage: z.dict(String).required(),
  initializationOptions: z.any().default(null),
  configuration: z.any().default(null),
  maxMessageBytes: z.number().default(DEFAULT_MAX_MESSAGE_BYTES),
  maxStderrBytes: z.number().default(DEFAULT_MAX_STDERR_BYTES),
  maxDocumentBytes: z.number().default(DEFAULT_MAX_DOCUMENT_BYTES),
  shutdownTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
  killGraceMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_KILL_GRACE_MS),
})

export const Config: z<Config> = z.object({
  servers: z.dict(LspLocalServerConfig).required(),
})

function throwTeardownFailures(results: readonly PromiseSettledResult<void>[], message: string): void {
  const failures: unknown[] = []
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const entries = Object.entries(config.servers)
  if (entries.length === 0) throw new Error('lsp-stdio: servers must contain at least one server')

  const setupAbort = new AbortController()
  const stopSetupCancellation = ctx.on('internal/plugin', (fiber) => {
    // An async plugin callback must observe its own disposal before Cordis can
    // run effect cleanup, because unload otherwise waits for this callback.
    if (fiber === ctx.fiber && fiber.uid === null) {
      setupAbort.abort(new Error('lsp-stdio setup disposed'))
    }
  })

  // Resolve every server-local setting before registration so a bad later command or bound cannot
  // publish an earlier provider. Registry-level mapping conflicts are rolled back below.
  const providers = await (async () => {
    const lookups = entries.map(async ([providerId, rawConfig]) => {
      if (providerId.trim() === '') throw new Error('lsp-stdio: server ids must be non-empty strings')
      const resolved = rawConfig as ResolvedServerConfig
      validateServerConfig(providerId, resolved)
      const executable = await ctx.subprocess.resolveExecutable(
        resolved.command,
        resolved.env,
        setupAbort.signal,
      )
      setupAbort.signal.throwIfAborted()
      return new LocalLspProvider(
        providerId,
        ctx.fs,
        resolved,
        executable,
        spec => ctx.subprocess.spawn(spec),
      )
    })
    try {
      return await Promise.all(lookups)
    } catch (error: unknown) {
      setupAbort.abort(error)
      await Promise.allSettled(lookups)
      throw error
    } finally {
      stopSetupCancellation()
    }
  })()

  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const provider of providers) disposers.push(ctx.lsp.registerProvider(provider))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return async () => {
      // Remove every route before process teardown so no new query can enter a draining provider.
      for (const dispose of disposers.reverse()) dispose()
      const results = await Promise.allSettled(providers.map(provider => provider.disposeAll()))
      throwTeardownFailures(results, 'lsp-stdio provider teardown failed')
    }
  }, 'lsp-stdio.registerProviders')
}

function validateServerConfig(providerId: string, resolved: ResolvedServerConfig): void {
  // Teardown budgets feed `deadline()`, whose `<= 0` is the internal no-timeout sentinel; a
  // nonpositive value would let a server that ignores shutdown hang disposal forever. Fail at load.
  assertTimer(providerId, 'shutdownTimeoutMs', resolved.shutdownTimeoutMs)
  assertTimer(providerId, 'killGraceMs', resolved.killGraceMs)
  // Byte caps must be positive: a nonpositive stderr cap defeats the retained-tail bound
  // (`slice(-0)` keeps everything), `maxMessageBytes: 0` makes every response fatal, and a bad
  // document cap fails later in the read path instead of at load.
  assertPositiveInteger(providerId, 'maxStderrBytes', resolved.maxStderrBytes)
  assertPositiveInteger(providerId, 'maxMessageBytes', resolved.maxMessageBytes)
  assertPositiveInteger(providerId, 'maxDocumentBytes', resolved.maxDocumentBytes)
}

function assertTimer(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

function assertPositiveInteger(providerId: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`lsp-stdio: servers.${providerId}.${name} must be a positive integer`)
  }
}

class LocalLspProvider implements LspProvider {
  readonly id: LspProviderId
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /** One live instance per stable canonical workspace identity. */
  private readonly instances = new Map<WorkspaceKey, LspInstance>()
  /** One complete source-read→open→query→close serialization tail per canonical workspace. */
  private readonly queues = new Map<WorkspaceKey, Promise<void>>()
  /** Workspace canonicalizations that have not entered a provider-owned queue yet. */
  private readonly workspaceLookups = new Set<Promise<void>>()
  private readonly lifetime = new AbortController()
  private disposed = false

  constructor(
    providerId: string,
    private readonly fs: Context['fs'],
    private readonly config: ResolvedServerConfig,
    private readonly executable: string,
    private readonly spawner: ConnectionSpawner,
  ) {
    this.id = LspProviderId(providerId)
    this.extensionToLanguage = config.extensionToLanguage
  }

  /** Read the disposed flag through a method so a `query()` await cannot narrow it to a literal. */
  private isDisposed(): boolean {
    return this.disposed
  }

  /** Reject work that cannot publish or use a provider-owned instance. */
  private assertActive(signal?: AbortSignal): void {
    /* v8 ignore next -- the seam unregisters this provider before disposal; direct in-flight calls
       exercise the post-await check instead. */
    if (this.isDisposed()) throw new LspError('lsp-stdio provider is disposed', 'LSP_DISPOSED')
    if (signal?.aborted) throw abortError(signal)
  }

  /** Fuse caller cancellation with provider disposal for every filesystem and protocol await. */
  private querySignal(signal?: AbortSignal): AbortSignal {
    return signal === undefined
      ? this.lifetime.signal
      : AbortSignal.any([signal, this.lifetime.signal])
  }

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
    // Honor an already-aborted signal before provider I/O so a canceled request never starts a server.
    this.assertActive(signal)
    const querySignal = this.querySignal(signal)
    const workspaceResult = canonicalizeWorkspace(this.fs, request.workspaceRoot, querySignal)
    const workspaceLookup = workspaceResult.then(() => undefined, () => undefined)
    this.workspaceLookups.add(workspaceLookup)
    let workspace: HostWorkspace
    try {
      workspace = await workspaceResult
    } finally {
      this.workspaceLookups.delete(workspaceLookup)
    }
    this.assertActive(querySignal)
    const workspaceKey = workspace.target.targetKey
    return this.enqueue(workspaceKey, querySignal, async () => {
      this.assertActive(querySignal)
      // Read inside the workspace queue but before spawning: a queued query sees current bytes when
      // its turn starts, while an invalid source still cannot leave an idle process pooled.
      const source = await readHostSource(this.fs, request.filePath, workspace, this.config.maxDocumentBytes, querySignal)
      // Disposal may have snapshotted the instance map while host I/O was pending. Re-check before a
      // synchronous get-or-create so every spawned process remains owned by teardown.
      this.assertActive(querySignal)
      let instance = this.instanceFor(workspaceKey, workspace)
      try {
        return await instance.query(request, source, querySignal)
      } catch (error) {
        // A selected child can have died while idle or fail during the next write. Queries are
        // read-only, so replace that transport once and retry transparently.
        if (!instance.isTransportFailure(error)) throw error
        await instance.dispose()
        this.evictIfCurrent(workspaceKey, instance)
        this.assertActive(querySignal)
        instance = this.instanceFor(workspaceKey, workspace)
        return await instance.query(request, source, querySignal)
      } finally {
        // Reach quiescence before dropping a dead slot; a replacement must survive this ownership check.
        if (instance.dead) {
          await instance.dispose()
          this.evictIfCurrent(workspaceKey, instance)
        }
      }
    })
  }

  /** Serialize one complete query lifecycle for a canonical workspace. */
  private enqueue<T>(workspace: WorkspaceKey, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(workspace) ?? Promise.resolve()
    const result = abortable(previous, signal).then(run)
    // The tail follows the actual prior work even when this caller aborts its wait. It never rejects,
    // so later callers serialize without inheriting an earlier query's outcome.
    const tail = previous.then(() => result).then(() => undefined, () => undefined)
    this.queues.set(workspace, tail)
    void tail.then(() => {
      if (this.queues.get(workspace) === tail) this.queues.delete(workspace)
    })
    return result
  }

  /** Return or synchronously publish the one instance for a canonical workspace. */
  private instanceFor(workspaceKey: WorkspaceKey, workspace: HostWorkspace): LspInstance {
    this.assertActive()
    const existing = this.instances.get(workspaceKey)
    if (existing !== undefined) return existing
    const created = this.createInstance(workspace)
    this.instances.set(workspaceKey, created)
    return created
  }

  /** Drop the slot iff it still contains this instance. */
  private evictIfCurrent(workspace: WorkspaceKey, instance: LspInstance): void {
    /* v8 ignore next -- mismatch requires another query to replace the slot before this finally runs. */
    if (this.instances.get(workspace) === instance) this.instances.delete(workspace)
  }

  private createInstance(workspace: HostWorkspace): LspInstance {
    const spec: InstanceSpec = {
      command: this.executable,
      args: this.config.args,
      cwd: workspace.canonicalPath,
      workspaceUri: workspace.fileUrl,
      env: this.config.env,
      configuration: this.config.configuration,
      initializationOptions: this.config.initializationOptions,
      maxMessageBytes: this.config.maxMessageBytes,
      maxStderrBytes: this.config.maxStderrBytes,
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      killGraceMs: this.config.killGraceMs,
    }
    return new LspInstance(spec, this.spawner)
  }

  /** Dispose every live instance and block further queries. */
  async disposeAll(): Promise<void> {
    this.disposed = true
    this.lifetime.abort(new LspError('lsp-stdio provider is disposed', 'LSP_DISPOSED'))
    const live = [...this.instances.values()]
    const draining = [...this.queues.values()]
    const resolving = [...this.workspaceLookups]
    this.instances.clear()
    const results = await Promise.allSettled([
      ...live.map(instance => instance.dispose()),
      ...draining,
      ...resolving,
    ])
    this.queues.clear()
    this.workspaceLookups.clear()
    throwTeardownFailures(results, 'lsp-stdio instance teardown failed')
  }
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/lsp-stdio'
  export const name = 'lsp-stdio-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
