import { Context } from '@ejunz/cordis'

import type { Plugin } from '@ejunz/cordis'

import { scopeOf } from '@ejunz/ea/scope'

import { assertSupportedJsonSchema, defineTool } from '@ejunz/ea/tools'

import type { ToolDefinition } from '@ejunz/ea/tools'

import type { ContentBlock } from '@ejunz/ea/llm'

import type { JsonValue } from '@ejunz/ea/session'

const DYNAMIC_TOOL = Symbol('cordis-host-runner.dynamic-tool')

const SCHEMA_TYPES = new Set<unknown>(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array', 'json'])

const VALID_TYPES = '\'string\' | \'number\' | \'integer\' | \'boolean\' | \'null\' | \'object\' | \'array\' | \'json\''

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

type DynamicToolDefinition = ToolDefinition & { [DYNAMIC_TOOL]: true }

type DynamicToolMarker = { [DYNAMIC_TOOL]?: unknown }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null
    || typeof prototype === 'object'
      && Object.getPrototypeOf(prototype) === null
      && hasIntrinsicConstructor(prototype, 'Object')
}

function hasIntrinsicConstructor(prototype: object, name: 'Array' | 'Object'): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
  const constructor: unknown = descriptor?.value
  if (typeof constructor !== 'function') return false
  try {
    return constructor.name === name
      && constructor.prototype === prototype
      && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
  } catch {
    return false
  }
}

function hasPlainArrayPrototype(value: unknown[]): boolean {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, 'Array')) return false
  const objectPrototype: unknown = Object.getPrototypeOf(prototype)
  return typeof objectPrototype === 'object'
    && objectPrototype !== null
    && Object.getPrototypeOf(objectPrototype) === null
    && hasIntrinsicConstructor(objectPrototype, 'Object')
}

function isDensePlainArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || !hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) {
    return false
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false
  }
  return true
}

function assertSchemaContainerKeys(value: Record<string, unknown>, path: string): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))) {
    throw new Error(`ejunzAgent.defineTool ${path} must contain only own enumerable string keys`)
  }
}

type CloneDestination =
  | { kind: 'root' }
  | { kind: 'array'; target: unknown[]; index: number }
  | { kind: 'object'; target: Record<string, unknown>; key: string }

type CloneTask =
  | { kind: 'visit'; value: unknown; path: string; destination: CloneDestination }
  | { kind: 'array-item'; source: unknown[]; index: number; path: string; target: unknown[] }
  | { kind: 'leave'; source: object }

function cloneJson(value: unknown, path: string): unknown {
  const ancestors = new Set<object>()
  let root: unknown
  const assign = (destination: CloneDestination, item: unknown): void => {
    if (destination.kind === 'root') {
      root = item
      return
    }
    if (destination.kind === 'array') {
      destination.target[destination.index] = item
      return
    }
    Object.defineProperty(destination.target, destination.key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  const reject = (at: string): never => {
    // Naming the executable next step matters more than naming the rule: the
    // usual cause is a handler that returns whatever its last call produced,
    // and the fix is one keyword.
    throw new Error(`${at} must be lossless JSON data (objects, arrays, strings, numbers, booleans, null) — `
      + 'not a class instance, function, Map/Set, Date, or undefined. Return a plain object built from the '
      + 'values you need, or `return null` when the caller needs no value back.')
  }

  const tasks: CloneTask[] = [{ kind: 'visit', value, path, destination: { kind: 'root' } }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.source)
      continue
    }
    if (task.kind === 'array-item') {
      if (!Object.hasOwn(task.source, task.index)) reject(task.path)
      tasks.push({
        kind: 'visit',
        value: task.source[task.index],
        path: `${task.path}[${task.index}]`,
        destination: { kind: 'array', target: task.target, index: task.index },
      })
      continue
    }

    const current = task.value
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      assign(task.destination, current)
      continue
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Object.is(current, -0)) reject(task.path)
      assign(task.destination, current)
      continue
    }
    if (typeof current !== 'object' || ancestors.has(current)) reject(task.path)

    if (Array.isArray(current)) {
      if (!hasPlainArrayPrototype(current) || Reflect.ownKeys(current).length !== current.length + 1) reject(task.path)
      const output: unknown[] = []
      assign(task.destination, output)
      ancestors.add(current)
      tasks.push({ kind: 'leave', source: current })
      for (let index = current.length - 1; index >= 0; index--) {
        tasks.push({ kind: 'array-item', source: current, index, path: task.path, target: output })
      }
      continue
    }
    if (!isPlainRecord(current)) reject(task.path)
    const record = current as Record<string, unknown>
    if (Reflect.ownKeys(record).some(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(record, key))) {
      reject(task.path)
    }
    const output: Record<string, unknown> = {}
    assign(task.destination, output)
    ancestors.add(record)
    tasks.push({ kind: 'leave', source: record })
    const entries = Object.entries(record)
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      /* v8 ignore next -- the loop is bounded by the captured entry count. */
      if (entry === undefined) continue
      tasks.push({
        kind: 'visit',
        value: entry[1],
        path: `${task.path}.${entry[0]}`,
        destination: { kind: 'object', target: output, key: entry[0] },
      })
    }
  }
  return root
}

function copyAnnotations(value: Record<string, unknown>, output: Record<string, unknown>, path: string): void {
  if (Object.hasOwn(value, 'description')) output.description = value.description
  if (Object.hasOwn(value, 'title')) output.title = value.title
  if (Object.hasOwn(value, 'default')) output.default = cloneJson(value.default, `ejunzAgent.defineTool ${path}.default`)
  if (Object.hasOwn(value, 'examples')) output.examples = cloneJson(value.examples, `ejunzAgent.defineTool ${path}.examples`)
}

function assertSchemaKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  assertSchemaContainerKeys(value, path)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`ejunzAgent.defineTool ${path}.${key} is not supported by the unified schema DSL`)
  }
}

function normalizeParameterSchemaSpec(value: unknown, path = 'parameters'): {
  spec: Record<string, unknown>
  rootAnnotations?: Record<string, unknown>
} {
  if (!isPlainRecord(value)) {
    throw new Error(`ejunzAgent.defineTool ${path} must be a ParameterSchemaSpec object`)
  }
  if (value.type === 'object') {
    assertSchemaKeys(value, path, ['type', 'properties', 'required', 'additionalProperties', ...ANNOTATION_KEYS])
    if (!isPlainRecord(value.properties)) {
      throw new Error(`ejunzAgent.defineTool ${path}.properties must be an object of schemas`)
    }
    if (Object.hasOwn(value, 'additionalProperties') && value.additionalProperties !== true) {
      throw new Error(`ejunzAgent.defineTool ${path}.additionalProperties must be true or omitted because the implicit parameter root is open`)
    }
    if (Object.hasOwn(value, 'required') && value.required === undefined) {
      throw new Error(`ejunzAgent.defineTool ${path}.required must be an array of declared property names`)
    }
    const required = normalizeRequiredNames(value.required, value.properties, `${path}.required`)
    const rootAnnotations: Record<string, unknown> = {}
    copyAnnotations(value, rootAnnotations, path)
    return {
      spec: normalizePropertyMap(value.properties, path, required, true),
      ...(Object.keys(rootAnnotations).length === 0 ? {} : { rootAnnotations }),
    }
  }
  return { spec: normalizePropertyMap(value, path, new Set(), false) }
}

function normalizeRequiredNames(value: unknown, properties: Record<string, unknown>, path: string): Set<string> {
  if (value === undefined) return new Set()
  if (!isDensePlainArray(value)) {
    throw new Error(`ejunzAgent.defineTool ${path} must be an array of declared property names`)
  }
  const names = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const name = value[index]
    if (typeof name !== 'string') {
      throw new Error(`ejunzAgent.defineTool ${path} must be an array of declared property names`)
    }
    names.add(name)
    if (!Object.hasOwn(properties, name)) throw new Error(`ejunzAgent.defineTool ${path} names undeclared property ${JSON.stringify(name)}`)
  }
  return names
}

interface NormalizeRoot {
  value?: Record<string, unknown>
}

type NormalizeValueDestination =
  | { kind: 'property'; target: Record<string, unknown>; key: string }
  | { kind: 'item'; target: Record<string, unknown> }
  | { kind: 'one-of'; target: Record<string, unknown>[]; index: number }

type NormalizeMapDestination =
  | { kind: 'root'; holder: NormalizeRoot }
  | { kind: 'properties'; target: Record<string, unknown> }

type NormalizeTask =
  | {
    kind: 'map'
    entries: Record<string, unknown>
    path: string
    requiredNames: ReadonlySet<string>
    raw: boolean
    destination: NormalizeMapDestination
  }
  | {
    kind: 'value'
    value: unknown
    path: string
    forceRequired: boolean
    raw: boolean
    parameterProperty: boolean
    destination: NormalizeValueDestination
  }
  | { kind: 'leave'; value: object }

function assignNormalizedValue(destination: NormalizeValueDestination, value: Record<string, unknown>): void {
  if (destination.kind === 'property') {
    Object.defineProperty(destination.target, destination.key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  } else if (destination.kind === 'item') {
    destination.target.items = value
  } else {
    destination.target[destination.index] = value
  }
}

function assignNormalizedMap(destination: NormalizeMapDestination, value: Record<string, unknown>): void {
  if (destination.kind === 'root') destination.holder.value = value
  else destination.target.properties = value
}

function normalizePropertyMap(
  entries: Record<string, unknown>,
  path: string,
  requiredNames: ReadonlySet<string>,
  raw: boolean,
): Record<string, unknown> {
  const holder: NormalizeRoot = {}
  const ancestors = new Set<object>()
  const tasks: NormalizeTask[] = [{
    kind: 'map',
    entries,
    path,
    requiredNames,
    raw,
    destination: { kind: 'root', holder },
  }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      ancestors.delete(task.value)
      continue
    }
    if (task.kind === 'map') {
      if (ancestors.has(task.entries)) throw new Error(`ejunzAgent.defineTool ${task.path} is circular`)
      assertSchemaContainerKeys(task.entries, task.path)
      ancestors.add(task.entries)
      const spec: Record<string, unknown> = {}
      assignNormalizedMap(task.destination, spec)
      tasks.push({ kind: 'leave', value: task.entries })
      const mapEntries = Object.entries(task.entries)
      for (let index = mapEntries.length - 1; index >= 0; index--) {
        const entry = mapEntries[index]
        /* v8 ignore next -- the loop is bounded by the captured entry count. */
        if (entry === undefined) continue
        tasks.push({
          kind: 'value',
          value: entry[1],
          path: `${task.path}.${entry[0]}`,
          forceRequired: task.requiredNames.has(entry[0]),
          raw: task.raw,
          parameterProperty: true,
          destination: { kind: 'property', target: spec, key: entry[0] },
        })
      }
      continue
    }

    const { value, path } = task
    if (!isPlainRecord(value)) {
      throw new Error(`ejunzAgent.defineTool ${path} must be a ParameterSchemaSpec property object`)
    }
    assertSchemaContainerKeys(value, path)
    if (ancestors.has(value)) throw new Error(`ejunzAgent.defineTool ${path} is circular`)
    ancestors.add(value)
    const requiredKey = task.parameterProperty && !task.raw ? ['required'] : []
    if (task.parameterProperty && task.raw && Object.hasOwn(value, 'required') && value.type !== 'object') {
      throw new Error(`ejunzAgent.defineTool ${path}.required belongs to the containing raw object schema`)
    }
    if (task.parameterProperty && !task.raw && Object.hasOwn(value, 'required') && value.required !== true) {
      throw new Error(`ejunzAgent.defineTool ${path}.required must be true when present`)
    }
    const prop: Record<string, unknown> = {}
    assignNormalizedValue(task.destination, prop)
    tasks.push({ kind: 'leave', value })
    if (task.forceRequired || value.required === true) prop.required = true
    copyAnnotations(value, prop, path)

    if (Object.hasOwn(value, 'oneOf')) {
      assertSchemaKeys(value, path, ['oneOf', ...requiredKey, ...ANNOTATION_KEYS])
      if (!isDensePlainArray(value.oneOf) || value.oneOf.length < 2) {
        throw new Error(`ejunzAgent.defineTool ${path}.oneOf must contain at least two schemas`)
      }
      const oneOf: Record<string, unknown>[] = []
      prop.oneOf = oneOf
      for (let index = value.oneOf.length - 1; index >= 0; index--) {
        tasks.push({
          kind: 'value',
          value: value.oneOf[index],
          path: `${path}.oneOf[${index}]`,
          forceRequired: false,
          raw: task.raw,
          parameterProperty: false,
          destination: { kind: 'one-of', target: oneOf, index },
        })
      }
      continue
    }

    if (task.raw && !Object.hasOwn(value, 'type')) {
      assertSchemaKeys(value, path, ANNOTATION_KEYS)
      prop.type = 'json'
      continue
    }
    if (!SCHEMA_TYPES.has(value.type) || task.raw && value.type === 'json') {
      throw new Error(`ejunzAgent.defineTool ${path} must declare a valid type: ${VALID_TYPES} (got ${JSON.stringify(value.type)})`)
    }
    const type = value.type
    prop.type = type

    switch (type) {
      case 'object': {
        assertSchemaKeys(value, path, ['type', 'properties', 'additionalProperties', ...requiredKey, ...(task.raw ? ['required'] : []), ...ANNOTATION_KEYS])
        if (!task.raw && (!Object.hasOwn(value, 'additionalProperties') || typeof value.additionalProperties !== 'boolean')) {
          throw new Error(`ejunzAgent.defineTool ${path}.additionalProperties must be explicitly true or false`)
        }
        if (task.raw && Object.hasOwn(value, 'additionalProperties') && typeof value.additionalProperties !== 'boolean') {
          throw new Error(`ejunzAgent.defineTool ${path}.additionalProperties must be a boolean`)
        }
        if (task.raw && Object.hasOwn(value, 'required') && value.required === undefined) {
          throw new Error(`ejunzAgent.defineTool ${path}.required must be an array of declared property names`)
        }
        prop.additionalProperties = task.raw ? value.additionalProperties ?? true : value.additionalProperties
        if (Object.hasOwn(value, 'properties')) {
          const properties = value.properties
          if (!isPlainRecord(properties)) throw new Error(`ejunzAgent.defineTool ${path}.properties must be an object of schemas`)
          const nestedRequired = task.raw
            ? normalizeRequiredNames(value.required, properties, `${path}.required`)
            : new Set<string>()
          tasks.push({
            kind: 'map',
            entries: properties,
            path: `${path}.properties`,
            requiredNames: nestedRequired,
            raw: task.raw,
            destination: { kind: 'properties', target: prop },
          })
        } else if (task.raw && value.required !== undefined) {
          normalizeRequiredNames(value.required, {}, `${path}.required`)
        }
        break
      }
      case 'array':
        assertSchemaKeys(value, path, ['type', 'items', ...requiredKey, ...ANNOTATION_KEYS])
        if (Object.hasOwn(value, 'items')) {
          tasks.push({
            kind: 'value',
            value: value.items,
            path: `${path}.items`,
            forceRequired: false,
            raw: task.raw,
            parameterProperty: false,
            destination: { kind: 'item', target: prop },
          })
        }
        break
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertSchemaKeys(value, path, ['type', 'enum', 'const', ...requiredKey, ...ANNOTATION_KEYS])
        if (Object.hasOwn(value, 'enum')) {
          if (!isDensePlainArray(value.enum) || value.enum.length === 0) {
            throw new Error(`ejunzAgent.defineTool ${path}.enum must be a non-empty array`)
          }
          prop.enum = cloneJson(value.enum, `ejunzAgent.defineTool ${path}.enum`)
        }
        if (Object.hasOwn(value, 'const')) prop.const = cloneJson(value.const, `ejunzAgent.defineTool ${path}.const`)
        break
      case 'json':
        assertSchemaKeys(value, path, ['type', ...requiredKey, ...ANNOTATION_KEYS])
        break
      /* v8 ignore next 2 -- SCHEMA_TYPES narrows this closed switch before dispatch. */
      default:
        throw new Error(`ejunzAgent.defineTool ${path} must declare a valid type: ${VALID_TYPES}`)
    }
  }
  /* v8 ignore next -- the root map task assigns before scheduling descendants. */
  return holder.value ?? {}
}

