import type { JsonValue } from '@ejunz/ea/tools'

export type { JsonValue } from '@ejunz/ea/tools'

export interface HostToolSpec {
  /** Name the model calls, and the name the tool registry holds. */
  readonly name: string
  /** Model-facing description. */
  readonly description: string
  /** Parameter JSON Schema, as `ToolSchema.parameters` holds it. */
  readonly inputSchema: Record<string, unknown>
  /** Whether the host call returns a marker for the captured native Agent tool. */
  readonly runtimeDelegation?: boolean
}

export interface HostCatalog {
  /** Tools to register, in the order the host declared them. */
  readonly tools: readonly HostToolSpec[]
  /**
   * Model-facing statements about the set, and about the scope its calls act for, when
   * the host supplies them. The host resolves this text per session, so what a model
   * reads describes the session that asked.
   */
  readonly guidance?: string
}

export interface HostCallContext {
  readonly sessionId: string
  /** Native tools visible to the calling Agent scope, used to build its host catalog. */
  readonly runtimeTools?: readonly HostToolSpec[]
  /** Marks a call that only asks the host to authorize runtime delegation. */
  readonly runtimeDelegation?: boolean
}

export type HostArguments = Record<string, JsonValue>

export interface HostToolClient {
  /**
   * Declare the tools this client installs.
   * @param signal - aborts the round trip.
   * @param context - session the catalog is read for; omitted reads the set every session
   *   shares, which leaves out the tools a single domain publishes.
   * @returns the declared tools and the host's guidance.
   */
  catalog(signal: AbortSignal, context?: HostCallContext): Promise<HostCatalog>
  /**
   * Execute one declared tool.
   * @param name - tool name from the declared catalog.
   * @param args - tool arguments.
   * @param context - session the call belongs to.
   * @param signal - aborts the call.
   * @returns the tool result.
   */
  call(name: string, args: HostArguments, context: HostCallContext, signal: AbortSignal): Promise<JsonValue>
}

import type { JsonValue } from '@ejunz/ea/tools'

function invalid(detail: string): never {
  throw new Error(`host tool catalog is invalid: ${detail}`)
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${field} must be an object`)
  return value as Record<string, unknown>
}

export function parseHostCatalog(value: JsonValue | undefined): HostCatalog {
  const payload = record(value, 'catalog')
  const tools = payload.tools
  if (!Array.isArray(tools)) invalid('tools must be an array')
  const guidance = payload.guidance
  if (guidance !== undefined && typeof guidance !== 'string') invalid('guidance must be a string')

  const names = new Set<string>()
  const parsed: HostToolSpec[] = tools.map((entry, index) => {
    const spec = record(entry, `tools[${index}]`)
    const { name, description, runtimeDelegation } = spec
    if (typeof name !== 'string' || name.length === 0) invalid(`tools[${index}].name must be a non-empty string`)
    if (names.has(name)) invalid(`tools[${index}].name is duplicated`)
    names.add(name)
    if (typeof description !== 'string') invalid(`tools[${index}].description must be a string`)
    if (runtimeDelegation !== undefined && typeof runtimeDelegation !== 'boolean') {
      invalid(`tools[${index}].runtimeDelegation must be a boolean`)
    }
    return {
      name,
      description,
      inputSchema: record(spec.inputSchema, `tools[${index}].inputSchema`),
      ...(runtimeDelegation === true ? { runtimeDelegation: true } : {}),
    }
  })

  return { tools: parsed, ...(guidance === undefined ? {} : { guidance }) }
}

import type { LlmDomainRuntime } from '@ejunz/ea/llm'

import type { JsonValue } from '@ejunz/ea/tools'

export interface HostToolBridge {
  /**
   * Read the tool catalog the host exposes to Agent sessions.
   * @param signal - aborts the request.
   * @param context - session the catalog is read for; omitted reads the set every session
   *   shares, which leaves out the tools a single domain publishes.
   * @returns the declared tools and their guidance.
   */
  catalog(signal: AbortSignal, context?: HostCallContext): Promise<HostCatalog>
  /**
   * Execute one declared tool in the host process.
   * @param sessionId - Agent session the call acts for.
   * @param name - tool name from the declared catalog.
   * @param args - tool arguments.
   * @param signal - aborts the request.
   * @returns the tool result.
   */
  call(sessionId: string, name: string, args: HostArguments, signal: AbortSignal, runtimeDelegation?: boolean): Promise<JsonValue>
  /**
   * Read the LLM runtime configuration for one session's domain.
   *
   * The host owns which models a domain may use, so the runtime is read over the same
   * transport as the tools even though no tool serves it.
   * @param sessionId - Agent session to resolve.
   * @param signal - aborts the request.
   * @returns the domain runtime, or undefined when the host reports none.
   */
  runtime(sessionId: string, signal: AbortSignal): Promise<LlmDomainRuntime | undefined>
}

interface BridgeResponse {
  ok?: boolean
  value?: JsonValue
  error?: { message?: string }
}

function formatThrown(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through */
    }
  }
  return String(error);
}

async function request(
  origin: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<JsonValue | undefined> {
  const url = `${origin.replace(/\/$/, '')}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ejunz-agent-token': token,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw new Error(`Ejunz Agent bridge request failed for ${url}: ${formatThrown(error)}`, { cause: error })
  }
  let rawPayload: unknown
  try {
    rawPayload = await response.json()
  } catch (error) {
    throw new Error(`Ejunz Agent bridge request failed for ${url}: non-JSON response (${response.status}): ${formatThrown(error)}`)
  }
  if (typeof rawPayload === 'string') {
    try {
      rawPayload = JSON.parse(rawPayload)
    } catch (error) {
      throw new Error(`Ejunz Agent bridge request failed for ${url}: invalid JSON response envelope (${response.status}): ${formatThrown(error)}`)
    }
  }
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new Error(`Ejunz Agent bridge request failed for ${url}: unexpected response envelope (${response.status}, ${typeof rawPayload})`)
  }
  const payload = rawPayload as BridgeResponse
  if (!response.ok || payload.ok !== true) {
    const message = payload.error?.message
    if (message) throw new Error(message)
    const keys = Object.keys(payload).join(', ')
    const errorValue = (payload as { error?: unknown }).error
    const errorKeys = errorValue && typeof errorValue === 'object' ? Object.keys(errorValue).join(', ') : undefined
    throw new Error(
      `Ejunz Agent bridge request failed: ${response.status} (unexpected response envelope: ${keys}${errorKeys ? `; error fields: ${errorKeys}` : ''})`,
    )
  }
  return payload.value
}

