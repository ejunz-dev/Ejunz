import type { Branded } from '@ejunz/ea/brand'

export type LspProviderId = Branded<'LspProviderId'>

export function LspProviderId(id: string): LspProviderId {
  return id as LspProviderId
}

export type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'

export interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}

export interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}

export interface LspQueryRequest {
  /** Which semantic query to run. */
  readonly operation: LspOperation
  /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
  readonly filePath: string
  /** The zero-based UTF-16 cursor position to query at. */
  readonly position: LspPosition
  /** The workspace root the provider resolves against and indexes; required, never defaulted. */
  readonly workspaceRoot: string
}

export interface LspProviderQuery extends LspQueryRequest {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}

export interface LspLocation {
  /** The target document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}

export interface LspHover {
  /** The normalized hover text (markdown or plaintext, provider-joined). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}

export type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }

export interface LspProvider {
  /** Stable provider identity, reserved atomically with the extension mappings. */
  readonly id: LspProviderId
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * Run one query. The seam has already selected this provider and derived `languageId`.
   * @param request - the resolved provider query (caller request + derived language id).
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}

export interface LspService {
  /**
   * Register a provider, atomically reserving its id and every normalized extension. Any conflict
   * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
   * reservations. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id and all extension reservations.
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * Select a provider by the file's extension and run one query. Selection is per-query and
   * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the normalized query.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}

import { Context, Service } from '@ejunz/cordis'

import { EjunzAgentError } from '@ejunz/ea/llm'

declare module '@ejunz/cordis' {
  interface Context {
    lsp: LspService
  }
}

export class LspError extends EjunzAgentError {}

export function finalExtension(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath
  const dot = base.lastIndexOf('.')
  // dot <= 0 covers both "no dot" (-1) and a leading-dot dotfile (0): neither has an extension.
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

const EXTENSION_PATTERN = /^\.[^./\\]+$/

interface Route {
  readonly provider: LspProvider
  readonly languageId: string
}

export class Lsp extends Service implements LspService {
  private readonly providerIds = new Set<LspProviderId>()
  private readonly routes = new Map<string, Route>()

  constructor(ctx: Context) {
    super(ctx, 'lsp')
  }

  registerProvider(provider: LspProvider): () => void {
    // Validate and conflict-check everything BEFORE any mutation: an invalid or conflicting
    // registration must publish nothing (fail-loud, all-or-nothing).
    const id = provider.id
    if (id.trim() === '') {
      throw new LspError('an LSP provider id must be a non-empty string', 'LSP_INVALID_PROVIDER')
    }
    if (this.providerIds.has(id)) {
      throw new LspError(`an LSP provider with id "${id}" is already registered`, 'LSP_CONFLICT')
    }

    const entries = Object.entries(provider.extensionToLanguage)
    if (entries.length === 0) {
      throw new LspError(`LSP provider "${id}" registers no file extensions`, 'LSP_INVALID_PROVIDER')
    }

    // Normalize into this provider's route set, catching intra-provider duplicates (e.g. `.TS` and
    // `.ts`) before checking cross-provider conflicts.
    const pending = new Map<string, Route>()
    for (const [rawExt, languageId] of entries) {
      const ext = normalizeExtension(rawExt)
      if (!EXTENSION_PATTERN.test(ext)) {
        throw new LspError(`LSP provider "${id}" maps an invalid extension "${rawExt}"`, 'LSP_INVALID_PROVIDER')
      }
      if (languageId.trim() === '') {
        throw new LspError(`LSP provider "${id}" maps extension "${ext}" to an empty language id`, 'LSP_INVALID_PROVIDER')
      }
      if (pending.has(ext)) {
        throw new LspError(`LSP provider "${id}" maps extension "${ext}" more than once`, 'LSP_INVALID_PROVIDER')
      }
      pending.set(ext, { provider, languageId })
    }
    for (const ext of pending.keys()) {
      if (this.routes.has(ext)) {
        throw new LspError(`extension "${ext}" is already handled by another LSP provider`, 'LSP_CONFLICT')
      }
    }

    // All checks passed: reserve id and every extension in one lifecycle controller so disposal
    // releases them together.
    const dispose = this.ctx.effect(function* (this: Lsp) {
      this.providerIds.add(id)
      for (const [ext, route] of pending) this.routes.set(ext, route)
      yield () => {
        this.providerIds.delete(id)
        for (const ext of pending.keys()) this.routes.delete(ext)
      }
    }.bind(this), 'lsp.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is synchronous
    // fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
    const route = this.routes.get(finalExtension(request.filePath))
    if (route === undefined) {
      throw new LspError(`no LSP provider handles "${request.filePath}"`, 'LSP_UNAVAILABLE')
    }
    return route.provider.query({ ...request, languageId: route.languageId }, signal)
  }
}

function normalizeExtension(ext: string): string {
  const lower = ext.toLowerCase()
  return lower.startsWith('.') ? lower : `.${lower}`
}

export default Lsp

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/lsp'
  export const name = 'lsp-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
