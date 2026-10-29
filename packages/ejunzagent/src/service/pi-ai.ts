import { builtinProviders, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'

import type { BuiltinProvider } from '@earendil-works/pi-ai/providers/all'

import type {
  Api,
  Model,
  ModelCost,
  ModelThinkingLevel,
  OpenAICompletionsCompat,
  Provider,
  ThinkingLevelMap,
} from '@earendil-works/pi-ai'

const NO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export type PiAiModality = Model<Api>['input'][number]

const MODALITY_GATE: Record<PiAiModality, true> = {
  text: true,
  image: true,
}

export const MODALITIES = Object.keys(MODALITY_GATE) as readonly PiAiModality[]

function declaredInput(configured: readonly PiAiModality[] | undefined): Model<Api>['input'] | undefined {
  return configured === undefined || configured.length === 0 ? undefined : [...configured]
}

const THINKING_LEVEL_GATE: Record<ModelThinkingLevel, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

export const THINKING_LEVELS = Object.keys(THINKING_LEVEL_GATE) as readonly ModelThinkingLevel[]

type PiThinkingFormat = NonNullable<OpenAICompletionsCompat['thinkingFormat']>

type WithheldThinkingFormat = 'chat-template' | 'qwen-chat-template'

export type PiAiThinkingFormat = Exclude<PiThinkingFormat, WithheldThinkingFormat>

const THINKING_FORMAT_GATE: Record<PiAiThinkingFormat, true> = {
  'openai': true,
  'deepseek': true,
  'openrouter': true,
  'together': true,
  'zai': true,
  'qwen': true,
  'string-thinking': true,
  'ant-ling': true,
}

export const SUPPORTED_THINKING_FORMATS = Object.keys(THINKING_FORMAT_GATE) as readonly PiAiThinkingFormat[]

let providerIndex: Map<string, Provider> | undefined

function catalogProviders(): Map<string, Provider> {
  providerIndex ??= new Map(builtinProviders().map(provider => [provider.id, provider]))
  return providerIndex
}

export function catalogProvider(provider: string): Provider | undefined {
  return catalogProviders().get(provider)
}

export function catalogProviderIds(): readonly string[] {
  return getBuiltinProviders()
}

export function catalogProviderTakesApiKey(provider: string): boolean {
  return catalogProvider(provider)?.auth.apiKey !== undefined
}

export function catalogModels(provider: string): Map<string, Model<Api>> {
  if (!catalogProviders().has(provider)) return new Map()
  const models = getBuiltinModels(provider as BuiltinProvider) as Model<Api>[]
  return new Map(models.map(model => [model.id, model]))
}

export type PiAiReasoningEfforts = Partial<Record<ModelThinkingLevel, string | null>>

export interface PiAiCompatProfile {
  /** Reasoning parameter format the endpoint expects; absent keeps the catalog entry's, then pi-ai's baseURL-derived guess. */
  thinkingFormat?: PiAiThinkingFormat
  /** Whether the endpoint accepts `reasoning_effort`; absent keeps the catalog entry's, then pi-ai's baseURL-derived guess. */
  supportsReasoningEffort?: boolean
}

export interface PiAiModelProfile {
  /** Model id sent to the provider and accepted by {@link GenerateOptions.model}. */
  id: string
  /** Display name for selectors; defaults to the catalog name, then the id. */
  name?: string
  /** Maximum combined request and response context in tokens. */
  contextWindow?: number
  /**
   * Maximum output tokens. Configuring one also makes it this model's
   * per-request default; a value inherited from the installed catalog, or the
   * route's fallback, is the model's capability and never becomes a request
   * default on its own.
   */
  maxTokens?: number
  /**
   * Request modalities this model accepts. Absent — or empty, which describes
   * a model that accepts nothing and so states no answer either — keeps the
   * installed catalog entry's modalities, then the route's `defaultInput`.
   * Declaring images is what makes a hand-declared vision model usable, and
   * declaring text alone corrects a catalog model whose gateway does not serve
   * what the catalog records. This is a claim about the endpoint, not a check
   * of it: nothing interrogates a gateway for what it accepts, so a model
   * claiming images its endpoint refuses is refused by the provider instead,
   * mid-turn.
   */
  input?: PiAiModality[]
  /**
   * Selectable reasoning efforts. Absent inherits the installed catalog
   * entry's capability (a hand-declared model has none and does not reason);
   * `false` declares a non-reasoning model, which is how a profile strips
   * reasoning from a catalog model its gateway cannot serve; a non-empty dict
   * declares the offered levels and their wire spellings.
   */
  reasoningEfforts?: false | PiAiReasoningEfforts
  /** Reasoning-dispatch switches for this model, winning over the route's. */
  compat?: PiAiCompatProfile
}

export type PiAiModelOverride = Omit<PiAiModelProfile, 'id'>

export interface RouteCatalogRequest {
  /** Provider route key, stamped onto every materialized model. */
  provider: string
  /** Wire protocol override; absent defers to each catalog model's own API. */
  api?: string
  /** Endpoint override; absent defers to the catalog model, then the catalog provider. */
  baseURL?: string
  /** Configured catalog; absent means the whole installed catalog for this route. */
  models?: readonly PiAiModelProfile[]
  /** Installed-catalog customizations by model id; only meaningful while `models` is absent. */
  modelOverrides?: Readonly<Record<string, PiAiModelOverride>>
  /** Reasoning-dispatch switches for every `openai-completions` model on the route; entries override per field. */
  compat?: PiAiCompatProfile
  /** Context capacity for a model neither the entry nor the catalog sizes. */
  defaultContextWindow: number
  /** Output capability for a model neither the entry nor the catalog sizes. */
  defaultMaxTokens: number
  /** Modalities for a model neither the entry nor the catalog declares. */
  defaultInput: Model<Api>['input']
}

function invalid(provider: string, detail: string): never {
  throw new Error(`llm-pi-ai: provider "${provider}" ${detail}`)
}

function sharedCatalogApi(defaults: ReadonlyMap<string, Model<Api>>): string | undefined {
  const apis = new Set<string>()
  for (const model of defaults.values()) apis.add(model.api)
  return apis.size === 1 ? [...apis][0] : undefined
}

interface ModelReasoning {
  /** Whether the model reasons at all; `false` makes pi-ai ignore the map. */
  reasoning: boolean
  /** The map dispatch reads; absent only when the installed entry's (or none) applies. */
  thinkingLevelMap?: ThinkingLevelMap
}

function resolveModelReasoning(
  provider: string,
  entry: PiAiModelProfile,
  base: Model<Api> | undefined,
): ModelReasoning {
  const efforts = entry.reasoningEfforts
  if (efforts === undefined) {
    // Reasoning rides the installed entry or is absent: a bare capability flag
    // would make pi-ai advertise effort levels with no `thinkingLevelMap` to
    // spell them, and no listing endpoint reports a model's reasoning
    // protocol. The entry's map (when any) arrives through the `...base`
    // spread in the model literal.
    return { reasoning: base?.reasoning ?? false }
  }
  // The installed entry's map may ride along through `...base`; pi-ai never
  // reads it on a non-reasoning model, so stripping it is not worth a field
  // enumeration here.
  if (efforts === false) return { reasoning: false }
  // A YAML `reasoningEfforts:` left valueless arrives as null through the
  // schema union — outside the field's declared type, hence the widening —
  // while an explicit `{}` arrives as an empty dict. Both declare nothing,
  // and neither is a spelling of "inherit" or "disable".
  if ((efforts as unknown) === null || Object.keys(efforts).length === 0) {
    invalid(provider, `model "${entry.id}" has an empty reasoningEfforts; declare the offered levels, set`
      + ' false for a non-reasoning model, or omit the field to keep the installed catalog\'s capability')
  }
  const declared = THINKING_LEVELS.flatMap((level) => {
    const wire = efforts[level]
    return wire === undefined ? [] : [[level, wire] as const]
  })
  for (const [level, wire] of declared) {
    if (wire === null) {
      if (level !== 'off') {
        invalid(provider, `model "${entry.id}" reasoningEfforts.${level} needs the wire value dispatch`
          + ' should send; only "off" may leave it empty')
      }
    } else if (wire.length === 0) {
      invalid(provider, `model "${entry.id}" reasoningEfforts.${level} must not be an empty string`)
    }
  }
  if (!declared.some(([level]) => level !== 'off')) {
    invalid(provider, `model "${entry.id}" reasoningEfforts offers no level beyond "off"; declare a thinking`
      + ' level, or set reasoningEfforts to false for a non-reasoning model')
  }
  const map: ThinkingLevelMap = {}
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (wire === undefined) {
      map[level] = null
    } else if (wire !== null) {
      map[level] = wire
    }
  }
  return { reasoning: true, thinkingLevelMap: map }
}

