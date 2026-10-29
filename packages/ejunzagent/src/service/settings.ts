import type z from '@ejunz/schemastery'

interface SchemaNode {
  type?: string
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema. */
  inner?: SchemaNode
}

export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (key in properties) continue
          rebuilt[key] = entry
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source?.[key], [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets))
    }
    default:
      // TODO(settings-wire-redaction): Fail closed instead — a secret reachable
      // only through a union, intersection, or transform is returned verbatim
      // here, with nothing recording that it was missed.
      return value
  }
}

export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  return { value: stripped, secrets }
}

import type { Branded } from '@ejunz/ea-core/brand'

export type SettingsNamespace = Branded<'SettingsNamespace'>

export type SettingsUpdateSource = 'update' | 'provider'

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * Committed change to one registered namespace's resolved value. Emitted
     * after the provider persisted (for `update`) or published (`provider`)
     * the change; never emitted when the resolved value is deep-equal.
     * Listener failures are contained and logged — a sync throw and an async
     * rejection alike — except `INVARIANT`-coded failures, which rethrow
     * after every listener ran; that rethrow reaches the emitter only from
     * synchronous listeners, so invariant checks on this event must not be
     * async functions.
     * @param ns - the namespace whose resolved value changed.
     * @param next - the new resolved value.
     * @param prev - the previous resolved value.
     * @param source - whether the change entered through `update()` or the provider.
     * @mode emit
     */
    'settings/updated'(ns: SettingsNamespace, next: unknown, prev: unknown, source: SettingsUpdateSource): void

    /**
     * One registered namespace's RAW user section changed, whether or not the
     * resolved value did. `settings/updated` is the consumer-facing event and
     * stays deep-equal-gated; this one exists for configuration surfaces,
     * which must learn that a field went from inherited to overridden (same
     * resolved value, different meaning) and that their held revision is
     * stale. Listener containment matches `settings/updated`.
     * @param ns - the namespace whose stored section changed.
     * @param revision - the namespace's new revision.
     * @mode emit
     */
    'settings/document-updated'(ns: SettingsNamespace, revision: number): void
  }
}

import { Context, Service } from '@ejunz/cordis'

import type z from '@ejunz/schemastery'

const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/

