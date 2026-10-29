import type { ContentBlock } from '@ejunz/ea-core/llm'

export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

export interface FileLocation {
  path: string
  line?: number
}

export interface FileDiff {
  path: string
  /** Prior content, or `null` for a new file / an overwrite (no prior content available at call time). */
  oldText: string | null
  /** Content after the change. */
  newText: string
}

export type ToolCallView = GenericCallView | TerminalCallView | DiffCallView

export interface GenericCallView {
  card: 'generic'
  /**
   * Human-readable, always-visible label describing what THIS call does. Keep it
   * short — a UI shows it as a card header / log line.
   */
  title: string
  /** Category for icon/treatment; defaults to `other` when omitted. */
  kind?: ToolCallKind
  /**
   * The salient input to show in a detail/expanded view (e.g. a background
   * job id). Omit to show nothing; a string renders as-is, an object as pretty
   * JSON. NOT the full raw args object unless that is genuinely what a reader wants.
   */
  rawInput?: unknown
  /**
   * UI-facing content blocks to show on the pending call alongside the title.
   * Omit to show none. A UI maps these to its own content blocks.
   */
  content?: ContentBlock[]
  /** Files this call reads/modifies, for editor follow-along. Omit for a call that touches no file. */
  locations?: FileLocation[]
}

export interface TerminalCallView {
  card: 'terminal'
  /** The command, shown as the terminal card's title / header line. */
  title: string
  /**
   * A human-readable one-line summary of what the command does, rendered ABOVE
   * the terminal card (the card itself has no description slot). Omit for none.
   */
  description?: string
  /**
   * Working directory the command runs in, shown as the terminal header. An
   * ABSOLUTE path is used as-is; a RELATIVE path is resolved by the UI bridge
   * against the session's working directory (the pure presenter cannot see its cwd).
   * Omit entirely to let the bridge use that directory.
   */
  cwd?: string
}

export interface DiffCallView {
  card: 'diff'
  /** Card header (e.g. `Write foo.txt`). */
  title: string
  /** One entry per file the call changes. */
  diffs: FileDiff[]
  /** Files this call modifies, for editor follow-along (usually the diffs' paths). */
  locations?: FileLocation[]
}

export interface ReadFileLine {
  number: number
  text: string
}

export type ToolResultView = GenericResultView | TerminalResultView | DiffResultView | SearchResultView | ReadResultView | WebResultView

export interface GenericResultView {
  card: 'generic'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /**
   * UI-facing result content (ejunzAgent {@link ContentBlock}s), reformatted from
   * the model-facing result. Omit to let the UI render the raw result content.
   */
  content?: ContentBlock[]
}

export interface TerminalResultView {
  card: 'terminal'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** Captured command output (stdout+stderr as the tool chooses to combine them). */
  output?: string
  /**
   * Process exit code, when the run ended by exiting (not a signal). Lets a
   * capable UI show an exit-status pill. Omit when killed by a signal or unknown.
   */
  exitCode?: number
  /** Signal name that killed the process (e.g. `SIGTERM`). Mutually exclusive with `exitCode`. */
  signal?: string
}

export interface DiffResultView {
  card: 'diff'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The change to show, in file order — applied contextual hunks, or a whole-file diff when there is no before-image. */
  diffs: FileDiff[]
}

export interface SearchLineMatch {
  /** 1-based line number of the match within its file. */
  lineNumber: number
  /** The matched line text, as the tool surfaced it (the per-line preview budget already applied). */
  line: string
}

export interface SearchFileMatches {
  /** The file the matches belong to (the model-facing display path). */
  path: string
  /** The file's matched lines, in output order. */
  matches: SearchLineMatch[]
}

export interface SearchMatchesResultView {
  card: 'search'
  shape: 'matches'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** Matched lines grouped by file, in first-seen file order. */
  files: SearchFileMatches[]
  /**
   * Whether the tool capped the inline result: `files` carries only the retained
   * matches, not every match the search found. A UI shows a capped indicator so it
   * never presents a partial group as complete.
   */
  truncated: boolean
  /** Total matches the search found before capping (equals the retained count when not `truncated`). */
  total: number
}

export interface SearchPathsResultView {
  card: 'search'
  shape: 'paths'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The discovered paths, in the tool's result order (the retained page when `truncated`). */
  paths: string[]
  /**
   * Whether the tool capped the inline result: `paths` carries only the retained
   * page, not every path the search found. A UI shows a capped indicator so it
   * never presents a partial list as complete.
   */
  truncated: boolean
  /** Total paths the search found before capping (equals `paths.length` when not `truncated`). */
  total: number
}

export type SearchResultView = SearchMatchesResultView | SearchPathsResultView

export interface ReadResultView {
  card: 'read'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The read file's path (the model-facing path; the bridge relativizes it). */
  path: string
  /**
   * The 1-based first line the window requested, preserved even when `lines` is
   * empty (a byte cap below the first selected line yields an empty window) so a
   * UI knows where the window starts and where a continuation resumes.
   */
  offset: number
  /** The returned window's lines, in file order, each keeping its file line number. */
  lines: ReadFileLine[]
  /** Exact total line count in the file, so a UI can show a "showing N of M" affordance. */
  totalLines: number
  /**
   * A syntax-highlighting language hint derived from the file extension (e.g.
   * `ts`, `py`), or omitted when the extension maps to no known language so a UI
   * renders the lines as plain text.
   */
  lang?: string
  /**
   * The model-facing result content with its envelope stripped, for a UI without
   * the read capability. Omit to let such a UI render the raw result content.
   */
  content?: ContentBlock[]
}

export interface WebSource {
  /** The source URL. */
  url: string
  /** The source title, when the provider returned one. */
  title?: string
  /** A short excerpt or summary, when the provider returned one. */
  snippet?: string
  /** Publication/crawl timestamp as a provider-supplied ISO-8601 string, when present. */
  publishedAt?: string
}

export type WebResultView = WebSearchResultView | WebFetchResultView

export interface WebSearchResultView {
  card: 'web'
  kind: 'search'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The faithful, structured sources — the field render text cannot losslessly carry. */
  sources: WebSource[]
  /** The provider-generated answer text, when any. */
  answer?: string
  /** True when the web service cut the source list to honor the result cap. */
  truncated: boolean
}

export interface WebFetchResultView {
  card: 'web'
  kind: 'fetch'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** The final URL after allowed redirects. */
  url: string
  /** HTTP status code of the fetched response. */
  statusCode: number
  /**
   * True when the provider capped the decoded body, or the output cap or a
   * pre-conversion source cut trimmed the rendered text (the effective
   * truncation the model-facing text also reflects).
   */
  truncated: boolean
}

import { assertNever, EjunzAgentError } from '@ejunz/ea-core/llm'

import { isJsonValue, type JsonValue } from '@ejunz/ea-core/session'

export type JsonSchemaScalar = string | number | boolean | null

export type JsonSchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'

type JsonSchemaScalarType = Exclude<JsonSchemaType, 'object' | 'array'>

export interface JsonSchemaNode {
  /** Omit with no constraints for any JSON value, or use `oneOf`. */
  type?: JsonSchemaType
  /** Exactly one branch must validate; at least two branches are required. */
  oneOf?: JsonSchemaNode[]
  /** Nested property schemas (`type: 'object'` only). */
  properties?: Record<string, JsonSchemaNode>
  /** Required property names; each must appear in `properties`. */
  required?: string[]
  /** `false` rejects undeclared keys; absent/`true` follows JSON Schema's open default. */
  additionalProperties?: boolean
  /** Item schema (`type: 'array'` only); absent accepts any JSON item. */
  items?: JsonSchemaNode
  /** Allowed values for a scalar node. */
  enum?: JsonSchemaScalar[]
  /** The single allowed value for a scalar node. */
  const?: JsonSchemaScalar
  /** Annotation, ignored for validation. */
  description?: string
  /** Annotation, ignored for validation. */
  title?: string
  /** Annotation, ignored for validation but required to be lossless JSON. */
  default?: JsonValue
  /** Annotation, ignored for validation but required to be lossless JSON. */
  examples?: JsonValue
}

export type ObjectJsonSchema = JsonSchemaNode & { type: 'object' }

export class JsonSchemaError extends EjunzAgentError {
  /** Individual schema violations in walk order. */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`unsupported JSON schema: ${violations.join('; ')}`, 'UNSUPPORTED_SCHEMA')
    this.name = 'JsonSchemaError'
    this.violations = violations
  }
}

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

const SCHEMA_TYPES: readonly JsonSchemaType[] = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

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

function isIntrinsicObjectPrototype(value: object): boolean {
  return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, 'Object')
}

export function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  try {
    const prototype: unknown = Object.getPrototypeOf(value)
    return prototype === null
      || typeof prototype === 'object' && isIntrinsicObjectPrototype(prototype)
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
    && isIntrinsicObjectPrototype(objectPrototype)
}

function hasOnlyEnumerableStringKeys(value: object): boolean {
  try {
    return Reflect.ownKeys(value)
      .every(key => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key))
  } catch {
    return false
  }
}

export function isJsonSchemaRecord(value: unknown): value is Record<string, unknown> {
  return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value)
}

export function isPlainJsonArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false
  try {
    if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return false
    }
    return true
  } catch {
    return false
  }
}

function isJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function scalarMatches(type: JsonSchemaScalarType, value: unknown): value is JsonSchemaScalar {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return isJsonNumber(value)
    case 'integer': return isJsonNumber(value) && Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    /* v8 ignore next -- JsonSchemaScalarType is closed; this retains compile-time exhaustiveness. */
    default: return assertNever(type, 'JsonSchemaType')
  }
}

