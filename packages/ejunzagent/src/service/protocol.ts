import { Service, type Context, type Events } from '@ejunz/cordis'

declare const LOOKUP_HOST: unique symbol

declare const LOOKUP_WIRE: unique symbol

declare const CONTEXT_WIRE: unique symbol

export interface TypertLookup<Host, Wire> {
  readonly [LOOKUP_HOST]: Host
  readonly [LOOKUP_WIRE]: Wire
}

export type TypertLookupHost<Lookup> = Lookup extends TypertLookup<infer Host, infer _Wire> ? Host : never

export type TypertLookupWire<Lookup> = Lookup extends TypertLookup<infer _Host, infer Wire> ? Wire : never

export interface TypertContext<Wire> {
  readonly [CONTEXT_WIRE]: Wire
}

export type TypertContextWire<ContextType> = ContextType extends TypertContext<infer Wire> ? Wire : never

export interface TypertLookupMap {}

export interface TypertContextMap {}

export interface TypertRemoteMap {}

export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }

export interface TypertRemoteScopeMap {}

export type TypertForwardableEvent = {
  [Event in keyof Events]: unknown extends ThisParameterType<Events[Event]>
    ? ReturnType<Events[Event]> extends void ? Event : never
    : never
}[keyof Events]

export interface TypertRemoteEventSelection {}

export type TypertRemoteEvent = Extract<keyof Events, keyof TypertRemoteEventSelection>

export type TypertRemoteNamespace<Namespace extends string> = {
  [Endpoint in keyof TypertRemoteMap as Endpoint extends `${Namespace}/${infer Method}`
    ? Method
    : never]: TypertRemoteMap[Endpoint]
}

export type TypertRemoteScopeNamespace<
  Namespace extends string,
  ContextKey extends string = string,
> = {
  [Endpoint in keyof TypertRemoteScopeMap as Endpoint extends `${ContextKey}:${Namespace}/${infer Method}`
    ? Method
    : never]: TypertRemoteScopeMap[Endpoint]
}

type TypertRemoteScopeNamespaceKey<
  ContextKey extends string,
  Endpoint = keyof TypertRemoteScopeMap,
> = Endpoint extends `${ContextKey}:${infer Namespace}/${string}` ? Namespace : never

export type TypertRemoteScopeApi<ContextKey extends string> = {
  [Namespace in TypertRemoteScopeNamespaceKey<ContextKey>]:
  TypertRemoteScopeNamespace<Namespace, ContextKey>
}

export interface TypertRemoteNamespaceMap {}

export type TypertDisposer = () => Promise<void>

type StringKeyOf<Value> = Extract<keyof Value, string>

export interface TypertSchema<Output = unknown> {
  /**
   * Parse and validate one boundary value.
   * @param value - untrusted boundary value.
   * @returns the validated value.
   */
  parse(value: unknown): Output
}

export type TypertCodec =
  | {
    readonly mode: 'strict'
    readonly typeSymbol: string
    readonly schema: TypertSchema
  }
  | {
    readonly mode: 'src-json'
  }

export interface InvocationParameterDescriptor {
  /** Source-level parameter name. */
  readonly name: string
  /** Required key in the wire `args` object. */
  readonly wire: string
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup'
  /** Lookup key when `source` is `lookup`. */
  readonly lookup?: string
  /** Boundary codec for the wire representation. */
  readonly codec: TypertCodec
  /** Missing wire fields decode to `undefined` only for an explicitly declared `T | undefined`. */
  readonly acceptsUndefined?: true
}

export interface InvocationSourceLocation {
  readonly file: string
  readonly line: number
  readonly column: number
}