function resolveModelCompat(
  provider: string,
  entry: PiAiModelProfile,
  route: PiAiCompatProfile | undefined,
  base: Model<Api> | undefined,
  api: string,
): { compat: OpenAICompletionsCompat } | Record<string, never> {
  const thinkingFormat = entry.compat?.thinkingFormat ?? route?.thinkingFormat
  const supportsReasoningEffort = entry.compat?.supportsReasoningEffort ?? route?.supportsReasoningEffort
  if (thinkingFormat === undefined && supportsReasoningEffort === undefined) return {}
  if (api !== 'openai-completions') {
    if (entry.compat?.thinkingFormat !== undefined || entry.compat?.supportsReasoningEffort !== undefined) {
      invalid(provider, `model "${entry.id}" sets compat reasoning switches, but its api is "${api}";`
        + ' thinkingFormat and supportsReasoningEffort exist only on openai-completions')
    }
    return {}
  }
  // The installed entry's compat matches the entry's OWN api — a route-level
  // `api` repoint (an anthropic catalog served through an OpenAI-compatible
  // gateway) leaves `base.compat` in the other protocol's shape, so it is
  // inherited only while the resolved api still is the entry's. A repointed
  // model starts from pi-ai's baseURL-derived detection instead, which is
  // what a protocol change means for every other compat field too.
  const inherited: OpenAICompletionsCompat | undefined = base?.api === api ? base.compat : undefined
  return {
    compat: {
      ...inherited,
      ...thinkingFormat === undefined ? {} : { thinkingFormat },
      ...supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort },
    },
  }
}

export interface RouteCatalog {
  /** The materialized models in configuration order. */
  models: readonly Model<Api>[]
  /**
   * Per-request output caps this profile explicitly configured, by model id.
   *
   * Separate from `Model.maxTokens` because the two answer different
   * questions: pi-ai requires `maxTokens` as the model's output *capability*,
   * while the ejunzAgent seam's `defaultMaxTokens` is a cap the deployment chose
   * to send on requests that name none. Materializing a catalog capability as
   * a request default would start capping every request at a number nobody
   * picked, so only an explicit configuration lands here.
   */
  configuredMaxTokens: ReadonlyMap<string, number>
}

