import type { Context } from '@ejunz/cordis'

export interface ScopeLayer {
  /** Whether every table in this layer is empty. */
  isEmpty(): boolean
}

interface EntryValues<V> {
  values(): IterableIterator<V>
  isEmpty(): boolean
}

export class NamedEntries<V> implements EntryValues<V> {
  private data = new Map<string, V>()

  constructor(
    private readonly duplicateError: (name: string) => Error,
  ) {}

  /**
   * Insert one unique name.
   * @param name - name unique within this table.
   * @param value - borrowed value to retain.
   * @returns an idempotent undo that removes only this insertion.
   */
  insert(name: string, value: V): () => void {
    const data = this.data
    if (data.has(name)) throw this.duplicateError(name)
    data.set(name, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(name)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * Read one named value.
   * @param name - name to resolve.
   * @returns the retained value, or `undefined` when absent.
   */
  get(name: string): V | undefined {
    return this.data.get(name)
  }

  /**
   * Test one name for membership.
   * @param name - name to test.
   * @returns whether the table contains that name.
   */
  has(name: string): boolean {
    return this.data.has(name)
  }

  /**
   * Iterate live names in insertion order.
   * @returns the native live key iterator.
   */
  keys(): IterableIterator<string> {
    return this.data.keys()
  }

  /**
   * Iterate live entries in insertion order.
   * @returns the native live entry iterator.
   */
  entries(): IterableIterator<[string, V]> {
    return this.data.entries()
  }

  /**
   * Iterate live values in insertion order.
   * @returns the native live value iterator.
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * Test whether this table has no entries.
   * @returns whether the table is empty.
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

export class AnonymousEntries<V> implements EntryValues<V> {
  private data = new Map<symbol, V>()

  /**
   * Append one independently owned value.
   * @param value - borrowed value to retain.
   * @returns an idempotent undo for this exact append.
   */
  append(value: V): () => void {
    const data = this.data
    const key = Symbol()
    data.set(key, value)
    let active = true
    return () => {
      if (!active) return
      active = false
      data.delete(key)
      if (data.size === 0 && this.data === data) this.data = new Map()
    }
  }

  /**
   * Iterate live values in insertion order.
   * @returns the native live value iterator.
   */
  values(): IterableIterator<V> {
    return this.data.values()
  }

  /**
   * Test whether this table has no entries.
   * @returns whether the table is empty.
   */
  isEmpty(): boolean {
    return this.data.size === 0
  }
}

export class ScopedLayers<L extends ScopeLayer> {
  /** The eagerly constructed context-global layer. */
  readonly global: L

  private readonly scoped = new Map<ScopeKey, L>()

  constructor(
    private readonly createLayer: (scope: ScopeKey | undefined) => L,
    private readonly onChange: () => void,
  ) {
    this.global = createLayer(undefined)
  }

  /**
   * Read an existing exact-scope overlay. Deliberately chain-blind: callers
   * addressing one scope's OWN contributions (its restrictions, its guards)
   * must not silently pick up an ancestor's — use {@link chainLayers} where
   * inheritance is the point.
   * @param scope - exact scope key; `undefined` denotes no overlay.
   * @returns the existing scoped layer, or `undefined` without creating one.
   */
  peek(scope: ScopeKey | undefined): L | undefined {
    if (scope === undefined) return undefined
    return this.scoped.get(scope)
  }

  /**
   * Existing overlays along the scope's parent chain ({@link scopeChainOf}),
   * farthest ancestor first and the exact scope last, so a caller layering
   * them in order gives the nearest scope the final word.
   * @param scope - viewing scope, or `undefined` for no overlays.
   * @returns the existing layers, nearest last; absent overlays are skipped.
   */
  chainLayers(scope: ScopeKey | undefined): L[] {
    const layers: L[] = []
    for (const key of scopeChainOf(scope).reverse()) {
      const layer = this.scoped.get(key)
      if (layer !== undefined) layers.push(layer)
    }
    return layers
  }

  /**
   * Materialize global named entries followed by scope-chain shadows,
   * farthest ancestor first, so the nearest scope's entry wins a name.
   * @param scope - viewing scope, or `undefined` for the global view.
   * @param pick - select the named table from a layer.
   * @returns an insertion-ordered effective map.
   */
  merge<V>(
    scope: ScopeKey | undefined,
    pick: (layer: L) => NamedEntries<V>,
  ): Map<string, V> {
    const merged = new Map(pick(this.global).entries())
    for (const layer of this.chainLayers(scope)) {
      for (const [name, value] of pick(layer).entries()) merged.set(name, value)
    }
    return merged
  }

  /**
   * Attach one synchronous layer mutation to its registration context.
   * @param ctx - context that determines both scope visibility and effect ownership.
   * @param action - atomic mutation returning its synchronous undo.
   * @param options - Cordis effect label and optional change notification.
   * @returns the exact disposer returned by `ctx.effect()`.
   */
  effect(
    ctx: Context,
    action: (layer: L) => () => void,
    options: { label: string; notify?: boolean },
  ): () => void {
    const scope = scopeOf(ctx)
    const notify = options.notify ?? true
    const dispose = ctx.effect(function* (this: ScopedLayers<L>) {
      let layer: L
      let created = false
      if (scope === undefined) {
        layer = this.global
      } else {
        const existing = this.scoped.get(scope)
        if (existing === undefined) {
          layer = this.createLayer(scope)
          this.scoped.set(scope, layer)
          created = true
        } else {
          layer = existing
        }
      }

      let undo: () => void
      try {
        undo = action(layer)
      } catch (error) {
        if (scope !== undefined && created && layer.isEmpty()) this.scoped.delete(scope)
        throw error
      }

      yield () => {
        undo()
        if (scope !== undefined && layer.isEmpty()) this.scoped.delete(scope)
        if (notify) this.onChange()
      }
      if (notify) this.onChange()
    }.bind(this), options.label)
    // oxlint-disable-next-line typescript/no-misused-promises -- exact synchronous disposer preserves Cordis effect identity
    return dispose
  }
}

import type { Context, Fiber } from '@ejunz/cordis'

import { Context as CordisContext } from '@ejunz/cordis'

export type ScopeKey = object

const kScope = Symbol('ea.scope')

declare const ScopedBrand: unique symbol

export type Scoped<T extends object> = object & { readonly [ScopedBrand]: T }

const carrierKeys = new WeakMap<object, ScopeKey | undefined>()

const scopeParents = new WeakMap<ScopeKey, ScopeKey>()

export interface ScopeParentBinding {
  /**
   * Re-link the bound key to a different parent, with the same cycle check as
   * the bind. Valid only while nothing produced under the old parent is
   * retained — the blank-session recompose contract, which the holder upholds
   * because this relation cannot see what a session logged.
   * @param parent - the new enclosing scope key.
   */
  rebind(parent: ScopeKey): void
}

function linkScopeParent(key: ScopeKey, parent: ScopeKey): void {
  for (let cursor: ScopeKey | undefined = parent; cursor !== undefined; cursor = scopeParents.get(cursor)) {
    if (cursor === key) throw new Error('ea-scope: scope parent link would form a cycle')
  }
  scopeParents.set(key, parent)
}

export function bindScopeParent(key: ScopeKey, parent: ScopeKey): ScopeParentBinding {
  if (scopeParents.has(key)) {
    throw new Error('ea-scope: scope key is already bound to a parent; re-linking requires the binding returned by the original bind')
  }
  linkScopeParent(key, parent)
  return {
    rebind(next: ScopeKey): void {
      linkScopeParent(key, next)
    },
  }
}

export function scopeParentOf(key: ScopeKey): ScopeKey | undefined {
  return scopeParents.get(key)
}

export function scopeChainOf(key: ScopeKey | undefined): ScopeKey[] {
  const chain: ScopeKey[] = []
  for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) chain.push(cursor)
  return chain
}

export interface Scope {
  /** Context through which scope-owned registrations are made. */
  ctx: Context
  /** Exact Cordis disposer, used when nesting this scope in an ordered composite effect. */
  rawDispose: () => Promise<void> | void
  /** Dispose every scope-owned registration; racing calls await the same completion. */
  dispose(): Promise<void>
}

async function quiesceFiber(fiber: Fiber): Promise<void> {
  await Promise.resolve(fiber.dispose())
  while (fiber.inertia !== undefined) await fiber.inertia
}

function scope(): void {}

export interface CreateScopeOptions {
  /** Enclosing scope bound via {@link bindScopeParent} before the scope is usable; the binding stays internal. */
  parent?: ScopeKey
}

export function createScope(ctx: Context, key: ScopeKey, options?: CreateScopeOptions): Scope {
  if (options?.parent !== undefined) bindScopeParent(key, options.parent)
  const fiber = ctx.plugin(scope)
  const scoped: Context = fiber.ctx.extend({ [kScope]: key })
  let disposing: Promise<void> | undefined
  return {
    ctx: scoped,
    rawDispose: fiber.dispose,
    dispose: () => (disposing ??= quiesceFiber(fiber)),
  }
}

export function scopeOf(ctx: Context): ScopeKey | undefined {
  return (ctx as Context & { [kScope]?: ScopeKey })[kScope]
}

export function scopeTarget<T extends object>(base: T, key: ScopeKey | undefined): Scoped<T> {
  const baseFilter = (base as { [CordisContext.filter]?: (ctx: Context) => boolean })[CordisContext.filter]
  const carrier = {
    [CordisContext.filter](ctx: Context): boolean {
      if (baseFilter !== undefined && !baseFilter.call(base, ctx)) return false
      const tag = scopeOf(ctx)
      if (tag === undefined) return true
      for (let cursor = key; cursor !== undefined; cursor = scopeParents.get(cursor)) {
        if (cursor === tag) return true
      }
      return false
    },
  }
  carrierKeys.set(carrier, key)
  return carrier as unknown as Scoped<T>
}

export function isScopeCarrier(value: unknown): value is Scoped<object> {
  return typeof value === 'object' && value !== null && carrierKeys.has(value)
}

export function carrierKeyOf(value: unknown): ScopeKey | undefined {
  if (!isScopeCarrier(value)) return undefined
  return carrierKeys.get(value)
}

// @ea-scoped-events-generated-begin
type ScopedSubjectResolver = (args: readonly unknown[]) => unknown

const scopedSubjectResolvers: Readonly<Record<string, ScopedSubjectResolver | null>> = Object.freeze({
  'agent/created': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/disposed': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/error': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/inbox/claimed': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/inbox/discarded': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/inbox/inserted': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/pre-step': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/request': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/request-error': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/session-start': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/status': args => (args[0] as Record<string, unknown>)['agent'],
  'agent/turn-stopping': args => (args[0] as Record<string, unknown>)['agent'],
  'approval/request': args => (args[0] as Record<string, unknown>)['agent'],
  'goal/changed': args => (args[0] as Record<string, unknown>)['agent'],
  'session/created': null,
  'session/disposed': null,
  'session/event': null,
  'session/flush': null,
  'subagent/end': null,
  'subagent/start': null,
  'system-prompt/assemble': args => (args[1] as Record<string, unknown>)['scope'],
  'tools/execute': args => (args[0] as Record<string, unknown>)['agent'],
  'tools/post-execute': args => (args[0] as Record<string, unknown>)['agent'],
  'tools/pre-execute': args => (args[0] as Record<string, unknown>)['agent'],
  'tools/result': args => (args[0] as Record<string, unknown>)['agent'],
})

export function scopedSubjectResolverFor(event: string): ScopedSubjectResolver | null | undefined {
  return scopedSubjectResolvers[event]
}
// @ea-scoped-events-generated-end

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/scope'
  export const name = 'scope-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