export function settingsNamespace(value: string): SettingsNamespace {
  if (!NAMESPACE_PATTERN.test(value)) {
    throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`)
  }
  return value as SettingsNamespace
}

export type SettingsApplies = 'live' | 'restart'

export interface SettingsRegisterOptions<T> {
  /** Composition-layer values resolved below the user layer (entry-config subset). */
  base?: Partial<T>
  /** Owner's effect timing, surfaced to configuration UIs; defaults to `live`. */
  applies?: SettingsApplies
  /**
   * Reject a resolved section the owner could not act on, for constraints its
   * schema cannot express — a cross-field requirement, or one field's validity
   * depending on another's. Throwing here refuses the *write* that produced the
   * value, so a caller learns at `update`/`replace`/`mutate` instead of storing
   * something that would silently disable the owner.
   *
   * Kept separate from the schema because the schema is also what a
   * configuration surface renders and what an absent section resolves through;
   * folding a cross-field check into it would change both.
   *
   * Once the owner is registered, a stored section that fails this keeps the
   * namespace's last good value and warns, exactly as a schema failure does,
   * so an externally edited document cannot strand a running owner. At
   * registration there is no last good value yet, so a stored section that
   * already fails rejects the registration itself — again exactly as a schema
   * failure does.
   * @param value - the resolved section, schema-valid by construction.
   */
  validate?: (value: T) => void
}

export interface SettingsDescriptor {
  // TODO(settings-namespace-vocabulary): Rename `ns` to `namespace` across the
  // public API, provider contract, implementations, tests, and consumers.
  /** The registered namespace. */
  ns: SettingsNamespace
  /** Serialized schemastery schema (`schema.toJSON()`). */
  schema: unknown
  /** Current resolved value. */
  value: unknown
  /**
   * Monotonic revision of the raw user section this descriptor was read at.
   * Send it back as `expectedRevision` on a write to refuse a stale one.
   */
  revision: number
  /** Registrant's composition `base` layer (detached), when one was declared. */
  base?: unknown
  /**
   * Raw user section from the stored document (detached), when one exists and
   * is well-formed; a field's presence here is what marks it user-overridden.
   */
  user?: unknown
  /** Owner's declared effect timing. */
  applies: SettingsApplies
  /** Schema-declared secret positions; present only under `redactSecrets`. */
  secrets?: RedactedSecret[]
}

export interface SettingsDescribeOptions {
  /**
   * Strip `role('secret')` fields from `value`/`base`/`user` and enumerate
   * them in each descriptor's `secrets`. Every wire surface MUST pass this;
   * the verbatim default exists for same-process configuration UIs only.
   */
  redactSecrets?: boolean
}

export interface SettingsScope<T> {
  /** Current resolved value: schema defaults, then `base`, then the user layer. */
  get(): T
  /**
   * Observe committed changes to this namespace's resolved value. Invocations
   * of one callback run asynchronously, one at a time, in commit order; a
   * rejection is contained and logged like a sync throw. After the disposer
   * returns, no further invocation starts — one already queued is skipped;
   * one already started still settles, and service disposal waits for it.
   * @param callback - invoked after each commit with the next and previous values.
   * @returns the disposer removing this observer.
   */
  watch(callback: (next: T, prev: T) => void | Promise<void>): () => void
  /**
   * Merge a partial patch into this namespace's user layer and persist it.
   * @param patch - plain-object patch over the user section; JSON-compatible data
   * only (non-JSON values reject with their path before anything persists).
   */
  update(patch: object): Promise<void>
  /**
   * Replace this namespace's user section wholesale; absent keys re-inherit
   * the composition `base` and schema defaults (`replace({})` resets all).
   * @param section - the complete next user section; JSON-compatible data only,
   * as for {@link update}.
   */
  replace(section: object): Promise<void>
}

declare module '@ejunz/cordis' {
  interface Context {
    settings: SettingsProvider
  }
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every(key => key in right && deepEqualJson(left[key], right[key]))
}

export class SettingsConflictError extends Error {
  /** Stable machine code for wire layers mapping this to their own taxonomy. */
  readonly code = 'SETTINGS_CONFLICT'
  /** The revision the write expected. */
  readonly expected: number
  /** The revision the namespace actually stands at. */
  readonly actual: number

  /**
   * @param ns - the namespace whose write was refused.
   * @param expected - the revision the caller sent.
   * @param actual - the revision now stored.
   */
  constructor(ns: SettingsNamespace, expected: number, actual: number) {
    super(`settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'SettingsConflictError'
    this.expected = expected
    this.actual = actual
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

function applyPathOp(section: Record<string, unknown>, op: SettingsPathOp): Record<string, unknown> {
  const [head, ...rest] = op.path
  // The empty path addresses the section itself.
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) {
      throw new TypeError('settings mutate: setting the section root requires a plain object')
    }
    return { ...op.value }
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: op.value }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    // Unsetting through an absent path is already satisfied; setting through
    // one creates the intermediate objects it needs.
    if (op.op === 'unset') return section
    return { ...section, [head]: applyPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applyPathOp(child, { ...op, path: rest }) }
}

function describeRejected(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
    const name = proto?.constructor?.name
    return name === undefined || name === 'Object' ? 'a non-plain object' : `a ${name}`
  }
  return `a ${typeof value}`
}

function cloneJsonShaped(
  root: Record<string, unknown>,
  reject: (label: string, path: string) => TypeError,
): Record<string, unknown> {
  const visiting = new WeakSet<object>()
  const clone = (value: unknown, path: string): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw reject('a non-finite number', path)
      return value
    }
    if (Array.isArray(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      const entries = value.map((entry, index) => clone(entry, `${path}[${index}]`))
      // Un-mark on exit so one object referenced twice without a cycle passes.
      visiting.delete(value)
      return entries
    }
    if (isPlainObject(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      // TODO(settings-json-properties): Use property-safe construction here and
      // in mergeLayers so valid JSON keys such as "__proto__" remain own data.
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue
        out[key] = clone(entry, `${path}.${key}`)
      }
      visiting.delete(value)
      return out
    }
    throw reject(describeRejected(value), path)
  }
  return clone(root, '$') as Record<string, unknown>
}

function mergeLayers(under: unknown, over: unknown): unknown {
  if (over === undefined) return under
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value
  }
  return merged
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

