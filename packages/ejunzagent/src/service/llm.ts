export class EjunzAgentError extends Error {
  /** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
  readonly code: string

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.name = new.target.name
  }
}

export const CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'

export const QUOTA_EXCEEDED_CODE = 'QUOTA'

export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE'

export const INVALID_CREDENTIAL_CODE = 'INVALID_CREDENTIAL'

const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]`
  + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
)

const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?`
  + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?`
  + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
)

const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}`
  + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}`
  + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
)

export function isContextWindowExceededError(detail: string): boolean {
  return STRUCTURED_CONTEXT_OVERFLOW.test(detail)
    || /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(detail)
    || TOO_LARGE_FOR_CONTEXT.test(detail)
    || /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(detail)
    || EXCEEDS_MODEL_CONTEXT.test(detail)
}

export function isQuotaExceededError(detail: string): boolean {
  return /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)
    || /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)
    || /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail)
    || /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail)
    || /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
}

export function errorChain(value: unknown): string {
  // Tracks the active recursion path (entries removed on exit), so only true
  // cycles are flagged and a diamond-shared cause still renders in full.
  const path = new Set<unknown>()
  const render = (current: unknown): string => {
    if (path.has(current)) return '<circular cause>'
    path.add(current)
    try {
      if (!(current instanceof Error)) {
        if (typeof current === 'object' && current !== null) {
          const descriptor = Object.getOwnPropertyDescriptor(current, 'message')
          if (descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string') {
            return descriptor.value
          }
        }
        return String(current)
      }
      const message = current.message === '' ? current.name : current.message
      const members = current instanceof AggregateError && current.errors.length > 0
        ? ` [${current.errors.map(render).join('; ')}]`
        : ''
      const causeText = current.cause === undefined || current.cause === null
        ? ''
        : render(current.cause)
      // Wrappers like `new EjunzAgentError(String(value), code, { cause: value })`
      // repeat their cause verbatim; rendering it again would only add noise.
      const cause = causeText === '' || causeText === message ? '' : `: ${causeText}`
      return `${message}${members}${cause}`
    } catch {
      // Only hostile coercion or hostile accessors (a throwing toString /
      // Symbol.toPrimitive on a non-Error, or a throwing message/name/cause/
      // errors getter on an Error subclass): this renderer feeds UI notices
      // and logs, so nothing may escape. Inner frames catch their own throws,
      // so only the hostile node collapses, not the whole chain.
      return '<unrenderable value>'
    } finally {
      path.delete(current)
    }
  }
  return render(value)
}

export function isEjunzAgentError(value: unknown): value is EjunzAgentError {
  return value instanceof EjunzAgentError
}

import type { Branded } from '@ejunz/ea-core/brand'

export type MessageId = Branded<'MessageId'>

export function MessageId(id: string): MessageId {
  return id as MessageId
}

export type CallId = Branded<'CallId'>

export function CallId(id: string): CallId {
  return id as CallId
}

export type ProviderRequestId = Branded<'ProviderRequestId'>

export function ProviderRequestId(id: string): ProviderRequestId {
  return id as ProviderRequestId
}

export type ReasoningEffortId = Branded<'ReasoningEffortId'>

export function ReasoningEffortId(id: string): ReasoningEffortId {
  return id as ReasoningEffortId
}

const AGENT_LOOP_REQUESTS = new WeakSet<GenerateOptions>()

export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

export function markAgentLoopRequest<T extends GenerateOptions>(request: T): T {
  AGENT_LOOP_REQUESTS.add(request)
  return request
}

export function isAgentLoopRequest(request: GenerateOptions): boolean {
  return AGENT_LOOP_REQUESTS.has(request)
}

export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    /* v8 ignore next -- the loop condition guarantees one pending task. */
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}

export interface AssistantProvenance {
  /** Provider route that produced the message. */
  provider: string
  /** Provider model id that produced the message. */
  model: string
  /**
   * Lossless-JSON adapter state needed to replay the provider response.
   * `LlmRuntime` exposes it to a target adapter only when that adapter instance
   * currently owns both this historical provider and the target provider.
   */
  replayState?: unknown
}

export interface ModelMessageSource extends AssistantProvenance {
  kind: 'model'
}

export interface ToolMessageSource {
  kind: 'tool'
  callId: CallId
}

export type ContextForm =
  /** Instructions read out of workspace files the model is expected to follow. */
  | 'instructions'
  /** A catalog of items available in this session, republished as it changes. */
  | 'catalog'
  /** Current state, where a later snapshot from the same producer supersedes an earlier one. */
  | 'snapshot'
  /** A one-off account of something that just happened; it supersedes nothing. */
  | 'notice'
  /** A message another agent addressed to this one. */
  | 'relay'
  /** Material lifted out of another session's log, possibly reduced on the way in. */
  | 'recall'

export interface ContextSnapshotSection {
  /** The contributing subsystem's name. */
  readonly name: string
  /** That contribution's model-facing text, exactly as assembled. */
  readonly text: string
}

export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'instructions' }
  | { readonly form: 'catalog' }
  | {
    readonly form: 'snapshot'
    /** The named contributions this snapshot assembled, in order. */
    readonly sections: readonly ContextSnapshotSection[]
  }
  | {
    readonly form: 'notice'
    /** One-line account of what happened, shown without expanding the row. */
    readonly summary: string
  }
  | { readonly form: 'relay' }
  | { readonly form: 'recall' }

export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool: ToolMessageSource
}

export const CONTEXT_SUMMARY_MAX_CHARS = 120

export function boundContextSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

export interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource
}

export interface UserMessage extends Message {
  readonly role: 'user'
}

export interface AssistantMessage extends Message {
  readonly role: 'assistant'
  readonly source: ModelMessageSource
}

export interface ToolResultMessage extends Message {
  readonly role: 'user'
  readonly content: [ToolResultBlock]
  readonly source: ToolMessageSource
}

type NewMessage = Omit<Message, 'id'>

type NewUserMessage = Omit<UserMessage, 'id' | 'role'>

type NewAssistantMessage = Omit<AssistantMessage, 'id' | 'role' | 'source'> & {
  readonly source: Omit<ModelMessageSource, 'kind'> & { readonly kind?: never }
}

export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

export function createMessage<T extends NewMessage>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return freezeMessage({
    ...input,
    id: MessageId(crypto.randomUUID()),
  })
}

export function createUserMessage<T extends NewUserMessage>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({
    ...input,
    role: 'user',
  })
}

export function createAssistantMessage(
  input: NewAssistantMessage & { readonly id?: never; readonly role?: never },
): AssistantMessage {
  return createMessage({
    role: 'assistant',
    content: input.content,
    source: {
      kind: 'model',
      ...input.source,
    },
  })
}

export interface ToolResultMessageInput {
  readonly callId: CallId
  readonly content: ContentBlock[]
  readonly isError: boolean
}

export function createToolResultMessage(input: ToolResultMessageInput): ToolResultMessage {
  return createUserMessage({
    source: { kind: 'tool', callId: input.callId },
    content: [{
      type: 'tool-result',
      toolCallId: input.callId,
      content: input.content,
      isError: input.isError,
    }],
  })
}