export interface InvocationDescriptor {
  /** Globally stable generated identity. */
  readonly id: string
  /** Cordis service key owning the method. */
  readonly service: string
  /** Wire namespace, defaulting to the service key. */
  readonly namespace: string
  /** Public instance method name. */
  readonly method: string
  /** Service member invoked when the exported method name is an alias. */
  readonly implementation?: string
  /** Receiver selection mode. */
  readonly invocation:
    | { readonly kind: 'direct' }
    | {
      readonly kind: 'context'
      readonly context: string
      readonly wire: string
      readonly codec: TypertCodec
    }
  /** Optional consuming-Context projection for one direct lookup parameter. */
  readonly scope?: {
    /** Context kind whose Client binder supplies the identity. */
    readonly context: string
    /** Lookup parameter wire field replaced by the Context identity. */
    readonly wire: string
  }
  /** Ordered business parameters. */
  readonly parameters: readonly InvocationParameterDescriptor[]
  /** Transport cancellation injected after business parameters instead of entering wire args. */
  readonly cancellation?: {
    /** Reserved final Host method parameter. */
    readonly parameter: 'signal'
  }
  /** Codec for the resolved method result. */
  readonly result: TypertCodec
  /** Source declaration used only for diagnostics. */
  readonly sourceLocation?: InvocationSourceLocation
}

export interface TypertRemoteContribution {
  /** npm package that owns the Remote methods. */
  readonly package: string
  /** Consumer-side invocation descriptors generated from that package. */
  readonly descriptors: readonly InvocationDescriptor[]
}

export interface TypertClientRemote extends TypertRemoteNamespaceMap {
  /**
   * Mount one generated Host-for-Client contribution in the caller's fiber.
   * @param contribution - explicitly selected Remote package artifact.
   * @returns disposer after namespace services and concrete methods are ready.
   */
  $mount(contribution: TypertRemoteContribution): Promise<TypertDisposer>
  /**
   * Subscribe to one forwarded Host event; delivery is one-way, in registration
   * order, and isolates a throwing listener from the rest.
   * @template Event - forwarded event name selected by the Host assembly.
   * @param event - forwarded Host event name, unchanged on the wire.
   * @param listener - receives the Host's argument list as declared by Cordis `Events`.
   * @returns disposer owned by the calling fiber.
   */
  $on<Event extends TypertRemoteEvent>(event: Event, listener: Events[Event]): () => void
  /**
   * Hand one decoded forwarded frame to the subscription table. The carrier
   * owning the Host frame sink calls this; a consumer subscribes with
   * {@link TypertClientRemote.$on} and never calls it.
   *
   * `event` is a plain string because this is the wire boundary: the name is
   * whatever the Host assembly's allowlist selected, and one nobody subscribed
   * to is dropped silently.
   * @param event - forwarded Host event name, exactly as the Host emitted it.
   * @param args - the Host argument list, already JSON-decoded.
   */
  $dispatch(event: string, args: readonly unknown[]): void
}

export type TypertLookupResolver<Host = unknown, Wire = unknown> = (
  id: Wire,
) => Host | undefined | Promise<Host | undefined>

export interface TypertLookupProvider<Host = unknown, Wire = unknown> {
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string
  /** Wire field replacing the Host object parameter. */
  readonly wire: string
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string
  /**
   * Resolve a wire identity through the provider's default policy.
   * @param id - validated wire identity.
   * @returns the object, `undefined` when unavailable, or either asynchronously.
   */
  resolve(id: Wire): Host | undefined | Promise<Host | undefined>
}

export interface TypertLookupDefinition {
  /** Merge-declared lookup key. */
  readonly key: string
  /** Source parameter name recognized by the SRC weak parser. */
  readonly parameter: string
  /** Wire field replacing the Host object parameter. */
  readonly wire: string
  /** Canonical Host type symbol used by strict generation. */
  readonly hostTypeSymbol: string
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string
}

export interface TypertHostContextProvider<Wire = unknown> {
  /** Wire field carrying the Context identity. */
  readonly wire: string
  /** Canonical wire type symbol used by strict generation. */
  readonly wireTypeSymbol: string
  /**
   * Resolve a wire identity to its live scoped Context.
   * @param id - validated wire identity.
   * @returns the scoped Context, or `undefined` when unavailable.
   */
  resolve(id: Wire): Context | undefined | Promise<Context | undefined>
}

export type TypertHostContextResolver<Wire = unknown> = (
  id: Wire,
) => Context | undefined | Promise<Context | undefined>