function markDynamicTool(tool: ToolDefinition): DynamicToolDefinition {
  Object.defineProperty(tool, DYNAMIC_TOOL, { value: true })
  return tool as DynamicToolDefinition
}

function assertDynamicTool(tool: unknown): asserts tool is DynamicToolDefinition {
  if (!isPlainRecord(tool) || (tool as DynamicToolMarker)[DYNAMIC_TOOL] !== true) {
    throw new Error('dynamic tool registration must use a tool returned by ejunzAgent.defineTool(...)')
  }
}

function isContentBlockShape(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.type === 'string'
}

const RETURN_PREVIEW_LIMIT = 120

function describeReturn(value: JsonValue): string {
  // The caller has already crossed cloneJson, so this value is lossless JSON
  // and serialization cannot produce undefined.
  const json = JSON.stringify(value)
  return json.length > RETURN_PREVIEW_LIMIT ? `${json.slice(0, RETURN_PREVIEW_LIMIT)}…` : json
}

function assertRenderedContent(value: JsonValue): ContentBlock[] {
  if (Array.isArray(value) && value.every(isContentBlockShape)) {
    return value as unknown as ContentBlock[]
  }
  throw new Error(
    `output.render returned ${describeReturn(value)} — it must return an ARRAY of content blocks:\n`
    + '  ✓ return [{ type: \'text\', text: String(value) }]',
  )
}

export function sandboxDefineTool(options: unknown): ToolDefinition {
  if (!isPlainRecord(options)) throw new Error('ejunzAgent.defineTool options must be an object')
  const normalized = normalizeParameterSchemaSpec(options.parameters)
  if (!isPlainRecord(options.output)) {
    throw new Error('ejunzAgent.defineTool output must declare { schema, render, presentationMeta? }')
  }
  const output = options.output
  if (typeof output.render !== 'function') throw new Error('ejunzAgent.defineTool output.render must be a function')
  if (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function') {
    throw new Error('ejunzAgent.defineTool output.presentationMeta must be a function when present')
  }
  if (typeof options.execute !== 'function') throw new Error('ejunzAgent.defineTool execute must be a function')
  const schema = cloneJson(output.schema, 'ejunzAgent.defineTool output.schema')
  const rawExecute = options.execute as (args: unknown, exec: unknown) => Promise<unknown>
  const rawRender = output.render as (args: unknown, value: unknown) => unknown
  const rawPresentationMeta = output.presentationMeta as ((args: unknown, value: unknown) => unknown) | undefined
  const erasedDefineTool = defineTool as unknown as (definition: unknown) => ToolDefinition
  const tool = erasedDefineTool({
    ...options,
    parameters: normalized.spec,
    output: {
      schema,
      render(args: unknown, value: unknown): ContentBlock[] {
        return assertRenderedContent(cloneJson(rawRender(args, value), 'ejunzAgent.defineTool output.render result') as JsonValue)
      },
      ...rawPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: unknown): JsonValue {
          return cloneJson(rawPresentationMeta(args, value), 'ejunzAgent.defineTool output.presentationMeta result') as JsonValue
        },
      } : {},
    },
    async execute(args: unknown, exec: unknown): Promise<JsonValue> {
      return cloneJson(await rawExecute(args, exec), 'ejunzAgent.defineTool execute result') as JsonValue
    },
  })
  const parameters = { ...tool.parameters, ...normalized.rootAnnotations }
  assertSupportedJsonSchema(parameters)
  return markDynamicTool({
    ...tool,
    parameters,
  })
}

export function normalizeHandler(method: unknown, fn: unknown): { method: string; handler: (args: unknown) => Promise<unknown> } {
  if (typeof method !== 'string' || method.length === 0) {
    throw new Error('ejunzAgent.handle(method, fn) needs a non-empty string method name')
  }
  if (typeof fn !== 'function') {
    throw new Error(`ejunzAgent.handle("${method}") needs a handler function as its second argument`)
  }
  const rawHandler = fn as (args: unknown) => unknown
  return {
    method,
    handler: async (args: unknown): Promise<unknown> =>
      cloneJson(await rawHandler(args), `ejunzAgent.handle("${method}") result`),
  }
}

export function sandboxRegisterTool(ctx: Context, tool: unknown): () => void {
  assertDynamicTool(tool)
  return ctx.tools.register(tool)
}

const CTX_VERBS = new Set(['effect', 'on', 'once', 'provide', 'timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

const TIMER_VERBS = new Set(['timeout', 'interval', 'setTimeout', 'setInterval', 'throttle', 'debounce'])

function sandboxTools(ctx: Context): Record<string, unknown> {
  // Resolve reads and writes through the package's own scope.
  return {
    register: (tool: unknown): (() => void) => sandboxRegisterTool(ctx, tool),
    schemas: () => ctx.tools.schemas(scopeOf(ctx)),
    get: (name: string) => ctx.tools.schemas(scopeOf(ctx)).find(schema => schema.name === name),
  }
}

function denyContext(value: unknown, service: string, reportFailure: (error: Error) => void): unknown {
  if (value instanceof Context) {
    return rejectGuard(reportFailure,
      `service "${service}" returned a cordis Context, which the sandbox does not expose. `
      + 'Operate through your own plugin ctx (ctx.on / ctx.provide / ctx.tools.register) '
      + 'and the services you inject — never another context.',
    )
  }
  return value
}

function guardedService(service: object, name: string, reportFailure: (error: Error) => void): unknown {
  return new Proxy(service, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown
      if (typeof value !== 'function') return denyContext(value, name, reportFailure)
      return (...args: unknown[]): unknown => {
        const result = Reflect.apply(value, target, args) as unknown
        if (result instanceof Promise) return result.then(v => denyContext(v, name, reportFailure))
        return denyContext(result, name, reportFailure)
      }
    },
  })
}

function declaredInjects(ctx: Context): Set<string> {
  return new Set(Object.keys(ctx.fiber.inject))
}

function sandboxContext(ctx: Context, reportFailure: (error: Error) => void): Context {
  const tools = sandboxTools(ctx)
  const declared = declaredInjects(ctx)
  // A framework member or an undeclared service — distinguish the two so the
  // error teaches the right fix (declare it in inject vs it is withheld).
  const denyRead = (prop: string): never => {
    if (ctx.get(prop) !== undefined) {
      return rejectGuard(reportFailure,
        `service "${prop}" is not injected. Declare it: inject: ['${prop}', …] on your plugin, `
        + 'so cordis parks this dynamic package if the provider later goes away.',
      )
    }
    return rejectGuard(reportFailure,
      `sandbox ctx does not expose "${prop}". Available: ctx.tools.register / ctx.on / ctx.provide / `
      + 'the timer helpers after injecting timer, and any service you declared in inject. '
      + 'Framework internals (root, fiber, registry, extend, plugin, …) are withheld by design.',
    )
  }
  // `get` is optional lookup; property access requires a declaration. `tools`
  // is the façade's own API on either path.
  const readService = (name: string, requireDeclaration: boolean): unknown => {
    if (name === 'tools') return tools
    if (requireDeclaration && !declared.has(name)) return denyRead(name)
    const service = denyContext(ctx.get(name), name, reportFailure)
    if (service === null || (typeof service !== 'object' && typeof service !== 'function')) return service
    return guardedService(service, name, reportFailure)
  }
  const get = (name: string): unknown => readService(name, false)
  // Expose the guarded host service façade through lazy property forwarding.
  /* jscpd:ignore-start */
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === 'tools') return tools
      if (prop === 'get') return get
      if (typeof prop !== 'string') return undefined
      // Lazy verb forwarder — reads `ctx[verb]` only when called. Timer mixins
      // additionally require the Service declaration before Cordis resolves them.
      if (CTX_VERBS.has(prop)) {
        return (...args: unknown[]): unknown => {
          if (TIMER_VERBS.has(prop) && !declared.has('timer')) return denyRead('timer')
          const method = ctx[prop as keyof Context]
          return Reflect.apply(method as (...a: unknown[]) => unknown, ctx, args)
        }
      }
      return readService(prop, true)
    },
    // A façade is not the real ctx; block writes rather than let package code
    // stash state on a throwaway object and think it persisted.
    set(_target, prop) {
      return rejectGuard(reportFailure, `sandbox ctx is read-only; cannot assign "${String(prop)}"`)
    },
    // `in` reflects reachability: the façade API plus DECLARED services
    // (whether or not currently live). Does not resolve/wrap — no throw.
    has: (_target, prop) => prop === 'tools' || prop === 'get'
      || (typeof prop === 'string'
        && ((CTX_VERBS.has(prop) && (!TIMER_VERBS.has(prop) || declared.has('timer'))) || declared.has(prop))),
  }) as unknown as Context
  /* jscpd:ignore-end */
}

export function isPlugin(value: unknown): value is Plugin {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null
    && typeof (value as { apply?: unknown }).apply === 'function'
}

export function guardedPlugin(plugin: Plugin, reportFailure: (error: Error) => void): Plugin {
  if (typeof plugin === 'function') {
    const functionPlugin = plugin as (ctx: Context, config?: unknown) => unknown
    return {
      name: pluginName(plugin),
      apply(ctx: Context, config?: unknown) {
        return functionPlugin(sandboxContext(ctx, reportFailure), config)
      },
    }
  }
  const objectPlugin = plugin as { apply(ctx: Context, config?: unknown): unknown }
  return {
    ...plugin,
    apply(ctx: Context, config?: unknown) {
      return objectPlugin.apply(sandboxContext(ctx, reportFailure), config)
    },
  }
}

function rejectGuard(reportFailure: (error: Error) => void, message: string): never {
  const error = new Error(message)
  reportFailure(error)
  throw error
}

export function pluginName(plugin: Plugin): string {
  const named = (plugin as { name?: unknown }).name
  if (typeof named === 'string' && named.length > 0) return named
  return '<anonymous>'
}

import type { Branded } from '@ejunz/ea/brand'

import type { JsonValue, SessionId } from '@ejunz/ea/session/types'

export type CordisDynamicPluginId = Branded<'CordisDynamicPluginId'>

export type CordisDynamicPackageId = Branded<'CordisDynamicPackageId'>

export type CordisDynamicPluginRunId = Branded<'CordisDynamicPluginRunId'>

export type ApprovalRequestId = Branded<'ApprovalRequestId'>

export type CordisInspectRequestId = Branded<'CordisInspectRequestId'>

export type CordisInspectPlatform = 'host' | 'client'

export interface CordisInspectMethodManifest {
  /** Method name, unique within its provider. */
  name: string
  /** What the query returns and when to use it. */
  description: string
  /** JSON Schema accepted by the query. */
  inputSchema: JsonValue
  /** JSON Schema produced by the query. */
  outputSchema: JsonValue
}