export function createHostToolBridge(origin: string, token: string): HostToolBridge {
  return {
    async catalog(signal, context) {
      const body = context === undefined ? {} : {
        sessionId: context.sessionId,
        ...(context.runtimeTools === undefined ? {} : { runtimeTools: context.runtimeTools }),
      }
      return parseHostCatalog(await request(origin, token, '/api/ejunz-agent/data/tools/catalog', body, signal))
    },
    async call(sessionId, name, args, signal, runtimeDelegation) {
      const value = await request(origin, token, '/api/ejunz-agent/data/tools/call', {
        sessionId,
        name,
        args,
        ...(runtimeDelegation === true ? { runtimeDelegation: true } : {}),
      }, signal)
      return value as JsonValue
    },
    async runtime(sessionId, signal) {
      const value = await request(origin, token, '/api/ejunz-agent/data/domain/runtime', { sessionId }, signal)
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as unknown as LlmDomainRuntime
        : undefined
    },
  }
}

export function createHostToolClient(bridge: HostToolBridge): HostToolClient {
  return {
    catalog: (signal, context) => bridge.catalog(signal, context),
    call: (name, args, context, signal) => bridge.call(context.sessionId, name, args, signal, context.runtimeDelegation),
  }
}

import { Context, Service } from '@ejunz/cordis'

import type { JsonValue } from '@ejunz/ea/tools'

declare module '@ejunz/cordis' {
  interface Context {
    /** Service holding the host client this deployment attached. */
    provider: HostToolClientService
    /** Host client provided at the root, which the service attaches on load. */
    hostProvider: HostToolClient
  }
}

export class HostToolClientService extends Service {
  private client: HostToolClient | undefined

  constructor(ctx: Context) {
    super(ctx, 'provider')
    ctx.inject(['hostProvider'], (scope) => this.attach(scope.hostProvider))
  }

  /**
   * Attach the client this deployment authorizes.
   * @param client - client that declares the host's tools and executes them.
   */
  attach(client: HostToolClient): void {
    this.client = client
  }

  /**
   * Read the tools the attached client declares.
   * @param signal - aborts the round trip.
   * @param context - session the catalog is read for; omitted reads the set every session
   *   shares, which leaves out the tools a single domain publishes.
   * @returns the declared tools and the host's guidance.
   * @throws when no client is attached.
   */
  async catalog(signal: AbortSignal, context?: HostCallContext): Promise<HostCatalog> {
    if (this.client === undefined) throw new Error('tool-host: no client is attached, so no tool catalog is available')
    return this.client.catalog(signal, context)
  }