export function resolveRouteModels(request: RouteCatalogRequest): RouteCatalog {
  const { provider } = request
  const defaults = catalogModels(provider)
  const providerBaseUrl = catalogProvider(provider)?.baseUrl
  // An absent `models` key and an empty one are the same request: the config
  // schema materializes `[]` for the absent case, and an empty catalog could
  // serve no request anyway, so both mean "serve the installed catalog".
  const configured = request.models ?? []
  const overrides = request.modelOverrides ?? {}
  // Every miss is refused, never skipped: an override that lands nowhere is a
  // typo someone would otherwise hunt for in a silently unchanged model.
  for (const [id, override] of Object.entries(overrides)) {
    if (id.length === 0) invalid(provider, 'has a modelOverrides entry with an empty model id')
    if (defaults.size === 0) {
      invalid(provider, `sets modelOverrides for "${id}", but the installed catalog does not describe this route;`
        + ' a declared route spells every model out in its models list')
    }
    if (configured.length > 0) {
      invalid(provider, `sets modelOverrides for "${id}" beside a models list; models already replaces the served`
        + ' catalog, so declare the fields on its entries')
    }
    if (!defaults.has(id)) {
      invalid(provider, `modelOverrides names "${id}", which the installed catalog does not describe`)
    }
    // The id lives in the dict key; a value carrying its own would quietly
    // rename the model it meant to customize. The static shape already omits
    // it — this guards the schema boundary, which passes unknown keys through.
    if ('id' in override) {
      invalid(provider, `modelOverrides entry "${id}" sets "id", which is the dict key`)
    }
  }
  // An override becomes the catalog entry's configuration, so everything a
  // models entry may declare — capacities, efforts, compat — resolves through
  // the same path with the same diagnostics and request-default semantics.
  const entries: readonly PiAiModelProfile[] = configured.length > 0
    ? configured
    : [...defaults.values()].map(model => ({ id: model.id, ...overrides[model.id] }))
  if (entries.length === 0) {
    invalid(provider, 'resolves no models; the installed catalog does not describe this route, so its models'
      + ' must be listed in configuration')
  }
  const routeApi = sharedCatalogApi(defaults)
  const routeCompatDefined = request.compat?.thinkingFormat !== undefined
    || request.compat?.supportsReasoningEffort !== undefined
  const seen = new Set<string>()
  const configuredMaxTokens = new Map<string, number>()
  const models = entries.map((entry) => {
    if (entry.id.length === 0) invalid(provider, 'has a model with an empty id')
    if (seen.has(entry.id)) invalid(provider, `lists model "${entry.id}" more than once`)
    seen.add(entry.id)
    const base = defaults.get(entry.id)
    const api = request.api ?? base?.api ?? routeApi
    if (api === undefined) {
      invalid(provider, `model "${entry.id}" needs an api; the installed catalog does not describe it, so set the`
        + ' route\'s api to the wire protocol its endpoint speaks')
    }
    const baseUrl = request.baseURL ?? base?.baseUrl ?? providerBaseUrl
    if (baseUrl === undefined) {
      invalid(provider, `model "${entry.id}" needs a baseURL; the installed catalog does not describe this route`)
    }
    // Capacities fall back to the route's own defaults, so a model listing that
    // discloses nothing but ids still yields a serviceable route. The fallback
    // is a guess by construction, which is why it is a configurable route field
    // rather than a constant buried here.
    const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`)
    }
    const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      invalid(provider, `model "${entry.id}" maxTokens must be a positive integer`)
    }
    // Only a value the profile named is a deployment choice; the catalog's is
    // the model's capability and stays out of request defaults.
    if (entry.maxTokens !== undefined) configuredMaxTokens.set(entry.id, entry.maxTokens)
    return {
      // The installed entry lays the floor, and the fields below override it.
      // Enumerating instead would silently drop every `Model` field this
      // package does not model — reasoning-level spellings, compatibility
      // quirks, model headers, and whatever a pi-ai upgrade adds next. Spread,
      // never enumerate.
      ...base,
      id: entry.id,
      name: entry.name ?? base?.name ?? entry.id,
      api,
      provider,
      baseUrl,
      input: declaredInput(entry.input) ?? base?.input ?? [...request.defaultInput],
      cost: base?.cost ?? NO_COST,
      contextWindow,
      maxTokens,
      ...resolveModelReasoning(provider, entry, base),
      ...resolveModelCompat(provider, entry, request.compat, base, api),
    }
  })
  if (routeCompatDefined && !models.some(model => model.api === 'openai-completions')) {
    invalid(provider, 'sets compat reasoning switches, but no model on the route speaks openai-completions;'
      + ' thinkingFormat and supportsReasoningEffort exist only on that protocol')
  }
  return { models, configuredMaxTokens }
}

import { createProvider } from '@earendil-works/pi-ai'

import type { Api, ApiKeyAuth, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'

import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'

import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

const PROTOCOLS: Readonly<Record<string, () => ProviderStreams>> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
}

export function supportedProtocols(): readonly string[] {
  return Object.keys(PROTOCOLS)
}

function ejunzAgentApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

export interface ProviderSpec {
  /** Provider route key; also the `Models` collection key and each model's `provider`. */
  provider: string
  /** Display name for selectors and status labels. */
  displayName: string
  /** Wire protocol override; absent means each model keeps its catalog protocol. */
  api?: string
  /** Endpoint override already applied to {@link models}; kept for provider-level display. */
  baseURL?: string
  /** The route's materialized models, in configuration order. */
  models: readonly Model<Api>[]
  /**
   * Whether the profile names a credential, which it does through `apiKeyEnv`
   * alone: configuration carries the reference, never the secret. Only that
   * decides whether {@link routeAuth} adds the ejunzAgent's own api-key method to
   * a catalog provider that offers none; the key itself still arrives per
   * request, never at construction.
   */
  namesCredential: boolean
}

function routeAuth(spec: ProviderSpec, catalog: Provider | undefined): Provider['auth'] {
  if (catalog === undefined) return { apiKey: ejunzAgentApiKeyAuth(spec.displayName) }
  if (catalog.auth.apiKey !== undefined || !spec.namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: ejunzAgentApiKeyAuth(spec.displayName) }
}

function reuseCatalogProvider(base: Provider, spec: ProviderSpec): Provider {
  // Provider-level `baseUrl` is display metadata: pi-ai routes every request
  // through `Model.baseUrl`, which model resolution has already overridden.
  const baseUrl = spec.baseURL ?? base.baseUrl
  return {
    id: spec.provider,
    name: spec.displayName,
    ...baseUrl === undefined ? {} : { baseUrl },
    auth: routeAuth(spec, base),
    getModels: () => spec.models,
    // Delegated rather than copied: the catalog provider stays the receiver, so
    // an implementation holding state on itself keeps working.
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

export function buildProvider(spec: ProviderSpec): Provider {
  const catalog = catalogProvider(spec.provider)
  // A catalog route keeping its catalog protocol reuses the catalog provider;
  // an explicit protocol means the deployment is repointing the route at a
  // different wire format, which only the protocol table can serve.
  if (catalog !== undefined && spec.api === undefined) return reuseCatalogProvider(catalog, spec)

  // Every model on this path carries the route's protocol: model resolution
  // requires one for a route the catalog cannot default, and an explicit one
  // replaces each catalog model's own. So the route has a single API.
  const factory = spec.api === undefined ? undefined : PROTOCOLS[spec.api]
  if (factory === undefined) {
    throw new Error(
      `llm-pi-ai: provider "${spec.provider}" names api "${spec.api}", which this build cannot serve;`
      + ` supported protocols are ${supportedProtocols().join(', ')}`,
    )
  }
  return createProvider({
    id: spec.provider,
    name: spec.displayName,
    ...spec.baseURL === undefined ? {} : { baseUrl: spec.baseURL },
    auth: routeAuth(spec, catalog),
    models: spec.models,
    api: factory(),
  })
}

import type { CacheRetention, ModelThinkingLevel, Provider, ThinkingBudgets, Transport } from '@earendil-works/pi-ai'

import z from '@ejunz/schemastery'

import { credentialRef } from '@ejunz/ea/credentials'

import type { CredentialRef } from '@ejunz/ea/credentials'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea/timeout'

import { resolveRetryPolicy, RetryPolicySchema } from '@ejunz/ea/llm'

import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@ejunz/ea/llm'

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

export const DEFAULT_CONTEXT_WINDOW = 262_144

export const DEFAULT_MAX_TOKENS = 32_768

export const DEFAULT_INPUT: readonly PiAiModality[] = ['text']

export interface PiAiProviderProfile {
  /** Credential reference (environment-variable name) resolved per request through `ctx.credentials`. */
  apiKeyEnv?: string
  /** Name shown by configuration surfaces; defaults to the route key. */
  displayName?: string
  /**
   * Wire protocol every model on this route speaks. Omission keeps each
   * installed catalog model's own protocol, which is why a catalog route needs
   * no protocol at all; a route the catalog does not ship must name one.
   */
  api?: string
  /** Endpoint for this route's models; defaults to the installed catalog's endpoint. */
  baseURL?: string
  /**
   * This route's model catalog. Omission serves the installed catalog for the
   * route unchanged; an explicit list replaces it, each entry defaulting its
   * unset fields from the installed model of the same id.
   */
  models?: PiAiModelProfile[]
  /**
   * Installed-catalog customizations by model id: each entry reshapes that
   * one model with the same fields a {@link models} entry takes, while the
   * rest of the catalog keeps serving untouched. Only meaningful on a catalog
   * route with no `models` list — `models` already replaces the catalog, so
   * an override beside it, on a route the catalog does not ship, or naming a
   * model the catalog does not describe is refused rather than skipped.
   */
  modelOverrides?: Record<string, PiAiModelOverride>
  /**
   * Reasoning-dispatch switches for every `openai-completions` model on this
   * route; each model's own `compat` overrides per field. What neither sets
   * keeps the installed catalog entry's value, then pi-ai's baseURL-derived
   * detection.
   */
  compat?: PiAiCompatProfile
  /**
   * Context capacity for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 262,144). A guess by construction, so
   * a deployment whose gateway serves smaller models corrects it here.
   */
  defaultContextWindow?: number
  /**
   * Output capability for a model this route lists that neither the entry nor
   * the installed catalog sizes (default 32,768). This sizes the model; it
   * never becomes a per-request cap on its own.
   */
  defaultMaxTokens?: number
  /**
   * Request modalities for a model this route lists that neither its entry's
   * {@link PiAiModelProfile.input} nor the installed catalog declares (default
   * `[text]`). A fallback like the capacities above, not an override: a
   * catalog model keeps the modalities the catalog records for it, and this
   * value never narrows one. A gateway serving vision models the catalog does
   * not describe declares `[text, image]` once here instead of on every entry.
   * Unlike an entry's list, this one may not be empty — nothing sits below it
   * to answer instead.
   */
  defaultInput?: PiAiModality[]
  /** Provider request headers; EjunzAgent attribution wins reserved names. */
  headers?: Record<string, string>
  /** Provider-neutral pi-ai reasoning level. */
  reasoning?: ModelThinkingLevel
  /** Token budgets used by reasoning providers that support them. */
  thinkingBudgets?: ThinkingBudgets
  /** Prompt-cache retention preference. */
  cacheRetention?: CacheRetention
  /** Streaming transport preference. */
  transport?: Transport
  /** HTTP/provider SDK timeout in milliseconds. */
  timeoutMs?: number
  /** WebSocket connection timeout in milliseconds. */
  websocketConnectTimeoutMs?: number
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal defaults. */
  retryPolicy?: RetryPolicyConfig
}

export interface ResolvedPiAiProviderProfile
  extends Omit<PiAiProviderProfile, 'apiKeyEnv' | 'retryPolicy' | 'models' | 'displayName'> {
  /** EjunzAgent route key and the `Models` collection key (the configuration dict key). */
  provider: string
  /** Resolved display name for selectors and configuration surfaces. */
  displayName: string
  /** Validated credential reference, when one is configured. */
  apiKeyEnv?: CredentialRef
  /** Positive finite provider-idle interval after defaulting. */
  streamIdleTimeoutMs: number
  /** Immutable retry policy captured with this provider route. */
  retryPolicy: ResolvedRetryPolicy
  /**
   * The pi-ai provider this route registers, built from the resolved models.
   * Construction happens here so an unserviceable protocol or an underspecified
   * model fails with the rest of resolution, leaving the last good route set
   * serving requests.
   */
  piProvider: Provider
  /**
   * Per-request output caps this profile explicitly configured, by model id.
   * The seam materializes one only into a request that names no cap of its
   * own, so a catalog capability must not appear here.
   */
  configuredMaxTokens: ReadonlyMap<string, number>
}

export interface Config {
  /**
   * pi-ai provider routes, keyed by provider. An empty (or omitted) dict is
   * the dormant settings-driven posture: the adapter mounts with no routes
   * and registers them the moment a settings section supplies profiles.
   */
  providers?: Record<string, PiAiProviderProfile>
}

const thinkingBudgets = z.object({
  minimal: z.number(),
  low: z.number(),
  medium: z.number(),
  high: z.number(),
})

const compatProfile: z<PiAiCompatProfile> = z.object({
  thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
  supportsReasoningEffort: z.boolean(),
})

const reasoningEfforts = z.dict(
  z.union([z.string(), z.const(null)]),
  z.union(THINKING_LEVELS),
) as unknown as z<PiAiReasoningEfforts>

const modelFields = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  // No explicit default, unlike the route's `defaultInput`: schemastery
  // materializes `[]` for an absent array, and resolution reads that as "no
  // answer here" so the catalog entry below still applies.
  input: z.array(z.union(MODALITIES)),
  // The union, not a bare dict: schemastery materializes an absent dict as
  // `{}`, and absent must stay distinguishable — it means "inherit the
  // installed catalog's capability", while `false` disables reasoning.
  reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
  compat: compatProfile,
}

const modelProfile: z<PiAiModelProfile> = z.object({
  id: z.string().required(),
  ...modelFields,
})

const modelOverride: z<PiAiModelOverride> = z.object(modelFields)

const profile = z.object({
  apiKeyEnv: z.string().role('credential-ref'),
  displayName: z.string(),
  api: z.union(supportedProtocols()),
  baseURL: z.string(),
  models: z.array(modelProfile),
  modelOverrides: z.dict(modelOverride),
  compat: compatProfile,
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
  defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
  headers: z.dict(z.string()),
  reasoning: z.union(THINKING_LEVELS),
  thinkingBudgets,
  cacheRetention: z.union(['none', 'short', 'long']),
  transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
  timeoutMs: z.natural(),
  websocketConnectTimeoutMs: z.natural(),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

export const Config: z<Config> = z.object({
  providers: z.dict(profile).default({}),
})

export function assertServiceable(config: Config): void {
  resolveProfiles(config.providers)
}

function rejectRemovedFields(provider: string, source: PiAiProviderProfile): void {
  const legacy = source as PiAiProviderProfile & {
    provider?: unknown
    maxRetries?: unknown
    maxRetryDelayMs?: unknown
  }
  if ('provider' in legacy) {
    throw new Error(`llm-pi-ai: provider "${provider}" sets "provider", which moved to the providers dict key`)
  }
  if ('maxRetries' in legacy || 'maxRetryDelayMs' in legacy) {
    throw new Error(
      `llm-pi-ai: provider "${provider}" sets maxRetries or maxRetryDelayMs, which were removed;`
      + ' compose agent recovery with ea-llm-retry',
    )
  }
}

export function resolveProfiles(
  providers: Readonly<Record<string, PiAiProviderProfile>> | undefined,
): Map<string, ResolvedPiAiProviderProfile> {
  if (Array.isArray(providers)) {
    throw new Error('llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles')
  }
  const entries = Object.entries(providers ?? {})
  const resolved = new Map<string, ResolvedPiAiProviderProfile>()
  for (const [provider, source] of entries) {
    rejectRemovedFields(provider, source)
    if (provider.length === 0) throw new Error('llm-pi-ai: provider names must be non-empty')
    if (source.baseURL !== undefined && source.baseURL.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty baseURL`)
    }
    if (source.displayName !== undefined && source.displayName.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" has an empty displayName`)
    }
    const streamIdleTimeoutMs = source.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    if (!Number.isFinite(streamIdleTimeoutMs)
      || streamIdleTimeoutMs <= 0
      || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
      throw new Error(
        `llm-pi-ai: provider "${provider}" streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
      )
    }
    // Detached from the configuration object because pi-ai types `Model.input`
    // mutable. The schema's explicit default covers an absent key, so an empty
    // list here is always one someone typed — and unlike an entry's, nothing
    // below it can answer instead — so it is refused rather than read as "no
    // answer".
    const defaultInput = [...source.defaultInput ?? DEFAULT_INPUT]
    if (defaultInput.length === 0) {
      throw new Error(`llm-pi-ai: provider "${provider}" defaultInput must name at least one modality`)
    }
    // The route key, not the installed provider's own name: the directory has
    // always shown route keys, and a catalog route must not silently rename
    // itself on every configuration surface just because it gained a profile.
    const displayName = source.displayName ?? provider
    const catalog = resolveRouteModels({
      provider,
      ...source.api === undefined ? {} : { api: source.api },
      ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
      ...source.models === undefined ? {} : { models: source.models },
      ...source.modelOverrides === undefined ? {} : { modelOverrides: source.modelOverrides },
      ...source.compat === undefined ? {} : { compat: source.compat },
      defaultInput,
      defaultContextWindow: source.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
      defaultMaxTokens: source.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    })
    const { apiKeyEnv, retryPolicy, models: _models, displayName: _displayName, ...rest } = source
    resolved.set(provider, {
      ...rest,
      provider,
      displayName,
      ...apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) },
      streamIdleTimeoutMs,
      retryPolicy: resolveRetryPolicy(retryPolicy, `llm-pi-ai: provider "${provider}" retryPolicy`),
      ...rest.headers === undefined ? {} : { headers: { ...rest.headers } },
      ...rest.thinkingBudgets === undefined ? {} : { thinkingBudgets: { ...rest.thinkingBudgets } },
      configuredMaxTokens: catalog.configuredMaxTokens,
      piProvider: buildProvider({
        provider,
        displayName,
        ...source.api === undefined ? {} : { api: source.api },
        ...source.baseURL === undefined ? {} : { baseURL: source.baseURL },
        models: catalog.models,
        namesCredential: apiKeyEnv !== undefined,
      }),
    })
  }
  return resolved
}

import { LlmError } from '@ejunz/ea/llm'

import type { Message, ModelMessageSource } from '@ejunz/ea/llm'

import type { Api, AssistantMessage, Usage as PiUsage } from '@earendil-works/pi-ai'

type PiAiReplayBlock =
  | { type: 'text'; textSignature?: string }
  | { type: 'reasoning'; thinkingSignature?: string; redacted?: boolean }
  | { type: 'tool-call'; thoughtSignature?: string }

export interface PiAiReplayState {
  kind: 'pi-ai'
  version: 1
  api: Api
  provider: string
  model: string
  responseModel?: string
  responseId?: string
  stopReason: AssistantMessage['stopReason']
  blocks: PiAiReplayBlock[]
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}

function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

export function toPiReplayState(message: AssistantMessage): PiAiReplayState {
  return {
    kind: 'pi-ai',
    version: 1,
    api: message.api,
    provider: message.provider,
    model: message.model,
    ...message.responseModel === undefined ? {} : { responseModel: message.responseModel },
    ...message.responseId === undefined ? {} : { responseId: message.responseId },
    stopReason: message.stopReason,
    blocks: message.content.map((block): PiAiReplayBlock => {
      switch (block.type) {
        case 'text': return {
          type: 'text',
          ...block.textSignature === undefined ? {} : { textSignature: block.textSignature },
        }
        case 'thinking': return {
          type: 'reasoning',
          ...block.thinkingSignature === undefined ? {} : { thinkingSignature: block.thinkingSignature },
          ...block.redacted === undefined ? {} : { redacted: block.redacted },
        }
        case 'toolCall': return {
          type: 'tool-call',
          ...block.thoughtSignature === undefined ? {} : { thoughtSignature: block.thoughtSignature },
        }
      }
    }),
  }
}

function invalidReplay(message: string): never {
  throw new LlmError(`invalid pi-ai replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

function readReplayState(value: unknown): PiAiReplayState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay('expected an object')
  const state = value as Record<string, unknown>
  if (state['kind'] !== 'pi-ai') return invalidReplay('unknown state kind')
  if (state['version'] !== 1) return invalidReplay(`unsupported version ${String(state['version'])}`)
  for (const key of ['api', 'provider', 'model'] as const) {
    if (typeof state[key] !== 'string' || state[key].length === 0) return invalidReplay(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(String(state['stopReason']))) {
    return invalidReplay('unknown stopReason')
  }
  if (state['responseModel'] !== undefined && typeof state['responseModel'] !== 'string') return invalidReplay('responseModel must be a string')
  if (state['responseId'] !== undefined && typeof state['responseId'] !== 'string') return invalidReplay('responseId must be a string')
  if (!Array.isArray(state['blocks'])) return invalidReplay('blocks must be an array')
  for (const [index, value] of state['blocks'].entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`)
    const block = value as Record<string, unknown>
    if (!['text', 'reasoning', 'tool-call'].includes(String(block['type']))) return invalidReplay(`block ${index} has an unknown type`)
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature'] as const) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') return invalidReplay(`block ${index} ${signature} must be a string`)
    }
    if (block['redacted'] !== undefined && typeof block['redacted'] !== 'boolean') return invalidReplay(`block ${index} redacted must be boolean`)
  }
  return state as unknown as PiAiReplayState
}

function foreignAssistant(message: Message): AssistantMessage {
  const source = message.source.kind === 'model' ? message.source : undefined
  const content: AssistantMessage['content'] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text': content.push({ type: 'text', text: block.text }); break
      case 'reasoning': content.push({ type: 'thinking', thinking: block.text }); break
      case 'tool-call': content.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
      }); break
      case 'image':
        throw new LlmError('pi-ai chat history cannot represent structured assistant image output', 'UNSUPPORTED_CONTENT')
      default:
        // plugin-added block types are not representable in pi-ai.
        break
    }
  }
  return {
    role: 'assistant',
    content,
    // Deliberately never equals a catalog API: absent replay state is foreign
    // even if source names the same provider/model as this request.
    api: 'ea-foreign',
    provider: source?.provider ?? 'ea-foreign',
    model: source?.model ?? 'ea-foreign',
    usage: emptyPiUsage(),
    stopReason: content.some(piece => piece.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: 0,
  }
}

function replayedAssistant(message: Message, source: ModelMessageSource, rawState: unknown): AssistantMessage {
  const state = readReplayState(rawState)
  if (state.provider !== source.provider) return invalidReplay('provider does not match assistant source')
  if (state.model !== source.model) return invalidReplay('model does not match assistant source')
  if (state.blocks.length !== message.content.length) return invalidReplay('block count does not match assistant content')
  const content: AssistantMessage['content'] = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`)
    switch (block.type) {
      case 'text': return {
        type: 'text',
        text: block.text,
        ...replay.type === 'text' && replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {},
      }
      case 'reasoning': return {
        type: 'thinking',
        thinking: block.text,
        ...replay.type === 'reasoning' && replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {},
        ...replay.type === 'reasoning' && replay.redacted !== undefined ? { redacted: replay.redacted } : {},
      }
      case 'tool-call': return {
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: parseArguments(block.arguments),
        ...replay.type === 'tool-call' && replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {},
      }
      /* v8 ignore next -- readReplayState rejects unknown replay tags, so an equal plugin-added EjunzAgent tag cannot reach this switch */
      default: return invalidReplay(`block ${index} has an unsupported EjunzAgent type`)
    }
  })
  return {
    role: 'assistant',
    content,
    api: state.api,
    provider: state.provider,
    model: state.model,
    ...state.responseModel === undefined ? {} : { responseModel: state.responseModel },
    ...state.responseId === undefined ? {} : { responseId: state.responseId },
    usage: emptyPiUsage(),
    stopReason: state.stopReason,
    timestamp: 0,
  }
}

export function toPiAssistant(message: Message): AssistantMessage {
  const source = message.source
  return source.kind !== 'model' || source.replayState === undefined
    ? foreignAssistant(message)
    : replayedAssistant(message, source, source.replayState)
}

import { CallId, contentHasImage, LlmError } from '@ejunz/ea/llm'

import type { ContentBlock, GenerateOptions, Message } from '@ejunz/ea/llm'

import type { AttachmentStore } from '@ejunz/ea/attachment'

import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'

function flattenText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'tool-result':
        {
          const nested = await userContent(block.content, attachments)
          if (typeof nested === 'string') {
            if (nested.length > 0) content.push({ type: 'text', text: nested })
          } else {
            content.push(...nested)
          }
        }
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function textOnlyContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: toolResultText(result.content) || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(options, messages)
}

