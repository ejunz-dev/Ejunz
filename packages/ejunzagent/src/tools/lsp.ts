import type { GenericCallView } from '@ejunz/ea-core/tools'

import type { LspHover, LspLocation, LspOperation, LspPosition } from '@ejunz/ea-core/lsp'

import { posix, win32 } from 'node:path'

import { fileURLToPath } from 'node:url'

export const LSP_OPERATIONS: readonly LspOperation[] = ['goToDefinition', 'findReferences', 'goToImplementation', 'hover']

export const DEFAULT_MAX_LOCATIONS = 100

export const DEFAULT_MAX_RESULT_CHARS = 16_000

export interface LspToolInput {
  readonly operation: LspOperation
  readonly filePath: string
  /** Zero-based UTF-16 position converted from the one-based model coordinates. */
  readonly position: LspPosition
}

export interface LspToolArgs {
  readonly operation: string
  readonly file_path: string
  readonly line: number
  readonly character: number
}

export function parseLspArgs(args: LspToolArgs): LspToolInput {
  if (!isOperation(args.operation)) {
    throw new Error(`operation must be one of ${LSP_OPERATIONS.join(', ')}`)
  }
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const line = oneBased(args.line, 'line')
  const character = oneBased(args.character, 'character')
  return {
    operation: args.operation,
    filePath: args.file_path,
    // The model counts from 1; the seam (and protocol) count from 0.
    position: { line: line - 1, character: character - 1 },
  }
}

function isOperation(value: string): value is LspOperation {
  return (LSP_OPERATIONS as readonly string[]).includes(value)
}