export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

import type { ImageAttachmentRef } from '@ejunz/ea-core/attachment'

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * The provider topology changed: an adapter registered or unregistered
     * routes, or the configurable-provider directory gained or lost entries.
     * This payload-free registry notification fires at each commit point
     * (including registration disposal); consumers re-read `listProviders()`,
     * `listModels()`, or `listConfigurableProviders()` for the new state.
     * Observer failures are contained and cannot veto the registry mutation.
     * @mode emit
     */
    'llm/adapters-updated'(): void
  }
}

export interface LlmFailure {
  /** Human-readable provider or transport failure. */
  readonly message: string
  /** Stable provider-neutral machine-routing code. */
  readonly code: string
  /** HTTP status returned by the provider, when available. */
  readonly status?: number
  /** Provider-requested delay in milliseconds, when valid and available. */
  readonly providerRetryAfterMs?: number
  /** Opaque provider-issued request identifier for diagnostics. */
  readonly requestId?: ProviderRequestId
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ImageBlock {
  type: 'image'
  /** Immutable bytes and intrinsic display metadata owned by the attachment service. */
  attachment: ImageAttachmentRef
}

export interface ToolCallBlock {
  type: 'tool-call'
  /** Provider-issued call id; correlates with the matching tool result. */
  id: CallId
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: CallId
  content: ContentBlock[]
  isError?: boolean
}

export interface ContentBlockMap {
  'text': TextBlock
  'reasoning': ReasoningBlock
  'image': ImageBlock
  'tool-call': ToolCallBlock
  'tool-result': ToolResultBlock
}

export type ContentBlockType = keyof ContentBlockMap

export type ContentBlock = ContentBlockMap[ContentBlockType]

export interface FinishReasonMap {
  'stop': { kind: 'stop' }
  'tool-calls': { kind: 'tool-calls' }
  'max-tokens': { kind: 'max-tokens' }
  'aborted': { kind: 'aborted'; failure: LlmFailure }
  'error': { kind: 'error'; failure: LlmFailure }
}

export type FinishReason = FinishReasonMap[keyof FinishReasonMap]

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface LlmProviderInfo {
  /** Provider route key used by {@link GenerateOptions.provider}. */
  id: string
  /** Human-readable provider name for selectors and diagnostics. */
  name: string
}

export interface ModelModalityMap {
  text: 'text'
  image: 'image'
}

export type ModelModality = ModelModalityMap[keyof ModelModalityMap]

export interface LlmConfigurableProvider {
  /** Provider route key this entry activates when configured. */
  provider: string
  /** Human-readable provider name for configuration surfaces. */
  displayName: string
  /** User-settings namespace whose section configures this provider. */
  settingsNs: string
  /**
   * Path from that namespace's section root to this provider's profile
   * object; empty when the whole section is the profile.
   */
  settingsPath: readonly string[]
  /**
   * Whether the owning adapter knows this route only because configuration
   * declared it — a gateway or self-hosted server it ships nothing about.
   * Absent means the adapter draws no such distinction; false means it does
   * and this route is one of its own. Only the adapter can answer: a stored
   * profile is how a user-added route AND a corrected shipped one both look
   * from outside.
   */
  declared?: boolean
}

export interface LlmModelDiscoveryRequest {
  /**
   * Route the draft is editing, when it edits an existing one. A route whose
   * adapter already knows its models answers from that knowledge instead of
   * asking the endpoint — the adapter's own registry is the better answer, and
   * it costs no network call.
   */
  provider?: string
  /**
   * Endpoint to interrogate. Optional because a route the adapter already
   * describes needs none; a route it does not must supply one.
   */
  baseURL?: string
  /** Wire protocol the endpoint speaks, when the draft names one. */
  api?: string
  /** Credential for this interrogation alone; the ejunzAgent never stores it. */
  apiKey?: string
  /** Caller cancellation; implementations must settle promptly after it aborts. */
  signal?: AbortSignal
}

export interface LlmDiscoveredModel {
  /** Model id the endpoint accepts. */
  id: string
  /** Human-readable name when the endpoint supplies one. */
  name?: string
  /** Maximum combined request and response context, when disclosed. */
  contextWindow?: number
  /** Maximum output tokens, when disclosed. */
  maxTokens?: number
}

export interface LlmModelInfo {
  /** Provider route that owns this model entry. */
  provider: string
  /** Model id passed to {@link GenerateOptions.model}. */
  id: string
  /** Human-readable model name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar models. */
  description?: string
  /** Accepted request modalities; absent means unknown, while an explicit omission is negative capability. */
  inputModalities?: readonly ModelModality[]
}

export interface LlmModelContext {
  /** Maximum combined request and response context in tokens. */
  contextWindow: number
}

export interface LlmReasoningEffortInfo {
  /** Opaque stable value accepted by {@link GenerateOptions.reasoningEffort}. */
  id: ReasoningEffortId
  /** Human-readable effort name for selectors and diagnostics. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}

export interface LlmModelReasoningInfo {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly LlmReasoningEffortInfo[]
  /**
   * Adapter-configured default materialized into requests when callers omit
   * an effort. Absence preserves the provider's own default.
   */
  defaultEffort?: ReasoningEffortId
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  /** Provider-owned context capacity when known. */
  context?: LlmModelContext
  /** Adapter-configured per-request output cap materialized when callers omit one. */
  defaultMaxTokens?: number
  /** Adapter-owned selectable reasoning levels when exposed. */
  reasoning?: LlmModelReasoningInfo
}

export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: CallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | {
    type: 'finish'
    reason: FinishReason
    /** Adapter-private lossless-JSON state for replaying a successful response. */
    replayState?: unknown
  }

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>
}

export interface GenerateOptions {
  /** Registered provider route selecting the adapter instance. */
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for this exact model. */
  reasoningEffort?: ReasoningEffortId
  /**
   * Ordered conversation messages, exactly as the provider sees them (after
   * the `system` slot). A loop-built request assembles them as
   * the derived history (ea-agent-loop); a hand-built one-shot passes any list.
   */
  messages: Message[]
  /** System prompt text (adapters map to the provider's system slot). */
  system?: string
  /** Tool schemas (adapters map to the provider's `tools` field). */
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  /**
   * Stop sequences: generation halts as soon as the model produces any one of
   * these strings (adapters map to the provider's stop field, e.g. OpenAI
   * `stop`). The stop string itself is not included in the output.
   */
  stop?: string[]
  signal?: AbortSignal
  /**
   * Session identity stamped by the loop for request routing. Replay uses it
   * to separate cursors; adapters may map it to model-hidden transport metadata.
   */
  sessionId?: Branded<'SessionId'>
  /**
   * Provider-neutral classification for an auxiliary model call. Adapters may
   * map the purpose to model-hidden transport metadata or purpose-specific
   * generation policy. Ordinary conversation requests leave it unset.
   */
  purpose?: 'compaction' | 'session-title'
}