export interface TypertClientContextBinder<Wire = unknown> {
  /**
   * Read the Remote identity represented by a calling Context.
   * @param ctx - Context rebound by the Cordis service tracker.
   * @returns the wire identity, or `undefined` when the Context has the wrong scope.
   */
  identity(ctx: Context): Wire | undefined
}

export interface TypertRegistryChange {
  readonly kind: 'local' | 'remote' | 'lookup' | 'host-context' | 'client-context'
  readonly key: string
}

export type TypertRegistryListener = (change: TypertRegistryChange) => void

export interface TypertLocalRegistry {
  /**
   * Look up one invocation by `<namespace>/<method>`.
   * @param endpoint - canonical endpoint.
   * @returns the live descriptor, or `undefined` when absent.
   */
  get(endpoint: string): InvocationDescriptor | undefined
  /**
   * Report whether a strict definition has existed during this Typert Service lifetime.
   * @param endpoint - canonical endpoint.
   * @returns `true` after the endpoint has been registered at least once, even if withdrawn.
   */
  hasSeen(endpoint: string): boolean
  /** @returns a registration-order snapshot of local descriptors. */
  list(): readonly InvocationDescriptor[]
  /**
   * Observe later local-definition changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

export interface TypertRemoteRegistry {
  /**
   * Register one generated contribution for the calling Cordis fiber.
   * @param contribution - generated Remote descriptors.
   * @returns disposer withdrawing the exact contribution.
   */
  register(contribution: TypertRemoteContribution): TypertDisposer
  /**
   * Look up one Remote descriptor by endpoint.
   * @param endpoint - canonical endpoint.
   * @returns the descriptor, or `undefined` when unmounted.
   */
  get(endpoint: string): InvocationDescriptor | undefined
  /** @returns a registration-order snapshot of Remote descriptors. */
  list(): readonly InvocationDescriptor[]
  /**
   * Observe later Remote contribution changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

export interface TypertLookupRegistry {
  /**
   * Register one provider under its merge-declared key.
   * @param key - lookup key.
   * @param provider - owning package's live resolver.
   * @returns disposer withdrawing the exact provider.
   */
  register<K extends StringKeyOf<TypertLookupMap>>(
    key: K,
    provider: TypertLookupProvider<
      TypertLookupHost<TypertLookupMap[K]>,
      TypertLookupWire<TypertLookupMap[K]>
    >,
  ): TypertDisposer
  /**
   * Replace one provider's default resolution policy while this contribution is active.
   * Configuration may precede provider registration; without a live provider, `get()` remains unavailable.
   * @param key - lookup key whose wire declaration remains provider-owned.
   * @param resolver - composition-owned resolver used by every lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configure<K extends StringKeyOf<TypertLookupMap>>(
    key: K,
    resolver: TypertLookupResolver<
      TypertLookupHost<TypertLookupMap[K]>,
      TypertLookupWire<TypertLookupMap[K]>
    >,
  ): TypertDisposer
  /**
   * Look up one provider by runtime key.
   * @param key - descriptor lookup key.
   * @returns the live provider, or `undefined` when absent.
   */
  get(key: string): TypertLookupProvider | undefined
  /** @returns lookup declarations observed during this Typert Service lifetime. */
  definitions(): readonly TypertLookupDefinition[]
  /** @returns a snapshot of registered provider keys. */
  keys(): readonly string[]
  /**
   * Observe later lookup changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

export interface TypertContextRegistry {
  /**
   * Register a Host Context resolver.
   * @param key - merge-declared Context key.
   * @param provider - owning package's Host resolver.
   * @returns disposer withdrawing the exact provider.
   */
  registerHost<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    provider: TypertHostContextProvider<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * Override one Host Context key's identity policy for the calling fiber.
   * Configuration may precede provider registration and restores the provider's default resolver on disposal.
   * @param key - merge-declared Context key.
   * @param resolver - composition-owned resolver used by every Host Context lookup of this key.
   * @returns disposer restoring the provider's default resolver.
   */
  configureHost<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * Register a Client Context identity binder.
   * @param key - merge-declared Context key.
   * @param binder - Client scope identity resolver.
   * @returns disposer withdrawing the exact binder.
   */
  registerClient<K extends StringKeyOf<TypertContextMap>>(
    key: K,
    binder: TypertClientContextBinder<TypertContextWire<TypertContextMap[K]>>,
  ): TypertDisposer
  /**
   * Look up a Host Context resolver.
   * @param key - descriptor Context key.
   * @returns the provider, or `undefined` when absent.
   */
  getHost(key: string): TypertHostContextProvider | undefined
  /**
   * Look up a Client Context binder.
   * @param key - descriptor Context key.
   * @returns the binder, or `undefined` when absent.
   */
  getClient(key: string): TypertClientContextBinder | undefined
  /**
   * Observe later Context provider changes.
   * @param listener - synchronous contained observer.
   * @returns disposer for this subscription.
   */
  subscribe(listener: TypertRegistryListener): TypertDisposer
}