  /**
   * Execute one declared tool.
   * @param name - tool name from the declared catalog.
   * @param args - tool arguments.
   * @param context - session the call belongs to.
   * @param signal - aborts the call.
   * @returns the tool result.
   * @throws when no client is attached.
   */
  async call(name: string, args: HostArguments, context: HostCallContext, signal: AbortSignal): Promise<JsonValue> {
    if (this.client === undefined) throw new Error(`tool-host: no client is attached for ${name}`)
    return this.client.call(name, args, context, signal)
  }
}

export function attachHostToolClient(ctx: Context, client: HostToolClient): void {
  ctx.provider.attach(client)
}

import type { ContentBlock } from '@ejunz/ea/llm'

import type { JsonValue, ToolDefinition } from '@ejunz/ea/tools'

const RUNTIME_TOOL_CALL_TYPE = 'ejunz/runtime-tool-call'

interface RuntimeToolCall {
  toolName: string
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRuntimeToolCall(value: JsonValue): RuntimeToolCall | undefined {
  if (!isRecord(value) || value.type !== RUNTIME_TOOL_CALL_TYPE) return undefined
  const toolName = value.toolName
  if (typeof toolName !== 'string') {
    throw new Error('host tool returned a malformed runtime-tool-call result')
  }
  return { toolName }
}

function renderResult(value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value ?? null) }]
}

export function createHostToolDefinition(
  spec: HostToolSpec,
  client: HostToolClient,
  runtimeTool?: ToolDefinition,
): ToolDefinition {
  if (spec.runtimeDelegation === true && runtimeTool === undefined) {
    throw new Error(`native runtime tool ${spec.name} is not installed for this Agent`)
  }
  return {
    ...(runtimeTool ?? {}),
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    output: runtimeTool?.output ?? {
      schema: {},
      render: (_args, value) => renderResult(value),
    },
    execute: async (args, exec) => {
      const input = typeof args === 'object' && args !== null && !Array.isArray(args)
        ? args as HostArguments
        : {}
      if (exec.agent === undefined) throw new Error(`tool ${spec.name} requires an Agent session`)
      const result = await client.call(spec.name, input, {
        sessionId: exec.agent.session.id,
        ...(spec.runtimeDelegation === true ? { runtimeDelegation: true } : {}),
      }, exec.signal)
      const delegated = parseRuntimeToolCall(result)
      if (delegated === undefined) {
        if (spec.runtimeDelegation === true) {
          throw new Error(`host tool ${spec.name} did not authorize runtime delegation`)
        }
        return result
      }
      if (delegated.toolName !== spec.name) {
        throw new Error(`host tool ${spec.name} cannot delegate to runtime tool ${delegated.toolName}`)
      }
      if (runtimeTool === undefined) {
        throw new Error(`native runtime tool ${spec.name} is not installed for this Agent`)
      }
      return await runtimeTool.execute(exec.arguments, exec)
    },
  }
}

export interface ToolRegistry {
  /** Look up a tool as the given Agent scope sees it. */
  get(name: string, scope?: object): ToolDefinition | undefined
  /** Register one scoped host tool and return its disposer. */
  register(definition: ToolDefinition): () => void
}

export interface RegisterHostToolsOptions {
  registry: ToolRegistry
  client: HostToolClient
  catalog: HostCatalog
  scope?: object
}

export function registerHostTools(options: RegisterHostToolsOptions): () => void {
  const disposers: (() => void)[] = []
  try {
    for (const spec of options.catalog.tools) {
      const runtimeTool = options.registry.get(spec.name, options.scope)
      disposers.push(options.registry.register(createHostToolDefinition(spec, options.client, runtimeTool)))
    }
  } catch (error) {
    for (const dispose of [...disposers].reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of [...disposers].reverse()) dispose()
  }
}

import type { Context } from '@ejunz/cordis'

export const name = 'tool-host'

export const inject = ['tools']

const CATALOG_TIMEOUT_MS = 30_000

export interface InstallHostToolsOptions {
  /** The Agent's own scope: the tools bind to it and disappear with the Agent. */
  readonly agentCtx: Context
  /**
   * Client the installed tools read and call through. Passed in rather than resolved from
   * a service so an install works with either the deployment's client or its per-instance
   * host bridge.
   */
  readonly client: HostToolClient
}