export interface CordisInspectProviderManifest {
  /** Provider identity, unique within one platform. */
  id: string
  /** Capability described by this provider. */
  description: string
  /** Explicit read-only queries. */
  methods: readonly CordisInspectMethodManifest[]
}

export interface CordisInspectProviderView extends CordisInspectProviderManifest {
  /** Runtime plane that executes these methods. */
  platform: CordisInspectPlatform
}

export interface CordisInspectQueryRequest {
  /** Correlation identity. */
  requestId: CordisInspectRequestId
  /** Session whose model requested the query. */
  agentId: SessionId
  /** Provider selected from the Client manifest. */
  provider: string
  /** Method selected from the provider manifest. */
  method: string
  /** JSON query input, omitted when the method has no fields. */
  input?: JsonValue
}

export type CordisInspectQueryResolution =
  | { ok: true; data: JsonValue }
  | {
    ok: false
    reason: 'provider-missing' | 'method-missing' | 'invalid-input' | 'provider-error' | 'cancelled'
    message: string
  }

export interface CordisInspectQueryResolved {
  /** Query that left the pending state. */
  requestId: CordisInspectRequestId
}

export interface CordisInspectResolveAck {
  /** False for unknown, cancelled, stale, or late answers. */
  accepted: boolean
}

export type CordisDynamicRunMode = 'run' | 'update'

export type RequestRunOutcome = 'approved' | 'completed' | 'rejected' | 'cancelled' | 'failed'

export interface CordisErrorDetails {
  /** Original error message. */
  message: string
  /** Original stack when the thrown value supplied one. */
  stack?: string
}

export type CordisRunStatus =
  | 'awaiting-approval'
  | 'starting-host'
  | 'client-pending'
  | 'running'
  | 'waiting'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'stopped'

export interface CordisHalfState {
  /** Lifecycle state of this half. */
  status: 'absent' | 'pending' | 'stopped' | 'running' | 'waiting' | 'failed'
  /** Services still needed by a successfully created Fiber. */
  waitingFor: readonly string[]
  /** Failure text for this half. */
  error?: string
}

export interface CordisRunDiagnostic {
  /** Stage that failed. */
  phase: 'approval' | 'host-load' | 'host-apply' | 'client-load' | 'client-apply' | 'client-render'
  /** Original failure text. */
  message: string
  /** Original failure stack when available. */
  stack?: string
  /** Stable Plugin identity. */
  pluginId: CordisDynamicPluginId
  /** Immutable Package identity. */
  packageId: CordisDynamicPackageId
  /** Exact attempt identity. */
  pluginRunId: CordisDynamicPluginRunId
}

export interface DynamicCordisRunAttempt {
  /** Exact attempt identity. */
  pluginRunId: CordisDynamicPluginRunId
  /** Target Package. */
  packageId: CordisDynamicPackageId
  /** Explicit run/update intent. */
  mode: CordisDynamicRunMode
  /** Current attempt state. */
  status: CordisRunStatus
  /** Pending Client activation request; it represents approval only when `requiresApproval` is true. */
  approvalRequestId?: ApprovalRequestId
  /** Whether the pending Client activation requires a user decision. */
  requiresApproval?: boolean
  /** Host-half state. */
  host: CordisHalfState
  /** Client-half state. */
  client: CordisHalfState
  /** Most recent failure. */
  error?: CordisRunDiagnostic
}

export interface DynamicCordisPackage {
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Immutable package version currently active. */
  packageId: CordisDynamicPackageId
  /** This activation's identity. */
  pluginRunId: CordisDynamicPluginRunId
  /** Package label. */
  name: string
}

export interface DynamicCordisRunRequest {
  /** Correlation identity of the activation request. */
  requestId: ApprovalRequestId
  /** Session whose plugin and tool call own the request. */
  agentId: SessionId
  /** Stable plugin instance being acted on. */
  pluginId: CordisDynamicPluginId
  /** Package version the request will activate. */
  packageId: CordisDynamicPackageId
  /** Explicit lifecycle intent. */
  mode: CordisDynamicRunMode
  /** Package label. */
  name: string
  /** User-facing reason supplied at define time. */
  purpose: string
  /** Whether a page must wait for an explicit user decision before activation. */
  requiresApproval: boolean
}

export interface DynamicCordisRequestResolved {
  /** Request that left the pending state. */
  requestId: ApprovalRequestId
  /** How the request settled. */
  outcome: RequestRunOutcome
}

export interface DynamicCordisRetracted {
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Package version that was active. */
  packageId: CordisDynamicPackageId
  /** Exact activation being withdrawn. */
  pluginRunId: CordisDynamicPluginRunId
}

export interface DynamicCordisInventoryPackage {
  /** Immutable package version. */
  packageId: CordisDynamicPackageId
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** Whether this version contains Host code. */
  hasHostHalf: boolean
  /** Whether this version contains Client code. */
  hasClientHalf: boolean
}

export interface DynamicCordisInventoryRow {
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Session that owns this plugin. */
  agentId: SessionId
  /** Immutable versions in define order. */
  packages: readonly DynamicCordisInventoryPackage[]
  /** Last package that completed activation successfully. */
  currentPackageId?: CordisDynamicPackageId
  /** Package selected for a failed or in-progress transition. */
  nextPackageId?: CordisDynamicPackageId
  /** Current activation, absent while stopped. */
  activeRun?: {
    pluginRunId: CordisDynamicPluginRunId
    packageId: CordisDynamicPackageId
  }
  /** Latest activation attempt, including pending approval and diagnostics. */
  latestRun?: DynamicCordisRunAttempt
}

export type DynamicCordisUndefineReceipt =
  | { ok: true; wasRunning: boolean }
  | { ok: false; reason: 'plugin-missing'; message: string }

export interface DynamicCordisRenderFailure {
  /** Slot whose component failed. */
  slot: string
  /** Render failure text. */
  message: string
  /** Original render failure stack when available. */
  stack?: string
  /** Whether the failing contribution relinquished its slot. */
  abdicated: boolean
}

export type DynamicCordisRunResponse =
  | {
    ok: true
    /** Whether activation completed synchronously, is starting in a Client, or awaits user approval. */
    status: 'awaiting-approval' | 'starting' | 'running'
    pluginId: CordisDynamicPluginId
    packageId: CordisDynamicPackageId
    pluginRunId: CordisDynamicPluginRunId
    /** Missing Host services; a parked Fiber is a successful activation. */
    waitingFor: readonly string[]
    /** Missing Client services reported by the approving page. */
    clientWaitingFor?: readonly string[]
    /** Last fully successful Package. */
    currentPackageId?: CordisDynamicPackageId
    /** Selected transition target. */
    nextPackageId?: CordisDynamicPackageId
    /** Explicit lifecycle intent. */
    mode: CordisDynamicRunMode
  }
  | {
    ok: false
    reason:
      | 'plugin-missing'
      | 'package-missing'
      | 'invalid-mode'
      | 'transition-in-flight'
      | 'host-half-failed'
      | 'client-half-failed'
      | 'rejected'
      | 'cancelled'
      | 'not-running'
    message: string
    /** Original failure stack when available. */
    stack?: string
  }

export type DynamicCordisStopResponse =
  | { ok: true }
  | { ok: false; reason: 'plugin-missing' | 'not-running'; message: string }

export type DynamicCordisHostHalfResult =
  | {
    ok: true
    pluginId: CordisDynamicPluginId
    packageId: CordisDynamicPackageId
    pluginRunId: CordisDynamicPluginRunId
    waitingFor: readonly string[]
    /** False when a panel merely attaches this page to an already active run. */
    startedHere: boolean
  }
  | ({ ok: false } & CordisErrorDetails)

export interface DynamicCordisClientSource {
  /** Browser JavaScript body. */
  code: string
  /** Package label. */
  name: string
  /** Stable plugin instance. */
  pluginId: CordisDynamicPluginId
  /** Immutable source version. */
  packageId: CordisDynamicPackageId
  /** Exact activation the source belongs to. */
  pluginRunId: CordisDynamicPluginRunId
}

export type DynamicCordisRunResolution =
  | { ok: true; pluginRunId: CordisDynamicPluginRunId; waitingFor?: readonly string[] }
  | {
    ok: false
    reason: 'rejected' | 'host-half-failed' | 'client-half-failed'
    /** Activation that failed; absent for a refusal before activation. */
    pluginRunId?: CordisDynamicPluginRunId
    /** Whether this page created the failed activation instead of attaching to it. */
    startedHere?: boolean
    message?: string
    stack?: string
  }

export interface DynamicCordisResolveAck {
  /** False for late, unknown, or stale answers. */
  accepted: boolean
}

export type DynamicCordisInvokeResult =
  | { ok: true; value: JsonValue }
  | ({ ok: false; code: 'plugin-not-running' | 'stale-run' | 'method-not-found' | 'handler-error' } & CordisErrorDetails)

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * A Client-bearing activation needs a browser page, and may require a user decision.
     * @param request - correlation identity, owner, target version, mode, and approval requirement.
     * @mode emit
     */
    '@ejunz/cordis/request-run'(request: DynamicCordisRunRequest): void
    /**
     * A pending Client activation request left the answerable state.
     * @param resolved - request identity and outcome.
     * @mode emit
     */
    '@ejunz/cordis/request-run-resolved'(resolved: DynamicCordisRequestResolved): void
    /**
     * One exact Plugin/Package activation is now live in the Host.
     * @param pkg - stable plugin, immutable package, run identity, and label.
     * @mode emit
     */
    '@ejunz/cordis/dynamic-package'(pkg: DynamicCordisPackage): void
    /**
     * One exact activation was withdrawn.
     * @param retracted - plugin, package, and run identity.
     * @mode emit
     */
    '@ejunz/cordis/dynamic-retract'(retracted: DynamicCordisRetracted): void
    /**
     * Request a live read-only query from the Client inspect registry.
     * @param request - correlation, Session, provider, method, and JSON input.
     * @mode emit
     */
    '@ejunz/cordis/inspect-query'(request: CordisInspectQueryRequest): void
    /**
     * Notify every Client that an inspect query has settled or been cancelled.
     * @param resolved - exact query identity that is no longer answerable.
     * @mode emit
     */
    '@ejunz/cordis/inspect-query-resolved'(resolved: CordisInspectQueryResolved): void
  }
}

import { Service } from '@ejunz/cordis'

import type { Context } from '@ejunz/cordis'

import type { Agent } from '@ejunz/ea/agent'

import { snapshotJsonValue } from '@ejunz/ea/session'

import type { JsonValue } from '@ejunz/ea/session/types'

import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@ejunz/ea/tools'

import type { JsonSchemaNode } from '@ejunz/ea/tools'

export interface HostCordisInspectQueryContext {
  /** Tool-call cancellation. */
  signal: AbortSignal
  /** Agent whose scoped runtime is being inspected. */
  agent: Agent
}

export interface HostCordisInspectProviderRegistration {
  /** Provider and explicit method directory. */
  manifest: CordisInspectProviderManifest
  /** Execute one declared method. */
  query(method: string, input: JsonValue | undefined, context: HostCordisInspectQueryContext): Promise<JsonValue>
}

interface PendingClientQuery {
  request: CordisInspectQueryRequest
  method: CordisInspectMethodManifest
  settle(resolution: CordisInspectQueryResolution): void
}

declare module '@ejunz/cordis' {
  interface Context {
    /** Host registry for Cordis inspect providers and Client manifest/query routing. */
    cordisInspect: CordisInspectRegistryService
  }
}

export class CordisInspectRegistryService extends Service {
  private readonly providers = new Map<string, HostCordisInspectProviderRegistration>()
  private readonly pending = new Map<CordisInspectRequestId, PendingClientQuery>()
  private clientManifest: readonly CordisInspectProviderManifest[] | undefined
  private nextRequest = 1

  /** Register the process-global Host registry. */
  constructor(ctx: Context) {
    super(ctx, 'cordisInspect')
  }

  /**
   * Register one Host provider.
   * @param registration - manifest and local query handler.
   * @returns idempotent disposer.
   */
  register(registration: HostCordisInspectProviderRegistration): () => void {
    const manifest = validateManifest(registration.manifest)
    if (this.providers.has(manifest.id)) throw new Error(`Host Cordis inspect provider "${manifest.id}" is already registered`)
    const stored = { ...registration, manifest }
    this.providers.set(manifest.id, stored)
    return () => {
      if (this.providers.get(manifest.id) === stored) this.providers.delete(manifest.id)
    }
  }

  /**
   * Replace the mirrored Client provider directory.
   * @param providers - complete Client manifest snapshot.
   */
  syncClientManifest(providers: readonly CordisInspectProviderManifest[]): void {
    const ids = new Set<string>()
    const validated = providers.map((provider) => {
      const manifest = validateManifest(provider)
      if (ids.has(manifest.id)) throw new Error(`Client Cordis inspect manifest repeats provider "${manifest.id}"`)
      ids.add(manifest.id)
      return manifest
    })
    this.clientManifest = Object.freeze(validated)
  }

  /**
   * Return the complete known Host and Client provider directory.
   * @returns Host providers followed by the Client providers.
   */
  list(): CordisInspectProviderView[] {
    return [
      ...[...this.providers.values()].map(provider => view('host', provider.manifest)),
      ...(this.clientManifest ?? []).map(provider => view('client', provider)),
    ]
  }

