import { readdirSync, readFileSync } from 'node:fs'

interface ProcessInspectorInternals {
  readFile(path: string): string
  readDir(path: string): string[]
}

const DEFAULT_INTERNALS: ProcessInspectorInternals = {
  readFile: path => readFileSync(path, 'utf8'),
  readDir: path => readdirSync(path),
}

interface ProcStat {
  pid: number
  parentPid: number
  pgrp: number
  session: number
  state: string
  tpgid: number
  started: string
}

export function parseProcStat(text: string): ProcStat | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close <= open) return undefined
  const pid = Number(text.slice(0, open).trim())
  const rest = text.slice(close + 2).trim().split(/\s+/)
  const state = rest[0] || ''
  const parentPid = Number(rest[1])
  const pgrp = Number(rest[2])
  const session = Number(rest[3])
  const tpgid = Number(rest[5])
  const started = rest[19]
  if (![pid, parentPid, pgrp, session, tpgid].every(Number.isSafeInteger)
    || state.length !== 1 || started === undefined) return undefined
  return { pid, parentPid, pgrp, session, state, tpgid, started }
}

function readLinuxStat(internals: ProcessInspectorInternals, pid: number): ProcStat | undefined {
  try {
    return parseProcStat(internals.readFile(`/proc/${pid}/stat`))
  } catch (_unreadableProcEntry) {
    return undefined
  }
}

export function linuxProcessGroupHasLiveMembers(
  processGroupId: number,
  internals: ProcessInspectorInternals = DEFAULT_INTERNALS,
): boolean | undefined {
  let entries: string[]
  try {
    entries = internals.readDir('/proc')
  } catch (_unreadableProcDirectory) {
    return undefined
  }
  let matched = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const stat = readLinuxStat(internals, Number(entry))
    if (stat?.pgrp !== processGroupId) continue
    matched = true
    if (!/^[ZXx]$/.test(stat.state)) return true
  }
  return matched ? false : undefined
}

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'

import type { Readable } from 'node:stream'

import { randomBytes } from 'node:crypto'