export function normalizeLlmFailure(value: unknown): LlmFailure {
  const error = value instanceof Error
    ? value
    : new EjunzAgentError(thrownMessage(value), 'UNKNOWN', { cause: value })
  // Cross-package copies preserve own data but not class identity. Trust the
  // carried facts only when both own properties agree after validation.
  const carried = ownFailureSnapshot(error)
  if (carried !== undefined && carried.code === ownErrorCode(error)) return carried
  return Object.freeze({
    message: errorMessage(error),
    code: ejunzAgentErrorCode(error),
  })
}

function thrownMessage(value: unknown): string {
  try {
    const message = String(value)
    return message.length > 0 ? message : 'LLM adapter failed'
  } catch (_hostileThrownValue) {
    return 'LLM adapter failed'
  }
}

function ownErrorCode(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

function ownFailureSnapshot(error: Error): LlmFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'failure')
    return descriptor !== undefined && 'value' in descriptor
      ? failureSnapshot(descriptor.value)
      : undefined
  } catch (_sdkPropertyTrap) {
    return undefined
  }
}

function failureSnapshot(value: unknown): LlmFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  try {
    const candidate = value as Partial<LlmFailure>
    const message = candidate.message
    const code = candidate.code
    const status = candidate.status
    const providerRetryAfterMs = candidate.providerRetryAfterMs
    const requestId = candidate.requestId
    if (typeof message !== 'string' || message.length === 0
      || typeof code !== 'string' || code.length === 0
      || (status !== undefined && (!Number.isInteger(status) || status < 100 || status > 599))
      || (providerRetryAfterMs !== undefined
        && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0))
      || (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0))) return undefined
    return Object.freeze({
      message,
      code,
      ...status === undefined ? {} : { status },
      ...providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs },
      ...requestId === undefined ? {} : { requestId },
    })
  } catch (_sdkFailureGetter) {
    return undefined
  }
}

function errorMessage(error: Error): string {
  try {
    const message: unknown = error.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch (_sdkMessageGetter) {
    // The fallback below preserves a serializable failure beside the original Error.
  }
  return 'LLM adapter failed'
}

function ejunzAgentErrorCode(error: Error): string {
  return error instanceof EjunzAgentError ? error.code : 'UNKNOWN'
}

const LEGAL_API_KEY = /^[\x21-\x7E]+$/

export type ApiKeyRejection = 'empty' | 'illegalCharacters'

export type ApiKeyCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: ApiKeyRejection }

export function normalizeApiKey(raw: string): ApiKeyCheck {
  const value = raw.trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }
  if (!LEGAL_API_KEY.test(value)) return { ok: false, reason: 'illegalCharacters' }
  return { ok: true, value }
}

export function assertNever(value: never, context?: string): never {
  // JSON.stringify is typed string but returns undefined for undefined input;
  // String() covers that and other non-serializable escapes.
  const rendered = (JSON.stringify(value) as string | undefined) ?? String(value)
  throw new Error(`unreachable variant${context ? ` in ${context}` : ''}: ${rendered}`)
}

interface PartialBlock {
  blockType: string
  text: string
  toolCallId?: CallId
  toolCallName?: string
  toolCallArguments: string
  /** Set by `block-end` — authoritative, and freezes the partial. */
  block?: ContentBlock
}

export class BlockAssembler {
  private partials = new Map<number, PartialBlock>()
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined
  private _replayState: unknown = undefined

  /**
   * Feed one chunk into the assembly state.
   * @param chunk - the next raw chunk, in stream order.
   */
  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (!this.partials.has(chunk.index)) {
          this.order.push(chunk.index)
          this.partials.set(chunk.index, {
            blockType: chunk.blockType,
            text: '',
            toolCallArguments: '',
          })
        }
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const partial = this.ensure(chunk.index, 'tool-call')
        if (partial.block) return // closed by block-end; ignore stragglers
        partial.toolCallId = chunk.id
        if (chunk.name) partial.toolCallName = chunk.name
        partial.toolCallArguments += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const partial = this.ensure(chunk.index, chunk.block.type)
        // First close wins; ignoring re-close stragglers keeps streamed output
        // and the final assembled block in agreement.
        if (partial.block) return
        partial.block = chunk.block
        return
      }
      case 'usage': {
        this._usage = chunk.usage
        return
      }
      case 'finish': {
        this._finish = chunk.reason
        this._replayState = chunk.replayState
        return
      }
      default: return assertNever(chunk, 'BlockAssembler.push')
    }
  }

  private ensure(index: number, blockType: string): PartialBlock {
    let partial = this.partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', toolCallArguments: '' }
      this.partials.set(index, partial)
      this.order.push(index)
    }
    return partial
  }

  private assemble(partial: PartialBlock, index: number): ContentBlock {
    if (partial.block) return partial.block
    switch (partial.blockType) {
      case 'text': return { type: 'text', text: partial.text }
      case 'reasoning': return { type: 'reasoning', text: partial.text }
      case 'tool-call': return {
        type: 'tool-call',
        id: partial.toolCallId ?? CallId(`call-${index}`),
        name: partial.toolCallName ?? '',
        arguments: partial.toolCallArguments,
      }
      default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`)
    }
  }

  /** Invariant accessor: every index in `order` has a partial. */
  private mustGet(index: number): PartialBlock {
    const partial = this.partials.get(index)
    if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`)
    return partial
  }

  /**
   * Assemble all blocks seen so far, in stream order.
   * @returns one block per seen index, except that max-token truncation drops
   *   tool calls that cannot be executed safely; an open block assembles from
   *   its accumulated deltas (an unknown block type never closed by `block-end` throws).
   */
  blocks(): ContentBlock[] {
    const blocks = this.order.map(index => this.assemble(this.mustGet(index), index))
    return this.finish.kind === 'max-tokens'
      ? blocks.filter(block => block.type !== 'tool-call')
      : blocks
  }

  /** Usage from the `usage` chunk; undefined until one arrives. */
  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
  get finish(): FinishReason {
    return this._finish ?? { kind: 'stop' }
  }

  /** Adapter-private replay state from the terminal finish chunk, if any. */
  get replayState(): unknown {
    return this._replayState
  }

  /**
   * The assembled assistant message.
   * @param source - producer attribution for the assembled message.
   * @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
   */
  message(source: MessageSource = { kind: 'plugin', plugin: 'ea-llm/assembler' }): Message {
    return createMessage({ role: 'assistant', content: this.blocks(), source })
  }
}

import { createRequire } from 'node:module'

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }

export interface AppIdentity {
  /** `User-Agent` product token (lowercase, hyphenated). */
  product: string
  /** Product version; sourced from package metadata, never hand-copied. */
  version: string
  /** Repository home URL of the app, used as the `User-Agent` comment. */
  url: string
}

export const APP_IDENTITY: AppIdentity = {
  product: 'ejunz-agent',
  version,
  url: 'https://github.com/ejunz-dev/ejunz-agent',
}