  /**
   * Execute one provider query on its owning platform.
   * @param platform - Host or Client runtime.
   * @param providerId - provider selected from {@link list}.
   * @param methodName - declared method name.
   * @param input - optional lossless JSON input.
   * @param agent - requesting Agent and scope.
   * @param signal - tool-call cancellation.
   * @returns provider JSON data.
   */
  async query(
    platform: CordisInspectPlatform,
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (platform === 'host') {
      const registration = this.providers.get(providerId)
      if (registration === undefined) throw new Error(`Host Cordis inspect provider "${providerId}" is not registered`)
      const method = findMethod(registration.manifest, methodName)
      validateInput('Host', providerId, method, input)
      signal.throwIfAborted()
      const data = await registration.query(methodName, input, { agent, signal })
      signal.throwIfAborted()
      return validateOutput('Host', providerId, method, data)
    }
    return await this.queryClient(providerId, methodName, input, agent, signal)
  }

  /**
   * Accept the first valid Client response for a pending query.
   * @param agent - Agent whose Session owns the query.
   * @param requestId - Pending Client query identity.
   * @param resolution - Client provider result or failure.
   * @returns whether this response settled the still-pending query.
   */
  resolveClientQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    const pending = this.pending.get(requestId)
    if (pending === undefined || pending.request.agentId !== agent.id) return { accepted: false }
    if (!resolution.ok) return { accepted: false }
    try {
      resolution = {
        ok: true,
        data: validateOutput('Client', pending.request.provider, pending.method, resolution.data),
      }
    } catch {
      return { accepted: false }
    }
    this.pending.delete(requestId)
    pending.settle(resolution)
    this.ctx.emit('@ejunz/cordis/inspect-query-resolved', { requestId })
    return { accepted: true }
  }

  private async queryClient(
    providerId: string,
    methodName: string,
    input: JsonValue | undefined,
    agent: Agent,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const provider = this.clientManifest?.find(candidate => candidate.id === providerId)
    if (provider === undefined) throw new Error(`Client Cordis inspect provider "${providerId}" is not registered`)
    const method = findMethod(provider, methodName)
    validateInput('Client', providerId, method, input)
    signal.throwIfAborted()
    const requestId = `inspect-${this.nextRequest++}` as CordisInspectRequestId
    const request: CordisInspectQueryRequest = {
      requestId,
      agentId: agent.id,
      provider: providerId,
      method: methodName,
      ...input === undefined ? {} : { input },
    }
    const result = new Promise<CordisInspectQueryResolution>((resolve) => {
      this.pending.set(requestId, { request, method, settle: resolve })
    })
    const onAbort = (): void => {
      const pending = this.pending.get(requestId)
      if (pending === undefined) return
      this.pending.delete(requestId)
      pending.settle({ ok: false, reason: 'cancelled', message: `Client inspect query ${providerId}.${methodName} was cancelled` })
      this.ctx.emit('@ejunz/cordis/inspect-query-resolved', { requestId })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    else this.ctx.emit('@ejunz/cordis/inspect-query', request)
    try {
      const resolution = await result
      if (!resolution.ok) throw new Error(`${providerId}.${methodName}: ${resolution.message}`)
      return resolution.data
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}

function view(platform: CordisInspectPlatform, manifest: CordisInspectProviderManifest): CordisInspectProviderView {
  return { platform, ...manifest, methods: [...manifest.methods] }
}

function validateManifest(manifest: CordisInspectProviderManifest): CordisInspectProviderManifest {
  if (manifest.id.trim() === '') throw new Error('Cordis inspect provider id must not be empty')
  if (manifest.description.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" needs a description`)
  const names = new Set<string>()
  const methods = manifest.methods.map((method) => {
    if (method.name.trim() === '') throw new Error(`Cordis inspect provider "${manifest.id}" has an empty method name`)
    if (names.has(method.name)) throw new Error(`Cordis inspect provider "${manifest.id}" repeats method "${method.name}"`)
    if (method.description.trim() === '') throw new Error(`Cordis inspect method ${manifest.id}.${method.name} needs a description`)
    assertSupportedJsonSchema(method.inputSchema)
    assertSupportedJsonSchema(method.outputSchema)
    names.add(method.name)
    return Object.freeze({ ...method })
  })
  return Object.freeze({ ...manifest, methods: Object.freeze(methods) })
}

function findMethod(manifest: CordisInspectProviderManifest, name: string): CordisInspectMethodManifest {
  const method = manifest.methods.find(candidate => candidate.name === name)
  if (method === undefined) throw new Error(`Cordis inspect provider "${manifest.id}" has no method "${name}"`)
  return method
}

function validateInput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  input: JsonValue | undefined,
): void {
  const violations = validateJsonSchemaValue(method.inputSchema as JsonSchemaNode, input ?? {}, 'input')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} rejected input: ${violations.join('; ')}`)
}

function validateOutput(
  platform: 'Host' | 'Client',
  provider: string,
  method: CordisInspectMethodManifest,
  data: JsonValue,
): JsonValue {
  const snapshot = snapshotJsonValue(data)
  if (snapshot === undefined) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned a non-JSON value`)
  const violations = validateJsonSchemaValue(method.outputSchema as JsonSchemaNode, snapshot, 'output')
  if (violations.length > 0) throw new Error(`${platform} Cordis inspect ${provider}.${method.name} returned invalid output: ${violations.join('; ')}`)
  return snapshot
}

import type { Context, Fiber, Plugin } from '@ejunz/cordis'

export async function startHostHalf(
  group: Fiber,
  plugin: Plugin,
  reportGuardFailure: (error: Error) => void,
): Promise<Fiber> {
  await group.await()
  const fiber = group.ctx.plugin(guardedPlugin(plugin, reportGuardFailure))
  try {
    await fiber.await()
  } catch (error) {
    await fiber.dispose()
    const message = error instanceof Error ? error.message : String(error)
    // The commonest startup collision is running a NEW version of a package
    // while the old run still holds the name — teach the replace recipe.
    if (message.includes('already registered')) {
      throw new Error(
        `${message} — to REPLACE something an earlier dynamic package registered, first cordis_stop that package's id `
        + '(find it with cordis_runtime_inspect what:"temporary"), then run the new version.',
      )
    }
    throw error instanceof Error ? error : new Error(message)
  }
  return fiber
}

export function missingServices(ctx: Context, fiber: Fiber): string[] {
  return Object.keys(fiber.inject).filter(service => ctx.get(service) === undefined)
}

import type { Fiber } from '@ejunz/cordis'

import type { SessionId } from '@ejunz/ea/session/types'

export type DynamicCordisHandler = (args: unknown) => Promise<unknown>

export interface DynamicCordisRun {
  /** Exact activation identity. */
  pluginRunId: CordisDynamicPluginRunId
  /** Immutable package version being run. */
  packageId: CordisDynamicPackageId
  /** Host-half Fiber, absent for Client-only packages. */
  fiber?: Fiber
  /** Active Host methods. */
  handlers: Map<string, DynamicCordisHandler>
  /** Method registration cleanup. */
  handlerDisposers: (() => void)[]
  /** Runtime failures already sent to the owning Agent during this activation. */
  reportedRuntimeErrors: Set<string>
  /** Last render failure observed for this version's current run. */
  renderFailure?: DynamicCordisRenderFailure
  /** Approval whose transition started this run, when model-driven. */
  startedForRequest?: ApprovalRequestId
}

export interface DynamicCordisDefinition {
  /** Package identity. */
  packageId: CordisDynamicPackageId
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** Host source. */
  hostCode?: string
  /** Client source. */
  clientCode?: string
}

export interface DynamicCordisPlugin {
  /** Stable identity. */
  pluginId: CordisDynamicPluginId
  /** Owning session. */
  sessionId: SessionId
  /** Versions in define order. */
  packages: Map<CordisDynamicPackageId, DynamicCordisDefinition>
  /** Client-bearing Packages individually authorized by the user. */
  approvedClientPackages: Set<CordisDynamicPackageId>
  /** Whether one user decision authorized future Package versions of this Plugin. */
  clientVersionUpdatesApproved: boolean
  /** Last successfully activated version. */
  currentPackageId?: CordisDynamicPackageId
  /** Failed or in-progress target version. */
  nextPackageId?: CordisDynamicPackageId
  /** Current activation. */
  run?: DynamicCordisRun
  /** Latest activation attempt, including approval and asynchronous failure state. */
  latestRun?: DynamicCordisRunAttempt
}

export interface DynamicCordisPendingRequest {
  /** Session whose model requested this activation. */
  agentId: SessionId
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  pluginRunId: CordisDynamicPluginRunId
  mode: CordisDynamicRunMode
  /** Whether this request must wait for an explicit user decision. */
  requiresApproval: boolean
}

export interface DynamicCordisDefineRequest {
  /** Session that owns the plugin. */
  sessionId: SessionId
  /** Create a plugin or append to an existing one. */
  plugin:
    | { kind: 'new'; idPrefix: string }
    | { kind: 'existing'; pluginId: CordisDynamicPluginId }
  /** Package label. */
  name: string
  /** User-facing purpose. */
  purpose: string
  /** At least one source half. */
  code: { host?: string; client?: string }
}

export interface DynamicCordisDefineReceipt {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  hasHostHalf: boolean
  hasClientHalf: boolean
}

export interface DynamicCordisReference {
  pluginId: CordisDynamicPluginId
  packageId: CordisDynamicPackageId
  name: string
  purpose: string
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  activeRun?: { pluginRunId: CordisDynamicPluginRunId; packageId: CordisDynamicPackageId }
  latestRun?: DynamicCordisRunAttempt
}

export interface DynamicCordisPluginInspection extends DynamicCordisReference {
  /** Immutable Package summaries in define order. */
  packages: Array<{
    packageId: CordisDynamicPackageId
    name: string
    purpose: string
    hasHostHalf: boolean
    hasClientHalf: boolean
  }>
}

export interface DynamicCordisPackageInspection extends DynamicCordisReference {
  /** Host and Client function bodies stored for this Package. */
  code: { host?: string; client?: string }
}

export class DynamicCordisRegistry {
  private readonly plugins = new Map<CordisDynamicPluginId, DynamicCordisPlugin>()
  private readonly pendingRequests = new Map<ApprovalRequestId, DynamicCordisPendingRequest>()
  private nextPlugin = 1
  private nextPackage = 1
  private nextRun = 1
  private nextApproval = 1

  /**
   * Mint a semantic plugin ID without reusing a prior suffix.
   * @param prefix - validated lowercase semantic prefix proposed by the model.
   * @returns a process-unique Plugin ID.
   */
  mintPluginId(prefix: string): string {
    let id: CordisDynamicPluginId
    do id = `${prefix}-${this.nextPlugin++}` as CordisDynamicPluginId
    while (this.plugins.has(id))
    return id
  }

  /**
   * Mint an immutable package ID.
   * @returns a process-unique Package ID.
   */
  mintPackageId(): string {
    return `pkg-${this.nextPackage++}`
  }

  /**
   * Mint an activation ID.
   * @returns a process-unique Plugin Run ID.
   */
  mintPluginRunId(): string {
    return `run-${this.nextRun++}`
  }

  /**
   * Mint an approval ID.
   * @returns a process-unique approval request ID.
   */
  mintApprovalRequestId(): string {
    return `approval-${this.nextApproval++}`
  }

  /**
   * Add one stable plugin.
   * @param plugin - Plugin record to retain under its stable ID.
   */
  add(plugin: DynamicCordisPlugin): void {
    this.plugins.set(plugin.pluginId, plugin)
  }

  /**
   * Read one plugin.
   * @param id - stable Plugin ID.
   * @returns the Plugin record, or `undefined` when absent.
   */
  get(id: CordisDynamicPluginId): DynamicCordisPlugin | undefined {
    return this.plugins.get(id)
  }

  /**
   * Delete one plugin and all package versions.
   * @param id - stable Plugin ID to remove.
   * @returns whether a Plugin record was removed.
   */
  delete(id: CordisDynamicPluginId): boolean {
    return this.plugins.delete(id)
  }

  /**
   * Read all plugins in creation order.
   * @returns a snapshot of every Plugin record.
   */
  all(): DynamicCordisPlugin[] {
    return [...this.plugins.values()]
  }

  /**
   * Read one session's plugins in creation order.
   * @param sessionId - owning session to filter by.
   * @returns a snapshot of matching Plugin records.
   */
  ofSession(sessionId: SessionId): DynamicCordisPlugin[] {
    return this.all().filter(plugin => plugin.sessionId === sessionId)
  }

  /**
   * Publish one pending approval.
   * @param id - approval request ID.
   * @param pending - resolver and Plugin metadata retained until settlement.
   */
  armRequest(id: ApprovalRequestId, pending: DynamicCordisPendingRequest): void {
    this.pendingRequests.set(id, pending)
  }

  /**
   * Read one pending approval without claiming it.
   * @param id - approval request ID.
   * @returns the pending request, or `undefined` when absent.
   */
  peekRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    return this.pendingRequests.get(id)
  }

  /**
   * Claim one pending approval; first answer wins.
   * @param id - approval request ID.
   * @returns the claimed request, or `undefined` when already settled.
   */
  claimRequest(id: ApprovalRequestId): DynamicCordisPendingRequest | undefined {
    const pending = this.pendingRequests.get(id)
    if (pending !== undefined) this.pendingRequests.delete(id)
    return pending
  }

  /**
   * Cancel one pending approval.
   * @param id - approval request ID to remove.
   */
  disarmRequest(id: ApprovalRequestId): void {
    this.pendingRequests.delete(id)
  }

  /**
   * Find a pending approval for one Plugin.
   * @param pluginId - stable Plugin ID.
   * @returns its approval request ID, or `undefined` when none is pending.
   */
  pendingRequestFor(pluginId: CordisDynamicPluginId): ApprovalRequestId | undefined {
    for (const [requestId, request] of this.pendingRequests) {
      if (request.pluginId === pluginId) return requestId
    }
    return undefined
  }
}