export function toPiContext(options: GenerateOptions): PiContext

export function toPiContext(options: GenerateOptions, attachments: AttachmentStore): Promise<PiContext>

export function toPiContext(options: GenerateOptions, attachments?: AttachmentStore): PiContext | Promise<PiContext> {
  return attachments === undefined ? textOnlyContext(options) : toPiContextWithImages(options, attachments)
}

async function toPiContextWithImages(options: GenerateOptions, attachments: AttachmentStore): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []

  for (const message of options.messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      // pi-ai has a single systemPrompt slot; in-history system messages are
      // folded into user messages to preserve order (rare in practice — the
      // ejunzAgent sends the system prompt via options.system).
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    // user role: text + tool results (each result becomes its own message).
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = await userContent(regular, attachments)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, attachments)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent || '(no output)' }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }

  return piContext(options, messages)
}

import { CallId, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, isContextWindowExceededError, isQuotaExceededError, LlmError, QUOTA_EXCEEDED_CODE } from '@ejunz/ea/llm'

import type { FinishReason, StreamChunk, TokenUsage } from '@ejunz/ea/llm'

import { isContextOverflow } from '@earendil-works/pi-ai'

import type { AssistantMessage, AssistantMessageEvent, Usage as PiUsage } from '@earendil-works/pi-ai'