export function userAgent(identity: AppIdentity = APP_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

export function attributionHeaders(
  identity: AppIdentity = APP_IDENTITY,
): Record<string, string> {
  return { 'user-agent': userAgent(identity) }
}

export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

import z from '@ejunz/schemastery'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea-core/timeout'

const DEFAULT_MAX_RETRIES = 2

const DEFAULT_INITIAL_DELAY_MS = 500

const DEFAULT_MAX_DELAY_MS = 10_000

const DEFAULT_JITTER_RATIO = 0.1

const DEFAULT_RETRYABLE_CODES = Object.freeze([
  EMPTY_RESPONSE_CODE,
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

export interface BackoffConfig {
  /** Initial local exponential-backoff delay in milliseconds (default 500). */
  initialDelayMs?: number
  /** Maximum locally scheduled or accepted provider delay in milliseconds (default 10000). */
  maxDelayMs?: number
  /** Symmetric random multiplier range around one (default 0.1). */
  jitterRatio?: number
}

export interface NormalRetryPolicyConfig {
  /** Retry only configured transient failure codes. */
  mode: 'normal'
  /** Maximum eligible retries after the first request (default 2). */
  maxRetries?: number
  /** Stable failure codes eligible for this policy. */
  retryableCodes?: string[]
  /** Local exponential-backoff and jitter configuration. */
  backoff?: BackoffConfig
}

export interface AlwaysRetryPolicyConfig {
  /** Retry every model-request failure until success, cancellation, or disposal. */
  mode: 'always'
  /** Local exponential-backoff and jitter configuration. */
  backoff?: BackoffConfig
}

export type RetryPolicyConfig = NormalRetryPolicyConfig | AlwaysRetryPolicyConfig

export interface ResolvedRetryBackoff {
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
}

export interface ResolvedNormalRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'normal'
  readonly maxRetries: number
  readonly retryableCodes: readonly string[]
}

export interface ResolvedAlwaysRetryPolicy extends ResolvedRetryBackoff {
  readonly mode: 'always'
}

export type ResolvedRetryPolicy = ResolvedNormalRetryPolicy | ResolvedAlwaysRetryPolicy

const backoffSchema: z<BackoffConfig> = z.object({
  initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
  maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
  jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO),
})

const normalPolicySchema: z<NormalRetryPolicyConfig> = z.object({
  mode: z.const('normal').required(),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
  backoff: backoffSchema,
})

const alwaysPolicySchema: z<AlwaysRetryPolicyConfig> = z.object({
  mode: z.const('always').required(),
  backoff: backoffSchema,
})

export const RetryPolicySchema: z<RetryPolicyConfig> = z.union([
  normalPolicySchema,
  alwaysPolicySchema,
])

const NORMAL_POLICY_KEYS: ReadonlySet<string> = new Set([
  'mode', 'maxRetries', 'retryableCodes', 'backoff',
])

const ALWAYS_POLICY_KEYS: ReadonlySet<string> = new Set(['mode', 'backoff'])

const BACKOFF_KEYS: ReadonlySet<string> = new Set(['initialDelayMs', 'maxDelayMs', 'jitterRatio'])

function validateKeys(value: object, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`)
  }
}

function resolveBackoff(config: BackoffConfig | undefined, path: string): ResolvedRetryBackoff {
  if (config !== undefined) validateKeys(config, BACKOFF_KEYS, path)
  const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
  const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO

  if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (initialDelayMs > maxDelayMs) {
    throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`)
  }
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error(`${path}.jitterRatio must be between 0 and 1`)
  }

  return Object.freeze({ initialDelayMs, maxDelayMs, jitterRatio })
}

export function resolveRetryPolicy(
  config: RetryPolicyConfig | undefined,
  path: string,
): ResolvedRetryPolicy {
  if (config === undefined) {
    return Object.freeze({
      mode: 'normal',
      maxRetries: DEFAULT_MAX_RETRIES,
      retryableCodes: DEFAULT_RETRYABLE_CODES,
      ...resolveBackoff(undefined, `${path}.backoff`),
    })
  }

  switch (config.mode) {
    case 'normal': {
      validateKeys(config, NORMAL_POLICY_KEYS, path)
      const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
      const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES]
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
        throw new Error(`${path}.maxRetries must be a non-negative safe integer`)
      }
      if (retryableCodes.length === 0) {
        throw new Error(`${path}.retryableCodes must not be empty`)
      }
      if (retryableCodes.some(code => typeof code !== 'string' || code.length === 0)) {
        throw new Error(`${path}.retryableCodes must contain only non-empty strings`)
      }
      if (new Set(retryableCodes).size !== retryableCodes.length) {
        throw new Error(`${path}.retryableCodes must not contain duplicates`)
      }
      return Object.freeze({
        mode: 'normal',
        maxRetries,
        retryableCodes: Object.freeze([...retryableCodes]),
        ...resolveBackoff(config.backoff, `${path}.backoff`),
      })
    }
    case 'always':
      validateKeys(config, ALWAYS_POLICY_KEYS, path)
      return Object.freeze({
        mode: 'always',
        ...resolveBackoff(config.backoff, `${path}.backoff`),
      })
    default:
      throw new Error(`${path}.mode must be "normal" or "always"`)
  }
}

import { Context, Service } from '@ejunz/cordis'

export interface LlmDomainRuntime {
  domainId: string
  settings: Record<string, unknown>
  credentials: Record<string, string>
}

export interface LlmDomainRuntimeProvider {
  resolve(sessionId: string, signal: AbortSignal): Promise<LlmDomainRuntime | undefined>
}

declare module '@ejunz/cordis' {
  interface Context {
    llm: LlmRuntime
    llmDomainRuntime?: LlmDomainRuntimeProvider
  }

  interface Events {
    /**
     * Waterfall around every streaming model call (retry, replay, routing).
     * Bound to the {@link LlmRuntime}; call `next()` to reach the resolved
     * adapter's stream, or yield your own chunks to short-circuit.
     * @param options - the full request. A LOOP-built request carries the
     *   process-local {@link markAgentLoopRequest} identity and arrives deep-frozen
     *   (mutation throws): its content is a pure function of the session log (the
     *   reconstructability Agent Note), so listeners read it, never rewrite it.
     *   Hand-built calls do not carry that marker; their messages already obey
     *   the immutable creation contract.
     * @mode waterfall
     */
    'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>

  }
}

export interface LlmErrorOptions extends ErrorOptions {
  /** Valid HTTP status observed at the provider boundary. */
  status?: number
  /** Positive finite provider-requested delay in milliseconds. */
  providerRetryAfterMs?: number
  /** Non-empty opaque provider request id. */
  requestId?: ProviderRequestId
}

export class LlmError extends EjunzAgentError {
  /** Serializable facts retained beside this live Error. */
  readonly failure: LlmFailure

  /**
   * @param message - non-empty human-readable failure summary.
   * @param code - non-empty stable provider-neutral machine code.
   * @param options - optional cause and validated serializable provider facts.
   */
  constructor(message: string, code: string, options?: LlmErrorOptions) {
    if (typeof message !== 'string' || message.length === 0) throw new Error('LlmError message must be a non-empty string')
    if (typeof code !== 'string' || code.length === 0) throw new Error('LlmError code must be a non-empty string')
    if (options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
      throw new Error('LlmError status must be an integer from 100 through 599')
    }
    if (options?.providerRetryAfterMs !== undefined
      && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) {
      throw new Error('LlmError providerRetryAfterMs must be a positive finite number')
    }
    if (options?.requestId !== undefined
      && (typeof options.requestId !== 'string' || options.requestId.length === 0)) {
      throw new Error('LlmError requestId must be a non-empty string')
    }
    super(message, code, options)
    this.name = 'LlmError'
    this.failure = Object.freeze({
      message,
      code,
      ...options?.status === undefined ? {} : { status: options.status },
      ...options?.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
      ...options?.requestId === undefined ? {} : { requestId: options.requestId },
    })
  }
}