interface SettingsWatcher {
  callback: (next: never, prev: never) => void | Promise<void>
  /** Settled tail: invocations of this callback run one at a time, in commit order. */
  tail: Promise<void>
  /** Cleared by the disposer: a queued invocation checks this before starting. */
  active: boolean
}

interface SettingsRegistration {
  ns: SettingsNamespace
  schema: z<unknown>
  base: unknown
  applies: SettingsApplies
  /** Owner-supplied check for constraints the schema cannot express. */
  validate?: (value: unknown) => void
  resolved: unknown
  /**
   * Monotonic counter over this namespace's RAW user section — bumped by any
   * change to what is stored, including one whose resolved value is
   * unchanged (adding an override equal to the composition base). Editors
   * carry it as `expectedRevision` to detect a concurrent write, and the
   * document event carries it so another tab learns a field went from
   * inherited to overridden.
   */
  revision: number
  watchers: Set<SettingsWatcher>
}

export abstract class SettingsProvider extends Service {
  private readonly registrations = new Map<SettingsNamespace, SettingsRegistration>()
  /** Latest published raw document; empty until the provider's first publish. */
  private document: Record<string, unknown> = {}
  /** Per-namespace write chains; settled tails, so a failure never poisons the queue. */
  private readonly writeQueues = new Map<SettingsNamespace, Promise<unknown>>()
  /** In-flight watcher invocation segments, drained by the dispose teardown. */
  private readonly pendingTails = new Set<Promise<void>>()
  /** Set at service dispose: refuse new writes while queued ones drain. */
  private stopped = false