export function mapUsage(usage: PiUsage): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
    ...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {},
  }
}

function classifyPiAiError(message: string): string {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  // A stream truncated before the provider's terminal event: each pi-ai provider
  // throws its own wording when the wire closes mid-response without a terminal
  // event (`… stream ended before message_stop`, `… before a terminal response
  // event`, `… ended without a terminal event`, `Stream ended without
  // finish_reason`). The connection dropped mid-response, so this is a transport
  // truncation, not a model-level error.
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message)
    // undici renders a mid-stream socket drop as a bare `terminated` (its
    // `cause` — the real SocketError — was flattened away upstream); Node's
    // stream layer says `Premature close`.
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

export function mapStopReason(message: AssistantMessage, contextWindow?: number): FinishReason {
  const piAiOverflow = isContextOverflow(message, contextWindow)
  const ejunzAgentOverflow = message.stopReason === 'error'
    && message.errorMessage !== undefined
    && isContextWindowExceededError(message.errorMessage)
  if (piAiOverflow || ejunzAgentOverflow) {
    return {
      kind: 'error',
      failure: {
        message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
      },
    }
  }

  switch (message.stopReason) {
    case 'stop':
      // A terminal stop that produced no content blocks is a degenerate
      // provider completion, not a successful (empty) assistant message.
      if (message.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${message.model}" returned a completed response with no content`,
            code: EMPTY_RESPONSE_CODE,
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'aborted': return {
      kind: 'aborted',
      failure: { message: message.errorMessage ?? 'pi-ai stream aborted', code: 'ABORTED' },
    }
    case 'error': {
      const text = message.errorMessage ?? 'pi-ai stream error'
      return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
    }
  }
}

export async function* toStreamChunks(
  events: AsyncIterable<AssistantMessageEvent>,
  contextWindow?: number,
): AsyncGenerator<StreamChunk> {
  // pi-ai contentIndex ↔ our block index map 1:1 (both count blocks from 0
  // in stream order), but we track ids per index for tool calls.
  const toolIds = new Map<number, { id: string; name: string }>()

  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        // The id/name live on the partial's content at this index.
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: CallId(known?.id ?? ''),
          ...known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {},
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: CallId(event.toolCall.id),
            name: event.toolCall.name,
            // pi-ai hands back the PARSED arguments; the ejunzAgent vocabulary
            // keeps the raw string.
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield {
          type: 'finish',
          reason: mapStopReason(event.message, contextWindow),
          replayState: toPiReplayState(event.message),
        }
        return
      case 'error':
        // In-stream error delivery (pi-ai's style) → error finish chunk
        // (the ejunzAgent's other sanctioned error path besides throwing).
        yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
        return
      // no default: AssistantMessageEvent is pi-ai's closed union; a new
      // event type should fail compilation here via tsc's exhaustiveness
      // when one is added (switch covers all current variants).
    }
  }
  throw new LlmError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'