import { createContext, runInContext, Script } from 'node:vm'

export const HOST_BUILTIN_INSPECTION = [
  {
    name: 'ctx',
    description: 'Restricted Cordis Context. Prefer ctx.get(name) with an undefined check; use inject for hard dependencies.',
    signatures: [
      'ctx.get(name: string): unknown | undefined',
      'ctx.on(name: string, listener: Function): () => void',
      'ctx.provide(name: string, value: unknown): () => void',
      'ctx.effect(callback: Function, label?: string): () => void',
    ],
  },
  {
    name: 'ejunzAgent',
    description: 'Host helpers for Package-private Client RPC and model-visible dynamic Tools.',
    signatures: [
      'ejunzAgent.handle(method: string, handler: (args: JsonValue) => JsonValue | Promise<JsonValue>): () => void',
      'ejunzAgent.defineTool(definition: ToolDefinition): ToolDefinition',
      'ejunzAgent.registerTool(ctx: Context, tool: ToolDefinition): () => void',
    ],
  },
  { name: 'console', description: 'Package-tagged Host logging.', signatures: ['console.log(...values): void', 'console.error(...values): void'] },
  { name: 'btoa', description: 'Encode UTF-8 text as base64.', signatures: ['btoa(value: string): string'] },
  { name: 'atob', description: 'Decode base64 as UTF-8 text.', signatures: ['atob(value: string): string'] },
  { name: 'TextEncoder', description: 'Standard UTF-8 encoder constructor.', signatures: ['new TextEncoder()'] },
  { name: 'TextDecoder', description: 'Standard text decoder constructor.', signatures: ['new TextDecoder(label?: string)'] },
] as const

function taggedConsole(id: string): Record<'log' | 'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void> {
  const tag = `[cordis:${id}]`
  const log = (...args: unknown[]): void => { console.log(tag, ...args) }
  const error = (...args: unknown[]): void => { console.error(tag, ...args) }
  return { log, info: log, warn: log, debug: log, error }
}

const DUAL_REALM_INSTANCEOF_PRELUDE = `
(hostIntrinsics) => {
  'use strict'
  const ordinary = Function.prototype[Symbol.hasInstance]
  for (const name of Object.keys(hostIntrinsics)) {
    const VmCtor = globalThis[name]
    const HostCtor = hostIntrinsics[name]
    if (typeof VmCtor !== 'function' || typeof HostCtor !== 'function') continue
    Object.defineProperty(VmCtor, Symbol.hasInstance, {
      value: (instance) => ordinary.call(VmCtor, instance) || ordinary.call(HostCtor, instance),
      configurable: true,
    })
  }
}
`

function patchDualRealmInstanceof(sandbox: object): void {
  const patch = runInContext(DUAL_REALM_INSTANCEOF_PRELUDE, sandbox) as (intrinsics: Record<string, unknown>) => void
  patch({ Object, Array, Function, Error, TypeError, RangeError, SyntaxError, Promise, RegExp, Date, Map, Set })
}

const TIMER_REDIRECT
  = 'Node timers are unavailable. Use the cordis timer service instead: declare inject: [\'timer\'] on your plugin '
    + 'and call ctx.timeout / ctx.interval after querying Host Service.listService for the exact overloads. '
    + 'Those calls are fiber effects, cleaned up automatically when stopped.'

const NODE_API_REDIRECTS: Record<string, string> = {
  require:
    'Node modules are unavailable. Use the cordis services on ctx instead — e.g. inject: [\'fs\'] for files, '
    + '[\'web\'] for HTTP, [\'bash\'] for processes; query Service.listService with cordis_inspect_query first.',
  setTimeout: TIMER_REDIRECT,
  setInterval: TIMER_REDIRECT,
  setImmediate: TIMER_REDIRECT,
  clearTimeout: TIMER_REDIRECT,
  clearInterval: TIMER_REDIRECT,
  fetch:
    'Network access goes through the cordis web service: declare inject: [\'web\'] and call ctx.web '
    + '(query Host Service.listService with cordis_inspect_query for its methods).',
}

function nodeApiTraps(): Record<string, () => never> {
  const traps: Record<string, () => never> = {}
  for (const [name, redirect] of Object.entries(NODE_API_REDIRECTS)) {
    traps[name] = () => {
      throw new Error(`${name} is not available in the dynamic package sandbox — ${redirect}`)
    }
  }
  return traps
}

export function createSandbox(id: string, ejunzAgentExtras: Record<string, unknown> = {}): object {
  const sandbox = {
    ...nodeApiTraps(),
    console: taggedConsole(id),
    ejunzAgent: { defineTool: sandboxDefineTool, registerTool: sandboxRegisterTool, ...ejunzAgentExtras },
    // Web APIs absent from fresh vm contexts — made available so the model
    // can encode/decode base64 without Buffer (which is also absent). Host
    // closures over Buffer, never Buffer itself.
    btoa: (s: string) => Buffer.from(s, 'utf-8').toString('base64'),
    atob: (s: string) => Buffer.from(s, 'base64').toString('utf-8'),
    TextEncoder,
    TextDecoder,
  }
  createContext(sandbox)
  patchDualRealmInstanceof(sandbox)
  return sandbox
}

function isSyntaxError(error: unknown): error is Error {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'SyntaxError'
}

export function syntaxErrorContext(error: Error): string {
  const lines = (error.stack ?? '').split('\n')
  const messageIndex = lines.findIndex(line => line.startsWith('SyntaxError'))
  if (messageIndex === -1) return String(error)
  return lines.slice(0, messageIndex + 1).join('\n')
}

export function parseErrorMessage(half: 'code.host' | 'code.client', context: string): string {
  // Scope the TypeScript heuristic to the OFFENDING line, not the whole code:
  // an ` as ` inside an ordinary description string must not turn a plain
  // syntax error into a misleading remove-annotations message.
  const offendingLine = context.split('\n')[1] ?? ''
  if (/\bas\b/.test(offendingLine)) {
    return `dynamic package \`${half}\` failed to parse:\n${context}\n`
      + 'The sandbox runs plain JavaScript, not TypeScript. Remove type annotations:\n'
      + '  ✗ { type: \'text\' as const, text: x }\n'
      + '  ✓ { type: \'text\', text: x }'
  }
  return `dynamic package \`${half}\` failed to parse:\n${context}\n`
    + 'Note: it runs as the BODY of an async function (line numbers are offset by the 1-line wrapper). '
    + 'Check bracket balance — ending the returned plugin object with `});` closes a call that was never opened; '
    + 'a plain `return { … }` ends with `}` (an optional `;`), never `)`.'
}

export function precheckCode(code: string, half: 'code.host' | 'code.client'): void {
  try {
    // Compile-only: constructing the Script parses the source and runs nothing.
    new Script(`(async () => {\n${code}\n})()`, { filename: `cordis-dyn-${half}.js` })
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage(half, syntaxErrorContext(error)))
  }
}

export async function evaluateHostCode(sandbox: object, code: string, id: string, vmTimeoutMs: number): Promise<unknown> {
  try {
    return await runInContext(
      `(async () => {\n${code}\n})()`,
      sandbox,
      { filename: `cordis-dyn-${id}.js`, timeout: vmTimeoutMs },
    )
  } catch (error) {
    if (!isSyntaxError(error)) throw error
    throw new Error(parseErrorMessage('code.host', syntaxErrorContext(error)))
  }
}

import { Context } from '@ejunz/cordis'

import type { Fiber } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import type { Agent } from '@ejunz/ea/agent'

import { createUserMessage } from '@ejunz/ea/llm'

import type { JsonValue } from '@ejunz/ea/session/types'

import { TypertRemoteService, Remote } from '@ejunz/ea/typert-protocol'

export function CordisDynamicPluginId(id: string): CordisDynamicPluginId {
  return id as CordisDynamicPluginId
}

export function CordisDynamicPackageId(id: string): CordisDynamicPackageId {
  return id as CordisDynamicPackageId
}

export function CordisDynamicPluginRunId(id: string): CordisDynamicPluginRunId {
  return id as CordisDynamicPluginRunId
}

export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

declare module '@ejunz/cordis' {
  interface Context {
    /** Process-local dynamic Plugin registry and lifecycle service. */
    dynamicCordisRunner: DynamicCordisRunnerService
  }
}

export interface Config {
  /** Maximum synchronous VM evaluation time in milliseconds. */
  vmTimeoutMs?: number
}

type ResolvedConfig = Required<Config>

export interface DynamicCordisSnapshotRow {
  pluginId: CordisDynamicPluginId
  currentPackageId?: CordisDynamicPackageId
  nextPackageId?: CordisDynamicPackageId
  packages: Array<{
    packageId: CordisDynamicPackageId
    name: string
    purpose: string
    hasHostHalf: boolean
    hasClientHalf: boolean
  }>
  activeRun?: {
    pluginRunId: CordisDynamicPluginRunId
    packageId: CordisDynamicPackageId
    fiber?: Fiber
    handlers: string[]
    renderFailure?: DynamicCordisRenderFailure
  }
  latestRun?: DynamicCordisRunAttempt
}

interface ActivationPlan {
  plugin: DynamicCordisPlugin
  definition: DynamicCordisDefinition
  mode: CordisDynamicRunMode
}

export class DynamicCordisRunnerService extends TypertRemoteService {
  static inject = ['tools']

  static Config: z<Config> = z.object({
    vmTimeoutMs: z.number().min(1).default(5000),
  })

  private readonly rootCtx: Context
  private readonly registry = new DynamicCordisRegistry()
  private readonly inspectRegistry: CordisInspectRegistryService
  private readonly starting = new Map<CordisDynamicPluginId, Promise<DynamicCordisHostHalfResult>>()
  private readonly resolved: ResolvedConfig
  private group: Fiber | undefined

  /** Create the service under the Host composition. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'dynamicCordisRunner')
    this.rootCtx = ctx
    this.resolved = config as ResolvedConfig
    this.inspectRegistry = new CordisInspectRegistryService(ctx)
  }

  /**
   * Define a new Plugin's first Package or append a Package to an existing Plugin.
   * @param request - Session ownership, Plugin selection, metadata, and source code.
   * @returns Host-minted Plugin and Package identities with declared-half metadata.
   */
  define(request: DynamicCordisDefineRequest): DynamicCordisDefineReceipt {
    const name = request.name.trim()
    const purpose = request.purpose.trim()
    if (name.length === 0) throw new Error('cordis_define needs a non-empty `name`')
    if (purpose.length === 0) throw new Error('cordis_define needs a non-empty `purpose`')
    if (request.code.host === undefined && request.code.client === undefined) {
      throw new Error('cordis_define needs `code.host`, `code.client`, or both')
    }
    if (request.code.host !== undefined) precheckCode(request.code.host, 'code.host')
    if (request.code.client !== undefined) precheckCode(request.code.client, 'code.client')

    let plugin: DynamicCordisPlugin
    if (request.plugin.kind === 'new') {
      const prefix = request.plugin.idPrefix.trim()
      if (!/^[a-z]{3,6}$/.test(prefix)) {
        throw new Error('cordis_define `plugin.idPrefix` must contain 3–6 lowercase English letters')
      }
      const pluginId = CordisDynamicPluginId(this.registry.mintPluginId(prefix))
      plugin = {
        pluginId,
        sessionId: request.sessionId,
        packages: new Map(),
        approvedClientPackages: new Set(),
        clientVersionUpdatesApproved: false,
      }
      this.registry.add(plugin)
    } else {
      const found = this.registry.get(request.plugin.pluginId)
      if (found === undefined || found.sessionId !== request.sessionId) {
        throw new Error(missingPluginMessage(request.plugin.pluginId))
      }
      plugin = found
    }

    const packageId = CordisDynamicPackageId(this.registry.mintPackageId())
    const definition: DynamicCordisDefinition = {
      packageId,
      name,
      purpose,
      ...request.code.host === undefined ? {} : { hostCode: request.code.host },
      ...request.code.client === undefined ? {} : { clientCode: request.code.client },
    }
    plugin.packages.set(packageId, definition)
    return {
      pluginId: plugin.pluginId,
      packageId,
      name,
      purpose,
      hasHostHalf: definition.hostCode !== undefined,
      hasClientHalf: definition.clientCode !== undefined,
    }
  }

