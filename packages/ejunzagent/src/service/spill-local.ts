import { createHash, randomBytes } from 'node:crypto'

import { mkdtempSync } from 'node:fs'

import { mkdir, open } from 'node:fs/promises'

import { join } from 'node:path'

import { tmpdir } from 'node:os'

let defaultRoot: string | undefined

export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), 'ea-spill-'))
  return defaultRoot
}

export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

export interface SaveTextOptions {
  /** The spill root directory (configured or the lazy private default). */
  root: string
  /** The owning session id (scopes the directory). */
  sessionId: string
  /** Caller-suggested base name; sanitized to one safe segment before use. */
  suggestedName: string
  /** The full text to persist. */
  content: string
}

export interface SavedText {
  path: string
  bytes: number
}

export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const safeName = encodeSegment(options.suggestedName)
  const path = join(dir, `${randomBytes(6).toString('hex')}-${safeName}`)
  const bytes = Buffer.byteLength(options.content, 'utf8')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(options.content)
  } finally {
    await handle.close()
  }
  return { path, bytes }
}

import { Context } from '@ejunz/cordis'

import { resolve } from 'node:path'

import z from '@ejunz/schemastery'

import { SpillLocator, SpillStore } from '@ejunz/ea-core/spill'

import type { SaveTextSpill, SpillRef } from '@ejunz/ea-core/spill'

export interface Config {
  /**
   * Root directory for spill files. Omitted uses a lazily-created private
   * (0700) per-process directory under the OS temp dir — the safe default for
   * a local deployment. Set it to keep spill files under a known location.
   */
  root?: string
}

export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
  })

  /** Resolved absolute spill root (config `root`, else the private default), fixed at construction. */
  readonly root: string

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = config.root !== undefined ? resolve(config.root) : privateRoot()
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const saved = await saveTextFile({
      root: this.root,
      sessionId: input.owner.sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    return {
      locator: SpillLocator(saved.path),
      bytes: saved.bytes,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }
}

export default LocalSpillStore

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/spill-local'
  export const name = 'spill-local-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