type SchemaWalkTask =
  | { kind: 'enter'; node: unknown; path: string }
  | { kind: 'leave'; node: object }
  | { kind: 'one-of-tail'; node: Record<string, unknown>; path: string }
  | { kind: 'object-tail'; node: Record<string, unknown>; path: string; properties: unknown }

const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'] as const

function checkObjectSchemaTail(
  node: Record<string, unknown>,
  path: string,
  properties: unknown,
  violations: string[],
): void {
  const hasRequired = Object.hasOwn(node, 'required')
  const required = hasRequired ? node.required : undefined
  if (hasRequired) {
    if (!isPlainJsonArray(required) || required.some(entry => typeof entry !== 'string')) {
      violations.push(`${path}.required must be an array of strings`)
    } else {
      const declared = isJsonSchemaRecord(properties) ? properties : {}
      for (const key of required as string[]) {
        if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`)
      }
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
}

function checkSchemaNode(root: unknown, rootPath: string, violations: string[], seen: Set<object>): void {
  const tasks: SchemaWalkTask[] = [{ kind: 'enter', node: root, path: rootPath }]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      seen.delete(task.node)
      continue
    }
    if (task.kind === 'one-of-tail') {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`)
      }
      continue
    }
    if (task.kind === 'object-tail') {
      checkObjectSchemaTail(task.node, task.path, task.properties, violations)
      continue
    }

    const { node, path } = task
    if (!isJsonSchemaRecord(node)) {
      violations.push(`${path} must be a schema object`)
      continue
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`)
      continue
    }
    seen.add(node)
    tasks.push({ kind: 'leave', node })

    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue
      if (ANNOTATION_KEYWORDS.has(key)) {
        try {
          if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`)
        } catch {
          violations.push(`${path}.${key} annotation must be lossless JSON data`)
        }
        continue
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`)
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') {
      violations.push(`${path}.description must be a string`)
    }
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') {
      violations.push(`${path}.title must be a string`)
    }

    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`)
      continue
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`)
      }
      continue
    }

    if (hasOneOf) {
      const oneOf = node.oneOf
      tasks.push({ kind: 'one-of-tail', node, path })
      if (!isPlainJsonArray(oneOf) || oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        for (let index = oneOf.length - 1; index >= 0; index--) {
          tasks.push({ kind: 'enter', node: oneOf[index], path: `${path}.oneOf[${index}]` })
        }
      }
      continue
    }

    const type = node.type
    if (typeof type !== 'string' || !(SCHEMA_TYPES as readonly unknown[]).includes(type)) {
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      continue
    }
    const schemaType = type as JsonSchemaType
    const allowedFor: Record<string, JsonSchemaType[]> = {
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    }
    for (const [key, types] of Object.entries(allowedFor)) {
      if (Object.hasOwn(node, key) && !types.includes(schemaType)) {
        violations.push(`${path}.${key} is not supported on type "${schemaType}"`)
      }
    }

    switch (schemaType) {
      case 'object': {
        const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined
        tasks.push({ kind: 'object-tail', node, path, properties })
        if (Object.hasOwn(node, 'properties')) {
          if (!isJsonSchemaRecord(properties)) {
            violations.push(`${path}.properties must be an object of schemas`)
          } else {
            const entries = Object.entries(properties)
            for (let index = entries.length - 1; index >= 0; index--) {
              const entry = entries[index]
              /* v8 ignore next -- the loop is bounded by the captured entry count. */
              if (entry === undefined) continue
              tasks.push({ kind: 'enter', node: entry[1], path: `${path}.properties.${entry[0]}` })
            }
          }
        }
        break
      }
      case 'array': {
        if (Object.hasOwn(node, 'items')) tasks.push({ kind: 'enter', node: node.items, path: `${path}.items` })
        break
      }
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null': {
        const hasEnum = Object.hasOwn(node, 'enum')
        const allowed = hasEnum ? node.enum : undefined
        const enumValid = isPlainJsonArray(allowed)
          && allowed.length > 0
          && allowed.every(entry => scalarMatches(schemaType, entry))
        if (hasEnum && !enumValid) {
          violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`)
        }
        const hasConst = Object.hasOwn(node, 'const')
        const declaredConst = hasConst ? node.const : undefined
        const constValid = scalarMatches(schemaType, declaredConst)
        if (hasConst) {
          if (!constValid) {
            violations.push(`${path}.const must be a ${schemaType} value`)
          } else if (enumValid && !allowed.includes(declaredConst)) {
            violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
          }
        }
        break
      }
      /* v8 ignore next -- schemaType was narrowed from the closed SCHEMA_TYPES table above. */
      default: assertNever(schemaType, 'JsonSchemaType')
    }
  }
}