export interface TypertRegistryContract {
  readonly local: TypertLocalRegistry
  readonly remotes: TypertRemoteRegistry
  readonly lookups: TypertLookupRegistry
  readonly contexts: TypertContextRegistry
}

declare module '@ejunz/cordis' {
  interface Context {
    typert: TypertRegistryContract
  }
}

const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

export function isTypertRemoteSegment(value: string): boolean {
  return value !== '.' && value !== '..' && TYPERT_REMOTE_SEGMENT_PATTERN.test(value)
}

export class TypertLookupFailure<Failure = unknown> extends Error {
  /** Adapter-owned failure returned to the caller. */
  readonly failure: Failure

  /**
   * Wrap one adapter failure without exposing the rejected identity.
   * @param failure - typed failure owned by the active boundary adapter.
   */
  constructor(failure: Failure) {
    super('Typert lookup policy rejected the requested identity')
    this.name = 'TypertLookupFailure'
    this.failure = failure
  }
}

export interface TypertGatewayBindingOptions {
  /** Wire namespace; defaults to the Cordis service key. */
  readonly namespace?: string
}

export interface TypertGatewayBinding<Service extends object = object> {
  readonly service: Service
  readonly serviceKey: string
  readonly namespace: string
}

export type RemoteInvocationMarker =
  | { readonly kind: 'direct' }
  | { readonly kind: 'context'; readonly context: string }

export interface RemoteMethodMarker {
  /** Public instance method carrying the implementation. */
  readonly method: string
  /** Endpoint method when it differs from the implementation member. */
  readonly exportName?: string
  readonly invocation: RemoteInvocationMarker
}

type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
) => void

interface RemoteInitializerContext<This extends object> {
  readonly private: boolean
  readonly static: boolean
  readonly name: string | symbol
  addInitializer(initializer: (this: This) => void): void
}

interface StoredRemoteMethodMarker {
  readonly exportName?: string
  readonly invocation: RemoteInvocationMarker
}

const markers = new WeakMap<object, Map<string, StoredRemoteMethodMarker>>()

export function bindTypertRemote<Service extends object>(
  service: Service,
  serviceKey: string,
  options: TypertGatewayBindingOptions = {},
): TypertGatewayBinding<Service> {
  validateName('service key', serviceKey)
  const namespace = options.namespace ?? serviceKey
  validateName('namespace', namespace)
  return Object.freeze({ service, serviceKey, namespace })
}

export abstract class TypertRemoteService<out T = never> extends Service<T> {
  /** Visible binding consumed by the Gateway's source-mode discovery. */
  readonly typertRemote: TypertGatewayBinding<this>

  /**
   * Register the Service and bind the same key to Typert Gateway.
   * @param ctx - owning Cordis Context.
   * @param serviceKey - exact Cordis service key and default wire namespace.
   * @param options - optional distinct wire namespace.
   */
  protected constructor(ctx: Context, serviceKey: string, options: TypertGatewayBindingOptions = {}) {
    super(ctx, serviceKey)
    this.typertRemote = bindTypertRemote(this, this.name, options)
  }
}