function oneBased(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer (one-based)`)
  }
  return value
}

export function formatLocations(
  locations: readonly LspLocation[],
  workspaceUri: string,
  maxLocations: number,
  maxResultChars: number,
): string {
  if (locations.length === 0) return boundResult('No results.', maxResultChars, 'locations')
  const shown = locations.slice(0, maxLocations)
  const omitted = locations.length - shown.length
  const grouped = new Map<string, string[]>()
  for (const location of shown) {
    const path = renderUri(location.uri, workspaceUri)
    const line = location.range.start.line + 1
    const character = location.range.start.character + 1
    const entries = grouped.get(path) ?? []
    entries.push(`${path}:${line}:${character}`)
    grouped.set(path, entries)
  }
  const lines: string[] = []
  for (const entries of grouped.values()) lines.push(...entries)
  if (omitted > 0) {
    lines.push(`… ${omitted} more location${omitted === 1 ? '' : 's'} omitted (limit ${maxLocations}).`)
  }
  return boundResult(lines.join('\n'), maxResultChars, 'locations')
}

export function formatHover(hover: LspHover | null, maxResultChars: number): string {
  const text = hover === null ? 'No hover information.' : hover.contents
  return boundResult(text, maxResultChars, 'hover')
}

function boundResult(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text
  const notice = `\n… ${label} truncated (limit ${maxChars} characters).`
  if (notice.length >= maxChars) return notice.slice(0, maxChars)
  return `${text.slice(0, maxChars - notice.length)}${notice}`
}

export function renderUri(uri: string, workspaceUri: string): string {
  if (!uri.startsWith('file:')) return uri
  let target: URL
  let workspace: URL
  try {
    target = new URL(uri)
    workspace = new URL(workspaceUri)
  } catch {
    return uri
  }
  if (workspace.protocol !== 'file:') return uri
  // A `file:` URI does not carry its world's OS, so a leading `/X:` segment is
  // read as a Windows drive. A POSIX workspace literally rooted at `/c:/...`
  // would mis-render (display only; edits and reads use the exact URI).
  const drivePath = /^\/[a-z](?::|%3A)/iu
  const windowsWorld = workspace.hostname.length > 0 || drivePath.test(workspace.pathname)
  const targetWindowsWorld = windowsWorld && (target.hostname.length > 0 || drivePath.test(target.pathname))
  const workspacePath = filePath(workspace, windowsWorld)
  const targetPath = filePath(target, targetWindowsWorld)
  if (workspacePath === undefined || targetPath === undefined) return uri
  if (windowsWorld !== targetWindowsWorld) return targetPath
  const path = windowsWorld ? win32 : posix
  const relative = path.relative(workspacePath, targetPath)
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  const rendered = relative === '' ? '.' : outside ? targetPath : relative
  return windowsWorld ? rendered.replaceAll('\\', '/') : rendered
}

function filePath(url: URL, windows: boolean): string | undefined {
  try {
    const path = fileURLToPath(url, { windows })
    return path.includes('\0') ? undefined : path
  } catch {
    // `fileURLToPath` rejects malformed escapes, authorities, and encoded path separators.
    return undefined
  }
}

export function presentLspCall(args: LspToolArgs): GenericCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: `LSP ${args.operation} ${args.file_path}:${args.line}:${args.character}`,
    locations: [{ path: args.file_path, line: args.line }],
  }
}

import type { ToolExecution } from '@ejunz/ea-core/tools'

export function sessionCwd(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { defineTool } from '@ejunz/ea-core/tools'

import { assertNever } from '@ejunz/ea-core/llm'

import { LspError } from '@ejunz/ea-core/lsp'

import type {} from '@ejunz/ea-core/lsp'

import type {} from '@ejunz/ea-core/system-prompt'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea-core/timeout'

export const name = 'tool-lsp'

export const inject = ['tools', 'lsp', 'systemPrompt']

export const DEFAULT_LSP_TOOL_TIMEOUT_MS = 60_000

export const LSP_PROMPT_TEXT =
  'Use search/read for ordinary navigation. Use lsp when textual matches are ambiguous or before a change requires precise definitions, implementations, or references. Positions are one-based line and character (UTF-16) at the cursor; an off-symbol position may return no results. findReferences always includes the declaration.'

export interface Config {
  /** Largest number of rendered locations before an omission marker (default 100). */
  maxLocations?: number
  /** Largest complete rendered result in characters, including truncation metadata (default 16000). */
  maxResultChars?: number
  /** Tool-call timeout budget in ms (default 60000). */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxLocations: z.number().default(DEFAULT_MAX_LOCATIONS),
  maxResultChars: z.number().default(DEFAULT_MAX_RESULT_CHARS),
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_LSP_TOOL_TIMEOUT_MS),
})

type ResolvedConfig = Required<Config>

const LSP_POSITION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    line: { type: 'integer', required: true },
    character: { type: 'integer', required: true },
  },
} as const

const LSP_RANGE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    start: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
    end: { ...LSP_POSITION_OUTPUT_SCHEMA, required: true },
  },
} as const

export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxLocations', resolved.maxLocations)
  assertPositiveInteger('maxResultChars', resolved.maxResultChars)
  assertTimer('timeoutMs', resolved.timeoutMs)

  ctx.systemPrompt.section({ name: 'tool:lsp', order: 112, text: LSP_PROMPT_TEXT })

  ctx.tools.register(defineTool({
    name: 'lsp',
    description:
      'Query a language server for precise code navigation. operation is one of goToDefinition, findReferences, goToImplementation, hover. line and character are one-based UTF-16 cursor coordinates. findReferences includes the declaration.',
    parameters: {
      operation: {
        type: 'string',
        required: true,
        enum: [...LSP_OPERATIONS],
        description: 'goToDefinition, findReferences, goToImplementation, or hover.',
      },
      file_path: { type: 'string', required: true, description: 'The source file to query, relative to the workspace or absolute.' },
      line: { type: 'number', required: true, description: 'One-based line of the cursor.' },
      character: { type: 'number', required: true, description: 'One-based UTF-16 column of the cursor.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'locations' },
              locations: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    uri: { type: 'string', required: true },
                    range: { ...LSP_RANGE_OUTPUT_SCHEMA, required: true },
                  },
                },
              },
              resolvedWorkspaceUri: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'hover' },
              hover: {
                required: true,
                oneOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      contents: { type: 'string', required: true },
                      range: LSP_RANGE_OUTPUT_SCHEMA,
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      render: (_args, value) => {
        switch (value.kind) {
          case 'locations':
            return [{ type: 'text', text: formatLocations(value.locations, value.resolvedWorkspaceUri, resolved.maxLocations, resolved.maxResultChars) }]
          case 'hover':
            return [{ type: 'text', text: formatHover(value.hover, resolved.maxResultChars) }]
          /* v8 ignore next -- exhaustive over the output schema's closed union; unreachable. */
          default:
            return assertNever(value, 'tool-lsp output')
        }
      },
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      const input = parseLspArgs(args)
      const workspaceRoot = sessionCwd(exec)
      if (workspaceRoot === undefined) {
        throw new LspError('the lsp tool requires a session workspace cwd', 'LSP_WORKSPACE_REQUIRED')
      }
      const result = await ctx.lsp.query({
        operation: input.operation,
        filePath: input.filePath,
        position: input.position,
        workspaceRoot,
      }, exec.signal)
      switch (result.kind) {
        case 'locations':
          return {
            kind: 'locations' as const,
            locations: result.locations.map(location => ({
              uri: location.uri,
              range: {
                start: { line: location.range.start.line, character: location.range.start.character },
                end: { line: location.range.end.line, character: location.range.end.character },
              },
            })),
            resolvedWorkspaceUri: result.resolvedWorkspaceUri,
          }
        case 'hover':
          return {
            kind: 'hover' as const,
            hover: result.hover === null
              ? null
              : {
                contents: result.hover.contents,
                ...result.hover.range === undefined
                  ? {}
                  : {
                    range: {
                      start: { line: result.hover.range.start.line, character: result.hover.range.start.character },
                      end: { line: result.hover.range.end.line, character: result.hover.range.end.character },
                    },
                  },
              },
          }
        /* v8 ignore next -- exhaustive over the closed LspQueryResult union; unreachable. */
        default:
          return assertNever(result, 'tool-lsp result')
      }
    },
    presentCall: presentLspCall,
  }))
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-lsp: ${name} must be a positive integer`)
  }
}

function assertTimer(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-lsp: ${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/tool-lsp'
  export const name = 'tool-lsp-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