export function assertSupportedJsonSchema(schema: unknown): asserts schema is JsonSchemaNode {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

export function assertObjectJsonSchema(schema: unknown): asserts schema is ObjectJsonSchema {
  const violations: string[] = []
  checkSchemaNode(schema, 'schema', violations, new Set())
  if (violations.length === 0
    && (!isJsonSchemaRecord(schema) || !Object.hasOwn(schema, 'type') || schema.type !== 'object')) {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  if (violations.length > 0) throw new JsonSchemaError(violations)
}

function safelyIsJsonValue(value: unknown): boolean {
  try {
    return isJsonValue(value)
  } catch {
    return false
  }
}

function diagnosticPath(path: string): string {
  return path === '' ? 'arguments' : path
}

function propertyPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`
}

interface ValueChild {
  readonly node: JsonSchemaNode
  readonly value: unknown
  readonly path: string
}

interface ValueFrame {
  readonly node: JsonSchemaNode
  readonly value: unknown
  readonly path: string
  catches: boolean
  phase: 'start' | 'children'
  kind?: 'oneOf' | 'object' | 'array'
  children: ValueChild[]
  childIndex: number
  violations: string[]
  tailViolations: string[]
  matches: number
}

function losslessValueViolation(path: string): string[] {
  return [`"${diagnosticPath(path)}" must be a lossless JSON value`]
}

function appendViolations(target: string[], source: readonly string[]): void {
  for (const violation of source) target.push(violation)
}

function valueFrame(node: JsonSchemaNode, value: unknown, path: string): ValueFrame {
  return {
    node,
    value,
    path,
    catches: false,
    phase: 'start',
    children: [],
    childIndex: 0,
    violations: [],
    tailViolations: [],
    matches: 0,
  }
}

function checkScalarValue(node: JsonSchemaNode, value: unknown, path: string): string[] {
  const allowed = Object.hasOwn(node, 'enum') ? node.enum : undefined
  if (allowed !== undefined && !allowed.includes(value as JsonSchemaScalar)) {
    return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`]
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) {
    return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`]
  }
  return []
}

function checkValue(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  const frames: ValueFrame[] = [valueFrame(schema, value, path)]
  let rootResult: string[] | undefined

  const receive = (result: string[]): void => {
    const parent = frames.at(-1)
    if (parent === undefined) {
      rootResult = result
      return
    }
    if (parent.kind === 'oneOf') {
      if (result.length === 0) parent.matches++
    } else {
      appendViolations(parent.violations, result)
    }
  }
  const finish = (result: string[]): void => {
    frames.pop()
    receive(result)
  }

  while (frames.length > 0) {
    const frame = frames.at(-1)
    /* v8 ignore next -- the loop condition guarantees a current frame. */
    if (frame === undefined) break
    try {
      if (frame.phase === 'children') {
        if (frame.childIndex < frame.children.length) {
          const child = frame.children[frame.childIndex]
          /* v8 ignore next -- childIndex is bounded by children.length. */
          if (child === undefined) throw new Error('missing schema-value child frame')
          frame.childIndex++
          frames.push(valueFrame(child.node, child.value, child.path))
          continue
        }
        if (frame.kind === 'oneOf') {
          finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`])
          continue
        }
        appendViolations(frame.violations, frame.tailViolations)
        if (frame.violations.length > 0) {
          finish(frame.violations)
        } else if (frame.kind === 'object') {
          finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`])
        } else {
          finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`])
        }
        continue
      }

      const nodeType = Object.hasOwn(frame.node, 'type') ? frame.node.type : undefined
      frame.catches = !(nodeType !== undefined && !(SCHEMA_TYPES as readonly unknown[]).includes(nodeType))
      const oneOf = Object.hasOwn(frame.node, 'oneOf') ? frame.node.oneOf : undefined
      if (oneOf !== undefined) {
        frame.kind = 'oneOf'
        frame.children = Array.from(oneOf, branch => ({ node: branch, value: frame.value, path: frame.path }))
        frame.childIndex = 0
        frame.matches = 0
        frame.phase = 'children'
        continue
      }
      if (nodeType === undefined) {
        finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path))
        continue
      }

      switch (nodeType) {
        case 'object': {
          if (!isPlainJsonRecord(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an object`])
            break
          }
          const properties = Object.hasOwn(frame.node, 'properties') ? frame.node.properties ?? {} : {}
          const violations: string[] = []
          const required = Object.hasOwn(frame.node, 'required') ? frame.node.required ?? [] : []
          for (const key of required) {
            if (!Object.hasOwn(frame.value, key) || frame.value[key] === undefined) {
              violations.push(`missing required property "${propertyPath(frame.path, key)}"`)
            }
          }
          const children: ValueChild[] = []
          for (const [key, child] of Object.entries(properties)) {
            if (!Object.hasOwn(frame.value, key) || frame.value[key] === undefined) continue
            children.push({ node: child, value: frame.value[key], path: propertyPath(frame.path, key) })
          }
          const tailViolations: string[] = []
          if (Object.hasOwn(frame.node, 'additionalProperties') && frame.node.additionalProperties === false) {
            for (const key of Object.keys(frame.value)) {
              if (!Object.hasOwn(properties, key)) {
                tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`)
              }
            }
          }
          frame.kind = 'object'
          frame.children = children
          frame.childIndex = 0
          frame.violations = violations
          frame.tailViolations = tailViolations
          frame.phase = 'children'
          break
        }
        case 'array': {
          if (!Array.isArray(frame.value)) {
            finish([`"${diagnosticPath(frame.path)}" must be an array`])
            break
          }
          const items = Object.hasOwn(frame.node, 'items') ? frame.node.items : undefined
          const children = items === undefined
            ? []
            : frame.value.flatMap((entry, index): ValueChild[] => [{ node: items, value: entry, path: `${frame.path}[${index}]` }])
          frame.kind = 'array'
          frame.children = children
          frame.childIndex = 0
          frame.violations = []
          frame.phase = 'children'
          break
        }
        case 'string':
          finish(typeof frame.value === 'string'
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be a string`])
          break
        case 'number':
          finish(typeof frame.value !== 'number'
            ? [`"${diagnosticPath(frame.path)}" must be a number`]
            : !isJsonNumber(frame.value)
              ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`]
              : checkScalarValue(frame.node, frame.value, frame.path))
          break
        case 'integer':
          finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value)
            ? [`"${diagnosticPath(frame.path)}" must be an integer`]
            : checkScalarValue(frame.node, frame.value, frame.path))
          break
        case 'boolean':
          finish(typeof frame.value === 'boolean'
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be a boolean`])
          break
        case 'null':
          finish(frame.value === null
            ? checkScalarValue(frame.node, frame.value, frame.path)
            : [`"${diagnosticPath(frame.path)}" must be null`])
          break
        default:
          finish(assertNever(nodeType, 'JsonSchemaType'))
      }
    } catch (error) {
      let failed = frames.pop()
      while (failed !== undefined && !failed.catches) failed = frames.pop()
      if (failed === undefined) throw error
      receive(losslessValueViolation(failed.path))
    }
  }

  /* v8 ignore next -- every root frame finishes or throws. */
  return rootResult ?? losslessValueViolation(path)
}

export function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path = 'value'): string[] {
  return checkValue(schema, value, path)
}

import { EjunzAgentError } from '@ejunz/ea-core/llm'

import type { ContentBlock } from '@ejunz/ea-core/llm'

import type { JsonValue } from '@ejunz/ea-core/session'

export interface ValueSchemaAnnotations {
  /** Human-readable description projected into JSON Schema and generated types. */
  description?: string
  /** Human-readable title projected into JSON Schema. */
  title?: string
  /** Non-validating default annotation; it must be lossless JSON data. */
  default?: JsonValue
  /** Non-validating examples annotation; it must be lossless JSON data. */
  examples?: JsonValue
}

export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  additionalProperties: boolean
}

export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'json'
}

export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec

export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}

export interface ParameterJsonSchema extends ObjectJsonSchema {
  properties: Record<string, JsonSchemaNode>
}

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type StringKeyOf<S> = Extract<keyof S, string>

type RequiredKeys<S> = {
  [K in StringKeyOf<S>]: S[K] extends { required: true } ? K : never
}[StringKeyOf<S>]

type InferProperty<P, Depth extends unknown[]> = InferValueAt<P, Depth>

type InferProperties<S, Depth extends unknown[]> = Simplify<
  & { [K in RequiredKeys<S>]: InferProperty<S[K], Depth> }
  & { [K in Exclude<StringKeyOf<S>, RequiredKeys<S>>]?: InferProperty<S[K], Depth> }
>

type InferObject<S extends { additionalProperties: boolean }, Depth extends unknown[]> =
  S extends { properties: infer P }
    ? S['additionalProperties'] extends true
      ? InferProperties<P, Depth> & Record<string, JsonValue>
      : InferProperties<P, Depth>
    : S['additionalProperties'] extends true
      ? Record<string, JsonValue>
      : Record<string, never>

type InferScalar<S, Fallback> =
  S extends { const: infer C } ? C :
    S extends { enum: readonly (infer E)[] } ? E :
      Fallback

type NextInferenceDepth<Depth extends unknown[]> = [unknown, ...Depth]

type InferValueAt<S, Depth extends unknown[]> =
  Depth['length'] extends 16 ? JsonValue :
    S extends { type: 'string' } ? InferScalar<S, string> :
      S extends { type: 'number' | 'integer' } ? InferScalar<S, number> :
        S extends { type: 'boolean' } ? InferScalar<S, boolean> :
          S extends { type: 'null' } ? null :
            S extends { type: 'array' }
              ? S extends { items: infer I } ? InferValueAt<I, NextInferenceDepth<Depth>>[] : JsonValue[]
              : S extends { type: 'object'; additionalProperties: boolean }
                ? InferObject<S, NextInferenceDepth<Depth>>
                : S extends { type: 'json' } ? JsonValue :
                  S extends { oneOf: readonly unknown[] }
                    ? InferValueAt<S['oneOf'][number], NextInferenceDepth<Depth>>
                    : never

export type InferValue<S> = InferValueAt<S, []>

export type InferArgs<S> = InferProperties<S, []>

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

function authorError(message: string): never {
  throw new JsonSchemaError([message])
}

function copyAnnotations(source: Record<string, unknown>, target: JsonSchemaNode): void {
  if (Object.hasOwn(source, 'description')) target.description = source.description as string
  if (Object.hasOwn(source, 'title')) target.title = source.title as string
  if (Object.hasOwn(source, 'default')) target.default = source.default as JsonValue
  if (Object.hasOwn(source, 'examples')) target.examples = source.examples as JsonValue
}

function assertAuthorKeys(source: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

interface CompiledPropertyMap {
  properties: Record<string, JsonSchemaNode>
  required?: string[]
}

interface CompileRoot<T> {
  value?: T
}

type NodeDestination =
  | { kind: 'root'; holder: CompileRoot<JsonSchemaNode> }
  | { kind: 'property'; target: Record<string, JsonSchemaNode>; key: string }
  | { kind: 'item'; target: JsonSchemaNode }
  | { kind: 'one-of'; target: JsonSchemaNode[]; index: number }

type PropertyMapDestination =
  | { kind: 'root'; holder: CompileRoot<CompiledPropertyMap> }
  | { kind: 'object'; target: JsonSchemaNode }

type CompileTask =
  | { kind: 'value'; input: unknown; path: string; allowRequired: boolean; destination: NodeDestination }
  | { kind: 'property-map'; input: unknown; path: string; destination: PropertyMapDestination }
  | {
    kind: 'property'
    property: unknown
    path: string
    key: string
    properties: Record<string, JsonSchemaNode>
    required: string[]
  }
  | {
    kind: 'property-map-tail'
    compiled: CompiledPropertyMap
    required: string[]
    destination: PropertyMapDestination
  }
  | { kind: 'leave'; input: object }

function assignCompiledNode(destination: NodeDestination, node: JsonSchemaNode): void {
  switch (destination.kind) {
    case 'root':
      destination.holder.value = node
      break
    case 'property':
      Object.defineProperty(destination.target, destination.key, {
        value: node,
        enumerable: true,
        configurable: true,
        writable: true,
      })
      break
    case 'item':
      destination.target.items = node
      break
    case 'one-of':
      destination.target[destination.index] = node
      break
  }
}

function assignCompiledPropertyMap(destination: PropertyMapDestination, compiled: CompiledPropertyMap): void {
  if (destination.kind === 'root') {
    destination.holder.value = compiled
  } else {
    destination.target.properties = compiled.properties
  }
}

function runSchemaCompiler(initial: CompileTask): void {
  const seen = new Set<object>()
  const tasks: CompileTask[] = [initial]
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      seen.delete(task.input)
      continue
    }
    if (task.kind === 'property-map-tail') {
      if (task.required.length > 0) {
        task.compiled.required = task.required
        if (task.destination.kind === 'object') task.destination.target.required = task.required
      }
      continue
    }
    if (task.kind === 'property') {
      if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`)
      if (Object.hasOwn(task.property, 'required') && task.property.required !== true) {
        authorError(`${task.path}.required must be true when present`)
      }
      if (Object.hasOwn(task.property, 'required') && task.property.required === true) task.required.push(task.key)
      tasks.push({
        kind: 'value',
        input: task.property,
        path: task.path,
        allowRequired: true,
        destination: { kind: 'property', target: task.properties, key: task.key },
      })
      continue
    }
    if (task.kind === 'property-map') {
      if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`)
      if (seen.has(task.input)) authorError(`${task.path} is circular`)
      seen.add(task.input)
      const compiled: CompiledPropertyMap = { properties: {} }
      const required: string[] = []
      assignCompiledPropertyMap(task.destination, compiled)
      tasks.push({ kind: 'leave', input: task.input })
      tasks.push({ kind: 'property-map-tail', compiled, required, destination: task.destination })
      const entries = Object.entries(task.input)
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]
        /* v8 ignore next -- the loop is bounded by the captured entry count. */
        if (entry === undefined) continue
        tasks.push({
          kind: 'property',
          property: entry[1],
          path: `${task.path}.${entry[0]}`,
          key: entry[0],
          properties: compiled.properties,
          required,
        })
      }
      continue
    }

    const { input, path } = task
    if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`)
    if (seen.has(input)) authorError(`${path} is circular`)
    seen.add(input)
    const authorKeys = [...ANNOTATION_KEYS, ...(task.allowRequired ? ['required'] : [])]
    const node: JsonSchemaNode = {}
    assignCompiledNode(task.destination, node)
    tasks.push({ kind: 'leave', input })

    if (Object.hasOwn(input, 'oneOf')) {
      assertAuthorKeys(input, path, [...authorKeys, 'oneOf', 'type'])
      if (Object.hasOwn(input, 'type')) authorError(`${path} cannot declare both type and oneOf`)
      if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`)
      const branches: JsonSchemaNode[] = []
      node.oneOf = branches
      copyAnnotations(input, node)
      for (let index = input.oneOf.length - 1; index >= 0; index--) {
        tasks.push({
          kind: 'value',
          input: input.oneOf[index],
          path: `${path}.oneOf[${index}]`,
          allowRequired: false,
          destination: { kind: 'one-of', target: branches, index },
        })
      }
      continue
    }

    const inputType = Object.hasOwn(input, 'type') ? input.type : undefined
    switch (inputType) {
      case 'json':
        assertAuthorKeys(input, path, [...authorKeys, 'type'])
        copyAnnotations(input, node)
        break
      case 'object':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
        if (!Object.hasOwn(input, 'additionalProperties') || typeof input.additionalProperties !== 'boolean') {
          authorError(`${path}.additionalProperties must be explicitly true or false`)
        }
        node.type = 'object'
        copyAnnotations(input, node)
        node.additionalProperties = input.additionalProperties
        if (Object.hasOwn(input, 'properties')) {
          tasks.push({
            kind: 'property-map',
            input: input.properties,
            path: `${path}.properties`,
            destination: { kind: 'object', target: node },
          })
        }
        break
      case 'array':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
        node.type = 'array'
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'items')) {
          tasks.push({
            kind: 'value',
            input: input.items,
            path: `${path}.items`,
            allowRequired: false,
            destination: { kind: 'item', target: node },
          })
        }
        break
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
        node.type = inputType
        copyAnnotations(input, node)
        if (Object.hasOwn(input, 'enum')) {
          if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`)
          node.enum = Array.from(input.enum, entry => entry as JsonSchemaScalar)
        }
        if (Object.hasOwn(input, 'const')) node.const = input.const as JsonSchemaScalar
        break
      default:
        authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
    }
  }
}