import { closeSync, mkdtempSync, openSync, unlinkSync, writeSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { setTimeout as sleepMs } from 'node:timers/promises'

import { scrubbedParentEnv } from '@ejunz/ea-core/subprocess'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea-core/timeout'

import type {
  CollectedOutput,
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@ejunz/ea-core/subprocess'

export function childEnv(extra?: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const env = scrubbedParentEnv()
  if (process.platform !== 'win32') return { ...env, ...extra }
  let entries: [string, string | undefined][] = Object.entries(env)
  for (const [key, value] of Object.entries(extra ?? {})) {
    const normalized = key.toUpperCase()
    entries = entries.filter(([inherited]) => inherited.toUpperCase() !== normalized)
    entries.push([key, value])
  }
  return Object.fromEntries(entries)
}

export interface SpawnInternals {
  /** Directory for spill files (defaults to the OS temp dir). */
  spillDir?: string
  /** Windows tree-termination runner (defaults to `taskkill /PID <pid> /T /F`). */
  taskkill?: (pid: number) => void
  /** Host platform override for signalling decisions. */
  platform?: NodeJS.Platform
}

export interface LocalSubprocessHandle extends SubprocessHandle {
  /** Force-terminate the current tree synchronously without starting timers or waits. */
  terminateForHostExit(): void
}

function sleepTick(): Promise<void> {
  return sleepMs(15)
}

let spillCounter = 0

let defaultSpillDir: string | undefined

function privateSpillDir(): string {
  defaultSpillDir ??= mkdtempSync(join(tmpdir(), 'ea-subprocess-'))
  return defaultSpillDir
}

export class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private dropped = false
  private spillFd: number | undefined
  private spillFile: string | undefined
  private spillDisabled: boolean
  /** Total bytes ever pushed (not just retained). */
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly label: string,
    private readonly spillDir: string,
  ) {
    this.spillDisabled = maxSpillBytes === undefined
  }

  /**
   * Ingest one stream chunk, counting it toward the whole-stream total. On
   * first overflow of the in-memory cap a spill file is opened (when spilling
   * is enabled) and every chunk (already-collected ones included) is appended
   * there from then on; the in-memory tail then drops whole chunks from its
   * head (or the head of a single over-cap chunk) until it fits the cap again.
   * @param chunk - the raw bytes from one stream 'data' event.
   */
  push(chunk: Buffer): void {
    this.total += chunk.length
    const overflows = this.bytes + chunk.length > this.maxBytes
    if (!this.spillDisabled && (overflows || this.spillFd !== undefined)) this.spillAll(chunk)
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.bytes - this.maxBytes
      if (head.length <= excess) {
        // Drop the whole head chunk (length ≥ 1 is guaranteed while over cap).
        this.chunks.shift()
        this.bytes -= head.length
      } else {
        // Trim the head so the retained window is byte-exact at the cap — a
        // diagnostic tail (an LSP server's stderr) must hold the LAST
        // maxBytes regardless of how the stream was chunked.
        this.chunks[0] = head.subarray(excess)
        this.bytes -= excess
      }
      this.dropped = true
    }
  }

  /** Open the spill file lazily and append `chunk` (and any prior chunks once). */
  private spillAll(chunk: Buffer): void {
    if (this.maxSpillBytes !== undefined && this.total > this.maxSpillBytes) {
      this.discardSpill()
      return
    }
    if (this.spillFd === undefined) {
      // Random suffix + O_EXCL + no-follow-equivalent ('wx' fails on any
      // existing path, symlink or not) + owner-only mode: defeats spill-path
      // prediction and symlink planting in shared tmp dirs.
      this.spillFile = join(
        this.spillDir,
        `ea-subprocess-${process.pid}-${++spillCounter}-${randomBytes(6).toString('hex')}-${this.label}.log`,
      )
      this.spillFd = openSync(this.spillFile, 'wx', 0o600)
      for (const prior of this.chunks) writeSync(this.spillFd, prior)
    }
    writeSync(this.spillFd, chunk)
  }

  /** Stop spilling and remove the file once it can no longer hold the complete stream. */
  private discardSpill(): void {
    const fd = this.spillFd
    const file = this.spillFile
    this.spillFd = undefined
    this.spillFile = undefined
    this.spillDisabled = true
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Retain the descriptor so finalize can retry the failed close.
        this.spillFd = fd
      }
    }
    if (file !== undefined) {
      try {
        unlinkSync(file)
      } catch {
        // A failed unlink leaves at most maxSpillBytes behind, never an unbounded file.
      }
    }
  }

  /**
   * Incremental read in whole-stream byte coordinates: returns everything
   * pushed since `fromByte`. When `fromByte` has already slid out of the
   * in-memory tail window, the read is `lossy` — it returns the whole
   * retained tail and the gap is only recoverable from the spill file.
   * @param fromByte - whole-stream offset to resume from (a prior read's `nextOffset`; 0 for the first read).
   * @returns the delta text, the offset for the next read, the `lossy` flag, and the spill path when one was created.
   */
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string } {
    const windowStart = this.total - this.bytes
    const buffer = Buffer.concat(this.chunks)
    const lossy = fromByte < windowStart
    const slice = lossy ? buffer : buffer.subarray(fromByte - windowStart)
    return {
      text: slice.toString('utf8'),
      nextOffset: this.total,
      lossy,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }

  /**
   * Close the spill file once the stream has ended. A failed close (delayed
   * writeback fault) stops advertising the spill path — the file may be
   * missing its tail — while every in-memory read keeps working. Idempotent;
   * the spawn path seals both collectors at settlement so reads after exit
   * never point at a still-open file.
   */
  seal(): void {
    if (this.spillFd === undefined) return
    try {
      closeSync(this.spillFd)
    } catch {
      // A delayed writeback failure makes the spill unreliable; keep the
      // in-memory result but stop advertising that file.
      this.spillFile = undefined
    }
    this.spillFd = undefined
  }

  /**
   * Seal the spill file and return the final output.
   * @returns the final collected output: tail text, truncation flag, and the spill path when intact.
   */
  finalize(): CollectedOutput {
    this.seal()
    return {
      text: Buffer.concat(this.chunks).toString('utf8'),
      truncated: this.dropped,
      ...this.spillFile !== undefined ? { spillPath: this.spillFile } : {},
    }
  }
}