import type {
  Api,
  Model,
  Models,
  ModelThinkingLevel,
  MutableModels,
  SimpleStreamOptions,
  ThinkingLevel,
} from '@earendil-works/pi-ai'

import {
  attributionHeaders,
  contentHasImage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@ejunz/ea/llm'

import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ReasoningEffortId as ReasoningEffortIdType,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@ejunz/ea/llm'

import type { AttachmentStore } from '@ejunz/ea/attachment'

import { idleWatchdog, timeoutOf } from '@ejunz/ea/timeout'

interface PiAiSnapshot {
  /** The resolved profiles this collection was built from, used as its identity. */
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>
  /** Providers for exactly those profiles; never mutated once published. */
  models: Models
}

export interface PiAiAdapterOptions {
  /** Current validated profiles by provider route; called once per operation. */
  profiles: () => ReadonlyMap<string, ResolvedPiAiProviderProfile>
  resolveDomainProfiles?: (profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>, signal: AbortSignal) => Promise<ReadonlyMap<string, ResolvedPiAiProviderProfile>>
  /**
   * Resolve the credential for one already-resolved profile; called once per
   * stream call and frozen for that call. `undefined` defers to the route's own
   * pi-ai auth, which for an installed catalog route is its provider-native
   * ambient discovery; the plugin allows that only for a profile naming no
   * credential at all, because a named reference that misses throws `LlmError`
   * `MISSING_CREDENTIAL` rather than falling back.
   */
  resolveApiKey: (provider: string, profile: ResolvedPiAiProviderProfile, signal?: AbortSignal) => Promise<string | undefined>
  /** Resolve the optional durable attachment service at request time. */
  resolveAttachments?: () => AttachmentStore | undefined
}

function profileOptions(
  profile: ResolvedPiAiProviderProfile,
  reasoning: ModelThinkingLevel | undefined,
  apiKey: string | undefined,
): SimpleStreamOptions {
  const enabledReasoning: ThinkingLevel | undefined = reasoning === 'off' ? undefined : reasoning
  return {
    ...apiKey === undefined ? {} : { apiKey },
    ...enabledReasoning === undefined ? {} : { reasoning: enabledReasoning },
    ...profile.thinkingBudgets === undefined ? {} : { thinkingBudgets: profile.thinkingBudgets },
    ...profile.cacheRetention === undefined ? {} : { cacheRetention: profile.cacheRetention },
    ...profile.transport === undefined ? {} : { transport: profile.transport },
    ...profile.timeoutMs === undefined ? {} : { timeoutMs: profile.timeoutMs },
    ...profile.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
    // The agent recovery layer owns visible attempts; one adapter call is one SDK attempt.
    maxRetries: 0,
  }
}

function describableReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some(level => level === effort)
    ? effort as ModelThinkingLevel
    : undefined
}

function resolveReasoningLevel(
  model: Model<Api>,
  effort: ReasoningEffortIdType | ModelThinkingLevel | undefined,
): ModelThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort)) return effort as ModelThinkingLevel
  throw new LlmError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

function reasoningInfo(
  model: Model<Api>,
  defaultLevel: ModelThinkingLevel | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) },
    },
  }
}

function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(name => name.toLowerCase()))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

export class PiAiAdapter extends LlmAdapter {
  private snapshot: PiAiSnapshot | undefined

  constructor(private readonly config: PiAiAdapterOptions) {
    super()
  }

  /** Create an adapter snapshot for one domain-resolved profile set. */
  scoped(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): PiAiAdapter {
    const { resolveDomainProfiles: _resolveDomainProfiles, ...config } = this.config
    return new PiAiAdapter({ ...config, profiles: () => profiles })
  }

  /**
   * The snapshot for the current profiles. Resolution memoizes its result, so
   * an unchanged configuration is recognized by identity; a changed one gets a
   * brand-new collection, leaving any snapshot an operation already captured
   * untouched for as long as that operation holds it.
   */
  private current(): PiAiSnapshot {
    const profiles = this.config.profiles()
    if (this.snapshot?.profiles === profiles) return this.snapshot
    this.snapshot = this.snapshotFor(profiles)
    return this.snapshot
  }

  private snapshotFor(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): PiAiSnapshot {
    const models: MutableModels = createModels()
    for (const profile of profiles.values()) models.setProvider(profile.piProvider)
    return { profiles, models }
  }