function compilePropertyMap(input: unknown, path: string): CompiledPropertyMap {
  const holder: CompileRoot<CompiledPropertyMap> = {}
  runSchemaCompiler({ kind: 'property-map', input, path, destination: { kind: 'root', holder } })
  /* v8 ignore next -- the root task assigns before scheduling any descendants. */
  return holder.value ?? authorError(`${path} did not compile`)
}

function compileValueSchema(input: unknown, path: string): JsonSchemaNode {
  const holder: CompileRoot<JsonSchemaNode> = {}
  runSchemaCompiler({ kind: 'value', input, path, allowRequired: false, destination: { kind: 'root', holder } })
  /* v8 ignore next -- the root task assigns before scheduling any descendants. */
  return holder.value ?? authorError(`${path} did not compile`)
}

export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): JsonSchemaNode {
  const schema = compileValueSchema(spec, 'schema')
  assertSupportedJsonSchema(schema)
  return schema
}

export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema {
  const compiled = compilePropertyMap(spec, 'parameters')
  const schema: ParameterJsonSchema = {
    type: 'object',
    properties: compiled.properties,
    ...(compiled.required === undefined ? {} : { required: compiled.required }),
  }
  assertSupportedJsonSchema(schema)
  return schema
}

export class ToolArgsError extends EjunzAgentError {
  /** Individual violations in schema-walk order. */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS')
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

export function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[] {
  return validateJsonSchemaValue(parameterSchemaSpecToJsonSchema(spec), args, '')
}

export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  /** Tool name (must be unique). */
  readonly name: string
  /** Human-readable description sent to the model. */
  readonly description: string
  /** Per-property parameter schema compiled to an implicit open object root. */
  readonly parameters: S
  /** Canonical output schema plus pure Native and presentation projections. */
  readonly output: {
    /** Schema enforced against every successful body or policy-replaced value. */
    readonly schema: O
    /** Pure Native/model rendering of one validated canonical value. */
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    /** Pure replayable presentation metadata for direct top-level calls. */
    presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue
  }
  /** Optional positive cooperative timeout budget in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Pure classifier for sibling overlap.
   * @param args - typed validated arguments.
   * @returns Whether the call may join a parallel group.
   */
  isConcurrencySafe?(args: InferArgs<S>): boolean
  /**
   * Execute the tool after argument validation.
   * @param args - typed validated arguments.
   * @param exec - execution identity, caller, cancellation, and nesting data.
   * @returns The canonical value declared by `output.schema`.
   */
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  /**
   * Optional last-mile content transform for every normalized outcome. Unlike
   * `execute`, arguments remain `unknown` because invalid-input failures also
   * reach this callback. See {@link ToolDefinition.finalizeContent}.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Pure pending-state presenter.
   * @param args - typed validated arguments.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  /**
   * Pure completed-state presenter.
   * @param args - typed validated arguments.
   * @param result - final model-facing tool result.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}

export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  // Object-literal methods do not use `this`; retaining references is safe.
  // oxlint-disable-next-line typescript/unbound-method
  const userExecute = options.execute
  // oxlint-disable-next-line typescript/unbound-method
  const userFinalizeContent = options.finalizeContent
  // oxlint-disable-next-line typescript/unbound-method
  const userRender = options.output.render
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentationMeta = options.output.presentationMeta
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentCall = options.presentCall
  // oxlint-disable-next-line typescript/unbound-method
  const userPresentResult = options.presentResult
  // oxlint-disable-next-line typescript/unbound-method
  const userIsConcurrencySafe = options.isConcurrencySafe
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)
  const validate = (args: unknown): string[] => validateJsonSchemaValue(parameters, args, '')
  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters: parameters as unknown as Record<string, unknown>,
    output: {
      schema: outputSchema,
      render(args: unknown, value: JsonValue): ContentBlock[] {
        return userRender(args as InferArgs<S>, value as unknown as InferValue<NoInfer<O>>)
      },
      ...userPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: JsonValue): JsonValue {
          return userPresentationMeta(args as InferArgs<S>, value as unknown as InferValue<NoInfer<O>>)
        },
      } : {},
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const violations = validate(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args as InferArgs<S>, exec) as Promise<JsonValue>
    },
  }
  if (userFinalizeContent) {
    tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result)
  }
  // Presentation is display-only and may run on REPLAY of arbitrary logged args
  // (possibly from an older schema), so it must never throw: validate softly and
  // fall back to `undefined` (a generic UI presentation) on any mismatch, rather
  // than the hard `ToolArgsError` the execute path raises.
  if (userPresentCall) {
    tool.presentCall = (args: unknown): ToolCallView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentCall(args as InferArgs<S>)
    }
  }
  if (userPresentResult) {
    tool.presentResult = (args: unknown, result: ToolResult): ToolResultView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentResult(args as InferArgs<S>, result)
    }
  }
  if (userIsConcurrencySafe) {
    tool.isConcurrencySafe = (args: unknown): boolean => {
      if (validate(args).length > 0) return false
      return userIsConcurrencySafe(args as InferArgs<S>)
    }
  }
  return tool
}

import type { ContentBlock } from '@ejunz/ea-core/llm'

import type { JsonValue } from '@ejunz/ea-core/session'

const CONTENT_VALUE_SCHEMA = { type: 'array', items: { type: 'json' } } as const

export type ContentToolFixtureOptions<S extends ParameterSchemaSpec> = Omit<
  DefineToolOptions<S, typeof CONTENT_VALUE_SCHEMA>,
  'output' | 'execute'
> & {
  /** Produce the fixture's content blocks as its canonical test value. */
  execute(args: import('./schema.ts').InferArgs<S>, exec: ToolRunContext): Promise<ContentBlock[]>
}

export function defineContentToolFixture<const S extends ParameterSchemaSpec>(
  options: ContentToolFixtureOptions<S>,
): ToolDefinition {
  // oxlint-disable-next-line typescript/unbound-method
  const execute = options.execute
  return defineTool({
    ...options,
    output: {
      schema: CONTENT_VALUE_SCHEMA,
      render: (_args, value) => value as unknown as ContentBlock[],
    },
    async execute(args, exec) {
      return await execute(args, exec) as unknown as JsonValue[]
    },
  })
}

import { Context, Service } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeTarget } from '@ejunz/ea-core/scope'

import type { ScopeKey, ScopeLayer, Scoped } from '@ejunz/ea-core/scope'

import type { CallId, ContentBlock, ToolSchema } from '@ejunz/ea-core/llm'

import { assertNever, deepFreeze, EjunzAgentError } from '@ejunz/ea-core/llm'

import type { Agent } from '@ejunz/ea-core/agent'

import { snapshotJsonValue } from '@ejunz/ea-core/session'

import type { JsonValue, UserMessage } from '@ejunz/ea-core/session'

import type { ToolProviderResult } from '@ejunz/ea-core/system-prompt'

import type {} from '@ejunz/ea-core/user-approval'

export type { JsonValue } from '@ejunz/ea-core/session'

declare module '@ejunz/cordis' {
  interface Context {
    tools: ToolRuntime
  }