  /** Opaque read of {@link stopped}: control flow cannot narrow it across awaits. */
  private isStopped(): boolean {
    return this.stopped
  }

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /**
   * Load the provider's document once and publish it before the service
   * becomes injectable, and register the write-drain teardown. Providers with
   * their own init (watchers, connections) delegate here first via
   * `yield* super[Service.init]()`; their disposers then run before the drain.
   */
  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // Teardown: refuse new writes and new watcher starts, then wait until
      // every queued write chain and every started watcher invocation settles
      // so disposal completes only once storage and observers are quiescent.
      // Invocations queued but not yet started skip via the stopped check.
      this.stopped = true
      await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails])
    }
    this.publish(await this.load())
  }

  /** Whether {@link update} may persist through this provider. */
  abstract readonly writable: boolean

  /**
   * Absolute path of the provider's user-editable document, when its storage
   * is one local file. Configuration surfaces use this only as availability
   * metadata; the guarded open operation resolves the path again Host-side.
   * Non-file providers leave it undefined and expose no open-document affordance.
   * @returns the absolute local document path, or undefined for non-file storage.
   */
  get documentPath(): string | undefined {
    return undefined
  }

  /**
   * Prepare the provider's user-editable document for a native editor. File
   * providers may materialize an absent document before returning its path;
   * non-file providers return undefined.
   * @returns the absolute local document path, or undefined for non-file storage.
   */
  prepareDocument(): Promise<string | undefined> {
    return Promise.resolve(this.documentPath)
  }

  /**
   * Read the provider's current raw document (namespace to raw section).
   * @returns the detached raw document.
   */
  protected abstract load(): Promise<Record<string, unknown>>

  /**
   * Durably store one namespace's merged user section.
   * @param ns - the namespace being written.
   * @param section - the complete merged user section to store.
   */
  protected abstract persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>

  /**
   * Register a namespace schema and receive its owner scope. The registration
   * is an effect on the calling plugin's fiber: disposing that fiber removes
   * the namespace and its observers. An invalid stored section fails the
   * registration itself — the earliest point where the schema can judge it.
   * @param ns - unique namespace; duplicate registration fails loud.
   * @param schema - schemastery schema resolving this namespace's value.
   * @param options - composition `base` layer and effect timing.
   * @returns the owner scope for reads, observation, and updates.
   */
  register<T>(ns: SettingsNamespace, schema: z<T>, options?: SettingsRegisterOptions<T>): SettingsScope<T> {
    if (this.registrations.has(ns)) {
      throw new Error(`settings namespace "${ns}" is already registered`)
    }
    const registration: SettingsRegistration = {
      ns,
      schema: schema as z<unknown>,
      base: options?.base,
      applies: options?.applies ?? 'live',
      ...options?.validate === undefined
        ? {}
        : { validate: options.validate as (value: unknown) => void },
      resolved: deepFreeze(this.resolve(schema, options?.base, this.section(ns), options?.validate)),
      revision: 0,
      watchers: new Set(),
    }
    this.ctx.effect(() => {
      this.registrations.set(ns, registration)
      // TODO(settings-registration-quiescence): Deactivate every watcher and await
      // its tail on disposal so callbacks cannot outlive the registrant fiber.
      return () => this.registrations.delete(ns)
    }, `settings.register(${JSON.stringify(String(ns))})`)
    return {
      get: () => registration.resolved as T,
      watch: (callback) => {
        const watcher: SettingsWatcher = { callback: callback, tail: Promise.resolve(), active: true }
        registration.watchers.add(watcher)
        return () => {
          watcher.active = false
          registration.watchers.delete(watcher)
        }
      },
      update: patch => this.update(ns, patch),
      replace: section => this.replace(ns, section),
    }
  }

  /**
   * Describe every registered namespace for configuration surfaces, including
   * the composition `base` and raw user layers so a form can mark which fields
   * the user overrode (presence in `user`) and what a reset returns to.
   * @param options - redaction switch; wire surfaces must redact.
   * @returns one descriptor per registered namespace, in registration order.
   */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    return [...this.registrations.values()].map((registration) => {
      let user: Record<string, unknown> | undefined
      try {
        user = this.section(registration.ns)
      } catch {
        // A malformed stored section already warned at publish and kept the
        // last good resolved value; only that malformed shape can throw here,
        // and describing it as "no user layer" keeps this read total.
        user = undefined
      }
      const base = registration.base === undefined ? undefined : structuredClone(registration.base)
      const detachedUser = user === undefined ? undefined : structuredClone(user)
      const descriptor: SettingsDescriptor = {
        ns: registration.ns,
        schema: registration.schema.toJSON(),
        value: registration.resolved,
        revision: registration.revision,
        ...base === undefined ? {} : { base },
        ...detachedUser === undefined ? {} : { user: detachedUser },
        applies: registration.applies,
      }
      if (options?.redactSecrets !== true) return descriptor
      const schema = registration.schema as z<never>
      const redacted = redactSecrets(schema, registration.resolved)
      return {
        ...descriptor,
        value: redacted.value,
        ...base === undefined ? {} : { base: redactSecrets(schema, base).value },
        ...detachedUser === undefined ? {} : { user: redactSecrets(schema, detachedUser).value },
        secrets: redacted.secrets,
      }
    })
  }

  /**
   * Describe registered settings against a supplied document without mutating service state.
   * @param document - settings document values by namespace.
   * @param options - optional secret-redaction policy.
   * @returns one resolved descriptor per registration.
   */
  describeDocument(document: Record<string, unknown>, options?: SettingsDescribeOptions): SettingsDescriptor[] {
    return [...this.registrations.values()].map((registration) => {
      const raw = document[String(registration.ns)]
      const user = raw === undefined ? undefined : raw as Record<string, unknown>
      const base = registration.base === undefined ? undefined : structuredClone(registration.base)
      const resolved = this.resolve(registration.schema, registration.base, user, registration.validate)
      const descriptor: SettingsDescriptor = {
        ns: registration.ns,
        schema: registration.schema.toJSON(),
        value: resolved,
        revision: 0,
        ...base === undefined ? {} : { base },
        ...user === undefined ? {} : { user: structuredClone(user) },
        applies: registration.applies,
      }
      if (options?.redactSecrets !== true) return descriptor
      const schema = registration.schema as z<never>
      const redacted = redactSecrets(schema, resolved)
      return {
        ...descriptor,
        value: redacted.value,
        ...base === undefined ? {} : { base: redactSecrets(schema, base).value },
        ...user === undefined ? {} : { user: redactSecrets(schema, user).value },
        secrets: redacted.secrets,
      }
    })
  }

  /**
   * Read one registered namespace's resolved value.
   * @param ns - the namespace to read.
   * @returns the resolved value, or `undefined` while unregistered.
   */
  get(ns: SettingsNamespace): unknown {
    return this.registrations.get(ns)?.resolved
  }

  /**
   * Merge a patch into one registered namespace's user layer, validate the
   * resolved candidate, persist through the provider, then commit and emit.
   * A validation failure rejects before anything is persisted. Writes to one
   * namespace are serialized: concurrent updates apply in call order, each
   * merging over the previous write's committed section.
   * @param ns - the registered namespace to update.
   * @param patch - plain-object patch over the user section.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   */
  async update(ns: SettingsNamespace, patch: object, expectedRevision?: number): Promise<void> {
    return this.write(ns, patch, 'merge', expectedRevision)
  }

  /**
   * Replace one registered namespace's user section wholesale, validate,
   * persist, then commit and emit. Keys absent from `section` fall back to the
   * composition `base` and schema defaults — this is the removal/reset path a
   * merge-only patch cannot express (`replace({})` re-inherits everything).
   * @param ns - the registered namespace to replace.
   * @param section - the complete next user section.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   */
  async replace(ns: SettingsNamespace, section: object, expectedRevision?: number): Promise<void> {
    return this.write(ns, section, 'replace', expectedRevision)
  }

  /**
   * Apply path-addressed edits to one registered namespace's user section,
   * validate, persist, then commit and emit. The ops are applied to the
   * section as it stands when the write reaches the front of the queue, so a
   * caller never has to restate fields it did not touch — and, crucially,
   * cannot delete fields it never saw. This is the write path for any caller
   * holding a redacted view; `replace` remains the wholesale reset.
   * @param ns - the registered namespace to edit.
   * @param ops - ordered path edits; later ops observe earlier ones.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   */
  async mutate(ns: SettingsNamespace, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    if (!Array.isArray(ops)) throw new TypeError(`settings mutate for "${ns}" must be an array of path ops`)
    for (const op of ops) {
      if (!isPlainObject(op) || (op['op'] !== 'set' && op['op'] !== 'unset')) {
        throw new TypeError(`settings mutate for "${ns}" ops must be {op:'set'|'unset', path}`)
      }
      if (!Array.isArray(op['path']) || (op['path'] as unknown[]).some(part => typeof part !== 'string')) {
        throw new TypeError(`settings mutate for "${ns}" op paths must be arrays of strings`)
      }
    }
    return this.write(ns, ops, 'mutate', expectedRevision)
  }

  /** Validate a write, then queue it on the namespace's serialized write chain. */
  private write(
    ns: SettingsNamespace,
    input: object,
    mode: 'merge' | 'replace' | 'mutate',
    expectedRevision?: number,
  ): Promise<void> {
    const verb = mode === 'merge' ? 'update' : mode === 'replace' ? 'replace' : 'mutate'
    const registration = this.registrations.get(ns)
    if (registration === undefined) {
      throw new Error(`settings namespace "${ns}" is not registered`)
    }
    if (this.isStopped()) {
      throw new Error(`settings service is disposed: "${ns}" cannot be written`)
    }
    if (!this.writable) {
      throw new Error(`settings provider is read-only: "${ns}" cannot be updated in-process`)
    }
    // A mutate's ops array is wrapped so one JSON-shape walk covers both
    // shapes; merge/replace carry the section itself.
    let payload: Record<string, unknown>
    if (mode === 'mutate') {
      payload = { ops: input }
    } else {
      if (!isPlainObject(input)) throw new TypeError(`settings ${verb} for "${ns}" must be a plain object`)
      payload = input
    }
    // Snapshot at call time: the queue must never read a caller-owned object
    // the caller may keep mutating while the write waits its turn. The same
    // walk rejects values that JSON cannot preserve (see cloneJsonShaped).
    const snapshot = cloneJsonShaped(payload, (label, path) =>
      new TypeError(`settings ${verb} for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`))
    const previous = this.writeQueues.get(ns) ?? Promise.resolve()
    // Chain past a failed predecessor: one rejected write must not poison the
    // namespace queue for every later caller.
    const run = previous.catch(() => undefined).then(async () => {
      if (this.isStopped()) {
        throw new Error(`settings service was disposed before the queued "${ns}" ${verb} ran`)
      }
      if (this.registrations.get(ns) !== registration) {
        throw new Error(`settings namespace "${ns}" registration was disposed before the queued ${verb} ran`)
      }
      // Every mode derives from the section as it stands NOW, at the front of
      // the queue — never from whatever the caller last saw.
      const current = this.section(ns) ?? {}
      // The revision check belongs HERE, not at call time: the queue orders
      // writes but cannot tell a fresh writer from one holding a snapshot
      // that a predecessor already superseded.
      if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
        throw new SettingsConflictError(ns, expectedRevision, registration.revision)
      }
      const section = mode === 'merge'
        ? mergeLayers(current, snapshot) as Record<string, unknown>
        : mode === 'replace'
          ? snapshot
          : (snapshot['ops'] as SettingsPathOp[]).reduce(applyPathOp, current)
      const next = deepFreeze(this.resolve(registration.schema, registration.base, section, registration.validate))
      await this.persist(ns, section)
      // The write reached storage either way; the cache must say so. Commit
      // only when this registration is still the namespace owner — a fiber
      // disposed (or replaced) mid-persist must not receive the notification.
      this.document[ns] = section
      // TODO(settings-replacement-resync): Re-resolve any replacement registration
      // from this persisted section so an old in-flight write cannot leave it stale.
      if (this.registrations.get(ns) === registration && !this.isStopped()) {
        this.bumpRevision(registration, current, section)
        this.commit(registration, next, 'update')
      }
    })
    this.writeQueues.set(ns, run)
    return run
  }

  /**
   * Provider hook: commit a complete raw document observed in storage. Each
   * registered namespace re-resolves; an invalid section keeps that
   * namespace's last good value and warns, other namespaces still commit.
   * @param doc - the detached raw document (unregistered sections preserved).
   * @param source - change origin; defaults to `provider`.
   */
  protected publish(doc: Record<string, unknown>, source: SettingsUpdateSource = 'provider'): void {
    // Read every raw section BEFORE swapping the document, so the revision
    // bump below compares what was stored with what now is — an external edit
    // moves the revision exactly like an in-process write.
    const before = new Map<SettingsNamespace, unknown>()
    for (const registration of this.registrations.values()) {
      try {
        before.set(registration.ns, this.section(registration.ns))
      } catch {
        // A malformed stored section is not a readable "before"; treating it
        // as absent still bumps against any well-formed replacement.
        before.set(registration.ns, undefined)
      }
    }
    this.document = doc
    for (const registration of this.registrations.values()) {
      let next: unknown
      try {
        next = deepFreeze(this.resolve(registration.schema, registration.base, this.section(registration.ns), registration.validate))
      } catch (error) {
        this.ctx.logger.warn('settings: keeping last good "%s" after invalid stored section', registration.ns)
        this.ctx.logger.warn(error)
        continue
      }
      this.bumpRevision(registration, before.get(registration.ns), this.section(registration.ns))
      this.commit(registration, next, source)
    }
  }

  /** Read one namespace's raw user section, rejecting non-object sections. */
  private section(ns: SettingsNamespace): Record<string, unknown> | undefined {
    const section = this.document[ns]
    if (section === undefined) return undefined
    if (!isPlainObject(section)) {
      throw new TypeError(`settings section "${ns}" must be an object of keys`)
    }
    return section
  }

  /** Resolve one namespace value: schema defaults, then `base`, then the user layer. */
  private resolve<T>(
    schema: z<T>,
    base: unknown,
    section: Record<string, unknown> | undefined,
    validate?: (value: T) => void,
  ): T {
    // The merged candidate is untyped by construction; the schema call is the
    // runtime validation that admits it into T.
    const value = schema(mergeLayers(base, section) as never)
    // The owner's own check runs on the admitted value, so it sees defaults
    // and the composition base exactly as the owner will.
    validate?.(value)
    return value
  }

  /**
   * Advance a namespace's revision when its RAW section changed, and announce
   * it. Deliberately independent of {@link commit}'s resolved-value equality:
   * storing an override equal to the composition base leaves the resolved
   * value alone but changes what the document says, which is exactly what a
   * configuration surface must re-read.
   */
  private bumpRevision(registration: SettingsRegistration, before: unknown, after: unknown): void {
    if (deepEqualJson(before, after)) return
    registration.revision += 1
    this.emitDocumentUpdated(registration.ns, registration.revision)
  }

  /** Contained fan-out of `settings/document-updated`, mirroring {@link commit}'s. */
  private emitDocumentUpdated(ns: SettingsNamespace, revision: number): void {
    let invariantFailure: unknown
    const args = ['settings/document-updated', ns, revision]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(ns, revision)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(ns, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(ns, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Commit a resolved value when changed: swap, notify watchers, emit the event. */
  private commit(registration: SettingsRegistration, next: unknown, source: SettingsUpdateSource): void {
    const prev = registration.resolved
    if (deepEqualJson(next, prev)) return
    registration.resolved = next
    for (const watcher of [...registration.watchers]) {
      // Serialize per watcher: invocations of one callback run one at a time
      // in commit order, so a slow stale invocation can never apply after a
      // newer one. Sync throws and async rejections land in the same handler.
      // The activity check runs when the queued invocation would start, so a
      // disposer (or service stop) that ran while it waited prevents the
      // start entirely; started invocations drain at service dispose.
      const segment = watcher.tail
        .then(() => {
          if (!watcher.active || this.isStopped()) return
          return watcher.callback(next as never, prev as never)
        })
        .then(() => undefined, (error: unknown) => {
          this.warnWatcherFailure(registration.ns, error)
        })
      watcher.tail = segment
      this.pendingTails.add(segment)
      void segment.then(() => this.pendingTails.delete(segment))
    }
    // Fan the event out one listener at a time (the plain emit stops at the
    // first throwing listener, starving the rest). Invariant violations are
    // ejunzAgent-fatal by design and rethrow after every listener ran; any other
    // failure is contained so one broken observer cannot wedge the commit
    // path (and, through it, a provider's reload loop).
    let invariantFailure: unknown
    const args = ['settings/updated', registration.ns, next, prev, source]
    for (const listener of this.ctx.events.dispatch('emit', args) as Array<(...listenerArgs: unknown[]) => unknown>) {
      try {
        const returned = listener(registration.ns, next, prev, source)
        if (returned != null && typeof (returned as PromiseLike<unknown>).then === 'function') {
          // An emit listener may still be an async function; its rejection
          // cannot reach the synchronous INVARIANT rethrow below, so it is
          // contained here instead of becoming an unhandled rejection.
          void Promise.resolve(returned as PromiseLike<unknown>).then(undefined, (error: unknown) => {
            this.warnListenerFailure(registration.ns, error)
          })
        }
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === 'INVARIANT') {
          invariantFailure ??= error
          continue
        }
        this.warnListenerFailure(registration.ns, error)
      }
    }
    if (invariantFailure !== undefined) throw invariantFailure as Error
  }

  /** Contained-watcher diagnostic shared by the sync and async failure paths. */
  private warnWatcherFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: watcher for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }

  /** Contained-listener diagnostic shared by the sync and async failure paths. */
  private warnListenerFailure(ns: SettingsNamespace, error: unknown): void {
    this.ctx.logger.warn('settings: a settings/updated listener for "%s" failed', ns)
    this.ctx.logger.warn(error)
  }
}

