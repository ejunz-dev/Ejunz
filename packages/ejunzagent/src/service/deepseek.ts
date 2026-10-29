export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  /** Thinking-mode toggle (top level, NOT inside extra_body on the wire). */
  thinking?: { type: 'enabled' | 'disabled' }
  /** Thinking effort (official levels). */
  reasoning_effort?: 'low' | 'high' | 'max'
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  /**
   * Stop sequences (OpenAI `stop`): generation halts as soon as the model
   * produces any one of these strings. Mapped from `GenerateOptions.stop`.
   */
  stop?: string[]
}

export interface WireSystemMessage {
  role: 'system'
  content: string
}

export interface WireUserMessage {
  role: 'user'
  content: string
}

export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

export interface WireAssistantMessage {
  role: 'assistant'
  content: string | null
  /**
   * CoT passback, present on every turn whose assistant content carried
   * reasoning. REQUIRED on tool-call turns in thinking mode (see
   * guides/thinking_mode.mdx § Tool Calls); DeepSeek ignores it elsewhere,
   * while a gateway re-encoding for another vendor recovers that turn's
   * thinking signature by hashing it.
   */
  reasoning_content?: string
  tool_calls?: WireToolCall[]
}

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
}

export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

export interface WireDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /**
   * Thinking-mode CoT. The FIRST chunk carries an empty string (must not
   * open a reasoning block); absent entirely in non-thinking mode.
   */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Present on the first delta of each call only. */
  id?: string
  type?: 'function'
  function?: {
    /** Present on the first delta of each call only. */
    name?: string
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string
  }
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}

import { contentHasImage, LlmError } from '@ejunz/ea-core/llm'

import type { ContentBlock, GenerateOptions, Message } from '@ejunz/ea-core/llm'

export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'low' | 'high' | 'max'
}

const RETIRED_V4_WIRE_MODELS: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

export function wireModelId(model: string): string {
  return RETIRED_V4_WIRE_MODELS[model] ?? model
}

function reasoningEffort(effort: NonNullable<GenerateOptions['reasoningEffort']>): 'off' | 'low' | 'high' | 'max' {
  if (effort === 'off' || effort === 'low' || effort === 'high' || effort === 'max') {
    return effort as 'off' | 'low' | 'high' | 'max'
  }
  throw new LlmError(
    `DeepSeek does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort === undefined
    ? defaults.reasoningEffort
    : reasoningEffort(options.reasoningEffort)
  if (defaults.thinking === 'disabled' && effort !== undefined && effort !== 'off') {
    throw new LlmError(
      `DeepSeek deployment does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  if (effort === 'off') return { thinking: 'disabled' }
  if (effort === 'low' || effort === 'high' || effort === 'max') {
    return { thinking: 'enabled', reasoningEffort: effort }
  }
  return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
}

function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The DeepSeek chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: the
    // official samples replay message.content verbatim (which is "") and
    // some gateways reject null outright. Reasoning-ONLY turns (the model
    // can answer entirely in the reasoning channel, e.g. a v4-flash
    // greeting): the live API rejects null-content/no-tool_calls assistant
    // messages with a 400 ("content or tool_calls must be set"), and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // CoT passback on every reasoning-carrying turn. The official rule
    // (guides/thinking_mode.mdx) requires it on tool-call turns and ignores it
    // elsewhere; a gateway re-encoding the conversation for another vendor
    // recovers that turn's upstream thinking signature by hashing this exact
    // text, which a tool-call-free turn carries nowhere else.
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the ejunzAgent
    // vocabulary, but DeepSeek wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults = {},
): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  // A short title budget must produce visible text; conversation and
  // compaction calls continue to inherit the adapter's thinking defaults.
  const resolvedThinking = resolveThinking(options, defaults)

  return {
    model: wireModelId(options.model),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined
      ? { reasoning_effort: resolvedThinking.reasoningEffort }
      : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}

import { EventSourceParserStream } from 'eventsource-parser/stream'

import { LlmError } from '@ejunz/ea-core/llm'

export const DONE = '[DONE]'

export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@ejunz/ea-core/llm'

import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@ejunz/ea-core/llm'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only, absent until a delta carries a non-empty value. */
  callId?: string | undefined
  name?: string | undefined
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

function acceptIdentity(current: string | undefined, incoming: unknown): string | undefined {
  return typeof incoming === 'string' && incoming.length > 0 ? incoming : current
}

function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        block.callId = acceptIdentity(block.callId, call.id)
        block.name = acceptIdentity(block.name, call.function?.name)
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest.
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}

import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, ReasoningEffortId } from '@ejunz/ea-core/llm'

import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@ejunz/ea-core/llm'

import type { CredentialRef } from '@ejunz/ea-core/credentials'

import { idleWatchdog, timeoutOf } from '@ejunz/ea-core/timeout'

import type { AnonymousUserId } from '@ejunz/ea-core/anonymous-user-id'

export interface DeepSeekCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted when deployment metadata is unavailable. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's {@link DeepSeekConnectionOptions.maxTokens}. */
  maxTokens?: number
}