export function killGroup(pid: number, sig: NodeJS.Signals): void {
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    // Swallow: see contract above.
  }
}

export function taskkillProcessTree(pid: number): void {
  if (pid <= 0) return
  // Outcome deliberately unchecked: an already-absent tree (status 128), exit
  // races, and a missing taskkill binary (spawnSync reports, never throws) are
  // as tolerable here as ESRCH is for a POSIX group signal.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
}

function signalTree(
  platform: NodeJS.Platform,
  pid: number,
  sig: NodeJS.Signals,
  child: ChildProcess,
  taskkill: (pid: number) => void,
): void {
  if (platform === 'win32') {
    taskkill(pid)
    return
  }
  /* v8 ignore next -- kill/terminate gate on treeAlive(), which is false for pid -1; this guard protects direct callers only. */
  if (pid <= 0) return
  try {
    process.kill(-pid, sig)
  } catch {
    /* v8 ignore start -- the fallback needs a live child whose group signal fails
       (EPERM-style), which POSIX CI cannot stage; the swallow keeps teardown idempotent. */
    try {
      child.kill(sig)
    } catch {
      // The direct child already exited; teardown remains idempotent.
    }
    /* v8 ignore stop */
  }
}

export function spawnSubprocess(spec: SubprocessSpawnSpec, internals: SpawnInternals = {}): LocalSubprocessHandle {
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const spillDir = internals.spillDir ?? privateSpillDir()
  const platform = internals.platform ?? process.platform
  const taskkill = internals.taskkill ?? taskkillProcessTree

  if (spec.signal?.aborted) {
    throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
  }
  const [program, ...args] = spec.argv
  if (program === undefined || program.length === 0) {
    throw new Error('invalid argv: expected a non-empty program name at argv[0]')
  }

  const isCollect = (mode: SubprocessOutputMode): mode is SubprocessCollect =>
    mode !== 'pipe' && mode !== 'inherit'
  const outMode = spec.stdio.stdout
  const errMode = spec.stdio.stderr
  const stdinMode = spec.stdio.stdin

  const env = childEnv(spec.env)
  const child = spawn(program, args, {
    cwd: spec.cwd,
    env,
    stdio: [
      stdinMode === 'ignore' ? 'ignore' : 'pipe',
      outMode === 'inherit' ? 'inherit' : 'pipe',
      errMode === 'inherit' ? 'inherit' : 'pipe',
    ],
    // `detached` gives teardown a tree root on POSIX (its own process group);
    // Windows terminates by root pid through taskkill /T instead.
    detached: platform !== 'win32',
  })

  const collectStream = (mode: SubprocessOutputMode, stream: Readable | null, label: string): OutputCollector | undefined => {
    if (!isCollect(mode) || stream === null) return undefined
    const collector = new OutputCollector(mode.maxBytes, mode.spill?.maxBytes, label, spillDir)
    stream.on('data', (chunk: Buffer) => { collector.push(chunk) })
    return collector
  }
  const stdoutCollector = collectStream(outMode, child.stdout, 'stdout')
  const stderrCollector = collectStream(errMode, child.stderr, 'stderr')

  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let treeExitObserved = false
  let treeExitObservation: Promise<void> | undefined
  let settled = false

  // Failed spawns use pid -1 so signalling remains a no-op.
  const pid = child.pid ?? -1

  /** Whether the detached tree's root (or POSIX group) is still alive. */
  const treeAlive = (): boolean => {
    /* v8 ignore next -- only a timer callback already queued when the observer settles can enter here;
       the guard is the final defense against probing an id after its tree was confirmed absent. */
    if (treeExitObserved) return false
    if (pid <= 0) return false
    if (platform === 'win32') {
      // Windows has no group-liveness probe; the direct child's exit is the
      // observable boundary (taskkill /T already took the tree with it).
      return child.exitCode === null && child.signalCode === null
    }
    try {
      process.kill(-pid, 0)
      // A group containing only unreaped zombies still answers kill(0), but
      // it can execute no work and cannot be signalled into quiescence. Only
      // inspect after direct-child settlement so live-process polls remain a
      // syscall rather than repeated process-table scans.
      if (settled && platform === 'linux' && linuxProcessGroupHasLiveMembers(pid) === false) return false
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      /* v8 ignore next 2 -- POSIX reports an absent group as ESRCH; child-reaping timing
         makes observing the other arm platform-dependent. */
      if (code === 'ESRCH') return false
      /* v8 ignore start -- EPERM and non-POSIX negative-pid failures are platform defenses; CI runs
         tree-lifecycle tests on POSIX hosts where absence reports ESRCH. */
      if (code === 'EPERM') return true
      return child.exitCode === null && child.signalCode === null
      /* v8 ignore stop */
    }
  }

  /**
   * Start or reuse the handle's single whole-tree exit observer. The first
   * confirmed absence is a permanent no-more-signals boundary: it cancels a
   * pending escalation before this process-group id can be reused.
   */
  const observeTreeExit = (): Promise<void> => {
    treeExitObservation ??= (async () => {
      while (treeAlive()) await sleepTick()
      treeExitObserved = true
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      graceTimer = undefined
    })()
    return treeExitObservation
  }

  // The escalation's tier primitive (not on the handle — terminate() is the
  // only consumer-facing termination verb). Guards on TREE liveness, not
  // outcome settlement: a TERM-trapping helper can outlive the settled direct
  // child and must stay signalable, while a fully-dead tree (possible pid
  // reuse) must not be re-signalled by a later tier.
  const kill = (sig: NodeJS.Signals): void => {
    /* v8 ignore next -- the shared exit observer cancels the ordinary dead-tree timer;
       this remains the timer/death race guard and cannot be staged deterministically. */
    if (!treeAlive()) return
    signalTree(platform, pid, sig, child, taskkill)
  }

  const terminate = (): void => {
    if (treeExitObserved || graceTimer !== undefined) return
    // Observe from the first termination tier onward, even when inherited
    // pipes delay `done` and no consumer has begun its own teardown wait.
    void observeTreeExit()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- observer can record absence before its first await.
    if (treeExitObserved) return
    kill('SIGTERM')
    // The escalation must survive direct-child settlement — the leader dying
    // does not mean the tree died — so settle does not clear this timer, and
    // kill() re-probes tree liveness before force-killing. It stays ref'd:
    // the pending SIGKILL is a commitment, and a parent exiting before it
    // fires would orphan a trapped survivor. Self-bounds at graceMs.
    graceTimer = setTimeout(() => { kill('SIGKILL') }, spec.graceMs)
  }

  const terminateForHostExit = (): void => {
    kill('SIGKILL')
  }

  // The caller owns timeout classification; this layer only reacts to abort.
  const onAbort = (): void => { terminate() }
  spec.signal?.addEventListener('abort', onAbort, { once: true })

  // Batch stdin is written and closed up front; process exit and captured
  // output remain authoritative, so write errors (EPIPE) are best-effort.
  if (typeof stdinMode === 'object' && child.stdin !== null) {
    child.stdin.on('error', () => { /* stdin write is best-effort; outcome rides on exit/output. */ })
    child.stdin.end(stdinMode.data)
  }

  const done = new Promise<SubprocessOutcome>((resolve, reject) => {
    let pipeDrainTimer: ReturnType<typeof setTimeout> | undefined
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      // Only ejunzAgent-collected pipes are force-closed at the drain boundary;
      // a 'pipe'-mode stream belongs to the caller and closes with the child.
      if (stdoutCollector !== undefined) child.stdout?.destroy()
      if (stderrCollector !== undefined) child.stderr?.destroy()
      stdoutCollector?.seal()
      stderrCollector?.seal()
      cleanup()
      resolve({ exitCode, signal })
    }
    child.on('error', (error) => {
      // No meaningful close outcome follows a spawn failure.
      settled = true
      cleanup()
      reject(error)
    })
    child.on('exit', (exitCode, signal) => {
      // A surviving descendant that inherited a pipe must not hold the
      // outcome open indefinitely: after exit, the same bounded grace that
      // governs kills also bounds the close wait.
      pipeDrainTimer = setTimeout(() => {
        settle(exitCode, signal)
      }, spec.graceMs)
    })
    child.on('close', settle)
    function cleanup(): void {
      // graceTimer deliberately NOT cleared: the SIGKILL escalation must be
      // able to reach tree survivors after the direct child settles.
      if (pipeDrainTimer !== undefined) clearTimeout(pipeDrainTimer)
      spec.signal?.removeEventListener('abort', onAbort)
    }
  })

  const waitForExit = async (signal?: AbortSignal): Promise<boolean> => {
    const observed = observeTreeExit()
    if (treeExitObserved) return true
    if (signal?.aborted) return false
    if (signal === undefined) {
      await observed
      return true
    }
    const aborted = Promise.withResolvers<boolean>()
    const onAbort = (): void => { aborted.resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
    /* v8 ignore next -- closes the event-loop race between the preceding aborted check and listener registration. */
    if (signal.aborted) onAbort()
    try {
      return await Promise.race([observed.then(() => true), aborted.promise])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  return {
    pid,
    /* v8 ignore start -- pipe-mode fds exist on every spawn Node returns; the null-coalesces guard a nonconforming ChildProcess only. */
    stdin: stdinMode === 'pipe' ? child.stdin ?? undefined : undefined,
    stdout: outMode === 'pipe' ? child.stdout ?? undefined : undefined,
    stderr: errMode === 'pipe' ? child.stderr ?? undefined : undefined,
    /* v8 ignore stop */
    collected: {
      ...stdoutCollector !== undefined ? { stdout: stdoutCollector } : {},
      ...stderrCollector !== undefined ? { stderr: stderrCollector } : {},
    },
    done,
    terminate,
    terminateForHostExit,
    waitForExit,
  }
}

import { constants } from 'node:fs'

import { access, stat } from 'node:fs/promises'

import { delimiter, extname, isAbsolute, resolve } from 'node:path'

import { Context } from '@ejunz/cordis'

import { SubprocessRuntime } from '@ejunz/ea-core/subprocess'

import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@ejunz/ea-core/subprocess'

export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** Live handles retained for normal disposal and synchronous host-exit finalization. */
  private live = new Set<LocalSubprocessHandle>()
  /** Test hook: spill and platform knobs forwarded to spawnSubprocess. */
  internals: SpawnInternals = {}

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => {
      const onHostExit = (): void => { this.terminateForHostExit() }
      process.prependListener('exit', onHostExit)
      return async () => {
        try {
          await this.disposeManagedProcesses()
        } finally {
          process.off('exit', onHostExit)
        }
      }
    }, 'local subprocess teardown')
  }

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit()
      } catch (_ordinaryTreeTerminationFailed) {
        // Host exit cannot await or report one target; continue with the rest.
      }
    }

  }

  private async disposeManagedProcesses(): Promise<void> {
    // Terminate (escalating), then await WHOLE-TREE exit — not just the
    // direct child's settlement — so even a TERM-trapping descendant cannot
    // outlive the fiber. Keep both sets authoritative while these waits are
    // pending so a shorter process-level exit bound can still force-kill them.
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      // Spawn-failure rejections already settled and left the live set.
      pending.push(handle.done.catch(() => {}).then(() => handle.waitForExit()))
    }
    const outcomes = await Promise.allSettled(pending)
    const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
      ? [outcome.reason as unknown]
      : [])
    if (failures.length > 0) this.terminateForHostExit()
    this.live.clear()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const environment = childEnv(env)
    const absolute = isAbsolute(command)
    if (!absolute && (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new Error(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = environmentValue(env, 'PATH') ?? ''
    const extensions = process.platform === 'win32' && extname(command) === ''
      ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
    return path.split(delimiter).flatMap(directory =>
      extensions.map(extension => resolve(process.cwd(), directory, command + extension)))
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const handle = spawnSubprocess(spec, this.internals)
    this.live.add(handle)
    // Release ownership only once the whole TREE is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    handle.done.then(release, release)
    return handle
  }

}

function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

export default LocalSubprocessRuntime

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/subprocess-local'
  export const name = 'subprocess-local-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