export function assertUsableApiKey(raw: string, pkg: string, ref: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  // The Models page is named as the writer it usually is, not as the only one:
  // the same value can arrive from a hand-edited .env or a shell export in a
  // composition that mounts no credentials seam at all, where directing the
  // user to a page that deployment does not serve would be a dead end.
  throw new LlmError(
    checked.reason === 'empty'
      ? `${pkg}: the API key resolved from ${ref} is blank; set ${ref} to the raw key`
        + ' (the web Models page writes it) or export it in the launching environment'
      : `${pkg}: the API key resolved from ${ref} contains characters no HTTP header can carry;`
        + ` set ${ref} to the raw key alone (the web Models page writes it)`,
    INVALID_CREDENTIAL_CODE,
  )
}

export interface PreparedLlmCall {
  /** Detached, deep-frozen config with any adapter-owned default materialized. */
  readonly config: LlmCallConfig
  /** Immutable retry policy captured with the adapter registration. */
  readonly retryPolicy: ResolvedRetryPolicy
  /** Detached context metadata resolved with the registration-bound call. */
  readonly context?: LlmModelContext
  /** Config fields materialized by the captured adapter rather than proposed by the caller. */
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  /**
   * Dispatch this call once through the registration captured during
   * preparation. The request's call-config fields must match {@link config};
   * reuse or mismatch fails with `INVALID_PREPARED_CALL`.
   * @param options - fully assembled request carrying the prepared config.
   * @returns the chunk stream, including the `llm/stream` waterfall.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export abstract class LlmAdapter {
  /**
   * Describe one provider route owned by this adapter.
   * @param provider - a route passed to `registerAdapter()` for this instance.
   * @returns detached display metadata whose id must equal `provider`.
   */
  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  /**
   * Return the provider-owned retry policy captured with this route.
   * @param _provider - a route passed to `registerAdapter()` for this instance.
   * @returns a resolved policy, or `undefined` to use the normal defaults.
   */
  providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return undefined
  }

  /**
   * List models this adapter can currently advertise for one owned provider.
   * The result is advisory: an adapter may accept unlisted model ids, and
   * consumers must not turn absence into request rejection.
   * @param _provider - one provider route owned by this adapter.
   * @returns discoverable models in adapter-preferred order.
   */
  listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([])
  }

  /**
   * Resolve all metadata available for one exact model. This query is
   * independent of the advisory catalog and does not validate request routing.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id passed to {@link GenerateOptions.model}.
   * @param _signal - cancellation for this exact-model lookup; asynchronous
   *   implementations must settle promptly after it aborts.
   * @returns provider/model identity plus any context, call-default, and reasoning metadata.
   */
  resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  /**
   * Stream one model call as raw chunks. The only required method.
   * @param options - the fully-assembled request; implementations must honor `options.signal`.
   * @returns the chunk stream, obeying the adapter contract documented on `StreamChunk`.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface LlmProviderResolver {
  /** Return a scoped adapter, or `undefined` when the provider is unavailable. */
  resolve(provider: string, signal?: AbortSignal): Promise<LlmAdapter | undefined>
}

export interface AdapterRegistrationHandle {
  /** Release every route this registration currently holds. */
  (): void
  /**
   * Replace this registration's routes with `providers`, keeping the same
   * adapter instance. The candidate set is validated in full first — a
   * conflict with another adapter, an invalid name, or bad provider metadata
   * throws and leaves the current routes untouched — and the swap itself is
   * one synchronous section, so no request can observe a gap. An empty array
   * is legal here (a settings section that emptied holds zero routes while
   * staying registered), unlike an empty initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been released: its routes are gone and its disposer has already run,
   * so anything registered afterwards would have no owner left to release it.
   * @param providers - the complete next route set for this registration.
   */
  replace(providers: string[]): void
}

export interface DirectoryRegistrationHandle {
  /** Withdraw every entry this registration currently holds. */
  (): void
  /**
   * Replace this registration's entries with `entries`. The candidate set is
   * validated in full first — an entry another registration already declares,
   * a duplicate within the set, or invalid metadata throws and leaves the
   * current entries untouched — and the swap is one synchronous section, so no
   * reader observes a gap. An empty array is legal here, unlike an empty
   * initial registration.
   *
   * Throws `LlmError` with code `REGISTRATION_DISPOSED` once the registration
   * has been disposed.
   */
  replace(entries: readonly LlmConfigurableProvider[]): void
}