  /**
   * Remove a Plugin, its active run, and all immutable Packages.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity to remove.
   * @returns Whether removal succeeded and whether it stopped an active run.
   */
  async undefine(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisUndefineReceipt> {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) }
    const wasRunning = plugin.run !== undefined
    this.cancelPending(pluginId, `dynamic plugin "${pluginId}" was removed before approval`)
    if (plugin.run !== undefined) await this.retract(plugin)
    this.registry.delete(pluginId)
    return { ok: true, wasRunning }
  }

  /**
   * Remove a Plugin from the user panel and queue the resulting state change for the model's next step.
   * @param agent - Agent whose Session owns the Plugin and receives the context.
   * @param pluginId - Stable Plugin identity to remove.
   * @returns Whether removal succeeded and whether it stopped an active run.
   */
  @Remote('undefineFromPanel')
  async undefineFromPanel(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisUndefineReceipt> {
    const result = await this.undefine(agent, pluginId)
    if (result.ok) {
      this.injectUserContext(
        agent,
        `The user removed Cordis Plugin ${pluginId} and all of its Packages. The Plugin no longer exists.`,
      )
    }
    return result
  }

  /**
   * Start or update one Package for a model tool call. An unauthorized Client
   * Package waits for approval; Plugin-wide authorization covers later versions.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity to activate.
   * @param packageId - Immutable Package version to activate.
   * @param mode - Whether to run the current version or switch versions.
   * @param signal - Tool-call cancellation signal while the activation request is being created.
   * @returns The successful activation identity or an actionable refusal.
   */
  async run(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
    mode: CordisDynamicRunMode,
    signal?: AbortSignal,
  ): Promise<DynamicCordisRunResponse> {
    const plan = this.resolvePlan(agent, pluginId, packageId, mode)
    if (!plan.ok) return plan.response
    if (signal?.aborted === true) {
      return {
        ok: false,
        reason: 'cancelled',
        message: `the run request for dynamic plugin "${pluginId}" was cancelled before activation`,
      }
    }
    if (this.registry.pendingRequestFor(pluginId) !== undefined) {
      return { ok: false, reason: 'transition-in-flight', message: `dynamic plugin "${pluginId}" already has a pending run request` }
    }
    const attempt = this.createAttempt(plan)
    plan.plugin.nextPackageId = packageId
    plan.plugin.latestRun = attempt
    if (plan.definition.clientCode === undefined) {
      const started = await this.activate(plan, undefined, false, attempt)
      if (started.ok) return this.runResponse(plan.plugin, started)
      this.failAttempt(plan.plugin, attempt, 'host-load', started)
      return { ...started, reason: 'host-half-failed' }
    }

    const requestId = ApprovalRequestId(this.registry.mintApprovalRequestId())
    const requiresApproval = !plan.plugin.clientVersionUpdatesApproved
      && !plan.plugin.approvedClientPackages.has(packageId)
    attempt.approvalRequestId = requestId
    attempt.requiresApproval = requiresApproval
    attempt.status = requiresApproval ? 'awaiting-approval' : 'starting-host'
    this.registry.armRequest(requestId, {
      agentId: agent.id,
      pluginId,
      packageId,
      pluginRunId: attempt.pluginRunId,
      mode,
      requiresApproval,
    })
    this.ctx.emit('@ejunz/cordis/request-run', {
      requestId,
      agentId: agent.id,
      pluginId,
      packageId,
      mode,
      name: plan.definition.name,
      purpose: plan.definition.purpose,
      requiresApproval,
    })
    return {
      ok: true,
      status: requiresApproval ? 'awaiting-approval' : 'starting',
      pluginId,
      packageId,
      pluginRunId: attempt.pluginRunId,
      mode,
      waitingFor: [],
      ...plan.plugin.currentPackageId === undefined ? {} : { currentPackageId: plan.plugin.currentPackageId },
      nextPackageId: packageId,
    }
  }

  /**
   * Start Host code for an approved request or a direct panel gesture.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity to activate.
   * @param packageId - Immutable Package version to activate.
   * @param mode - Whether to run the current version or switch versions.
   * @param requestId - Model-driven request identity, or null for a direct user gesture.
   * @param approveFutureVersions - Whether this approval covers later Packages of the same Plugin.
   * @returns The exact Host activation or a failure message.
   */
  @Remote('runHostHalf')
  async runHostHalf(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
    mode: CordisDynamicRunMode,
    requestId: ApprovalRequestId | null,
    approveFutureVersions: boolean,
  ): Promise<DynamicCordisHostHalfResult> {
    const plan = this.resolvePlan(agent, pluginId, packageId, mode, requestId === null)
    if (!plan.ok) return { ok: false, message: plan.response.message }
    let attempt: DynamicCordisRunAttempt
    if (requestId !== null) {
      const pending = this.registry.peekRequest(requestId)
      if (pending === undefined || pending.pluginId !== pluginId || pending.packageId !== packageId || pending.mode !== mode) {
        return { ok: false, message: `run request "${requestId}" does not authorize ${pluginId}/${packageId}` }
      }
      const latest = plan.plugin.latestRun
      const expectedStatus = pending.requiresApproval ? 'awaiting-approval' : 'starting-host'
      if (latest === undefined || latest.pluginRunId !== pending.pluginRunId
        || (latest.status !== expectedStatus && (!pending.requiresApproval && latest.status !== 'client-pending'))) {
        return { ok: false, message: `run request "${requestId}" no longer identifies the latest run of ${pluginId}` }
      }
      attempt = latest
      if (pending.requiresApproval) {
        plan.plugin.approvedClientPackages.add(packageId)
        if (approveFutureVersions) plan.plugin.clientVersionUpdatesApproved = true
      }
    } else {
      const pending = this.registry.pendingRequestFor(pluginId)
      if (pending !== undefined) return { ok: false, message: `dynamic plugin "${pluginId}" has pending run request ${pending}` }
      const attached = plan.plugin.run?.packageId === packageId
        && plan.plugin.latestRun?.pluginRunId === plan.plugin.run.pluginRunId
        ? plan.plugin.latestRun
        : undefined
      attempt = attached ?? this.createAttempt(plan)
      if (attached === undefined) {
        plan.plugin.nextPackageId = packageId
        plan.plugin.latestRun = attempt
      }
      if (plan.definition.clientCode !== undefined) plan.plugin.approvedClientPackages.add(packageId)
    }
    const attaching = attempt.pluginRunId === plan.plugin.run?.pluginRunId
    if (!attaching) {
      attempt.status = 'starting-host'
      if (attempt.host.status !== 'absent') attempt.host = { status: 'pending', waitingFor: [] }
    }
    const started = await this.activate(plan, requestId ?? undefined, attaching, attempt)
    if (!started.ok) this.failAttempt(plan.plugin, attempt, 'host-load', started)
    return started
  }

  /**
   * Fetch Client code for the exact active run.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity to read.
   * @param pluginRunId - Exact active run authorized to receive source.
   * @returns Client source and its Plugin, Package, and run identities.
   */
  @Remote('getClientCode')
  getClientCode(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
  ): DynamicCordisClientSource {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) throw new Error(missingPluginMessage(pluginId))
    const run = plugin.run
    if (run === undefined || run.pluginRunId !== pluginRunId) {
      throw new Error(`dynamic plugin "${pluginId}" is not running activation "${pluginRunId}"`)
    }
    const definition = plugin.packages.get(run.packageId)
    if (definition?.clientCode === undefined) throw new Error(`package "${run.packageId}" has no Client half`)
    return {
      code: definition.clientCode,
      name: definition.name,
      pluginId,
      packageId: run.packageId,
      pluginRunId,
    }
  }

  /**
   * Resolve one model-driven Client activation request.
   * @param requestId - Request identity to settle once.
   * @param resolution - Browser refusal or exact Client activation result.
   * @returns Whether the still-pending request accepted this resolution.
   */
  @Remote('resolveRequestRun')
  async resolveRequestRun(
    requestId: ApprovalRequestId,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisResolveAck> {
    const pending = this.registry.peekRequest(requestId)
    if (pending === undefined) return { accepted: false }
    const plugin = this.registry.get(pending.pluginId)
    if (resolution.ok && plugin?.run?.pluginRunId !== resolution.pluginRunId) return { accepted: false }
    if (!resolution.ok && resolution.pluginRunId !== undefined
      && plugin?.run?.pluginRunId !== resolution.pluginRunId) return { accepted: false }
    this.registry.claimRequest(requestId)
    const settled = await this.settleActivation(plugin, resolution, requestId)
    this.announceResolved(requestId, resolution, pending.requiresApproval ? undefined : 'completed')
    this.steerRunOutcome(pending, settled)
    return { accepted: true }
  }

  /**
   * Settle a direct panel run after this page loaded or failed its Client half.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity being settled.
   * @param resolution - Exact Client activation result from the acting page.
   * @returns The committed activation or its failure.
   */
  @Remote('settleUserRun')
  async settleUserRun(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    resolution: DynamicCordisRunResolution,
  ): Promise<DynamicCordisRunResponse> {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) }
    const settled = await this.settleActivation(plugin, resolution)
    this.injectUserRunOutcome(agent, pluginId, settled)
    return settled
  }

  /**
   * Stop the active run while retaining every Package version.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity to stop.
   * @returns Success or the reason no run was stopped.
   */
  async stop(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisStopResponse> {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) }
    const pending = this.registry.pendingRequestFor(pluginId)
    if (plugin.run === undefined && pending === undefined) {
      return { ok: false, reason: 'not-running', message: `dynamic plugin "${pluginId}" is not running` }
    }
    if (pending !== undefined) this.cancelPending(pluginId, `dynamic plugin "${pluginId}" was stopped before approval`)
    if (plugin.run !== undefined) await this.retract(plugin)
    if (plugin.latestRun !== undefined) {
      plugin.latestRun.status = 'stopped'
      if (plugin.latestRun.host.status !== 'absent') plugin.latestRun.host = { status: 'stopped', waitingFor: [] }
      if (plugin.latestRun.client.status !== 'absent') plugin.latestRun.client = { status: 'stopped', waitingFor: [] }
    }
    return { ok: true }
  }

  /**
   * Stop a Plugin from the user panel and queue the resulting state change for the model's next step.
   * @param agent - Agent whose Session owns the Plugin and receives the context.
   * @param pluginId - Stable Plugin identity to stop.
   * @returns Success or the reason no run was stopped.
   */
  @Remote('stopFromPanel')
  async stopFromPanel(agent: Agent, pluginId: CordisDynamicPluginId): Promise<DynamicCordisStopResponse> {
    const result = await this.stop(agent, pluginId)
    if (!result.ok) return result
    const plugin = this.owned(agent, pluginId)
    this.injectUserContext(
      agent,
      `The user stopped Cordis Plugin ${pluginId}. Its Packages remain defined; currentPackageId is `
        + `${plugin?.currentPackageId ?? 'none'}.`,
    )
    return result
  }

  /**
   * Replace the Host mirror of the Client inspect provider directory.
   * @param providers - complete Client provider manifest.
   * @returns null after accepting the manifest.
   */
  @Remote('syncInspectManifest')
  syncInspectManifest(providers: readonly CordisInspectProviderManifest[]): null {
    this.inspectRegistry.syncClientManifest(providers)
    return null
  }

  /**
   * Claim one pending Client inspect query with its live result.
   * @param agent - Session that owns the query.
   * @param requestId - exact pending query identity.
   * @param resolution - provider result or structured refusal.
   * @returns whether this answer won the query.
   */
  @Remote('resolveInspectQuery')
  resolveInspectQuery(
    agent: Agent,
    requestId: CordisInspectRequestId,
    resolution: CordisInspectQueryResolution,
  ): CordisInspectResolveAck {
    return this.inspectRegistry.resolveClientQuery(agent, requestId, resolution)
  }

  /**
   * Frame-wide inventory, grouped as one row per stable Plugin.
   * @returns Source-free metadata for every process-local Plugin.
   */
  /* jscpd:ignore-start */
  @Remote('inventory')
  inventory(): DynamicCordisInventoryRow[] {
    return this.registry.all().map(plugin => ({
      pluginId: plugin.pluginId,
      agentId: plugin.sessionId,
      packages: [...plugin.packages.values()].map(definition => ({
        packageId: definition.packageId,
        name: definition.name,
        purpose: definition.purpose,
        hasHostHalf: definition.hostCode !== undefined,
        hasClientHalf: definition.clientCode !== undefined,
      })),
      ...plugin.currentPackageId === undefined ? {} : { currentPackageId: plugin.currentPackageId },
      ...plugin.nextPackageId === undefined ? {} : { nextPackageId: plugin.nextPackageId },
      ...plugin.run === undefined ? {} : {
        activeRun: { pluginRunId: plugin.run.pluginRunId, packageId: plugin.run.packageId },
      },
      ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
    }))
  }
  /* jscpd:ignore-end */

  /**
   * Read one Session's Host-rich state for inspection and result rendering.
   * @param agent - Agent whose Session selects visible Plugins.
   * @returns Plugin versions, active runs, Host fibers, and render failures.
   */
  snapshot(agent: Agent): DynamicCordisSnapshotRow[] {
    return this.registry.ofSession(agent.id).map(plugin => ({
      pluginId: plugin.pluginId,
      ...plugin.currentPackageId === undefined ? {} : { currentPackageId: plugin.currentPackageId },
      ...plugin.nextPackageId === undefined ? {} : { nextPackageId: plugin.nextPackageId },
      packages: [...plugin.packages.values()].map(definition => ({
        packageId: definition.packageId,
        name: definition.name,
        purpose: definition.purpose,
        hasHostHalf: definition.hostCode !== undefined,
        hasClientHalf: definition.clientCode !== undefined,
      })),
      ...plugin.run === undefined ? {} : {
        activeRun: {
          pluginRunId: plugin.run.pluginRunId,
          packageId: plugin.run.packageId,
          ...plugin.run.fiber === undefined ? {} : { fiber: plugin.run.fiber },
          handlers: [...plugin.run.handlers.keys()],
          ...plugin.run.renderFailure === undefined ? {} : { renderFailure: plugin.run.renderFailure },
        },
      },
      ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
    }))
  }

  /**
   * Read source-free context for an explicit `@pluginId` user gesture.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity referenced by the user.
   * @returns The preferred modification base, or undefined when unavailable.
   */
  reference(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisReference | undefined {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return undefined
    const packageId = plugin.nextPackageId
      ?? plugin.currentPackageId
      ?? [...plugin.packages.keys()].at(-1)
    if (packageId === undefined) return undefined
    const definition = plugin.packages.get(packageId)
    if (definition === undefined) return undefined
    return {
      pluginId,
      packageId,
      name: definition.name,
      purpose: definition.purpose,
      ...plugin.currentPackageId === undefined ? {} : { currentPackageId: plugin.currentPackageId },
      ...plugin.nextPackageId === undefined ? {} : { nextPackageId: plugin.nextPackageId },
      ...plugin.run === undefined ? {} : {
        activeRun: { pluginRunId: plugin.run.pluginRunId, packageId: plugin.run.packageId },
      },
      ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
    }
  }

  /**
   * List source-free Plugin summaries owned by one Session.
   * @param agent - Agent whose Session selects visible Plugins.
   * @returns one summary per Plugin in creation order.
   */
  listPlugins(agent: Agent): DynamicCordisPluginInspection[] {
    return this.registry.ofSession(agent.id).map(plugin => this.inspectPlugin(agent, plugin.pluginId))
  }

  /**
   * Inspect one Plugin without returning Package source.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - stable Plugin identity.
   * @returns version pointers, latest run, and all Package summaries.
   */
  inspectPlugin(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPluginInspection {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) throw new Error(missingPluginMessage(pluginId))
    const reference = this.reference(agent, pluginId)
    if (reference === undefined) throw new Error(`dynamic plugin "${pluginId}" has no package`)
    return {
      ...reference,
      packages: [...plugin.packages.values()].map(definition => ({
        packageId: definition.packageId,
        name: definition.name,
        purpose: definition.purpose,
        hasHostHalf: definition.hostCode !== undefined,
        hasClientHalf: definition.clientCode !== undefined,
      })),
    }
  }

  /**
   * Read one exact immutable Package and its Host and Client source.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity that owns the Package.
   * @param packageId - Exact immutable Package identity to inspect.
   * @returns Package metadata, source, and the Plugin's lifecycle pointers.
   */
  inspectPackage(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
  ): DynamicCordisPackageInspection {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) throw new Error(missingPluginMessage(pluginId))
    const definition = plugin.packages.get(packageId)
    if (definition === undefined) {
      throw new Error(`dynamic package "${packageId}" does not exist on plugin "${pluginId}"`)
    }
    return {
      pluginId,
      packageId,
      name: definition.name,
      purpose: definition.purpose,
      code: {
        ...definition.hostCode === undefined ? {} : { host: definition.hostCode },
        ...definition.clientCode === undefined ? {} : { client: definition.clientCode },
      },
      /* jscpd:ignore-start */
      ...plugin.currentPackageId === undefined ? {} : { currentPackageId: plugin.currentPackageId },
      ...plugin.nextPackageId === undefined ? {} : { nextPackageId: plugin.nextPackageId },
      ...plugin.run === undefined ? {} : {
        activeRun: { pluginRunId: plugin.run.pluginRunId, packageId: plugin.run.packageId },
      },
      ...plugin.latestRun === undefined ? {} : { latestRun: cloneAttempt(plugin.latestRun) },
      /* jscpd:ignore-end */
    }
  }

  /**
   * Record a post-load render failure for the exact active run.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity that rendered.
   * @param pluginRunId - Exact active run that produced the failure.
   * @param failure - Slot, message, and entry-retirement result.
   * @returns Null after recording or ignoring a stale report.
   */
  @Remote('reportRenderFailure')
  async reportRenderFailure(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    failure: DynamicCordisRenderFailure,
  ): Promise<null> {
    const plugin = this.owned(agent, pluginId)
    if (plugin?.run?.pluginRunId === pluginRunId) {
      const run = plugin.run
      const definition = plugin.packages.get(plugin.run.packageId)
      const shouldSteer = run.renderFailure === undefined
      run.renderFailure = failure
      const attempt = plugin.latestRun
      if (attempt?.pluginRunId === pluginRunId) {
        attempt.error = this.diagnostic(plugin, attempt, 'client-render', failure)
        attempt.client = { status: 'failed', waitingFor: attempt.client.waitingFor, error: failure.message }
        attempt.status = 'failed'
      }
      if (definition !== undefined && shouldSteer) {
        this.steerRenderFailure(agent, plugin, definition, pluginRunId, failure)
      }
    }
    return await Promise.resolve(null)
  }

  /**
   * Report a Client guard rejection that happened after the Package completed activation.
   * @param agent - Agent whose Session must own the Plugin.
   * @param pluginId - Stable Plugin identity whose Client code was rejected.
   * @param pluginRunId - Exact active run that produced the rejection.
   * @param failure - Original guard message and stack.
   * @returns Null after reporting or ignoring a stale/startup failure.
   */
  @Remote('reportClientGuardFailure')
  async reportClientGuardFailure(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    failure: CordisErrorDetails,
  ): Promise<null> {
    const plugin = this.owned(agent, pluginId)
    const run = plugin?.run
    if (plugin !== undefined && run?.pluginRunId === pluginRunId) {
      this.steerGuardFailure(plugin, run, 'Client', failure)
    }
    return await Promise.resolve(null)
  }

  /**
   * Invoke an active Host method while rejecting stale Client runs.
   * @param pluginId - Stable Plugin identity that owns the method.
   * @param pluginRunId - Exact active run authorizing the call.
   * @param method - Registered Host handler name.
   * @param args - JSON argument delivered to the handler.
   * @returns The JSON result or a typed invocation failure.
   */
  @Remote('invoke')
  async invoke(
    pluginId: CordisDynamicPluginId,
    pluginRunId: CordisDynamicPluginRunId,
    method: string,
    args: JsonValue,
  ): Promise<DynamicCordisInvokeResult> {
    const plugin = this.registry.get(pluginId)
    if (plugin === undefined || plugin.run === undefined) {
      return { ok: false, code: 'plugin-not-running', message: `dynamic plugin "${pluginId}" is not running` }
    }
    const run = plugin.run
    if (run.pluginRunId !== pluginRunId) {
      return { ok: false, code: 'stale-run', message: `activation "${pluginRunId}" is no longer active` }
    }
    const handler = run.handlers.get(method)
    if (handler === undefined) {
      return { ok: false, code: 'method-not-found', message: `dynamic plugin "${pluginId}" registered no Host method "${method}"` }
    }
    try {
      return { ok: true, value: await handler(args) as JsonValue }
    } catch (error) {
      const failure = errorDetails(error)
      this.steerHostHandlerFailure(plugin, run, method, failure)
      return { ok: false, code: 'handler-error', ...failure }
    }
  }

  private resolvePlan(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    packageId: CordisDynamicPackageId,
    mode: CordisDynamicRunMode,
    allowActiveAttach = false,
  ): { ok: true } & ActivationPlan | { ok: false; response: Extract<DynamicCordisRunResponse, { ok: false }> } {
    const plugin = this.owned(agent, pluginId)
    if (plugin === undefined) return { ok: false, response: { ok: false, reason: 'plugin-missing', message: missingPluginMessage(pluginId) } }
    const definition = plugin.packages.get(packageId)
    if (definition === undefined) {
      return { ok: false, response: { ok: false, reason: 'package-missing', message: `plugin "${pluginId}" has no package "${packageId}"` } }
    }
    const current = plugin.currentPackageId
    if (mode === 'update' && (current === undefined || current === packageId)) {
      return {
        ok: false,
        response: {
          ok: false,
          reason: 'invalid-mode',
          message: current === undefined
            ? `plugin "${pluginId}" has no successful version yet; start "${packageId}" with mode "run"`
            : `package "${packageId}" is already current; use mode "run"`,
        },
      }
    }
    if (mode === 'run' && current !== undefined && current !== packageId) {
      return {
        ok: false,
        response: {
          ok: false,
          reason: 'invalid-mode',
          message: `package "${packageId}" differs from current "${current}"; use mode "update"`,
        },
      }
    }
    if (!allowActiveAttach && this.starting.has(pluginId)) {
      return { ok: false, response: { ok: false, reason: 'transition-in-flight', message: `plugin "${pluginId}" is already starting` } }
    }
    return { ok: true, plugin, definition, mode }
  }

  private activate(
    plan: ActivationPlan,
    requestId: ApprovalRequestId | undefined,
    allowActiveAttach: boolean,
    attempt: DynamicCordisRunAttempt,
  ): Promise<DynamicCordisHostHalfResult> {
    const inFlight = this.starting.get(plan.plugin.pluginId)
    if (inFlight !== undefined) return inFlight
    const starting = this.startFresh(plan, requestId, allowActiveAttach, attempt)
    this.starting.set(plan.plugin.pluginId, starting)
    return starting.finally(() => { this.starting.delete(plan.plugin.pluginId) })
  }

  private async startFresh(
    plan: ActivationPlan,
    requestId: ApprovalRequestId | undefined,
    allowActiveAttach: boolean,
    attempt: DynamicCordisRunAttempt,
  ): Promise<DynamicCordisHostHalfResult> {
    const { plugin, definition, mode } = plan
    if (allowActiveAttach
      && plugin.run?.packageId === definition.packageId
      && plugin.run.pluginRunId === attempt.pluginRunId) {
      return {
        ok: true,
        pluginId: plugin.pluginId,
        packageId: definition.packageId,
        pluginRunId: plugin.run.pluginRunId,
        waitingFor: missingFor(this.ctx, plugin.run),
        startedHere: false,
      }
    }
    if (plugin.run !== undefined) await this.retract(plugin)
    if (mode === 'update' || plugin.currentPackageId === undefined) plugin.nextPackageId = definition.packageId
    const run: DynamicCordisRun = {
      pluginRunId: attempt.pluginRunId,
      packageId: definition.packageId,
      handlers: new Map(),
      handlerDisposers: [],
      reportedRuntimeErrors: new Set(),
      ...requestId === undefined ? {} : { startedForRequest: requestId },
    }
    if (definition.hostCode !== undefined) {
      const failure = await this.startHost(plugin, definition.hostCode, run)
      if (failure !== undefined) return { ok: false, ...failure }
    }
    plugin.run = run
    this.ctx.emit('@ejunz/cordis/dynamic-package', {
      pluginId: plugin.pluginId,
      packageId: definition.packageId,
      pluginRunId: run.pluginRunId,
      name: definition.name,
    })
    attempt.host = {
      status: run.fiber === undefined ? 'absent' : missingFor(this.ctx, run).length === 0 ? 'running' : 'waiting',
      waitingFor: missingFor(this.ctx, run),
    }
    if (definition.clientCode === undefined) {
      this.commitActivation(plugin, run)
    } else {
      attempt.status = 'client-pending'
      attempt.client = { status: 'pending', waitingFor: [] }
    }
    return {
      ok: true,
      pluginId: plugin.pluginId,
      packageId: definition.packageId,
      pluginRunId: run.pluginRunId,
      waitingFor: missingFor(this.ctx, run),
      startedHere: true,
    }
  }

  private async startHost(
    plugin: DynamicCordisPlugin,
    hostCode: string,
    run: DynamicCordisRun,
  ): Promise<CordisErrorDetails | undefined> {
    const handle = (method: unknown, fn: unknown): (() => void) => {
      const normalized = normalizeHandler(method, fn)
      run.handlers.set(normalized.method, normalized.handler)
      const dispose = (): void => {
        if (run.handlers.get(normalized.method) === normalized.handler) run.handlers.delete(normalized.method)
      }
      run.handlerDisposers.push(dispose)
      return dispose
    }
    try {
      const sandbox = createSandbox(plugin.pluginId, { handle })
      const evaluated = await evaluateHostCode(sandbox, hostCode, plugin.pluginId, this.resolved.vmTimeoutMs)
      if (!isPlugin(evaluated)) {
        throw new Error(evaluated === undefined
          ? 'the Host half returned `undefined` — did you forget `return`?'
          : 'the Host half must return a Plugin function or an object with apply(ctx)')
      }
      run.fiber = await startHostHalf(
        this.requireGroup(),
        evaluated,
        (error) => { this.steerGuardFailure(plugin, run, 'Host', errorDetails(error)) },
      )
      return undefined
    } catch (error) {
      for (const dispose of run.handlerDisposers.splice(0)) dispose()
      return errorDetails(error)
    }
  }

  private async settleActivation(
    plugin: DynamicCordisPlugin | undefined,
    resolution: DynamicCordisRunResolution,
    requestId?: ApprovalRequestId,
  ): Promise<DynamicCordisRunResponse> {
    if (plugin === undefined) return { ok: false, reason: 'plugin-missing', message: 'the dynamic plugin was removed during activation' }
    const attempt = plugin.latestRun
    if (!resolution.ok) {
      if (resolution.reason === 'rejected') {
        if (attempt !== undefined) {
          attempt.status = 'rejected'
          attempt.error = this.diagnostic(plugin, attempt, 'approval', resolution.message ?? 'the run request was declined')
          attempt.client = { status: 'stopped', waitingFor: [] }
        }
        return { ok: false, reason: 'rejected', message: resolution.message ?? 'the run request was declined' }
      }
      const run = plugin.run
      const ownsRun = run !== undefined
        && resolution.pluginRunId === run.pluginRunId
        && (requestId === undefined || run.startedForRequest === requestId)
        && resolution.startedHere !== false
      if (ownsRun) await this.retract(plugin)
      if (attempt !== undefined && (resolution.pluginRunId === undefined || attempt.pluginRunId === resolution.pluginRunId)) {
        this.failAttempt(
          plugin,
          attempt,
          resolution.reason === 'host-half-failed' ? 'host-apply' : 'client-apply',
          {
            message: resolution.message ?? resolution.reason,
            ...resolution.stack === undefined ? {} : { stack: resolution.stack },
          },
        )
      }
      return {
        ok: false,
        reason: resolution.reason,
        message: resolution.message ?? resolution.reason,
        ...resolution.stack === undefined ? {} : { stack: resolution.stack },
      }
    }
    const run = plugin.run
    if (run === undefined || run.pluginRunId !== resolution.pluginRunId) {
      return { ok: false, reason: 'client-half-failed', message: `activation "${resolution.pluginRunId}" is no longer active` }
    }
    if (attempt !== undefined && attempt.pluginRunId === run.pluginRunId) {
      attempt.client = {
        status: resolution.waitingFor === undefined || resolution.waitingFor.length === 0 ? 'running' : 'waiting',
        waitingFor: resolution.waitingFor ?? [],
      }
    }
    this.commitActivation(plugin, run)
    return {
      ...this.runResponse(plugin, {
        ok: true,
        pluginId: plugin.pluginId,
        packageId: run.packageId,
        pluginRunId: run.pluginRunId,
        waitingFor: missingFor(this.ctx, run),
        startedHere: false,
      }),
      ...resolution.waitingFor === undefined ? {} : { clientWaitingFor: resolution.waitingFor },
    }
  }

  private commitActivation(plugin: DynamicCordisPlugin, run: DynamicCordisRun): void {
    plugin.currentPackageId = run.packageId
    delete plugin.nextPackageId
    delete run.startedForRequest
    const attempt = plugin.latestRun
    if (attempt?.pluginRunId === run.pluginRunId) {
      attempt.status = attempt.host.status === 'waiting' || attempt.client.status === 'waiting' ? 'waiting' : 'running'
      delete attempt.approvalRequestId
      delete attempt.requiresApproval
      delete attempt.error
    }
  }

  private runResponse(
    plugin: DynamicCordisPlugin,
    started: Extract<DynamicCordisHostHalfResult, { ok: true }>,
  ): Extract<DynamicCordisRunResponse, { ok: true }> {
    return {
      ok: true,
      status: 'running',
      pluginId: plugin.pluginId,
      packageId: started.packageId,
      pluginRunId: started.pluginRunId,
      waitingFor: started.waitingFor,
      currentPackageId: started.packageId,
      mode: plugin.latestRun?.pluginRunId === started.pluginRunId ? plugin.latestRun.mode : 'run',
    }
  }

  private announceResolved(
    requestId: ApprovalRequestId,
    resolution: DynamicCordisRunResolution,
    override?: RequestRunOutcome,
  ): void {
    const outcome = override ?? (resolution.ok ? 'approved' : resolution.reason === 'rejected' ? 'rejected' : 'failed')
    this.ctx.emit('@ejunz/cordis/request-run-resolved', { requestId, outcome })
  }

  private steerRunOutcome(
    pending: DynamicCordisPendingRequest,
    settled: DynamicCordisRunResponse,
  ): void {
    const agents = this.rootCtx.get('agents')
    const agent = agents?.get(pending.agentId)
    if (agent === undefined) return
    const plugin = this.registry.get(pending.pluginId)
    const identity = `${pending.pluginId}/${pending.packageId} (${pending.pluginRunId})`
    let text: string
    if (settled.ok) {
      text = `Cordis ${pending.mode} ${identity} completed successfully. `
        + `currentPackageId is ${settled.currentPackageId ?? pending.packageId}. Continue using the running Plugin.`
    } else if (settled.reason === 'rejected') {
      text = `The user rejected Cordis ${pending.mode} ${identity}. `
        + 'Do not request the same activation again unless the user asks.'
    } else {
      const returnedStatus = pending.requiresApproval ? 'awaiting-approval' : 'starting'
      text = `Cordis ${pending.mode} ${identity} failed after cordis_run returned ${returnedStatus}: `
        + `${settled.reason}\n${formatErrorDetails(settled)}\n`
        + `currentPackageId: ${plugin?.currentPackageId ?? 'none'}\n`
        + `nextPackageId: ${plugin?.nextPackageId ?? pending.packageId}\n`
        + 'Inspect the failed Package, correct it on the same Plugin when needed, and retry the activation autonomously.'
    }
    agent.steer(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'cordis-host-runner' },
    }))
  }

  private steerRenderFailure(
    agent: Agent,
    plugin: DynamicCordisPlugin,
    definition: DynamicCordisDefinition,
    pluginRunId: CordisDynamicPluginRunId,
    failure: DynamicCordisRenderFailure,
  ): void {
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: `Cordis Client UI ${plugin.pluginId}/${definition.packageId} (${pluginRunId}) failed while rendering `
          + `Slot "${failure.slot}" after activation.\n`
          + `${formatErrorDetails(failure)}\n`
          + `entryAbdicated: ${failure.abdicated}\n`
          + 'Inspect the failed Package, fix the Client code by defining a new Package on the same Plugin, and '
          + 'activate that Package autonomously with cordis_run mode:"update".',
      }],
      source: { kind: 'plugin', plugin: 'cordis-host-runner' },
    }))
  }

  private steerHostHandlerFailure(
    plugin: DynamicCordisPlugin,
    run: DynamicCordisRun,
    method: string,
    failure: CordisErrorDetails,
  ): void {
    const reportKey = `Host\u0000handler\u0000${method}\u0000${failure.message}`
    if (!this.claimRuntimeFailure(plugin, run, reportKey)) return
    const agents = this.rootCtx.get('agents')
    const agent = agents?.get(plugin.sessionId)
    if (agent === undefined) return
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: `Cordis Host handler ${plugin.pluginId}/${run.packageId} (${run.pluginRunId}) failed when the Client called `
          + `host.call(${JSON.stringify(method)}).\n`
          + `${formatErrorDetails(failure)}\n`
          + 'The Plugin remains running. Inspect this Package, correct the Host code on the same Plugin, and activate '
          + 'the new Package autonomously with cordis_run mode:"update". If the handler needs a Service, either declare '
          + 'that Service in the returned Plugin inject list or read it with ctx.get(name) and handle undefined.',
      }],
      source: { kind: 'plugin', plugin: 'cordis-host-runner' },
    }))
  }

  /* jscpd:ignore-start */
  private steerGuardFailure(
    plugin: DynamicCordisPlugin,
    run: DynamicCordisRun,
    platform: 'Host' | 'Client',
    failure: CordisErrorDetails,
  ): void {
    const reportKey = `${platform}\u0000guard\u0000${failure.message}`
    if (!this.claimRuntimeFailure(plugin, run, reportKey)) return
    const agents = this.rootCtx.get('agents')
    const agent = agents?.get(plugin.sessionId)
    if (agent === undefined) return
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: `Cordis ${platform} guard rejected runtime code in ${plugin.pluginId}/${run.packageId} `
          + `(${run.pluginRunId}) after activation.\n${formatErrorDetails(failure)}\n`
          + 'The Plugin remains running. Inspect this Package, define a corrected Package on the same Plugin, and '
          + 'activate it autonomously with cordis_run mode:"update".',
      }],
      source: { kind: 'plugin', plugin: 'cordis-host-runner' },
    }))
  }
  /* jscpd:ignore-end */

  private claimRuntimeFailure(plugin: DynamicCordisPlugin, run: DynamicCordisRun, key: string): boolean {
    const attempt = plugin.latestRun
    if (plugin.run !== run || attempt?.pluginRunId !== run.pluginRunId
      || (attempt.status !== 'running' && attempt.status !== 'waiting')) return false
    if (run.reportedRuntimeErrors.has(key)) return false
    run.reportedRuntimeErrors.add(key)
    return true
  }

  private injectUserRunOutcome(
    agent: Agent,
    pluginId: CordisDynamicPluginId,
    settled: DynamicCordisRunResponse,
  ): void {
    const plugin = this.owned(agent, pluginId)
    let text: string
    if (settled.ok) {
      text = `The user manually ran Cordis Plugin ${pluginId}, Package ${settled.packageId}, `
        + `as ${settled.pluginRunId}. The activation succeeded; currentPackageId is ${settled.currentPackageId}.`
    } else {
      const attempt = plugin?.latestRun
      text = `The user manually ran Cordis Plugin ${pluginId}`
        + `${attempt === undefined ? '' : `, Package ${attempt.packageId}, as ${attempt.pluginRunId}`}, but it failed: `
        + `${settled.reason}\n${formatErrorDetails(settled)}\n`
        + `currentPackageId: ${plugin?.currentPackageId ?? 'none'}\n`
        + `nextPackageId: ${plugin?.nextPackageId ?? 'none'}`
    }
    this.injectUserContext(agent, text)
  }

  private injectUserContext(agent: Agent, text: string): void {
    const agents = this.rootCtx.get('agents')
    if (agents?.get(agent.id) !== agent) return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'cordis-host-runner' },
    }))
  }

  private cancelPending(pluginId: CordisDynamicPluginId, message: string): void {
    const requestId = this.registry.pendingRequestFor(pluginId)
    if (requestId === undefined) return
    const pending = this.registry.claimRequest(requestId)
    if (pending === undefined) return
    const plugin = this.registry.get(pluginId)
    if (plugin?.latestRun?.pluginRunId === pending.pluginRunId) {
      plugin.latestRun.status = 'cancelled'
      plugin.latestRun.error = this.diagnostic(plugin, plugin.latestRun, 'approval', message)
      delete plugin.latestRun.approvalRequestId
      delete plugin.latestRun.requiresApproval
    }
    this.announceResolved(requestId, { ok: false, reason: 'rejected' }, 'cancelled')
  }

  private createAttempt(plan: ActivationPlan): DynamicCordisRunAttempt {
    return {
      pluginRunId: CordisDynamicPluginRunId(this.registry.mintPluginRunId()),
      packageId: plan.definition.packageId,
      mode: plan.mode,
      status: 'starting-host',
      host: {
        status: plan.definition.hostCode === undefined ? 'absent' : 'pending',
        waitingFor: [],
      },
      client: {
        status: plan.definition.clientCode === undefined ? 'absent' : 'pending',
        waitingFor: [],
      },
    }
  }

  private failAttempt(
    plugin: DynamicCordisPlugin,
    attempt: DynamicCordisRunAttempt,
    phase: NonNullable<DynamicCordisRunAttempt['error']>['phase'],
    failure: CordisErrorDetails,
  ): void {
    attempt.status = 'failed'
    attempt.error = this.diagnostic(plugin, attempt, phase, failure)
    if (phase.startsWith('host')) attempt.host = { status: 'failed', waitingFor: [], error: failure.message }
    else attempt.client = { status: 'failed', waitingFor: [], error: failure.message }
  }

  private diagnostic(
    plugin: DynamicCordisPlugin,
    attempt: DynamicCordisRunAttempt,
    phase: NonNullable<DynamicCordisRunAttempt['error']>['phase'],
    failure: CordisErrorDetails | string,
  ): NonNullable<DynamicCordisRunAttempt['error']> {
    const details = typeof failure === 'string' ? { message: failure } : failure
    return {
      phase,
      ...details,
      pluginId: plugin.pluginId,
      packageId: attempt.packageId,
      pluginRunId: attempt.pluginRunId,
    }
  }

  private async retract(plugin: DynamicCordisPlugin): Promise<void> {
    const run = plugin.run
    if (run === undefined) return
    delete plugin.run
    for (const dispose of run.handlerDisposers.splice(0)) dispose()
    if (run.fiber !== undefined) await run.fiber.dispose()
    this.ctx.emit('@ejunz/cordis/dynamic-retract', {
      pluginId: plugin.pluginId,
      packageId: run.packageId,
      pluginRunId: run.pluginRunId,
    })
  }

  private owned(agent: Agent, pluginId: CordisDynamicPluginId): DynamicCordisPlugin | undefined {
    const plugin = this.registry.get(pluginId)
    return plugin?.sessionId === agent.id ? plugin : undefined
  }

  private requireGroup(): Fiber {
    this.group ??= this.rootCtx.plugin({ name: 'cordis-dynamic', apply: () => {} })
    return this.group
  }
}

