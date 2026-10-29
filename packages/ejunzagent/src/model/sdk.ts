import { randomUUID } from 'node:crypto'

import type { Readable, Writable } from 'node:stream'

import { StringDecoder } from 'node:string_decoder'

type JsonRpcId = string | number

type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>

type NotificationHandler = (method: string, params: Record<string, unknown>) => void

export class JsonRpcResponseError extends Error {
  /**
   * @param code - the wire error code, or `undefined` when the peer sent none.
   * @param message - the wire error message.
   * @param data - the optional structured error payload, verbatim.
   */
  constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

export interface JsonRpcTransportPeer {
  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @returns the result; rejects with {@link JsonRpcResponseError} on an error
   * response, and with a plain `Error` on a write failure or closure.
   */
  request(method: string, params: object): Promise<unknown>
  /**
   * Send a notification; omitted params produce no `params` member.
   * @param method - the JSON-RPC method name.
   * @param params - the optional notification parameters object.
   */
  notify(method: string, params?: object): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class JsonRpcLineTransport implements JsonRpcTransportPeer {
  private buffer = ''
  private readonly decoder = new StringDecoder('utf8')
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  /** Attach the input listeners and begin reading frames. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
  }

  /**
   * Detach listeners and reject pending requests. Safe before {@link start}.
   */
  close(): void {
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.failPending(new Error('JSON-RPC transport closed'))
  }

  /**
   * Install the request handler, replacing any prior handler.
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and normalized
   * params object.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @param signal - optional abandonment signal: aborting removes the pending
   * entry (no state is retained for a response that may never come) and
   * rejects with the signal's reason.
   * @returns the result; rejects per {@link JsonRpcTransportPeer.request}.
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      let detach = (): void => {}
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason))
          return
        }
        const onAbort = (): void => {
          this.pending.delete(id)
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach()
          resolve(value)
        },
        reject: (error) => {
          detach()
          reject(error)
        },
      })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: object): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Wait for prior frame write callbacks. The empty barrier emits no bytes.
   * @returns a promise that settles with the output write callback.
   */
  flush(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.output.write('', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    this.drainLines()
  }

  private drainLines(): void {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      void this.handleLine(line)
    }
  }

  private readonly onInputError = (error: Error): void => {
    this.failPending(error)
  }

  private readonly onInputEnd = (): void => {
    this.buffer += this.decoder.end()
    this.drainLines()
    this.failPending(new Error('JSON-RPC input closed'))
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // Only JSON syntax errors reach this catch; malformed peer lines are ignored.
      return
    }
    if (!message || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleIncomingResponse(id, frame)
      return
    }
    if (typeof method === 'string') {
      this.notificationHandler?.(method, objectParams(frame.params))
    }
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.writeError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: Record<string, unknown>): void {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}

function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`)
}

import type { ContentBlock } from '@ejunz/ea-core/llm'

import type { SessionEvent } from '@ejunz/ea-core/session'

import type { SubagentStopReason } from '@ejunz/ea-core/subagent'

export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `EjunzAgentSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

export interface InitializeResult {
  /** Wire-stable server identity (`ejunz-agent-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

export type SdkRunStatus = 'ok' | 'error'

export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

export interface EjunzAgentSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

export interface EjunzAgentSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'shutdown': { params: undefined; result: Record<string, never> }
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/sdk'
  export const name = 'sdk-protocol-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