const FIBER_DISPOSED = 4

const FIBER_UNLOADING = 5

function isUnloading(ctx: Context): boolean {
  const state: number = ctx.fiber.state
  return state === FIBER_UNLOADING || state === FIBER_DISPOSED
}

export interface SettingsSectionHooks<T> {
  /**
   * Receive the active configuration source: the resolved settings scope
   * while one is attached, the composition entry otherwise. Called before
   * the matching `onChange` at attach and at detach.
   * @param current - thunk returning the currently authoritative value.
   */
  setSource(current: () => T): void
  /**
   * Re-judge anything derived from the source — registration-level facts,
   * memoized resolutions — after an attach, a detach, or a committed change.
   */
  onChange(): void
  /**
   * Reject a resolved section this consumer could not act on, for constraints
   * its schema cannot express. See {@link SettingsRegisterOptions.validate}.
   * @param value - the resolved section, schema-valid by construction.
   */
  validate?: (value: T) => void
}

export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    })
    hooks.setSource(() => scope.get())
    sctx.effect(() => () => {
      // This disposer runs for two different reasons. A settings provider
      // detaching leaves the consumer running, so it must fall back to its
      // composition entry and re-judge what it derived. The consumer's own
      // unload runs it too — and there `onChange` would re-register routes
      // and touch resources the teardown is releasing, so the fallback is
      // pointless and the notification actively harmful.
      if (isUnloading(ctx)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      // A stored change landing while the consumer unloads reaches the watcher
      // before the registration is released, and `onChange` is exactly as
      // harmful here as in the disposer above: it re-registers routes against
      // a fiber whose resources are being let go.
      if (isUnloading(ctx)) return
      hooks.onChange()
    })
  })
}

export default SettingsProvider

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/settings'
  export const name = 'settings-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