function missingFor(ctx: Context, run: DynamicCordisRun): string[] {
  return run.fiber === undefined ? [] : missingServices(ctx, run.fiber)
}

function missingPluginMessage(id: CordisDynamicPluginId): string {
  return `no dynamic plugin "${id}" in this process — it may have been removed or lost on EA restart`
}

function errorDetails(error: unknown): CordisErrorDetails {
  if (typeof error !== 'object' || error === null) return { message: String(error) }
  const message = 'message' in error && typeof error.message === 'string'
    ? error.message
    : Object.prototype.toString.call(error)
  const stack = 'stack' in error && typeof error.stack === 'string' ? error.stack : undefined
  return { message, ...stack === undefined ? {} : { stack } }
}

function formatErrorDetails(failure: CordisErrorDetails): string {
  return `message: ${failure.message}`
    + (failure.stack === undefined ? '' : `\nstack:\n${failure.stack}`)
}

function cloneAttempt(attempt: DynamicCordisRunAttempt): DynamicCordisRunAttempt {
  return {
    ...attempt,
    host: { ...attempt.host, waitingFor: [...attempt.host.waitingFor] },
    client: { ...attempt.client, waitingFor: [...attempt.client.waitingFor] },
    ...attempt.error === undefined ? {} : { error: { ...attempt.error } },
  }
}

export default DynamicCordisRunnerService

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/cordis-host-runner'
  export const name = 'cordis-host-runner-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