export class LlmRuntime extends Service {
  private adapters = new Map<string, AdapterRegistration>()
  private directory = new Map<string, LlmConfigurableProvider>()
  private discoveries = new Map<
    string,
    (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>
  >()
  private resolvers = new Set<LlmProviderResolver>()

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  /**
   * Register a domain-aware provider resolver owned by the current service fiber.
   * @param resolver - provider lookup implementation.
   * @returns disposer for the resolver registration.
   */
  registerProviderResolver(resolver: LlmProviderResolver): () => void {
    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      this.resolvers.add(resolver)
      yield () => {
        this.resolvers.delete(resolver)
        this.emitAdaptersUpdated()
      }
    }.bind(this), 'llm.registerProviderResolver()')
    return () => void dispose()
  }

  private resolvedRegistration(provider: string, adapter: LlmAdapter): AdapterRegistration {
    const info = adapter.providerInfo(provider)
    if (typeof info.id !== 'string' || info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
      throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, 'INVALID_ADAPTER')
    }
    return {
      adapter,
      provider: { id: info.id, name: info.name },
      retryPolicy: adapter.providerRetryPolicy(provider)
        ?? resolveRetryPolicy(undefined, `llm: provider "${provider}" retryPolicy`),
    }
  }

  private async resolveRegistration(provider: string, signal?: AbortSignal): Promise<AdapterRegistration> {
    const registered = this.adapters.get(provider)
    if (registered !== undefined) return registered
    for (const resolver of this.resolvers) {
      const adapter = await resolver.resolve(provider, signal)
      if (adapter !== undefined) return this.resolvedRegistration(provider, adapter)
    }
    throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
  }

  /**
   * Check whether an adapter can be resolved for a provider.
   * @param provider - provider id to resolve.
   * @param signal - optional cancellation for provider discovery.
   * @returns whether a matching adapter exists.
   */
  async canResolveProvider(provider: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.resolveRegistration(provider, signal)
      return true
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'NO_ADAPTER') return false
      throw error
    }
  }

  /** Notify topology observers without letting one broken listener veto the commit. */
  private emitAdaptersUpdated(): void {
    // Cordis emit uses Array.map: one synchronous throw starves later
    // listeners. Registry notifications are non-vetoing, so contain each
    // callback independently; INVARIANT-coded failures still surface.
    let invariantFailure: unknown
    for (const listener of this.ctx.events.dispatch('emit', ['llm/adapters-updated']) as Array<() => unknown>) {
      try {
        const returned = listener()
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          // An emit listener may still be an async function; its rejection
          // cannot reach the synchronous INVARIANT rethrow below, so it is
          // contained here instead of becoming an unhandled rejection.
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnAdaptersListenerFailure(error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnAdaptersListenerFailure(error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnAdaptersListenerFailure(error: unknown): void {
    this.ctx.logger.warn('llm: an llm/adapters-updated listener failed')
    this.ctx.logger.warn(error)
  }

  /**
   * Register an adapter for the given provider routes. Throws `LlmError` with code
   * `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
   * Disposed with the fiber.
   * @param providers - every provider route this adapter should serve.
   * @param adapter - the adapter that streams calls for those providers.
   * @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
   */
  registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle {
    // The routes this registration currently holds; `replace` rewrites it, and
    // the disposer releases whatever it holds at disposal time.
    const owned = new Set<string>()
    // The disposer has run: `owned` being empty cannot say so on its own,
    // because `replace([])` legally leaves a live registration holding none.
    let released = false
    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (providers.length === 0) throw new LlmError('an adapter must register at least one provider', 'INVALID_ADAPTER')
      this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned))
      yield () => {
        released = true
        for (const provider of owned) this.adapters.delete(provider)
        owned.clear()
        this.emitAdaptersUpdated()
      }
    }.bind(this), 'llm.registerAdapter()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget — discard the (always-resolved) promise.
    const handle = (() => void dispose()) as AdapterRegistrationHandle
    handle.replace = (next: string[]): void => {
      // Registering here would leak: the effect's disposer already ran, so
      // nothing remains to release whatever this call would put in the map.
      if (released) {
        throw new LlmError('a disposed adapter registration cannot replace its routes', 'REGISTRATION_DISPOSED')
      }
      this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned))
    }
    return handle
  }

  /**
   * Validate one candidate route set for `adapter`, treating routes this
   * registration already holds as available. Nothing is mutated: a rejected
   * candidate leaves the registry exactly as it was.
   */
  private prepareRoutes(providers: string[], adapter: LlmAdapter, owned: ReadonlySet<string>): AdapterRegistration[] {
    const unique = new Set<string>()
    const registrations: AdapterRegistration[] = []
    for (const provider of providers) {
      if (provider.length === 0) throw new LlmError('adapter provider names must be non-empty', 'INVALID_ADAPTER')
      if (unique.has(provider) || (this.adapters.has(provider) && !owned.has(provider))) {
        throw new LlmError(`an adapter for provider "${provider}" is already registered`, 'DUPLICATE_ADAPTER')
      }
      const info = adapter.providerInfo(provider)
      if (typeof info.id !== 'string' || info.id !== provider || typeof info.name !== 'string' || info.name.length === 0) {
        throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, 'INVALID_ADAPTER')
      }
      unique.add(provider)
      const retryPolicy = adapter.providerRetryPolicy(provider)
        ?? resolveRetryPolicy(undefined, `llm: provider "${provider}" retryPolicy`)
      registrations.push({
        adapter,
        provider: { id: info.id, name: info.name },
        retryPolicy,
      })
    }
    return registrations
  }

  /**
   * Swap this registration's routes for the prepared ones in one synchronous
   * section, so no observer can see the registry between the release and the
   * re-registration. The route set's one mutation point is also where
   * `llm/adapters-updated` is published, so a `replace` announces itself
   * exactly like a first registration.
   */
  private commitRoutes(owned: Set<string>, registrations: readonly AdapterRegistration[]): void {
    for (const provider of owned) this.adapters.delete(provider)
    owned.clear()
    for (const registration of registrations) {
      this.adapters.set(registration.provider.id, registration)
      owned.add(registration.provider.id)
    }
    this.emitAdaptersUpdated()
  }

  /**
   * Describe provider routes with a registered adapter.
   * @returns detached provider metadata in registration order.
   */
  listProviders(): LlmProviderInfo[] {
    return [...this.adapters.values()].map(({ provider }) => ({ ...provider }))
  }

  /**
   * Declare provider routes an adapter plugin can activate through
   * configuration. Registration is all-or-nothing: an empty list, invalid
   * entry, or a provider already declared by any registration throws
   * `LlmError` without registering the rest. Disposed with the fiber.
   * @param entries - every configurable provider this plugin owns.
   * @returns a handle that withdraws all of them, and can atomically replace them.
   */
  registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle {
    let held: LlmConfigurableProvider[] = []
    let disposed = false
    /**
     * Validate a candidate set in full against everything this registration
     * does not already hold, then publish it. Nothing is written until the
     * whole set passes, so a refused candidate leaves the current entries in
     * place — the property that makes `replace` a swap rather than a
     * delete-then-add that can strand the directory empty.
     */
    const commit = (candidates: readonly LlmConfigurableProvider[]): void => {
      const detached: LlmConfigurableProvider[] = []
      const own = new Set(held.map(entry => entry.provider))
      for (const entry of candidates) {
        if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) {
          throw new LlmError('configurable providers need a non-empty provider, displayName, and settingsNs', 'INVALID_DIRECTORY')
        }
        if (entry.settingsPath.some(segment => segment.length === 0)) {
          throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, 'INVALID_DIRECTORY')
        }
        if ((this.directory.has(entry.provider) && !own.has(entry.provider))
          || detached.some(seen => seen.provider === entry.provider)) {
          throw new LlmError(`configurable provider "${entry.provider}" is already declared`, 'DUPLICATE_DIRECTORY')
        }
        detached.push({ ...entry, settingsPath: [...entry.settingsPath] })
      }
      for (const entry of held) this.directory.delete(entry.provider)
      for (const entry of detached) this.directory.set(entry.provider, entry)
      held = detached
      this.emitAdaptersUpdated()
    }

    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (entries.length === 0) {
        throw new LlmError('a configurable-provider registration must declare at least one provider', 'INVALID_DIRECTORY')
      }
      commit(entries)
      yield () => {
        disposed = true
        for (const entry of held) this.directory.delete(entry.provider)
        held = []
        this.emitAdaptersUpdated()
      }
    }.bind(this), 'llm.registerConfigurableProviders()')

    const handle = ((): void => void dispose()) as DirectoryRegistrationHandle
    handle.replace = (next: readonly LlmConfigurableProvider[]): void => {
      if (disposed) {
        throw new LlmError('this configurable-provider registration was disposed', 'REGISTRATION_DISPOSED')
      }
      commit(next)
    }
    return handle
  }

  /**
   * List every declared configurable provider, registered or dormant.
   * @returns detached directory entries in declaration order.
   */
  listConfigurableProviders(): LlmConfigurableProvider[] {
    return [...this.directory.values()].map(entry => ({ ...entry, settingsPath: [...entry.settingsPath] }))
  }

  /**
   * Offer to interrogate provider endpoints on behalf of the settings
   * namespace this plugin owns. The namespace is the key because that is what
   * a configuration surface already holds from the configurable-provider
   * directory, and because a provider being *added* has no route to name yet.
   * Disposed with the fiber.
   * @param settingsNs - the namespace whose profiles this discovery serves.
   * @param discover - interrogates one endpoint; must honor `request.signal`.
   * @returns the disposer that withdraws the offer.
   */
  registerModelDiscovery(
    settingsNs: string,
    discover: (request: LlmModelDiscoveryRequest) => Promise<readonly LlmDiscoveredModel[]>,
  ): () => void {
    const dispose = this.ctx.effect(function* (this: LlmRuntime) {
      if (settingsNs.length === 0) {
        throw new LlmError('model discovery needs a non-empty settings namespace', 'INVALID_DISCOVERY')
      }
      if (this.discoveries.has(settingsNs)) {
        throw new LlmError(`model discovery for "${settingsNs}" is already registered`, 'DUPLICATE_DISCOVERY')
      }
      this.discoveries.set(settingsNs, discover)
      yield () => {
        this.discoveries.delete(settingsNs)
      }
    }.bind(this), 'llm.registerModelDiscovery()')
    return () => void dispose()
  }

  /**
   * Interrogate one provider endpoint for the models it advertises. The
   * request describes a draft, not a stored route, so nothing here reads or
   * writes settings or credentials — the caller owns both, and the reply is
   * candidate metadata a surface may offer for adoption.
   * @param settingsNs - namespace whose registered discovery serves this draft.
   * @param request - the endpoint, protocol, and one-shot credential to use.
   * @returns the advertised models, deduplicated in endpoint order.
   */
  async discoverModels(
    settingsNs: string,
    request: LlmModelDiscoveryRequest,
  ): Promise<LlmDiscoveredModel[]> {
    const discover = this.discoveries.get(settingsNs)
    if (discover === undefined) {
      throw new LlmError(`no model discovery is registered for "${settingsNs}"`, 'NO_DISCOVERY')
    }
    // One of the two identifies what to describe: a route the adapter knows, or
    // an endpoint to ask. Neither leaves nothing to answer about.
    if ((request.provider ?? '').length === 0 && (request.baseURL ?? '').length === 0) {
      throw new LlmError('model discovery needs a provider route or a baseURL', 'INVALID_DISCOVERY')
    }
    const discovered = await discover(request)
    const seen = new Set<string>()
    const models: LlmDiscoveredModel[] = []
    for (const model of discovered) {
      if (typeof model.id !== 'string' || model.id.length === 0 || seen.has(model.id)) continue
      seen.add(model.id)
      models.push({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      })
    }
    return models
  }

  /**
   * Resolve the retry policy captured when one provider route was registered.
   * @param provider - registered provider route to inspect.
   * @returns the provider-owned policy, with normal defaults already resolved.
   */
  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    return this.registration(provider).retryPolicy
  }

  /** Detach typed adapter-owned modality metadata. */
  private detachedModalities(modalities: readonly ModelModality[] | undefined): ModelModality[] | undefined {
    return modalities === undefined ? undefined : [...modalities]
  }

  /**
   * Discover models advertised by one registered provider. Catalog membership
   * is advisory and never changes routing or request validation.
   * @param provider - registered provider route to inspect.
   * @returns detached model metadata in adapter-preferred order.
   */
  async listModels(provider: string): Promise<LlmModelInfo[]> {
    const adapter = (await this.resolveRegistration(provider)).adapter
    const models = await adapter.listModels(provider)
    const seen = new Set<string>()
    return models.map((model) => {
      if (
        typeof model.provider !== 'string'
        || model.provider !== provider
        || typeof model.id !== 'string'
        || model.id.length === 0
        || typeof model.name !== 'string'
        || model.name.length === 0
        || (model.description !== undefined && typeof model.description !== 'string')
        || seen.has(model.id)
      ) {
        throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, 'INVALID_CATALOG')
      }
      seen.add(model.id)
      const inputModalities = this.detachedModalities(model.inputModalities)
      return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        ...model.description === undefined ? {} : { description: model.description },
        ...inputModalities === undefined ? {} : { inputModalities },
      }
    })
  }

  /**
   * Resolve and validate all metadata from the adapter that owns one exact
   * route. The result is detached from adapter-owned objects; catalog
   * membership remains advisory and does not control request routing.
   * @param provider - registered provider route to inspect.
   * @param model - exact model id passed to the adapter.
   * @param signal - optional cancellation for adapter-owned asynchronous lookup.
   * @returns exact model identity plus available context and reasoning metadata.
   */
  async resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return this.resolveModelInfoFor(await this.resolveRegistration(provider, signal), model, signal)
  }

  private async resolveModelInfoFor(
    registration: AdapterRegistration,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const provider = registration.provider.id
    const resolved = await registration.adapter.resolveModel(provider, model, signal)
    if (
      typeof resolved.provider !== 'string'
      || resolved.provider !== provider
      || typeof resolved.id !== 'string'
      || resolved.id !== model
      || typeof resolved.name !== 'string'
      || resolved.name.length === 0
      || (resolved.description !== undefined && typeof resolved.description !== 'string')
    ) {
      throw new LlmError(
        `adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_INFO',
      )
    }
    const context = resolved.context
    if (context !== undefined && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) {
      throw new LlmError(
        `adapter returned invalid context metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_CONTEXT',
      )
    }
    // Capability metadata rides through: an explicit modality omission is
    // negative capability downstream preflights act on (image admission).
    const inputModalities = this.detachedModalities(resolved.inputModalities)
    const defaultMaxTokens = resolved.defaultMaxTokens
    if (defaultMaxTokens !== undefined
      && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) {
      throw new LlmError(
        `adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_MAX_TOKENS',
      )
    }
    const info: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: resolved.name,
      ...resolved.description === undefined ? {} : { description: resolved.description },
      ...inputModalities === undefined ? {} : { inputModalities },
      ...context === undefined ? {} : { context: { contextWindow: context.contextWindow } },
      ...defaultMaxTokens === undefined ? {} : { defaultMaxTokens },
    }
    const reasoning = resolved.reasoning
    if (reasoning === undefined) return info
    if (reasoning.efforts.length === 0) {
      throw new LlmError(
        `adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    const seen = new Set<string>()
    const efforts = reasoning.efforts.map((effort) => {
      if (
        typeof effort.id !== 'string'
        || effort.id.length === 0
        || typeof effort.name !== 'string'
        || effort.name.length === 0
        || (effort.description !== undefined && typeof effort.description !== 'string')
        || seen.has(effort.id)
      ) {
        throw new LlmError(
          `adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`,
          'INVALID_MODEL_REASONING',
        )
      }
      seen.add(effort.id)
      return {
        id: effort.id,
        name: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      }
    })
    if (reasoning.defaultEffort !== undefined && !seen.has(reasoning.defaultEffort)) {
      throw new LlmError(
        `adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`,
        'INVALID_MODEL_REASONING',
      )
    }
    return {
      ...info,
      reasoning: {
        efforts,
        ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
      },
    }
  }

  /**
   * Validate a conversation call config against its exact model capability and
   * materialize adapter-configured defaults. Unsupported explicit efforts
   * reject before provider I/O; no clamping or aliasing is performed. This
   * standalone query does not bind a later dispatch; use {@link prepareCall}
   * when logging and streaming must share one adapter registration.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a detached config only when a default must be materialized.
   */
  async resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig> {
    return (await this.resolveCallFor(await this.resolveRegistration(config.provider, signal), config, signal)).config
  }

  private async resolveCallFor(
    registration: AdapterRegistration,
    config: LlmCallConfig,
    signal?: AbortSignal,
  ): Promise<{ config: LlmCallConfig; context?: LlmModelContext }> {
    const info = await this.resolveModelInfoFor(registration, config.model, signal)
    const defaulted = config.maxTokens === undefined && info.defaultMaxTokens !== undefined
      ? { ...config, maxTokens: info.defaultMaxTokens }
      : config
    const reasoning = info.reasoning
    const requested = defaulted.reasoningEffort
    let resolvedConfig = defaulted
    if (reasoning === undefined) {
      if (requested !== undefined) {
        throw new LlmError(
          `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`,
          'UNSUPPORTED_REASONING_EFFORT',
        )
      }
    } else {
      const effective = requested ?? reasoning.defaultEffort
      if (effective !== undefined) {
        if (!reasoning.efforts.some(effort => effort.id === effective)) {
          throw new LlmError(
            `provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`,
            'UNSUPPORTED_REASONING_EFFORT',
          )
        }
        if (requested !== effective) resolvedConfig = { ...defaulted, reasoningEffort: effective }
      }
    }
    return {
      config: resolvedConfig,
      ...info.context === undefined ? {} : { context: info.context },
    }
  }

  /**
   * Resolve one call under its current adapter registration. The returned
   * one-shot handle keeps that registration across header logging and dispatch,
   * so HMR cannot combine one adapter's capability result with another adapter.
   * @param config - provider/model route and optional request controls.
   * @param signal - optional cancellation for adapter-owned capability lookup.
   * @returns a prepared config and its registration-bound stream entry point.
   */
  async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall> {
    const registration = await this.resolveRegistration(config.provider, signal)
    const resolved = await this.resolveCallFor(registration, config, signal)
    const resolvedConfig = deepFreeze(structuredClone(resolved.config))
    const context = resolved.context === undefined
      ? undefined
      : deepFreeze(structuredClone(resolved.context))
    const adapterDefaults = deepFreeze<LlmCallConfigAdapterDefaults>({
      ...config.reasoningEffort === undefined && resolvedConfig.reasoningEffort !== undefined
        ? { reasoningEffort: true }
        : {},
      ...config.maxTokens === undefined && resolvedConfig.maxTokens !== undefined
        ? { maxTokens: true }
        : {},
    })
    let dispatched = false
    return Object.freeze({
      config: resolvedConfig,
      retryPolicy: registration.retryPolicy,
      adapterDefaults,
      ...context === undefined ? {} : { context },
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        if (dispatched) {
          throw new LlmError('a prepared LLM call can only be dispatched once', 'INVALID_PREPARED_CALL')
        }
        if (!callConfigEquals(options, resolvedConfig)) {
          throw new LlmError(
            'prepared LLM call config changed before adapter dispatch',
            'INVALID_PREPARED_CALL',
          )
        }
        dispatched = true
        return this.streamWithRegistration(options, { registration, config: resolvedConfig })
      },
    })
  }

  private registration(provider: string): AdapterRegistration {
    const registration = this.adapters.get(provider)
    if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, 'NO_ADAPTER')
    return registration
  }

  /** Remove replay state whose historical route is owned by another adapter. */
  private forAdapter(options: GenerateOptions, adapter: LlmAdapter): GenerateOptions {
    const messages: Message[] = options.messages.map((message) => {
      const source = message.source
      if (message.role !== 'assistant' || source.kind !== 'model' || source.replayState === undefined) return message
      if (this.adapters.get(source.provider)?.adapter === adapter) return message
      return freezeMessage({
        ...message,
        source: { kind: 'model', provider: source.provider, model: source.model },
      })
    })
    if (messages.every((message, index) => message === options.messages[index])) return options
    const filtered = { ...options, messages }
    return Object.isFrozen(options) ? deepFreeze(filtered) : filtered
  }

  /**
   * Final adapter boundary. Adapter selection, dispatch, iterator construction,
   * and iteration failures become one terminal failure chunk. Middleware and
   * downstream consumer failures remain thrown plugin or consumer errors.
   */
  private async * adapterStream(
    options: GenerateOptions,
    prepared?: { registration: AdapterRegistration; config: LlmCallConfig },
  ): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<StreamChunk>
    try {
      const registration = prepared?.registration ?? await this.resolveRegistration(options.provider, options.signal)
      const resolvedConfig = prepared === undefined
        ? (await this.resolveCallFor(registration, options, options.signal)).config
        : prepared.config
      if (prepared !== undefined && !callConfigEquals(options, resolvedConfig)) {
        throw new LlmError(
          'prepared LLM call config changed before adapter dispatch',
          'INVALID_PREPARED_CALL',
        )
      }
      const resolvedOptions = callConfigEquals(options, resolvedConfig)
        ? options
        : Object.isFrozen(options)
          ? deepFreeze({ ...options, ...resolvedConfig })
          : { ...options, ...resolvedConfig }
      const adapter = registration.adapter
      const stream = adapter.stream(this.forAdapter(resolvedOptions, adapter))
      iterator = stream[Symbol.asyncIterator]()
    } catch (error: unknown) {
      yield adapterFailureChunk(error, options.signal)
      return
    }

    let completed = false
    try {
      while (true) {
        let item: { done: true } | { done: false; value: StreamChunk }
        try {
          const next = await iterator.next()
          item = next.done
            ? { done: true }
            : { done: false, value: next.value }
        } catch (error: unknown) {
          completed = true
          yield adapterFailureChunk(error, options.signal)
          return
        }
        if (item.done) {
          completed = true
          return
        }
        // End the adapter-owned try before yielding: consumer/middleware
        // failures resumed into this generator must remain thrown.
        yield item.value
      }
    } finally {
      if (!completed) {
        const close = iterator.return?.bind(iterator)
        if (close) await close()
      }
    }
  }

  /**
   * Stream one model call as raw chunks (token-level deltas). Replay state is
   * retained only when the same adapter instance owns its historical provider
   * and the target provider. Final adapter selection remains fixed through
   * asynchronous exact-model resolution and dispatch. Adapter selection,
   * dispatch, and iteration failures become terminal `error` or `aborted`
   * finish chunks; middleware, nested-call, cleanup, and consumer failures
   * remain thrown.
   * @param options - the full request; `options.provider` selects the adapter.
   * @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
   */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithRegistration(options)
  }

  private streamWithRegistration(
    options: GenerateOptions,
    prepared?: { registration: AdapterRegistration; config: LlmCallConfig },
  ): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(
      this,
      'llm/stream',
      options,
      () => this.adapterStream(options, prepared),
    )
  }
}

function adapterFailureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeLlmFailure(error)
  return {
    type: 'finish',
    reason: signal?.aborted || failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}

interface AdapterRegistration {
  readonly adapter: LlmAdapter
  readonly provider: LlmProviderInfo
  readonly retryPolicy: ResolvedRetryPolicy
}

export default LlmRuntime

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/llm'
  export const name = 'llm-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