export interface DeepSeekConnectionOptions {
  /** Endpoint base; `/chat/completions` is appended. */
  baseURL: string
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret. Configuration carries
   * only this name — a literal key is not a configuration value.
   */
  apiKeyEnv: CredentialRef
  /** Request defaults applied to every call (thinking mode, effort). */
  defaults: RequestDefaults
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

export interface DeepSeekAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => DeepSeekConnectionOptions
  resolveDomainOptions?: (connection: DeepSeekConnectionOptions, signal: AbortSignal) => Promise<DeepSeekConnectionOptions>
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: DeepSeekConnectionOptions, signal?: AbortSignal) => Promise<string>
  /** Resolve the ejunzAgent-home anonymous id shared with telemetry and feedback. */
  resolveUserId: () => AnonymousUserId
}

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export const DEFAULT_CONTEXT_WINDOW = 1_000_000

export const DEFAULT_MAX_TOKENS = 256_000

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

const OFF_REASONING_EFFORT = ReasoningEffortId('off')

const LOW_REASONING_EFFORT = ReasoningEffortId('low')

const HIGH_REASONING_EFFORT = ReasoningEffortId('high')

const MAX_REASONING_EFFORT = ReasoningEffortId('max')

const REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
  {
    id: LOW_REASONING_EFFORT,
    name: 'Low',
    description: 'Prefer for routine or latency-sensitive tasks.',
  },
  {
    id: HIGH_REASONING_EFFORT,
    name: 'High',
    description: 'The default balance for most tasks.',
  },
  {
    id: MAX_REASONING_EFFORT,
    name: 'Max',
    description: 'Reserve for the hardest quality-first tasks.',
  },
] as const

const OFF_ONLY_REASONING_EFFORTS = [
  {
    id: OFF_REASONING_EFFORT,
    name: 'Off',
    description: 'Use for simple tasks that do not need reasoning.',
  },
] as const

function modelInfo(provider: string, model: DeepSeekCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: ['text'],
  }
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

function followAbort(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) {
    controller.abort(signal.reason)
    return controller
  }
  signal.addEventListener('abort', () => {
    controller.abort(signal.reason)
  }, { once: true })
  return controller
}

export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