  interface Events {
    /**
     * Allow, deny, or ask before dispatch. `next()` delegates to allow; missing
     * approval support turns `ask` into denial. Async gates must observe
     * `exec.signal`; the registry rechecks cancellation after they settle but
     * never abandons their promise.
     * Scope-filtered dispatch (`@ejunz/ea-core/scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @mode waterfall
     */
    'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    /**
     * Around-dispatch waterfall for timeout, retry, or metrics. `next()` returns
     * a normalized result; wrappers may change only `exec.signal`, while call
     * identity remains immutable. The registry re-fuses the original caller
     * signal before the body, so replacement cannot detach caller cancellation;
     * wrappers must still restore their signal and reach quiescence.
     * Scope-filtered dispatch (`@ejunz/ea-core/scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the allowed call about to dispatch (name, parsed arguments, caller agent, signal).
     * @mode waterfall
     */
    'tools/execute'(this: Scoped<ToolRuntime>, exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult>
    /**
     * Accept, replace, enrich, or block a normalized dispatch result. `next()`
     * accepts it unchanged; thrown tools still reach this waterfall as errors. Async
     * listeners must observe `exec.signal`; after they settle, caller
     * cancellation replaces only a successful accepted outcome with the code
     * selected by whether the tool body was invoked.
     * Scope-filtered dispatch (`@ejunz/ea-core/scope`): agent-scoped listeners receive only that agent's calls.
     * @param exec - the call that just ran (name, parsed arguments, caller agent).
     * @param result - the dispatch outcome a listener may accept, replace, or block.
     * @mode waterfall
     */
    'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>
    /**
     * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
     * Scope-filtered dispatch (`@ejunz/ea-core/scope`): keyed by `exec.agent`.
     * @param exec - the execution object that traversed the pipeline.
     * @param result - a deep-frozen snapshot of the final returned result.
     * @mode emit
     */
    'tools/result'(this: Scoped<ToolRuntime>, exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): undefined
    /**
     * A tool was registered or unregistered, or a scoped restriction changed
     * (the available tool set changed — possibly for one scope only). An
     * UNFILTERED registry-subject notification, deliberately not scope-filtered
     * dispatch: a global change concerns every agent's next assembly, so a
     * scoped listener subscribing here sees every change, not just its own
     * scope's.
     * @mode emit
     */
    'tools/change'(): void
  }
}

export interface ToolOutputDefinition {
  /** Raw supported JSON Schema enforced against every successful canonical value. */
  readonly schema: JsonSchemaNode
  /** Pure projection from validated arguments and value to Native/model content. */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** Pure replayable presentation projection, computed only for top-level calls. */
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}

export interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
  /**
   * Run one accepted call and return only its canonical lossless-JSON value.
   * Async work must observe or forward `exec.signal` and settle only after its
   * owned work reaches quiescence. The registry preserves caller cancellation
   * through around-dispatch signal replacement and does not abandon this
   * promise, but it cannot hard-kill same-process code.
   * @param args - losslessly snapshotted, frozen model arguments.
   * @param exec - execution identity, cancellation signal, and context deferral.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  /**
   * Synchronous last-mile transform for model-facing content. The registry
   * snapshots this callback when execution starts and invokes it exactly once
   * for every normalized outcome, including pipeline failures that bypass
   * `tools/post-execute`, immediately before lossless materialization.
   * Returning `undefined` preserves the content; every other result field
   * remains registry-owned. The callback must be total and must not throw.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@ejunz/ea-core/tool-call-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `schemas()` whitelists only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
  /**
   * Pure synchronous classifier for overlap with sibling tool calls. Only
   * `true` opts in; omission, exceptions, non-`true` returns, and invalid
   * `defineTool` arguments are exclusive. This metadata is never model-visible.
   *
   * Opted-in executions must not mutate parent-owned state. Shared state must
   * tolerate concurrent dispatch; recorder races are permitted only when they
   * commute or fail closed. See the
   * [parallel-tool-call Agent Note](../../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)
   * for the full contract.
   * @param args - parsed arguments; `defineTool` validates before calling.
   * @returns Whether this call may join a parallel group.
   */
  isConcurrencySafe?(args: unknown): boolean
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived from
   * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
   * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
   * or `undefined` (or omit the method) to fall back to a generic presentation
   * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
   * call it during live streaming AND a session-log replay, so it must depend
   * only on `args`.
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * durable result projection (`content`, failure state, and optional `meta`). Returns a
   * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
   * pending title and render the raw result content. Pure and side-effect-free
   * for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}

export interface ToolResult {
  /** The final model-facing content (or the rendered error text on failure). */
  content: ContentBlock[]
  /** Whether the call failed. */
  isError: boolean
  /**
   * The tool-private presentation payload projected by its output declaration
   * and threaded verbatim from the `tool/result` event. Absent when the tool
   * declared no projector or the call was nested under a composite transport.
   */
  meta?: JsonValue
}

declare const toolExecutionTokenBrand: unique symbol

export type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }

export interface ToolExecutionInput {
  readonly callId: CallId
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: Agent
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}

export type ToolExecutionMode =
  | { kind: 'parallel' }
  | { kind: 'exclusive' }

export interface ToolExecution extends ToolExecutionInput {
  /** Registry-assigned execution identity for result correlation. */
  readonly token: ToolExecutionToken
}

export interface ToolDispatchExecution extends Omit<ToolExecution, 'signal'> {
  /** Cancellation signal visible to the next wrapper or tool body. */
  signal: AbortSignal
}

export interface ToolRunContext extends ToolExecution {
  /**
   * Defer one context — typically a nested-dispatch context ferried by a
   * composite tool, or a fresh plugin-sourced instruction — until this tool's
   * final result reaches the agent loop. Contexts retain their individual
   * source and metadata and are emitted in call order.
   */
  deferContext(context: UserMessage): void
  /**
   * Mark a successful final result as terminal for the current agent turn.
   * The marker rides this execution's own result (`concludesTurn` exists only
   * on {@link ToolExecutionSuccess}); a composite that dispatches nested
   * calls forwards it from the nested result, exactly like
   * `additionalContexts`, so only an authoritative nested success can
   * conclude the enclosing run.
   */
  concludeTurn(): void
}

type MutableToolRunContext = Omit<ToolRunContext, 'signal'> & { signal: AbortSignal }

export type ScheduledToolPreparation =
  | { kind: 'dispatch'; exec: ToolRunContext }
  | { kind: 'post-result'; exec: ToolRunContext; result: ToolExecutionResult }
  | { kind: 'final-result'; exec: ToolRunContext; result: ToolExecutionResult }

export type ScheduledToolDispatch =
  | { kind: 'post-result'; result: ToolExecutionResult }
  | { kind: 'final-result'; result: ToolExecutionResult }

export interface ToolRuntimeScheduler {
  /** Materialize input, run the ordered pre-execute/guard gate, and decide what stage follows. */
  prepare(exec: ToolExecutionInput): Promise<ScheduledToolPreparation>
  /** Run only the around-dispatch/body stage. */
  dispatch(exec: ToolRunContext): Promise<ScheduledToolDispatch>
  /** Run post-execute and definition-owned content finalization, then materialize and notify. */
  finalize(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult>
  /** Run definition-owned content finalization, then materialize and notify without post-execute. */
  finish(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult
}

export const TOOL_RUNTIME_SCHEDULER: unique symbol = Symbol('@ejunz/ea-core/tools.scheduler')

export const TOOL_ABORTED = 'ABORTED'

export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH'

export interface ToolErrorInfo {
  name: string
  code: string
}

export interface ToolFailure {
  /** Human-readable failure message without the Native `Error: ` envelope. */
  message: string
  /** Internal error class/code used by policy and durable diagnostics. */
  info?: ToolErrorInfo
}

export class ToolNotFoundError extends EjunzAgentError {
  /**
   * @param toolName - the name the caller asked for.
   * @param reachableFrom - how the model reaches this tool instead, when the
   *   name IS visible and only the presentation denies calling it directly.
   *   Omitted for a name that is registered nowhere.
   */
  constructor(toolName: string, reachableFrom?: string) {
    super(
      reachableFrom === undefined
        ? `unknown tool "${toolName}"`
        : `unknown tool "${toolName}": ${reachableFrom}`,
      'UNKNOWN_TOOL',
    )
    this.name = 'ToolNotFoundError'
  }
}

export class ToolOutputError extends EjunzAgentError {
  /** Schema/value violations in validation order. */
  readonly violations: string[]

  constructor(toolName: string, violations: string[]) {
    super(`tool "${toolName}" returned invalid output: ${violations.join('; ')}`, 'INVALID_TOOL_OUTPUT')
    this.name = 'ToolOutputError'
    this.violations = violations
  }
}

function projectionError(toolName: string, projector: 'render' | 'presentationMeta', error: unknown): ToolOutputError {
  return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`])
}

function snapshotProjection<T>(toolName: string, projector: 'render' | 'presentationMeta', candidate: T): T {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) {
      throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`])
    }
    return detached
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw projectionError(toolName, projector, error)
  }
}

function snapshotToolValue(toolName: string, candidate: unknown): JsonValue {
  try {
    const detached = snapshotJsonValue(candidate)
    if (detached === undefined) throw new ToolOutputError(toolName, ['value is not lossless JSON'])
    return detached as JsonValue
  } catch (error: unknown) {
    if (error instanceof ToolOutputError) throw error
    throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`])
  }
}

export interface ToolExecutionSuccess {
  readonly isError: false
  /** Execution-local canonical value; deliberately omitted from durable events. */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  /** The agent loop stops after committing this successful result batch. */
  readonly concludesTurn?: true
}

export interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}

export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof error.message === 'string') {
      return error.message
    }
    return String(error)
  } catch {
    // A hostile thrown value can trap `instanceof`, property access, or string
    // coercion. Error normalization is the outermost safety boundary, so its
    // fallback must itself be total.
    return '<unprintable thrown value>'
  }
}

function failureMessageFromContent(content: ContentBlock[]): string {
  const text = content
    .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
    .join('\n')
  return text.length > 0 ? text : 'tool result blocked by post-execute policy'
}

function materializePresentation<T>(candidate: T): T {
  const detached = snapshotJsonValue(candidate)
  if (detached === undefined) {
    throw new TypeError('tool result must be losslessly JSON-serializable')
  }
  return deepFreeze(detached)
}