  /** The profile for one route within one snapshot, or the not-owned failure. */
  private profileOf(snapshot: PiAiSnapshot, provider: string): ResolvedPiAiProviderProfile {
    const profile = snapshot.profiles.get(provider)
    if (profile === undefined) {
      throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return profile
  }

  /** The configured descriptor for one exact route/model pair within one snapshot. */
  private modelOf(snapshot: PiAiSnapshot, provider: string, model: string): Model<Api> {
    this.profileOf(snapshot, provider)
    const resolved = snapshot.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, 'UNKNOWN_MODEL')
    }
    return resolved
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // The configured name, not the route key: `displayName` exists so a
    // deployment can label a route, and a label only the configuration surface
    // reads would leave every selector showing the raw key.
    return { id: provider, name: this.current().profiles.get(provider)?.displayName ?? provider }
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.current().profiles.get(provider)?.retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      this.profileOf(snapshot, provider)
      return snapshot.models.getModels(provider).map(model => ({
        provider,
        id: model.id,
        name: model.name,
        inputModalities: [...model.input],
      }))
    })
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve().then(() => {
      const snapshot = this.current()
      const profile = this.profileOf(snapshot, provider)
      const resolvedModel = this.modelOf(snapshot, provider, model)
      const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning)
      // Only a cap the deployment configured is a request default; the
      // catalog's `maxTokens` sizes the model and stops there.
      const configuredMaxTokens = profile.configuredMaxTokens.get(model)
      return {
        provider,
        id: model,
        name: resolvedModel.name,
        inputModalities: [...resolvedModel.input],
        context: { contextWindow: resolvedModel.contextWindow },
        ...configuredMaxTokens === undefined ? {} : { defaultMaxTokens: configuredMaxTokens },
        ...reasoningInfo(resolvedModel, defaultLevel),
      }
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('llm-pi-ai does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    // One capture per stream call, taken before any await: the profile, the
    // model descriptor, and the collection all come from the same immutable
    // snapshot, and the credential freezes with them. A configuration change
    // mid-request builds a separate snapshot, so this request finishes under
    // the one it started with and the next call picks up the new one.
    const requestSignal = options.signal ?? new AbortController().signal
    const baseProfiles = this.config.profiles()
    const profiles = this.config.resolveDomainProfiles === undefined
      ? baseProfiles
      : await this.config.resolveDomainProfiles(baseProfiles, requestSignal)
    const snapshot = this.config.resolveDomainProfiles === undefined ? this.current() : this.snapshotFor(profiles)
    const profile = this.profileOf(snapshot, options.provider)
    const model = this.modelOf(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? profile.reasoning,
    )
    const apiKey = await this.config.resolveApiKey(options.provider, profile, requestSignal)

    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    const streamIdleTimeoutMs = profile.streamIdleTimeoutMs
    using watchdog = idleWatchdog(upstream, streamIdleTimeoutMs, 'LLM_STREAM_IDLE_TIMEOUT')

    try {
      const containsImage = options.messages.some(message => contentHasImage(message.content))
      if (containsImage && !model.input.includes('image')) {
        throw new LlmError(`pi-ai model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
      }
      const attachments = containsImage ? this.config.resolveAttachments?.() : undefined
      if (containsImage && attachments === undefined) {
        throw new LlmError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
      }
      const context = attachments === undefined
        ? toPiContext(options)
        : await toPiContext(options, attachments)
      const events = snapshot.models.streamSimple(model, context, {
        ...profileOptions(profile, reasoning, apiKey),
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
        signal: watchdog.signal,
        // Profile headers are deployment-owned; attribution names are
        // EjunzAgent-owned and therefore win collisions.
        headers: requestHeaders(profile.headers),
      })
      const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
      let exhausted = false
      try {
        while (true) {
          const result = await watchdog.next(iterator)
          const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
          if (timeout !== undefined) throw timeout
          if (result.done) {
            exhausted = true
            return
          }
          yield result.value
        }
      } finally {
        if (!exhausted) {
          consumer.abort('pi-ai stream consumer stopped')
          try {
            await iterator.return(undefined)
          } catch (_abortedSdkTeardown) {
            // The stable signal already owns SDK termination; return-time abort cannot add an outcome.
          }
        }
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) {
        throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    } finally {
      consumer.abort('pi-ai stream consumer stopped')
    }
  }
}

import { INVALID_CREDENTIAL_CODE, LlmError, normalizeApiKey } from '@ejunz/ea/llm'

import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@ejunz/ea/llm'

import { attributionHeaders } from '@ejunz/ea/llm'

const LISTABLE_PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-completions',
  'openai-responses',
])

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

interface ListingEntry {
  id?: unknown
  /** Common gateway extensions; absent from the official listings. */
  name?: unknown
  display_name?: unknown
  context_window?: unknown
  context_length?: unknown
  max_tokens?: unknown
  max_output_tokens?: unknown
}

function capacity(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
  return undefined
}

function label(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

function listingUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

async function readBounded(response: Response, url: string): Promise<string> {
  const oversized = (): LlmError =>
    new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  /* v8 ignore next -- fetch always exposes a body stream on a 2xx Response; the null guard is defensive. */
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed or abandoned read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      // Cancel after a drained read, or after this function walked away from
      // an oversized one, is cleanup; the reply is already decided either way.
    })
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function readListing(body: unknown): LlmDiscoveredModel[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) {
    throw new LlmError(
      'the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand',
      'DISCOVERY_FAILED',
    )
  }
  const models: LlmDiscoveredModel[] = []
  for (const raw of data) {
    const entry = raw as ListingEntry | null
    const id = label(entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    models.push({
      id,
      ...name === undefined ? {} : { name },
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxTokens === undefined ? {} : { maxTokens },
    })
  }
  return models
}

function usableProbeKey(raw: string): string {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    INVALID_CREDENTIAL_CODE,
  )
}

export async function discoverModels(
  request: LlmModelDiscoveryRequest,
  storedApiKey?: () => Promise<string | undefined>,
): Promise<readonly LlmDiscoveredModel[]> {
  // A catalog route already has its answer, and a better one: the installed
  // entries carry context windows and output caps no listing endpoint reports.
  if (request.provider !== undefined) {
    const installed = catalogModels(request.provider)
    if (installed.size > 0) {
      return [...installed.values()].map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      }))
    }
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `pi-ai ships no catalog for provider "${request.provider ?? ''}", so its models can only come from its`
      + " endpoint; set a baseURL, or enter this provider's models by hand",
      'DISCOVERY_FAILED',
    )
  }
  // A draft that has not chosen a protocol yet is asked as OpenAI Chat
  // Completions: it is the shape a gateway is overwhelmingly likely to speak,
  // and the alternative — refusing until the field is filled — would withhold
  // the action from the case it exists for. The cost is a misdirected message
  // when the endpoint speaks something else (an Anthropic gateway answers 401,
  // which reads as a credential problem), and hand-entry remains the way out.
  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new LlmError(
      `pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`,
      'DISCOVERY_UNSUPPORTED',
    )
  }
  const url = listingUrl(request.baseURL)
  // A key typed into the form wins: it is the one the user is testing, and it
  // may be the replacement for exactly the stored key that is failing. The
  // stored one is only asked for here, past the catalog short-circuit and the
  // protocol check, so a route answered from the registry costs no credential
  // lookup — and no diagnostic about a credential it never needed.
  // A probe carrying no key stays unauthenticated, which is how a route that
  // relies on the provider's own ambient discovery is meant to be asked.
  const supplied = request.apiKey ?? await storedApiKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` },
        ...attributionHeaders(),
      },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
  } catch (error: unknown) {
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text: string
  try {
    text = await readBounded(response, url)
  } catch (error: unknown) {
    // Cancellation during the body read rejects with the abort reason, which
    // may be any value; the caller gets the same coded failure it would have
    // for a cancellation before the request went out.
    if (request.signal?.aborted) {
      throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw error
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error: unknown) {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}

import type { Context } from '@ejunz/cordis'

import { launchEnvironmentOf } from '@ejunz/ea/launch-environment'

import { assertUsableApiKey, LlmError } from '@ejunz/ea/llm'

import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@ejunz/ea/llm'

import { deepEqualJson, installSettingsSection, settingsNamespace } from '@ejunz/ea/settings'

export const name = 'llm-pi-ai'

export const inject = ['llm']

const NS = settingsNamespace('llm-pi-ai')

function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    // `displayName` rides along because the registry hands it to every selector
    // through `providerInfo()`: a rename that did not re-register would leave
    // the old label showing until some unrelated fact happened to change.
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
      retryPolicy: profile.retryPolicy,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

function directoryEntries(
  profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
): LlmConfigurableProvider[] {
  const catalog = new Set(catalogProviderIds())
  const entries = new Map<string, LlmConfigurableProvider>()
  const declare = (provider: string, displayName: string): void => {
    entries.set(provider, {
      provider,
      displayName,
      settingsNs: NS,
      settingsPath: ['providers', provider],
      // Membership of the installed catalog, not of the settings document:
      // narrowing a shipped provider's models stores a profile too, and that
      // route is still one pi-ai knows.
      declared: !catalog.has(provider),
    })
  }
  // A provider whose only native method is OAuth leaves this adapter nothing
  // to authenticate with, so offering it would put a card on the settings page
  // whose own posture — no key, credentials discovered by the provider — fails
  // every request. Catalog *membership* is unaffected, so `declare` above still
  // answers what pi-ai ships.
  for (const provider of catalog) {
    if (catalogProviderTakesApiKey(provider)) declare(provider, provider)
  }
  for (const [provider, profile] of profiles) declare(provider, profile.displayName)
  return [...entries.values()]
}

export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  /**
   * The resolved profiles for the current configuration, memoized by the raw
   * snapshot's identity — which is also what makes the adapter's own snapshot
   * stable across operations that observe no change.
   *
   * No fallback for an unserviceable snapshot lives here: the section schema
   * resolves the whole profile set, so a write that could not be served is
   * refused where it is written, and the settings seam keeps a namespace's
   * last good value for a stored section that fails. Anything reaching this
   * point has already resolved once.
   */
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = resolveProfiles(raw.providers)
    lastRaw = raw
    memoized = next
    return next
  }
  profiles()

  const currentDomainRuntime = async (signal: AbortSignal) => {
    const agent = ctx.get('agents')?.currentInitiator()
    const provider = ctx.get('llmDomainRuntime')
    return agent === undefined || provider === undefined ? undefined : await provider.resolve(agent.id, signal)
  }
  const domainRuntimes = new WeakMap<object, { credentials: Record<string, string> }>()

  const resolveDomainProfiles = async (
    _baseProfiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ResolvedPiAiProviderProfile>> => {
    const runtime = await currentDomainRuntime(signal)
    const base = profiles()
    if (runtime === undefined) return base
    const section = runtime.settings['llm-pi-ai']
    let next = base
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      const domainProviders = (section as Config).providers
      if (domainProviders && typeof domainProviders === 'object' && !Array.isArray(domainProviders)) {
        const globalProviders = current().providers ?? {}
        const providers = { ...globalProviders } as NonNullable<Config['providers']>
        for (const [provider, override] of Object.entries(domainProviders)) {
          providers[provider] = { ...(globalProviders[provider] ?? {}), ...override }
        }
        next = resolveProfiles(providers)
      }
    }
    for (const profile of next.values()) domainRuntimes.set(profile, runtime)
    return next
  }

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
    _signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const ref = profile.apiKeyEnv
    const scoped = domainRuntimes.get(profile)
    if (scoped !== undefined && ref !== undefined) {
      const hit = scoped.credentials[ref]
      if (hit !== undefined) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
      throw new LlmError(
        `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not set — store ${ref} through the credentials service (the web Models page writes it)`,
        'MISSING_CREDENTIAL',
      )
    }
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? (await credentials.resolve(ref))?.value
      // Without the seam the environment is the whole credential plane.
      : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) return assertUsableApiKey(hit, 'llm-pi-ai', ref)
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — store ${ref} through the credentials service (the web Models page writes it) or export it,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new PiAiAdapter({
    profiles,
    resolveDomainProfiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerProviderResolver({
    resolve: async (provider, signal) => {
      const base = profiles()
      const resolved = await resolveDomainProfiles(base, signal ?? new AbortController().signal)
      if (resolved === base || !resolved.has(provider)) return undefined
      return adapter.scoped(resolved)
    },
  })
  // The full installed catalog is configurable from the moment the plugin
  // mounts — dormant or not — so configuration surfaces can offer every
  // pi-ai provider before any route exists. Hand-declared routes join it as
  // profiles appear, and leave with them.
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(profiles())
    if (deepEqualJson(entries, directoryFacts)) return
    // Atomic replace, never dispose-then-register: a route another adapter
    // family already declares (a profile keyed `deepseek-official`) would
    // otherwise leave this plugin's whole directory withdrawn and the Models
    // page empty. The candidate set is validated first, so a collision keeps
    // the previous entries serving and only costs a diagnostic.
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()
  /**
   * The credential a named route already resolves, for an interrogation whose
   * draft carries none. A route being declared for the first time names no
   * profile yet, and a profile that names no credential defers to pi-ai's own
   * discovery, so both answer `undefined` and the endpoint is asked
   * unauthenticated — the same posture a request to that route would take.
   */
  const storedApiKey = async (provider: string | undefined): Promise<string | undefined> => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return resolveApiKey(provider, profile)
  }
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace rather than per route: the provider
  // a surface is adding does not exist yet. The draft is the whole request
  // except the credential: a configuration surface edits a redacted descriptor
  // and never holds a stored secret, so an already-configured route supplies
  // its own here rather than being interrogated unauthenticated.
  ctx.llm.registerModelDiscovery(NS, request => discoverModels(request, () => storedApiKey(request.provider)))
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below. A bare
  // mount (zero routes) is the dormant posture: nothing registers until a
  // settings section supplies profiles, and routes drop when it empties.
  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration, so a change to either must re-register. The swap is
    // atomic (same adapter instance, validated before anything moves): a
    // conflicting route leaves the previous routes serving requests, and
    // `registeredFacts` only advances once the registry actually holds the
    // new set — so returning to a working configuration always re-applies.
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // profiles, and an empty section keeps it that way.
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config, {
    // Refuse an unserviceable section where it is written: without this a
    // schema-valid profile the adapter cannot serve would be stored and then
    // silently disable every route in this namespace.
    validate: assertServiceable,
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // Named here rather than left to the settings watcher: `assertServiceable`
      // cannot see the llm registry, so a profile claiming a route another
      // adapter family owns is stored successfully and only fails at this swap.
      // Without its own diagnostic that refusal reaches the operator as a
      // generic "settings: watcher failed", naming neither the route nor why it
      // is not serving. The previous routes keep serving either way.
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('llm-pi-ai: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
      // The directory follows the profiles the registry accepted, so a route
      // that failed to register is not advertised as configurable. A refused
      // directory swap is contained here for the same reason the registry's
      // is: the previous entries keep serving, and `directoryFacts` stays put
      // so returning to a working configuration re-applies.
      try {
        ensureDirectory()
      } catch (error) {
        ctx.logger.error('llm-pi-ai: keeping the previous configurable-provider directory after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/llm-pi-ai'
  export const name = 'llm-pi-ai-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