export class DeepSeekAdapter extends LlmAdapter {
  constructor(private readonly config: DeepSeekAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow
      ?? connection.defaultContextWindow
    return Promise.resolve({
      // The chat-completions wire route is text-only regardless of catalog
      // membership, so the uncatalogued fallback declares the same negative
      // capability — "unknown" here would let the host accept and persist
      // images the serializer must then reject.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...connection.defaults.thinking === 'disabled'
        ? {
          reasoning: {
            efforts: OFF_ONLY_REASONING_EFFORTS,
            defaultEffort: OFF_REASONING_EFFORT,
          },
        }
        : {
          reasoning: {
            efforts: REASONING_EFFORTS,
            defaultEffort: connection.defaults.reasoningEffort === 'off'
              ? OFF_REASONING_EFFORT
              : connection.defaults.reasoningEffort === 'low'
                ? LOW_REASONING_EFFORT
                : connection.defaults.reasoningEffort === 'max'
                  ? MAX_REASONING_EFFORT
                  : HIGH_REASONING_EFFORT,
          },
        },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const requestSignal = options.signal ?? new AbortController().signal
    const baseConnection = this.config.options()
    const connection = this.config.resolveDomainOptions === undefined
      ? baseConnection
      : await this.config.resolveDomainOptions(baseConnection, requestSignal)
    const apiKey = await this.config.resolveApiKey(connection, requestSignal)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    let sawChunk = false
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      userId,
      // Keep-alive SSE comments must not hide a first-token stall: only
      // rearm after the model has actually opened a stream chunk.
      () => { if (sawChunk) watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        sawChunk = true
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    onComment: () => void,
  ): AsyncIterable<StreamChunk> {
    const body = serializeRequest(options, connection.defaults)
    // Prepared outside the try so the TRANSPORT label below covers exactly the
    // transport boundary, never a serialization failure.
    const payload = JSON.stringify(body)
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-ejunz-agent-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-ejunz-agent-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-ejunz-agent-compact': '1' }
        : {},
    }

    // TODO(http): adopt the Cordis HTTP service when shared transport configuration
    // outweighs its additional runtime dependencies.
    const transport = followAbort(signal)
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: payload,
        signal: transport.signal,
      })
    } catch (error: unknown) {
      // The outer stream distinguishes caller cancellation and watchdog expiry.
      if (signal.aborted) throw error
      // fetch wraps every transport failure (DNS, refused connection, TLS,
      // proxy) in a bare `TypeError: fetch failed` whose actionable detail
      // lives on `cause`. Wrapping with the endpoint and chaining the cause
      // lets `errorChain` render the full diagnosis at every reporting boundary.
      throw new LlmError(
        `DeepSeek API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `DeepSeek API error (HTTP ${response.status})`
      let providerError: WireError['error']
      try {
        const parsed = await response.json() as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // Only swallow error-body parsing: the HTTP status still identifies the
        // failure, so malformed gateway JSON must not mask it.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onComment))
  }
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@ejunz/ea-core/llm'

import type { RetryPolicyConfig } from '@ejunz/ea-core/llm'

import { credentialRef } from '@ejunz/ea-core/credentials'

import { launchEnvironmentOf, type LaunchEnvironmentSnapshot } from '@ejunz/ea-core/launch-environment'

import { deepEqualJson, installSettingsSection, settingsNamespace } from '@ejunz/ea-core/settings'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea-core/timeout'

import { getOrCreateAnonymousUserId, type AnonymousUserId } from '@ejunz/ea-core/anonymous-user-id'

export const name = 'llm-deepseek'

export const inject = ['llm']

const NS = settingsNamespace('llm-deepseek')

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

const PROVIDER = 'deepseek-official'

const DEFAULT_MODELS: DeepSeekCatalogModel[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: DEFAULT_CONTEXT_WINDOW },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek-V4-Flash',
    description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  },
]

export interface Config {
  /** Credential reference (environment-variable name) resolved per request; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** Endpoint base; falls back to $DEEPSEEK_BASE_URL from a trusted environment layer, then the public API. */
  baseURL?: string
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort (default `high`); `off` disables thinking per request. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Default per-request output cap (default 256,000); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to V41 Flash, V4 Flash, and V4 Pro. */
  models?: DeepSeekCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<DeepSeekCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  thinking: z.union(['enabled', 'disabled']),
  reasoningEffort: z.union(['off', 'low', 'high', 'max']),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

export const PUBLIC_BASE_URL = 'https://api.deepseek.com'

const BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

export type ResolvedDeepSeekOptions = DeepSeekConnectionOptions

function resolveModels(models: readonly DeepSeekCatalogModel[] | undefined): DeepSeekCatalogModel[] {
  const seen = new Set<string>()
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error('llm-deepseek: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-deepseek: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-deepseek: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    if (seen.has(model.id)) throw new Error(`llm-deepseek: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

export function resolveAdapterOptions(config: Config, environment?: LaunchEnvironmentSnapshot): ResolvedDeepSeekOptions {
  if (config.thinking === 'disabled'
    && config.reasoningEffort !== undefined
    && config.reasoningEffort !== 'off') {
    throw new Error('llm-deepseek: only reasoningEffort "off" can be configured when thinking is disabled')
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-deepseek: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-deepseek: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-deepseek: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL
      ?? environment?.get(BASE_URL_ENV)?.value
      ?? PUBLIC_BASE_URL,
    defaults: {
      thinking: config.thinking,
      reasoningEffort: config.reasoningEffort,
    },
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-deepseek: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedDeepSeekOptions | undefined
  const options = (): ResolvedDeepSeekOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx))
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-deepseek: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const currentDomainRuntime = async (signal: AbortSignal) => {
    const agent = ctx.get('agents')?.currentInitiator()
    const provider = ctx.get('llmDomainRuntime')
    return agent === undefined || provider === undefined ? undefined : await provider.resolve(agent.id, signal)
  }
  const domainRuntimes = new WeakMap<object, { credentials: Record<string, string> }>()

  const resolveDomainOptions = async (connection: ResolvedDeepSeekOptions, signal: AbortSignal): Promise<ResolvedDeepSeekOptions> => {
    const runtime = await currentDomainRuntime(signal)
    if (runtime === undefined) return connection
    const section = runtime.settings['llm-deepseek']
    const next = !section || typeof section !== 'object' || Array.isArray(section)
      ? connection
      : resolveAdapterOptions({ ...current(), ...section as Config }, undefined)
    domainRuntimes.set(next, runtime)
    return next
  }

  const resolveApiKey = async (connection: ResolvedDeepSeekOptions, _signal?: AbortSignal): Promise<string> => {
    // Every credential fact comes from the caller's snapshot, so a rejected
    // settings generation cannot leak its key onto the previous endpoint.
    const ref = connection.apiKeyEnv
    const scoped = domainRuntimes.get(connection)
    if (scoped !== undefined) {
      const hit = scoped.credentials[ref]
      if (hit !== undefined) return assertUsableApiKey(hit, 'llm-deepseek', ref)
      throw new LlmError(`llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it)`, 'MISSING_CREDENTIAL')
    }
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-deepseek', ref)
    } else {
      // Without the seam there is no managed store to rank against, so the
      // environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'llm-deepseek', ref)
      }
    }
    throw new LlmError(
      `llm-deepseek: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  let userId: AnonymousUserId | undefined
  const resolveUserId = (): AnonymousUserId => userId ??= getOrCreateAnonymousUserId()
  const adapter = new DeepSeekAdapter({ options, resolveDomainOptions, resolveApiKey, resolveUserId })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'DeepSeek', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two, and an observer that reacted
    // to it would see this provider disappear and come back.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/llm-deepseek'
  export const name = 'llm-deepseek-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