function errorInfo(error: unknown): ToolErrorInfo | undefined {
  try {
    return error instanceof EjunzAgentError ? { name: error.name, code: error.code } : undefined
  } catch {
    return undefined
  }
}

export type Config = Record<never, never>

export interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}

interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

interface ToolView {
  /** Visible definitions after restrictions and scoped shadowing. */
  readonly visible: ReadonlyMap<string, ToolDefinition>
  /** Pre-restriction capability names used by prompt-order validation. */
  readonly knownNames: ReadonlySet<string>
  /** Current global names that a scoped restriction may name. */
  readonly restrictableNames: ReadonlySet<string>
}

export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined

class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolDefinition>
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()
  readonly guards = new AnonymousEntries<ToolGuard>()
  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty()
  }

  /** Whether every compiled restriction in this layer admits a global tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

  /** First monotonic denial from this layer's live guard registrations. */
  guardReason(exec: ToolExecution): string | undefined {
    for (const guard of this.guards.values()) {
      const reason = guard(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }
}

interface ToolAskResolution {
  readonly decision: Extract<PreToolDecision, { kind: 'allow' | 'deny' }>
  readonly approvalCancelled: boolean
}

interface ToolCancellationState {
  readonly callerSignal: AbortSignal
  bodyInvoked: boolean
}

interface FusedToolSignal {
  readonly signal: AbortSignal
  dispose(): void
}

export class ToolRuntime extends Service {
  static inject = ['systemPrompt']

  static Config: z<Config> = z.object({})

  /** Internal staged view consumed by `ea-agent-loop`'s parallel scheduler. */
  readonly [TOOL_RUNTIME_SCHEDULER]: ToolRuntimeScheduler = {
    prepare: exec => this.prepareScheduledExecution(exec),
    dispatch: exec => this.dispatchScheduledExecution(exec),
    finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
    finish: (exec, result) => this.finishScheduledExecution(exec, result),
  }

  /** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
  private deferredContexts = new WeakMap<ToolRunContext, UserMessage[]>()
  /** Executions whose tool body declared the current turn complete. */
  private concludingExecutions = new WeakSet<ToolExecution>()
  /** Original caller cancellation, kept outside the wrapper-mutable execution object. */
  private cancellationStates = new WeakMap<ToolRunContext, ToolCancellationState>()
  /** Definition-owned final content transform snapshotted before policy begins. */
  private contentFinalizers = new WeakMap<ToolRunContext, ToolDefinition['finalizeContent']>()
  private readonly layers = new ScopedLayers(
    scope => new ToolLayer(scope),
    () => { this.ctx.emit('tools/change') },
  )
  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))
  }

  /**
   * Build one scope's wire schemas and names for prompt-order validation.
   * Restrictions do not make known tools invalid; known names remain available
   * for prompt-order validation.
   */
  private wireSchemas(scope?: ScopeKey): ToolProviderResult {
    const view = this.view(scope)
    const schemas = [...view.visible.values()].map(definition => this.schemaOf(definition, false))
    return { schemas, knownNames: [...view.knownNames] }
  }

  /**
   * Register globally or in the calling agent scope. Scoped tools shadow
   * globals; duplicates within one layer fail.
   * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
   * @returns the exact disposer that unregisters the tool.
   */
  register(definition: ToolDefinition): () => void {
    const name = definition.name
    const output = (definition as Partial<ToolDefinition>).output
    if (output === undefined || typeof output !== 'object'
      || typeof output.render !== 'function'
      || (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')) {
      throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`)
    }
    assertSupportedJsonSchema(output.schema)
    const timeoutMs = definition.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.tools.insert(name, definition),
      { label: 'tools.register()' },
    )
  }

  /**
   * Restrict global tools for the calling agent scope. Empty filters, unknown
   * names and scope-local names fail. Restrictions
   * intersect; scoped registrations remain visible.
   * @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    const known = this.view(scope).restrictableNames
    const unknown = [...allow ?? [], ...deny ?? []].filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    return this.layers.effect(
      this.ctx,
      layer => layer.restrictions.append(compiled),
      { label: 'tools.restrict()' },
    )
  }

  /**
   * Register a monotonic guard after the extensible `tools/pre-execute`
   * waterfall. A plain-context guard applies globally; one registered through
   * `agent.ctx` applies only to that agent. Any matching guard may deny by
   * returning a reason, while no guard can force-allow a call another guard
   * denied. The exact effect disposer is returned for ordered ownership and
   * HMR cleanup.
   * @param guard - synchronous check; a returned string denies the execution.
   * @returns the exact disposer that unregisters the guard.
   */
  guard(guard: ToolGuard): () => void {
    return this.layers.effect(
      this.ctx,
      layer => layer.guards.append(guard),
      { label: 'tools.guard()', notify: false },
    )
  }

  /** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
  private guardReason(exec: ToolExecution): string | undefined {
    const globalReason = this.layers.global.guardReason(exec)
    if (globalReason !== undefined) return globalReason
    if (exec.agent === undefined) return undefined
    for (const layer of this.layers.chainLayers(exec.agent)) {
      const reason = layer.guardReason(exec)
      if (reason !== undefined) return reason
    }
    return undefined
  }

  /**
   * Resolve every registry fact one scope needs in one layer traversal. The
   * visible map applies restrictions to the INHERITED surface, then the
   * scope's own registrations and the reserved presentation transport; the
   * other sets retain the pre-restriction facts needed by restriction and
   * prompt-order validation.
   *
   * A restriction filters what a scope inherits — the global layer and every
   * ancestor layer on its chain — and never what its OWN layer registers.
   * That exemption is what a per-child capability filter has to keep intact:
   * the delegation runtime registers a child's reporting and structured-output
   * tools into the child's own layer, and a filter naming the capabilities the
   * child may use must not strip the machinery it answers through.
   *
   * Reading the exempt set as "the global layer" instead of "not mine" held
   * only while every model-facing tool sat in the host composition. Once
   * presets moved them onto the agent plane they became an ANCESTOR
   * contribution, so a child's filter silently stopped constraining anything
   * it was given.
   * @param scope - the viewing scope (the agent), or undefined for the global view.
   * @returns the complete derived view for that scope.
   */
  private view(scope?: ScopeKey): ToolView {
    // Scope-chain layers, farthest ancestor first, the exact scope last.
    const layers = this.layers.chainLayers(scope)
    // Chain-blind on purpose: this is the ONE layer whose registrations the
    // scope owns rather than inherits, and it is absent until the scope
    // contributes something.
    const own = this.layers.peek(scope)
    // Inherited surface, nearest ancestor last: a nearer scope's same-name
    // entry shadows a farther one, and the global layer is the farthest.
    const inherited = new Map<string, ToolDefinition>(this.layers.global.tools.entries())
    for (const layer of layers) {
      if (layer === own) continue
      for (const [name, definition] of layer.tools.entries()) inherited.set(name, definition)
    }
    const visible = new Map<string, ToolDefinition>()
    const knownNames = new Set<string>()
    const restrictableNames = new Set<string>()
    for (const [name, definition] of inherited) {
      knownNames.add(name)
      restrictableNames.add(name)
      // Restrictions intersect across the whole chain: any scope on it may
      // mask an inherited name for everything nested inside it.
      if (layers.every(layer => layer.admits(name))) visible.set(name, definition)
    }
    // The scope's own registrations last, shadowing an inherited name and
    // outside the filter above.
    if (own !== undefined) {
      for (const [name, definition] of own.tools.entries()) {
        knownNames.add(name)
        visible.set(name, definition)
      }
    }
    return { visible, knownNames, restrictableNames }
  }

  /**
   * Look up a tool as one scope sees it (scoped
   * shadows global; a restricted-away global reads as absent). Presenters pass
   * the calling agent so the rendered card matches the definition that
   * actually executed.
   * @param name - the tool name as registered.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns the definition the scope resolves, or undefined when none is visible.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.view(scope).visible.get(name)
  }

  /** Resolve the visible definition for execution. */
  private resolveExecution(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.get(name, scope)
  }

  /**
   * Project visible definitions onto the allowlisted model-facing schema fields,
   * excluding execution and presentation callbacks.
   * @param scope - the viewing scope (the agent); omitted = the global view.
   * @returns one deep-cloned schema per visible tool.
   */
  schemas(scope?: ScopeKey): ToolSchema[] {
    return [...this.view(scope).visible.values()].map(definition => this.schemaOf(definition, true))
  }

  /** Project one definition onto the model-facing schema fields. */
  private schemaOf(definition: ToolDefinition, detachParameters: boolean): ToolSchema {
    const { name, description, parameters } = definition
    const detached = detachParameters ? snapshotJsonValue(parameters) : parameters
    if (detached === undefined) {
      throw new Error(`tool "${name}" parameters must be lossless JSON before schema projection`)
    }
    return {
      name,
      description,
      parameters: detached,
    }
  }

  /**
   * Classify a pending call through the caller's visible tool definition. Only
   * an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
   * throwing classifiers are exclusive.
   * @param exec - call name, parsed arguments, and optional agent scope.
   * @returns the fail-closed scheduling mode.
   */
  executionMode(exec: ToolExecutionInput): ToolExecutionMode {
    const tool = this.resolveExecution(exec.name, exec.agent)
    if (!tool?.isConcurrencySafe) return { kind: 'exclusive' }
    try {
      const concurrencySafe: unknown = tool.isConcurrencySafe(exec.arguments)
      return concurrencySafe === true ? { kind: 'parallel' } : { kind: 'exclusive' }
    } catch {
      return { kind: 'exclusive' }
    }
  }

  /**
   * Execute through pre-policy, guards, around-dispatch, post-policy,
   * definition-owned content finalization, and final notification. Tool and
   * listener failures resolve as materialized error results; an invisible tool
   * reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
   * snapshot final observers receive. Cancellation
   * arriving after entry and before final result materialization skips a
   * not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
   * successful started outcome with `ABORTED`; already-started work is still
   * drained and may retain a tool-owned structured error.
   * @param exec - the typed same-process call input. The registry assigns its
   *   correlation token before policy begins.
   * @returns the materialized final result.
   */
  async execute(exec: ToolExecutionInput): Promise<ToolExecutionResult> {
    return this.prepareExecution(exec, prepared => this.completeScheduledExecution(prepared))
  }

  private async completeScheduledExecution(prepared: ScheduledToolPreparation): Promise<ToolExecutionResult> {
    switch (prepared.kind) {
      case 'dispatch': {
        const dispatched = await this.dispatchScheduledExecution(prepared.exec)
        return dispatched.kind === 'post-result'
          ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result)
          : this.finishScheduledExecution(prepared.exec, dispatched.result)
      }
      case 'post-result':
        return await this.finalizeScheduledExecution(prepared.exec, prepared.result)
      case 'final-result':
        return this.finishScheduledExecution(prepared.exec, prepared.result)
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(prepared, 'scheduled tool preparation')
    }
  }

  private createExecution(exec: ToolExecutionInput): ScheduledToolPreparation | { kind: 'ready'; exec: MutableToolRunContext } {
    const deferredContexts: UserMessage[] = []
    const token = createExecutionToken()
    const callId = exec.callId
    const name = exec.name
    const agent = exec.agent
    const signal = exec.signal
    const visible = this.get(name, agent)
    const concludingExecutions = this.concludingExecutions
    const base = {
      token,
      callId,
      name,
      signal,
      ...agent !== undefined ? { agent } : {},
      deferContext(context: UserMessage): void {
        deferredContexts.push(context)
      },
      concludeTurn(): void {
        concludingExecutions.add(this as unknown as ToolExecution)
      },
    }
    // Capture the finalizer BEFORE argument materialization: the
    // `finalizeContent` contract snapshots the callback when the call starts,
    // and an arguments getter can replace or clear the registered callback
    // during `snapshotJsonValue`.
    const capturedFinalizer = visible?.finalizeContent?.bind(visible)
    try {
      const detached = snapshotJsonValue(exec.arguments)
      if (detached === undefined) {
        throw new TypeError('tool execution arguments must be losslessly JSON-serializable')
      }
      const execution: MutableToolRunContext = { ...base, arguments: deepFreeze(detached) }
      this.deferredContexts.set(execution, deferredContexts)
      this.contentFinalizers.set(execution, capturedFinalizer)
      this.cancellationStates.set(execution, {
        callerSignal: signal,
        bodyInvoked: false,
      })
      return { kind: 'ready', exec: execution }
    } catch (error: unknown) {
      const execution: MutableToolRunContext = { ...base, arguments: undefined }
      this.contentFinalizers.set(execution, capturedFinalizer)
      return { kind: 'final-result', exec: execution, result: toolErrorResult(error) }
    }
  }

  /**
   * Run the ordered pre-execute and monotonic guard stages for the scheduler.
   * @param input - the caller-supplied execution input.
   * @returns the prepared execution plus the next scheduler stage.
   * @internal
   */
  private async prepareScheduledExecution(input: ToolExecutionInput): Promise<ScheduledToolPreparation> {
    return this.prepareExecution(input, prepared => prepared)
  }

  private async prepareExecution<T>(
    input: ToolExecutionInput,
    next: (prepared: ScheduledToolPreparation) => T | PromiseLike<T>,
  ): Promise<T> {
    const created = this.createExecution(input)
    if (created.kind !== 'ready') return next(created)
    const exec = created.exec
    if (this.callerCancelled(exec)) {
      return next({ kind: 'final-result', exec, result: toolAbortedBeforeDispatchResult() })
    }
    try {
      const carrier = scopeTarget(this, exec.agent)
      const gate = await this.ctx.waterfall(
        carrier, 'tools/pre-execute', exec,
        () => Promise.resolve<PreToolDecision>({ kind: 'allow' }),
      )
      const askResolution: ToolAskResolution = gate.kind === 'ask'
        ? await this.serviceAsk(exec, gate)
        : { decision: gate, approvalCancelled: false }
      const { decision } = askResolution
      if (this.callerCancelled(exec) && askResolution.approvalCancelled) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      const denialReason = decision.kind === 'allow'
        ? this.guardReason(exec)
        : decision.reason
      if (denialReason !== undefined) {
        return await next({
          kind: 'post-result',
          exec,
          result: this.materializeFinalResult({
            content: [{ type: 'text', text: `Error: ${denialReason}` }],
            isError: true,
            error: { message: denialReason },
          }),
        })
      }
      if (this.callerCancelled(exec)) {
        return await next({ kind: 'post-result', exec, result: toolAbortedBeforeDispatchResult() })
      }
      return await next({ kind: 'dispatch', exec })
    } catch (error: unknown) {
      return next({ kind: 'final-result', exec, result: toolErrorResult(error) })
    }
  }

  /** Whether the original caller signal is currently aborted. */
  private callerCancelled(exec: ToolRunContext): boolean {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.callerSignal.aborted
  }

  /** Canonical cancellation outcome selected by whether the tool body started. */
  private cancellationResult(exec: ToolRunContext, prior?: ToolExecutionResult): ToolExecutionResult {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    return state.bodyInvoked
      ? toolAbortedResult(prior)
      : toolAbortedBeforeDispatchResult(prior)
  }

  /**
   * Dispatch the registered body with the original caller signal fused back
   * into any around-wrapper replacement. Cancellation never abandons the body:
   * a started promise reaches quiescence before its outcome becomes `ABORTED`.
   */
  private async dispatchToolBody(exec: MutableToolRunContext): Promise<ToolExecutionResult> {
    const state = this.cancellationStates.get(exec)
    /* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
    if (state === undefined) throw new Error('tool registry scheduler invariant violated: missing cancellation state')
    const wrapperSignal = exec.signal
    const fused = fuseToolSignals(state.callerSignal, wrapperSignal)
    const signal = fused.signal

    if (isAborted(signal)) {
      fused.dispose()
      return toolAbortedBeforeDispatchResult()
    }
    exec.signal = signal
    try {
      const tool = this.resolveExecution(exec.name, exec.agent)
      if (!tool) throw new ToolNotFoundError(exec.name)
      state.bodyInvoked = true
      const returned = await tool.execute(exec.arguments, exec)
      const result = this.createSuccessResult(exec, tool, returned)
      return isAborted(signal)
        ? toolAbortedResult(result)
        : result
    } catch (error: unknown) {
      return toolErrorResult(error)
    } finally {
      fused.dispose()
      exec.signal = wrapperSignal
    }
  }

  /**
   * Run around-dispatch and the tool body. Tool and unknown-tool failures still
   * receive post-execute; pipeline failures are already final.
   * @param exec - the prepared execution.
   * @returns whether the result still needs post-execute.
   * @internal
   */
  private async dispatchScheduledExecution(exec: ToolRunContext): Promise<ScheduledToolDispatch> {
    try {
      const mutableExec = exec as MutableToolRunContext
      const carrier = scopeTarget(this, exec.agent)
      const result = await this.ctx.waterfall(
        carrier, 'tools/execute', mutableExec,
        () => this.dispatchToolBody(mutableExec),
      )
      const normalized = this.normalizeDispatchResult(exec, result)
      const deferredContexts = this.deferredContexts.get(exec)
      /* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
      if (deferredContexts === undefined) throw new Error('tool registry scheduler invariant violated: unprepared execution')
      const resultWithDeferredContexts: ToolExecutionResult = deferredContexts.length === 0
        ? normalized
        : this.markCanonical(exec, {
          ...normalized,
          additionalContexts: [
            ...deferredContexts,
            ...normalized.additionalContexts ?? [],
          ],
        })
      return {
        kind: 'post-result',
        result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError
          ? this.cancellationResult(exec, resultWithDeferredContexts)
          : resultWithDeferredContexts,
      }
    } catch (error: unknown) {
      return { kind: 'final-result', result: toolErrorResult(error) }
    }
  }

  /**
   * Run ordered post-execute, then apply definition-owned content finalization,
   * materialize, and notify the final outcome.
   * @param exec - the prepared execution.
   * @param result - dispatch/pre result that still needs post-execute.
   * @returns the materialized final result.
   * @internal
   */
  private async finalizeScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    try {
      const postResult = await this.postExecute(exec, result)
      return this.finishScheduledExecution(
        exec,
        this.callerCancelled(exec) && !postResult.isError
          ? this.cancellationResult(exec, postResult)
          : postResult,
      )
    } catch (error: unknown) {
      return this.finishScheduledExecution(exec, toolErrorResult(error))
    }
  }

  /**
   * Materialize the candidate, apply definition-owned content finalization,
   * then materialize and notify the authoritative result.
   * @param exec - the prepared execution.
   * @param result - final result.
   * @returns the materialized final result.
   * @internal
   */
  private finishScheduledExecution(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    let materializedResult: ToolExecutionResult
    try {
      materializedResult = this.materializeFinalResult(result)
    } catch (error: unknown) {
      materializedResult = this.materializeFinalResult(toolErrorResult(error))
    }
    let finalResult: ToolExecutionResult
    try {
      finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult))
    } catch (error: unknown) {
      finalResult = this.materializeFinalResult(toolErrorResult(error))
    }
    this.notifyResult(exec, finalResult)
    return finalResult
  }

  /** Apply the snapshotted tool-owned content transform without exposing other result fields. */
  private applyFinalContent(exec: ToolRunContext, result: ToolExecutionResult): ToolExecutionResult {
    const finalizeContent = this.contentFinalizers.get(exec)
    if (finalizeContent === undefined) return result
    const content = finalizeContent(exec, result)
    return content === undefined ? result : { ...result, content }
  }

  /** Notify observers without exposing a mutation or error channel into the outcome. */
  private notifyResult(exec: ToolExecution, result: ToolExecutionResult): void {
    // Freeze the registry's live object before observers receive its readonly
    // WeakMap-keyable view.
    Object.freeze(exec)
    const { name: toolName, callId } = exec
    const reportFailure = (error: unknown): void => {
      this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`)
    }
    const callbacks = this.ctx.events.dispatch('emit', [
      scopeTarget(this, exec.agent), 'tools/result', exec, result,
    ])
    for (const callback of callbacks) {
      try {
        const returned: unknown = callback(exec, result)
        void Promise.resolve(returned).catch(reportFailure)
      } catch (error: unknown) {
        reportFailure(error)
      }
    }
  }

  /**
   * Resolve an `ask` decision to allow/deny through the approval seam. The
   * seam is consumed opportunistically with `ctx.get('approval')` — a
   * deployment that composes no ApprovalService keeps the historical degrade
   * to deny, and an unmount mid-session degrades the same way on the next ask.
   * An agent-less execution also degrades: without an agent there is no
   * session to audit to and no UI to route to. Otherwise the outcome maps
   * one-to-one — `allowed-once` proceeds; the three non-grants deny with
   * distinct reasons so the model can tell a human "no" from an absent
   * approval channel.
   */
  private async serviceAsk(
    exec: ToolExecution,
    ask: Extract<PreToolDecision, { kind: 'ask' }>,
  ): Promise<ToolAskResolution> {
    const approval = this.ctx.get('approval')
    if (approval === undefined) {
      return {
        decision: { kind: 'deny', reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)` },
        approvalCancelled: false,
      }
    }
    if (exec.agent === undefined) {
      return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through` },
        approvalCancelled: false,
      }
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason !== undefined ? { reason: ask.reason } : {},
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
      case 'rejected': return {
        decision: { kind: 'deny', reason: `the user rejected tool "${exec.name}"` },
        approvalCancelled: false,
      }
      case 'cancelled': return {
        decision: { kind: 'deny', reason: `approval for tool "${exec.name}" was cancelled` },
        approvalCancelled: true,
      }
      case 'unavailable': return {
        decision: { kind: 'deny', reason: `tool "${exec.name}" requires approval, but no approval channel is available` },
        approvalCancelled: false,
      }
      default: return assertNever(outcome, 'ApprovalOutcome')
    }
  }

  /**
   * Run the `tools/post-execute` waterfall over a dispatched `result` and apply
   * its {@link PostToolDecision}: `accept` keeps the call successful (replacing
   * `content` when given), `block` turns it into an `isError` whose content is
   * the corrective `feedback`. Either decision may attach `additionalContexts`,
   * which are ferried on the returned result for the loop's active-batch FIFO.
   * Context deferred by the tool body survives an accepted result but is
   * discarded when the outer call is blocked; a block exposes only context the
   * blocking decision explicitly supplied.
   * Runs inside `execute`'s outer try/catch (a throwing listener → isError).
   */
  private async postExecute(exec: ToolExecution, result: ToolExecutionResult): Promise<ToolExecutionResult> {
    const decision = await this.ctx.waterfall(
      scopeTarget(this, exec.agent), 'tools/post-execute', exec, result,
      () => Promise.resolve<PostToolDecision>({ kind: 'accept' }),
    )
    const decisionContexts = decision.additionalContexts ?? []
    if (decision.kind === 'block') {
      const message = failureMessageFromContent(decision.feedback)
      return this.markCanonical(exec, {
        content: decision.feedback,
        isError: true,
        error: { message },
        ...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {},
      })
    }
    if (Object.hasOwn(decision, 'content') && Object.hasOwn(decision, 'value')) {
      throw new TypeError('tools/post-execute accept decision cannot replace both value and content')
    }
    const additionalContexts = [
      ...result.additionalContexts ?? [],
      ...decisionContexts,
    ]
    if (Object.hasOwn(decision, 'value')) {
      if (result.isError) {
        throw new TypeError('tools/post-execute cannot replace the value of a failed result')
      }
      const tool = this.resolveExecution(exec.name, exec.agent)
      if (tool === undefined) throw new ToolNotFoundError(exec.name)
      const replaced = this.createSuccessResult(exec, tool, decision.value)
      return this.markCanonical(exec, {
        ...replaced,
        ...additionalContexts.length > 0 ? { additionalContexts } : {},
      })
    }
    return this.markCanonical(exec, {
      ...result,
      ...decision.content !== undefined ? { content: decision.content } : {},
      ...additionalContexts.length > 0 ? { additionalContexts } : {},
    })
  }

  /** Registry-normalized results and the exact dispatch that validated each value. */
  private readonly canonicalResults = new WeakMap<object, ToolExecutionToken>()

  /** Mark one registry-normalized result as canonical only for its owning dispatch. */
  private markCanonical<T extends ToolExecutionResult>(exec: ToolExecution, result: T): T {
    this.canonicalResults.set(result, exec.token)
    return result
  }

  /** Snapshot, validate, render, and optionally project one successful body value. */
  private createSuccessResult(exec: ToolExecution, tool: ToolDefinition, candidate: unknown): ToolExecutionSuccess {
    const detached = snapshotToolValue(tool.name, candidate)
    const violations = validateJsonSchemaValue(tool.output.schema, detached, 'value')
    if (violations.length > 0) throw new ToolOutputError(tool.name, violations)
    const value = deepFreeze(detached)
    let rendered: ContentBlock[]
    try {
      rendered = tool.output.render(exec.arguments, value)
    } catch (error: unknown) {
      throw projectionError(tool.name, 'render', error)
    }
    const content = snapshotProjection(tool.name, 'render', rendered)
    let meta: JsonValue | undefined
    if (tool.output.presentationMeta !== undefined) {
      let projected: JsonValue
      try {
        projected = tool.output.presentationMeta(exec.arguments, value)
      } catch (error: unknown) {
        throw projectionError(tool.name, 'presentationMeta', error)
      }
      meta = snapshotProjection(tool.name, 'presentationMeta', projected)
    }
    const concludesTurn = this.concludingExecutions.has(exec)
    return this.markCanonical(exec, this.materializeFinalResult({
      isError: false,
      value,
      content,
      ...meta !== undefined ? { meta } : {},
      ...concludesTurn ? { concludesTurn: true as const } : {},
    }) as ToolExecutionSuccess)
  }

  /** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
  private normalizeDispatchResult(exec: ToolExecution, result: ToolExecutionResult): ToolExecutionResult {
    if (this.canonicalResults.get(result) === exec.token) return result
    if (result.isError) {
      return this.markCanonical(exec, {
        isError: true,
        error: result.error,
        content: result.content,
        ...result.meta !== undefined ? { meta: result.meta } : {},
        ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
      })
    }
    const tool = this.resolveExecution(exec.name, exec.agent)
    if (tool === undefined) throw new ToolNotFoundError(exec.name)
    const normalized = this.createSuccessResult(exec, tool, result.value)
    return this.markCanonical(exec, {
      ...normalized,
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    })
  }

  /** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
  private materializeFinalResult(result: ToolExecutionResult): ToolExecutionResult {
    const presentation = {
      content: result.content,
      ...result.meta !== undefined ? { meta: result.meta } : {},
      ...result.additionalContexts !== undefined ? { additionalContexts: result.additionalContexts } : {},
    }
    if (result.isError) {
      return materializePresentation({ isError: true as const, error: result.error, ...presentation })
    }
    const detached = materializePresentation({
      isError: false as const,
      ...presentation,
      ...result.concludesTurn === true ? { concludesTurn: true as const } : {},
    })
    return deepFreeze({ ...detached, value: result.value })
  }
}

function createExecutionToken(): ToolExecutionToken {
  return Symbol('ea.tool.execution') as ToolExecutionToken
}

function toolErrorResult(error: unknown): ToolExecutionResult {
  const info = errorInfo(error)
  const message = errorMessage(error)
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, ...info ? { info } : {} },
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function fuseToolSignals(caller: AbortSignal, wrapper: AbortSignal): FusedToolSignal {
  if (caller === wrapper) return { signal: caller, dispose() {} }

  const controller = new AbortController()
  let listening = false
  const dispose = (): void => {
    if (!listening) return
    listening = false
    caller.removeEventListener('abort', abortFromCaller)
    wrapper.removeEventListener('abort', abortFromWrapper)
  }
  const abortFrom = (source: AbortSignal): void => {
    const reason: unknown = source.reason
    controller.abort(reason)
    dispose()
  }
  const abortFromCaller = (): void => { abortFrom(caller) }
  const abortFromWrapper = (): void => { abortFrom(wrapper) }

  if (wrapper.aborted) abortFromWrapper()
  else if (caller.aborted) abortFromCaller()
  else {
    listening = true
    caller.addEventListener('abort', abortFromCaller, { once: true })
    wrapper.addEventListener('abort', abortFromWrapper, { once: true })
  }
  return { signal: controller.signal, dispose }
}

function toolAbortedResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted' }],
    isError: true,
    error: {
      message: 'tool call aborted',
      info: { name: 'AbortError', code: TOOL_ABORTED },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

function toolAbortedBeforeDispatchResult(prior?: ToolExecutionResult): ToolExecutionResult {
  const additionalContexts = prior?.additionalContexts ?? []
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    },
    ...additionalContexts.length > 0 ? { additionalContexts } : {},
  }
}

export default ToolRuntime

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/tools'
  export const name = 'tools-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