export function Remote<This extends object, Args extends unknown[], Result>(
  _method: (this: This, ...args: Args) => Result,
  context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void

export function Remote(exportName: string): RemoteMethodDecorator

export function Remote<This extends object, Args extends unknown[], Result>(
  methodOrExportName: string | ((this: This, ...args: Args) => Result),
  context?: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
): void | RemoteMethodDecorator {
  if (typeof methodOrExportName === 'string') {
    validateName('Remote export name', methodOrExportName)
    return function (
      methodOrTarget: unknown,
      decoratorContext: unknown,
    ): void {
      applyRemoteMarker(methodOrTarget, decoratorContext, { kind: 'direct' }, methodOrExportName)
    }
  }
  applyRemoteMarker(methodOrExportName, context, { kind: 'direct' })
}

export function RemoteScope(
  key: Extract<keyof TypertContextMap, string>,
  exportName?: string,
): RemoteMethodDecorator {
  validateName('Scope key', key)
  if (exportName !== undefined) validateName('Remote export name', exportName)
  return function (
    methodOrTarget: unknown,
    context: unknown,
  ): void {
    applyRemoteMarker(methodOrTarget, context, { kind: 'context', context: key }, exportName)
  }
}

export function remoteMethods(service: object): readonly RemoteMethodMarker[] {
  const prototype = Object.getPrototypeOf(service) as object | null
  if (prototype === null) return []
  return [...(markers.get(prototype) ?? [])].map(([method, marker]) => ({ method, ...marker }))
}

/**
 * Accept both TC39 method-decorator context and TypeScript
 * `experimentalDecorators` legacy calls (`target, propertyKey, descriptor`).
 */
function applyRemoteMarker(
  methodOrTarget: unknown,
  contextOrKey: unknown,
  invocation: RemoteInvocationMarker,
  exportName?: string,
): void {
  if (
    contextOrKey !== null
    && typeof contextOrKey === 'object'
    && 'addInitializer' in contextOrKey
  ) {
    addMarkerInitializer(contextOrKey as RemoteInitializerContext<object>, invocation, exportName)
    return
  }
  // Legacy emit: Reflect.decorate / __decorate pass (prototype, name, descriptor).
  if (typeof contextOrKey === 'string') {
    if (methodOrTarget === null || (typeof methodOrTarget !== 'object' && typeof methodOrTarget !== 'function')) {
      throw new TypeError('typert-protocol: Remote legacy decorator target is missing')
    }
    mark(methodOrTarget as object, contextOrKey, invocation, exportName)
    return
  }
  throw new TypeError('typert-protocol: Remote decorator context is missing')
}

function addMarkerInitializer<This extends object>(
  context: RemoteInitializerContext<This>,
  invocation: RemoteInvocationMarker,
  exportName?: string,
): void {
  if (context.private || context.static || typeof context.name !== 'string') {
    throw new TypeError('typert-protocol: Remote decorators require a public instance method with a string name')
  }
  const method = context.name
  context.addInitializer(function (this: This) {
    const prototype = Object.getPrototypeOf(this) as object | null
    if (prototype === null) {
      throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`)
    }
    mark(prototype, method, invocation, exportName)
  })
}

function mark(
  prototype: object,
  method: string,
  invocation: RemoteInvocationMarker,
  exportName?: string,
): void {
  let table = markers.get(prototype)
  if (table === undefined) {
    table = new Map()
    markers.set(prototype, table)
  }
  const marker: StoredRemoteMethodMarker = {
    ...(exportName === undefined || exportName === method ? {} : { exportName }),
    invocation: Object.freeze(invocation),
  }
  const current = table.get(method)
  if (current !== undefined) {
    if (current.exportName === marker.exportName && sameInvocation(current.invocation, invocation)) return
    throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`)
  }
  table.set(method, Object.freeze(marker))
}

function sameInvocation(left: RemoteInvocationMarker, right: RemoteInvocationMarker): boolean {
  return left.kind === right.kind
    && (left.kind === 'direct' || (right.kind === 'context' && left.context === right.context))
}

function validateName(subject: string, value: string): void {
  if (!isTypertRemoteSegment(value)) {
    throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`)
  }
}

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/typert-protocol'
  export const name = 'typert-protocol-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