interface HostToolInstallation {
  readonly client: HostToolClient
  queue: Promise<void>
  catalog?: HostCatalog
  dispose?: () => void
}

const installations = new WeakMap<Context, HostToolInstallation>()

function installCatalog(agentCtx: Context, client: HostToolClient, catalog: HostCatalog): () => void {
  const agent = agentCtx.agent
  if (agent === undefined) throw new Error('tool-host: host tools require an Agent scope')
  const registry = agentCtx.get('tools') as ToolRegistry | undefined
  if (registry === undefined) throw new Error('tool-host: the tool registry is unavailable in this Agent scope')
  const disposeTools = registerHostTools({ registry, client, catalog, scope: agent })
  try {
    const guidance = catalog.guidance
    const disposeContext = guidance !== undefined && guidance.length > 0
      ? agentCtx.get('systemPrompt')?.context({
        name: 'host-tools',
        order: 120,
        text: () => guidance,
      })
      : undefined
    return () => {
      disposeContext?.()
      disposeTools()
    }
  } catch (error) {
    disposeTools()
    throw error
  }
}

export async function refreshHostTools(agentCtx: Context): Promise<void> {
  const installation = installations.get(agentCtx)
  if (installation === undefined) return
  const update = installation.queue.then(async () => {
    const agent = agentCtx.agent
    if (agent === undefined) throw new Error('tool-host: host tools require an Agent scope')
    const sessionId = agent.session.id
    const previousCatalog = installation.catalog
    const disposePrevious = installation.dispose
    disposePrevious?.()
    delete installation.dispose
    try {
      const registry = agentCtx.get('tools') as (ToolRegistry & {
        schemas(scope?: object): { name: string; description: string; parameters: Record<string, unknown> }[]
      }) | undefined
      if (registry === undefined) throw new Error('tool-host: the tool registry is unavailable in this Agent scope')
      const runtimeTools = registry.schemas(agent).map(({ name, description, parameters }) => ({
        name,
        description,
        inputSchema: parameters,
      }))
      const catalog = await installation.client.catalog(AbortSignal.timeout(CATALOG_TIMEOUT_MS), { sessionId, runtimeTools })
      if (previousCatalog !== undefined && JSON.stringify(previousCatalog) === JSON.stringify(catalog)) {
        installation.dispose = installCatalog(agentCtx, installation.client, previousCatalog)
        return
      }
      installation.dispose = installCatalog(agentCtx, installation.client, catalog)
      installation.catalog = catalog
      agentCtx.logger.info(`tool-host: refreshed ${catalog.tools.length} host tool(s) for session ${sessionId}`)
    } catch (error) {
      if (previousCatalog !== undefined) {
        installation.dispose = installCatalog(agentCtx, installation.client, previousCatalog)
        installation.catalog = previousCatalog
      } else {
        delete installation.dispose
        delete installation.catalog
      }
      throw error
    }
  })
  installation.queue = update.then(() => undefined, () => undefined)
  await update
}

export async function installHostTools(options: InstallHostToolsOptions): Promise<void> {
  const { agentCtx, client } = options
  if (agentCtx.agent === undefined) throw new Error('tool-host: host tools require an Agent scope')
  const existing = installations.get(agentCtx)
  if (existing !== undefined && existing.client !== client) {
    throw new Error('tool-host: a different client is already installed for this Agent')
  }
  const installation = existing ?? { client, queue: Promise.resolve() }
  installations.set(agentCtx, installation)
  try {
    await refreshHostTools(agentCtx)
  } catch (error) {
    if (existing === undefined) installations.delete(agentCtx)
    throw error
  }
}

export const HOST_TOOLS_SERVICE = 'hostTools'

declare module '@ejunz/cordis' {
  interface Context {
    /** Installer published by this package while a host client is attached. */
    hostTools?: {
      /**
       * Install the host tools for one Agent scope.
       * @param agentCtx - the Agent's own scope.
       * @returns a promise settling after the tools and their prompt section are registered.
       */
      install(agentCtx: Context): Promise<void>
    }
  }
}

export async function apply(ctx: Context): Promise<void> {
  await ctx.plugin(HostToolClientService)
  const client = ctx.get('provider')
  if (client === undefined) throw new Error('tool-host: the host client service published no provider')
  ctx.provide(HOST_TOOLS_SERVICE, {
    install: (agentCtx: Context) => installHostTools({ agentCtx, client }),
  })
}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/tool-host'
  export const name = 'tool-host-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
