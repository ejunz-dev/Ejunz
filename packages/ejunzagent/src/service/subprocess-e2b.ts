import { Buffer } from 'node:buffer'

import { posix } from 'node:path'

import { e2bControlEnvs } from '@ejunz/ea-core/e2b'

import type { Sandbox } from '@ejunz/ea-core/e2b'

import { SENSITIVE_ENV_PATTERN } from '@ejunz/ea-core/subprocess'

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function remoteEnvironmentEntries(raw: string): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = []
  for (const entry of raw.split('\0')) {
    if (entry.length === 0) continue
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    entries.push([entry.slice(0, separator), entry.slice(separator + 1)])
  }
  return entries
}

export async function readRemoteEnvironment(sandbox: Sandbox, signal?: AbortSignal): Promise<string> {
  // TODO(e2b-replace-environment): Remove this ambient probe when E2B can start
  // a command with a replacement environment instead of merged overrides.
  const result = await sandbox.commands.run(
    'set -o pipefail; ea_e2b_passwd="$(getent passwd "$(id -u)")"; IFS=: read -r _ _ _ _ _ ea_e2b_home _ <<<"$ea_e2b_passwd"; test -n "$ea_e2b_home" -a -d "$ea_e2b_home"; printf \'%s\' "$ea_e2b_home" | base64 -w 0; printf \'\\n\'; env -0 | base64 -w 0',
    { envs: e2bControlEnvs(), ...(signal === undefined ? {} : { signal }) },
  )
  const lines = result.stdout.trim().split('\n')
  if (lines.length !== 2 || !lines.every(line => BASE64.test(line))) {
    throw new Error('subprocess-e2b: remote environment transport returned invalid base64')
  }
  const [encodedHome, encodedEnvironment] = lines as [string, string]
  let home: string
  let raw: string
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    home = decoder.decode(Buffer.from(encodedHome, 'base64'))
    raw = decoder.decode(Buffer.from(encodedEnvironment, 'base64'))
  } catch (error: unknown) {
    throw new Error('subprocess-e2b: remote environment is not valid UTF-8', { cause: error })
  }
  if (!posix.isAbsolute(home) || home.includes('\0')) {
    throw new Error(`subprocess-e2b: remote login home is invalid: ${JSON.stringify(home)}`)
  }
  const environment = new Map(remoteEnvironmentEntries(raw))
  environment.set('HOME', home)
  return [...environment].map(([name, value]) => `${name}=${value}\0`).join('')
}

export function scrubRemoteEnvironment(raw: string): Map<string, string> {
  const environment = new Map<string, string>()
  for (const [name, value] of remoteEnvironmentEntries(raw)) {
    if (name.startsWith('EA_') || SENSITIVE_ENV_PATTERN.test(name)) continue
    environment.set(name, value)
  }
  return environment
}

export function bootstrapEnvironment(raw: string): Record<string, string> {
  const environment: Record<string, string> = { TERM: 'dumb' }
  for (const [name] of remoteEnvironmentEntries(raw)) {
    if (name.startsWith('EA_') || SENSITIVE_ENV_PATTERN.test(name)) environment[name] = ''
  }
  return environment
}

export function serializeRemoteEnvironment(
  raw: string,
  explicit: Readonly<NodeJS.ProcessEnv> | undefined,
): string {
  const environment = scrubRemoteEnvironment(raw)
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value?.includes('\0') === true) {
      throw new Error('subprocess-e2b: environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    // An explicit undefined is the seam's tombstone: remove the ambient entry.
    if (value === undefined) environment.delete(name)
    else environment.set(name, value)
  }
  return [...environment].map(([name, value]) => `${name}=${value}\0`).join('')
}

import { Buffer } from 'node:buffer'

import type { SubprocessOutputRead, SubprocessOutputReader } from '@ejunz/ea-core/subprocess'

const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/u

export const E2B_OUTPUT_COMPLETE_FRAME = '!ea-e2b-output-complete!'

export class E2BBase64Decoder {
  private pending = ''
  private complete = false

  /**
   * Decode every complete newline-delimited frame in one arbitrarily split SDK callback.
   * @param text - ASCII base64 frames from E2B's decoded callback.
   * @returns the complete raw bytes made available by this callback.
   */
  push(text: string): Buffer {
    if (text.length === 0) return Buffer.alloc(0)
    this.pending += text
    const decoded: Buffer[] = []
    for (;;) {
      const boundary = this.pending.indexOf('\n')
      if (boundary < 0) break
      const frame = this.pending.slice(0, boundary)
      this.pending = this.pending.slice(boundary + 1)
      if (frame === E2B_OUTPUT_COMPLETE_FRAME) {
        if (this.complete) throw new Error('subprocess-e2b: duplicate output transport completion')
        this.complete = true
        continue
      }
      if (this.complete) throw new Error('subprocess-e2b: output transport continued after completion')
      if (!BASE64_TEXT.test(frame)) {
        throw new Error('subprocess-e2b: invalid base64 output transport')
      }
      const bytes = Buffer.from(frame, 'base64')
      if (bytes.toString('base64') !== frame) {
        throw new Error('subprocess-e2b: invalid base64 output transport')
      }
      decoded.push(bytes)
    }
    return Buffer.concat(decoded)
  }

  /**
   * Validate clean encoder completion, or discard an interrupted trailing frame after requested termination.
   * @param requireComplete - Whether natural completion requires the reserved EOF frame.
   */
  finish(requireComplete = true): void {
    if (!requireComplete) {
      this.pending = ''
      return
    }
    if (this.pending.length > 0) {
      throw new Error('subprocess-e2b: truncated base64 output transport')
    }
    if (!this.complete) throw new Error('subprocess-e2b: incomplete output transport')
  }
}

export class E2BOutputReader implements SubprocessOutputReader {
  private chunks: Buffer[] = []
  private retainedBytes = 0
  private totalBytes = 0
  private spillValid = true

  /**
   * Create a bounded reader over one remote spill path.
   * @param maxBytes - In-memory tail cap.
   * @param maxSpillBytes - Maximum complete remote file size the caller accepts.
   * @param spillPath - Remote full-output path.
   */
  constructor(
    private readonly maxBytes: number,
    private readonly maxSpillBytes: number | undefined,
    private readonly spillPath: string,
  ) {}

  /** Total bytes observed from the SDK stream. */
  get size(): number {
    return this.totalBytes
  }

  /** Stop advertising a remote spill whose writer did not reach clean EOF. */
  invalidateSpill(): void {
    this.spillValid = false
  }

  /**
   * Append one byte-faithful decoded transport event.
   * @param bytes - Raw command bytes recovered from the ASCII SDK transport.
   */
  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return
    const chunk = Buffer.from(bytes)
    this.totalBytes += chunk.length
    this.chunks.push(chunk)
    this.retainedBytes += chunk.length
    while (this.retainedBytes > this.maxBytes) {
      const head = this.chunks[0] as Buffer
      const excess = this.retainedBytes - this.maxBytes
      if (head.length <= excess) {
        this.chunks.shift()
        this.retainedBytes -= head.length
      } else {
        this.chunks[0] = head.subarray(excess)
        this.retainedBytes -= excess
      }
    }
  }

  /** @inheritdoc */
  readFrom(fromByte: number): SubprocessOutputRead {
    const retained = Buffer.concat(this.chunks, this.retainedBytes)
    const firstRetained = this.totalBytes - this.retainedBytes
    const lossy = fromByte < firstRetained
    const start = lossy ? 0 : Math.min(retained.length, Math.max(0, fromByte - firstRetained))
    return {
      text: retained.subarray(start).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
      ...(lossy && this.spillValid && this.maxSpillBytes !== undefined && this.totalBytes <= this.maxSpillBytes
        ? { spillPath: this.spillPath }
        : {}),
    }
  }
}

import { CommandExitError, e2bControlEnvs, SandboxNotFoundError } from '@ejunz/ea-core/e2b'

import type { Sandbox } from '@ejunz/ea-core/e2b'

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function signalOpts(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

export function commandOpts(
  envs: Record<string, string>,
  signal?: AbortSignal,
): { envs: Record<string, string>; signal?: AbortSignal } {
  return { envs: e2bControlEnvs(envs), ...signalOpts(signal) }
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function waitTick(pollMs: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, pollMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function signalRemoteGroups(
  sandbox: Sandbox,
  envs: Record<string, string>,
  groups: readonly number[],
  signal: 'TERM' | 'KILL',
): Promise<void> {
  // TODO(e2b-pgid-identity): Prefer an atomic identity-bound group signal if E2B adds one;
  // a userspace identity precheck cannot close the numeric-PGID reuse race.
  try {
    await sandbox.commands.run(
      `kill -${signal} -- ${groups.map(group => `-${group}`).join(' ')}`,
      commandOpts(envs),
    )
  } catch (error: unknown) {
    if (!(error instanceof CommandExitError) && !(error instanceof SandboxNotFoundError)) throw error
  }
}

import { Buffer } from 'node:buffer'

import { PassThrough, Writable } from 'node:stream'

import { posix } from 'node:path'

import {
  CommandExitError,
  e2bControlEnvs,
  FileNotFoundError,
  SandboxNotFoundError,
  quoteE2BShellArg,
} from '@ejunz/ea-core/e2b'

import type { CommandHandle, CommandResult, Sandbox } from '@ejunz/ea-core/e2b'

import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@ejunz/ea-core/subprocess'

import type E2BRuntime from '@ejunz/ea-core/e2b'

const OUTPUT_ENCODER_SOURCE = [
  '(async () => {',
  '  for await (const chunk of process.stdin) {',
  "    if (!process.stdout.write(chunk.toString('base64') + '\\n')) {",
  "      await new Promise(resolve => process.stdout.once('drain', resolve))",
  '    }',
  '  }',
  `  if (!process.stdout.write(${JSON.stringify(E2B_OUTPUT_COMPLETE_FRAME)} + '\\n')) {`,
  "    await new Promise(resolve => process.stdout.once('drain', resolve))",
  '  }',
  '})().catch(() => { process.exitCode = 1 })',
].join('\n')

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function hasSpill(mode: SubprocessOutputMode): mode is SubprocessCollect & { spill: { maxBytes: number } } {
  return isCollect(mode) && mode.spill !== undefined
}

function isValidProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

class DeferredStdin extends Writable {
  constructor(private readonly ready: Promise<CommandHandle>) {
    super({ decodeStrings: false })
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.ready.then(handle => handle.sendStdin(chunk)).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.ready.then(handle => handle.closeStdin()).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }
}

interface RemotePaths {
  pid: string
  status: string
  environment: string
  stdout: string
  stderr: string
}

type CommandSettlement =
  | { kind: 'result'; result: CommandResult }
  | { kind: 'error'; error: unknown }

function withinMs(settlement: Promise<CommandSettlement>, timeoutMs: number): Promise<CommandSettlement | undefined> {
  return new Promise<CommandSettlement | undefined>((resolve) => {
    const timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
    void settlement.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function commandText(spec: SubprocessSpawnSpec, paths: RemotePaths): string {
  const encoder = `"$ea_e2b_env_bin" -i "$ea_e2b_node" -e ${quoteE2BShellArg(OUTPUT_ENCODER_SOURCE)}`
  const stdoutRedirect = hasSpill(spec.stdio.stdout)
    ? `> >("$ea_e2b_tee" --output-error=warn-nopipe >("$ea_e2b_head" -c ${spec.stdio.stdout.spill.maxBytes} > ${quoteE2BShellArg(paths.stdout)}) | ${encoder} 2>/dev/null)`
    : `> >(${encoder} 2>/dev/null)`
  const stderrRedirect = hasSpill(spec.stdio.stderr)
    ? `2> >("$ea_e2b_tee" --output-error=warn-nopipe >("$ea_e2b_head" -c ${spec.stdio.stderr.spill.maxBytes} > ${quoteE2BShellArg(paths.stderr)}) | ${encoder} >&2 2>/dev/null)`
    : `2> >(${encoder} >&2 2>/dev/null)`
  const inner = [
    'set +e',
    'ea_e2b_env_bin=$1',
    'ea_e2b_node=$2',
    'ea_e2b_ps=$3',
    'ea_e2b_tr=$4',
    'ea_e2b_tee=$5',
    'ea_e2b_head=$6',
    'ea_e2b_rm=$7',
    'shift 7',
    'ea_e2b_pgid="$("$ea_e2b_ps" -o pgid= -p "$$" | "$ea_e2b_tr" -d " ")"',
    `printf '%s\\n' "$ea_e2b_pgid" > ${quoteE2BShellArg(paths.pid)}`,
    `mapfile -d '' -t ea_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
    `"$ea_e2b_rm" -f -- ${quoteE2BShellArg(paths.environment)}`,
    `"$ea_e2b_env_bin" -i -- "\${ea_e2b_env[@]}" "$@" ${stdoutRedirect} ${stderrRedirect}`.trimEnd(),
    'ea_e2b_status=$?',
    `printf '%s\\n' "$ea_e2b_status" > ${quoteE2BShellArg(paths.status)}`,
    'wait',
    'exit "$ea_e2b_status"',
  ].join('\n')
  const argv = spec.argv.map(quoteE2BShellArg).join(' ')
  const bootstrap = [
    `mapfile -d '' -t ea_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
    'ea_e2b_env_bin="$(command -v env)"',
    'ea_e2b_setsid="$(command -v setsid)"',
    'ea_e2b_bash="$(command -v bash)"',
    'ea_e2b_node="$(command -v node)"',
    'ea_e2b_ps="$(command -v ps)"',
    'ea_e2b_tr="$(command -v tr)"',
    'ea_e2b_tee="$(command -v tee)"',
    'ea_e2b_head="$(command -v head)"',
    'ea_e2b_rm="$(command -v rm)"',
    'for ea_e2b_tool in "$ea_e2b_env_bin" "$ea_e2b_setsid" "$ea_e2b_bash" "$ea_e2b_node" "$ea_e2b_ps" "$ea_e2b_tr" "$ea_e2b_tee" "$ea_e2b_head" "$ea_e2b_rm"; do',
    '  [[ "$ea_e2b_tool" == /* && -x "$ea_e2b_tool" ]] || exit 125',
    'done',
    `exec "$ea_e2b_env_bin" -i -- "\${ea_e2b_env[@]}" "$ea_e2b_setsid" --wait -- "$ea_e2b_bash" -c ${quoteE2BShellArg(inner)} ea-e2b "$ea_e2b_env_bin" "$ea_e2b_node" "$ea_e2b_ps" "$ea_e2b_tr" "$ea_e2b_tee" "$ea_e2b_head" "$ea_e2b_rm" ${argv}`,
  ].join('\n')
  return bootstrap
}

const WAIT_ABORTED = Symbol('wait aborted')

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof WAIT_ABORTED> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(WAIT_ABORTED)
  return new Promise<T | typeof WAIT_ABORTED>((resolve) => {
    const onAbort = (): void => { cleanup(); resolve(WAIT_ABORTED) }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void promise.then((value) => { cleanup(); resolve(value) })
  })
}

export class E2BSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly commandState = Promise.withResolvers<CommandHandle | undefined>()
  private readonly readyState = Promise.withResolvers<CommandHandle>()
  private readonly stdoutDecoder = new E2BBase64Decoder()
  private readonly stderrDecoder = new E2BBase64Decoder()
  private readonly terminationController = new AbortController()
  /** Releases output waits that survive the command outcome, so blocked SDK callbacks settle. */
  private readonly outputReleased = new AbortController()
  private readonly stdoutReader: E2BOutputReader | undefined
  private readonly stderrReader: E2BOutputReader | undefined
  private readonly paths: RemotePaths
  private controlEnvs: Record<string, string> = {}
  private remotePid = -1
  private outputTransportError: Error | undefined
  private outputDrainExpired = false
  private stateDirectoryCreated = false
  private quiescenceProven = false
  private terminationAttempt: Promise<void> | undefined
  private terminationFailure: Error | undefined
  private terminationSignal: NodeJS.Signals | null = null

  /**
   * Begin an E2B command without blocking the synchronous subprocess spawn call.
   * @param runtime - Shared E2B sandbox owner.
   * @param spec - Fully resolved subprocess request.
   * @param stateDir - Remote directory retaining process identity, status, and valid spills.
   * @param pollMs - Remote status/liveness poll cadence.
   */
  constructor(
    private readonly runtime: E2BRuntime,
    private readonly spec: SubprocessSpawnSpec,
    readonly stateDir: string,
    private readonly pollMs: number,
  ) {
    this.paths = {
      pid: posix.join(stateDir, 'pid'),
      status: posix.join(stateDir, 'exit-code'),
      environment: posix.join(stateDir, 'environment'),
      stdout: posix.join(stateDir, 'stdout.log'),
      stderr: posix.join(stateDir, 'stderr.log'),
    }
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutReader = isCollect(outMode)
      ? new E2BOutputReader(outMode.maxBytes, outMode.spill?.maxBytes, this.paths.stdout)
      : undefined
    this.stderrReader = isCollect(errMode)
      ? new E2BOutputReader(errMode.maxBytes, errMode.spill?.maxBytes, this.paths.stderr)
      : undefined
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new DeferredStdin(this.readyState.promise) : undefined
    void this.readyState.promise.catch(() => {})
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.done = this.run()
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Remote process id after start; `-1` while E2B startup is pending or after it fails. */
  get pid(): number {
    return this.remotePid
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.quiescenceProven || this.terminationAttempt !== undefined) return
    this.terminationController.abort(new Error('subprocess-e2b: command terminated'))
    this.stdout?.destroy()
    this.stderr?.destroy()
    this.terminationFailure = undefined
    const attempt = this.terminateRemote()
    this.terminationAttempt = attempt
    void attempt.then(
      () => { this.terminationAttempt = undefined },
      (error: unknown) => {
        if (!this.quiescenceProven) this.terminationFailure = asError(error)
        this.terminationAttempt = undefined
      },
    )
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescenceProven) return true
    let handle: CommandHandle | undefined
    if (this.terminationController.signal.aborted) {
      const observed = await waitWithSignal(this.commandState.promise, signal)
      if (observed === WAIT_ABORTED) return false
      handle = observed
      if (handle === undefined) {
        this.markQuiescent()
        return true
      }
      if (this.remotePid <= 0) {
        const attempt = this.terminationAttempt
        if (attempt !== undefined && await waitWithSignal(attempt.catch(() => undefined), signal) === WAIT_ABORTED) {
          return false
        }
        this.throwTerminationFailure()
        // Successful pre-publication termination records quiescence; its only other outcome is the failure above.
        return true
      }
    } else {
      const observed = await waitWithSignal(
        this.readyState.promise.catch(() => this.commandState.promise),
        signal,
      )
      if (observed === WAIT_ABORTED) return false
      handle = observed
      if (handle === undefined) {
        this.markQuiescent()
        return true
      }
    }
    this.throwTerminationFailure()
    let sandbox: Sandbox
    try {
      sandbox = await this.runtime.getSandbox()
    } catch (error: unknown) {
      if (signal?.aborted === true) return false
      if (error instanceof SandboxNotFoundError) {
        this.markQuiescent()
        return true
      }
      throw error
    }
    const processGroupId = this.remotePid > 0 ? this.remotePid : handle.pid
    while (await this.groupAlive(sandbox, processGroupId, signal)) {
      this.throwTerminationFailure()
      if (!await waitTick(this.pollMs, signal)) return false
    }
    this.throwTerminationFailure()
    if (signal?.aborted === true) return false
    this.markQuiescent()
    return true
  }

  private readonly onAbort = (): void => { this.terminate() }

  private markQuiescent(): void {
    this.quiescenceProven = true
    this.terminationFailure = undefined
  }

  private async run(): Promise<SubprocessOutcome> {
    let sandbox: Sandbox | undefined
    let preparing = true
    try {
      sandbox = await this.runtime.getSandbox()
      await this.prepareState(sandbox)
      preparing = false
      const handle = await sandbox.commands.run(
        commandText(this.spec, this.paths),
        {
          background: true,
          cwd: this.spec.cwd,
          envs: e2bControlEnvs(this.controlEnvs),
          stdin: this.spec.stdio.stdin !== 'ignore',
          timeoutMs: 0,
          onStdout: async (data) => { await this.dispatchOutput('stdout', data) },
          onStderr: async (data) => { await this.dispatchOutput('stderr', data) },
        },
      )
      const completion = handle.wait()
      void completion.catch(() => {})
      if (!isValidProcessId(handle.pid)) {
        const invalidPid = new Error(`subprocess-e2b: E2B returned invalid command pid ${handle.pid}`)
        try {
          await handle.kill()
          this.markQuiescent()
        } catch (cleanupError: unknown) {
          this.terminationFailure = asError(cleanupError)
          this.commandState.resolve(handle)
          throw new AggregateError(
            [invalidPid, cleanupError],
            'subprocess-e2b: invalid command pid rollback did not reach quiescence',
          )
        }
        throw invalidPid
      }
      this.commandState.resolve(handle)
      try {
        this.remotePid = await this.waitForProcessGroupId(sandbox, completion)
      } catch (error: unknown) {
        try {
          await this.rollbackUnpublishedGroup(sandbox, handle)
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'subprocess-e2b: process-group publication failed and rollback did not reach quiescence',
          )
        }
        throw error
      }
      this.readyState.resolve(handle)
      await this.writeBatchStdin(handle)
      const outcome = await this.waitForCommand(sandbox, handle, completion)
      if (this.outputTransportError !== undefined) throw this.outputTransportError
      const requireCompleteOutput = this.terminationSignal === null && !this.outputDrainExpired
      this.stdoutDecoder.finish(requireCompleteOutput)
      this.stderrDecoder.finish(requireCompleteOutput)
      await this.finalizeSpills(sandbox)
      return outcome
    } catch (error: unknown) {
      const canceledPreparation = preparing && this.terminationController.signal.aborted
      let failure = await this.rollbackPublishedFailure(error)
      if (sandbox !== undefined && this.stateDirectoryCreated) {
        try {
          await this.removeFailedState(sandbox)
        } catch (cleanupError: unknown) {
          failure = new AggregateError(
            [failure, cleanupError],
            'subprocess-e2b: command failed and private state cleanup failed',
          )
        }
      }
      this.commandState.resolve(undefined)
      this.readyState.reject(failure)
      if (canceledPreparation && failure === error) return { exitCode: null, signal: 'SIGTERM' }
      throw failure
    } finally {
      this.spec.signal?.removeEventListener('abort', this.onAbort)
      this.stdout?.end()
      this.stderr?.end()
    }
  }

  private async prepareState(sandbox: Sandbox): Promise<void> {
    const signal = this.terminationController.signal
    const ambient = await readRemoteEnvironment(sandbox, signal)
    this.controlEnvs = bootstrapEnvironment(ambient)
    // Own the directory before the request: a cancellation racing a committed
    // creation must still enter cleanup (removal tolerates an absent path).
    this.stateDirectoryCreated = true
    await sandbox.files.makeDir(this.stateDir, { signal })
    await sandbox.commands.run(
      `chmod 700 -- ${quoteE2BShellArg(this.stateDir)}`,
      commandOpts(this.controlEnvs, signal),
    )
    const files = [
      { path: this.paths.pid, data: '' },
      { path: this.paths.status, data: '' },
      { path: this.paths.environment, data: serializeRemoteEnvironment(ambient, this.spec.env) },
      ...(hasSpill(this.spec.stdio.stdout) ? [{ path: this.paths.stdout, data: '' }] : []),
      ...(hasSpill(this.spec.stdio.stderr) ? [{ path: this.paths.stderr, data: '' }] : []),
    ]
    await sandbox.files.write(files, { signal })
    await sandbox.commands.run(
      `chmod 600 -- ${files.map(file => quoteE2BShellArg(file.path)).join(' ')}`,
      commandOpts(this.controlEnvs, signal),
    )
    signal.throwIfAborted()
  }

  private async writeBatchStdin(handle: CommandHandle): Promise<void> {
    if (typeof this.spec.stdio.stdin !== 'object') return
    try {
      await handle.sendStdin(this.spec.stdio.stdin.data)
      await handle.closeStdin()
    } catch (_processClosedItsInput) {
      // Like the local adapter, batch stdin is best-effort; exit and output remain authoritative.
    }
  }

  private async dispatchOutput(stream: 'stdout' | 'stderr', data: string): Promise<void> {
    let bytes: Buffer
    try {
      bytes = stream === 'stdout' ? this.stdoutDecoder.push(data) : this.stderrDecoder.push(data)
    } catch (error: unknown) {
      this.outputTransportError ??= asError(error)
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(this.outputTransportError)
      return
    }
    try {
      if (stream === 'stdout') {
        this.stdoutReader?.push(bytes)
        await this.writeOutput(this.stdout, this.spec.stdio.stdout === 'inherit' ? process.stdout : undefined, bytes)
        return
      }
      this.stderrReader?.push(bytes)
      await this.writeOutput(this.stderr, this.spec.stdio.stderr === 'inherit' ? process.stderr : undefined, bytes)
    } catch (error: unknown) {
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(asError(error))
    }
  }

  private async writeOutput(pipe: PassThrough | undefined, inherited: NodeJS.WriteStream | undefined, data: Uint8Array): Promise<void> {
    const target = pipe ?? inherited
    if (target === undefined || data.length === 0 || this.terminationController.signal.aborted) return
    if (target.destroyed) throw new Error('subprocess output stream is closed')
    if (target.write(data)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve() }
      const onClose = (): void => { cleanup(); resolve() }
      const onRelease = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const cleanup = (): void => {
        target.removeListener('drain', onDrain)
        target.removeListener('close', onClose)
        target.removeListener('error', onError)
        this.terminationController.signal.removeEventListener('abort', onRelease)
        this.outputReleased.signal.removeEventListener('abort', onRelease)
      }
      target.once('drain', onDrain)
      target.once('close', onClose)
      target.once('error', onError)
      this.terminationController.signal.addEventListener('abort', onRelease, { once: true })
      this.outputReleased.signal.addEventListener('abort', onRelease, { once: true })
      if (this.terminationController.signal.aborted || this.outputReleased.signal.aborted) onRelease()
    })
  }

  private async waitForProcessGroupId(sandbox: Sandbox, completion: Promise<CommandResult>): Promise<number> {
    const commandSettled = completion.then(
      () => true,
      () => true,
    )
    while (true) {
      // TODO(e2b-publication-cancel): Join cancellation to the existing
      // termination transaction before aborting an in-flight SDK file read.
      const raw = await sandbox.files.read(this.paths.pid)
      const value = raw.trim()
      if (value.length > 0) {
        const pid = Number(value)
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid)) {
          throw new Error(`subprocess-e2b: remote wrapper published invalid process-group id ${JSON.stringify(value)}`)
        }
        // A same-UID sandbox process can rewrite this file; refuse ids whose
        // negative form addresses every process (`kill -- -1`) or init's group.
        if (pid <= 1) {
          throw new Error(`subprocess-e2b: unsafe published process-group id ${pid}`)
        }
        return pid
      }
      const settled = await Promise.race([commandSettled, waitTick(this.pollMs).then(() => false)])
      if (settled) throw new Error('subprocess-e2b: remote command exited before publishing its process-group id')
    }
  }

  private async waitForCommand(
    sandbox: Sandbox,
    handle: CommandHandle,
    completion: Promise<CommandResult>,
  ): Promise<SubprocessOutcome> {
    const settlement = completion.then<CommandSettlement, CommandSettlement>(
      result => ({ kind: 'result', result }),
      (error: unknown) => ({ kind: 'error', error }),
    )
    const hasPipeOutput = this.spec.stdio.stdout === 'pipe' || this.spec.stdio.stderr === 'pipe'
    let completed = hasPipeOutput ? await settlement : undefined
    while (true) {
      const rawStatus = (await sandbox.files.read(this.paths.status)).trim()
      if (rawStatus.length > 0) {
        const exitCode = Number(rawStatus)
        if (!/^(?:0|[1-9][0-9]*)$/.test(rawStatus) || !Number.isSafeInteger(exitCode) || exitCode > 255) {
          throw new Error(`subprocess-e2b: remote wrapper published invalid exit code ${JSON.stringify(rawStatus)}`)
        }
        if (completed !== undefined) return this.commandOutcome(completed, exitCode)
        const drained = await withinMs(settlement, this.spec.graceMs)
        if (drained !== undefined) return this.commandOutcome(drained, exitCode)
        this.outputDrainExpired = true
        this.stdoutReader?.invalidateSpill()
        this.stderrReader?.invalidateSpill()
        // Release inherited-output waits so a callback blocked on host
        // backpressure cannot keep the disconnected SDK settlement pending.
        this.outputReleased.abort(new Error('subprocess-e2b: output drain grace expired'))
        await handle.disconnect()
        return { exitCode, signal: null }
      }
      if (completed !== undefined) return this.commandOutcome(completed)
      // TODO(e2b-status-watch): Replace collect/inherit control-plane polling
      // when E2B can observe direct-command exit independently of descendant-held output.
      completed = await Promise.race([settlement, waitTick(this.pollMs).then(() => undefined)])
    }
  }

  private commandOutcome(settlement: CommandSettlement, publishedExitCode?: number): SubprocessOutcome {
    if (settlement.kind === 'result') {
      return { exitCode: publishedExitCode ?? settlement.result.exitCode, signal: null }
    }
    if (settlement.error instanceof CommandExitError) {
      if (publishedExitCode !== undefined) return { exitCode: publishedExitCode, signal: null }
      return this.terminationSignal === null
        ? { exitCode: settlement.error.exitCode, signal: null }
        : { exitCode: null, signal: this.terminationSignal }
    }
    throw settlement.error
  }

  private async rollbackPublishedFailure(error: unknown): Promise<unknown> {
    if (this.remotePid <= 0 || this.quiescenceProven) return error
    this.terminate()
    try {
      await this.waitForExit()
      return error
    } catch (cleanupError: unknown) {
      return new AggregateError(
        [asError(error), asError(cleanupError)],
        'subprocess-e2b: command monitoring failed and process-group rollback did not reach quiescence',
      )
    }
  }

  private async rollbackUnpublishedGroup(sandbox: Sandbox, handle: CommandHandle): Promise<void> {
    // The bootstrap ends in an exec chain through the scrubbed environment and
    // `setsid`, so E2B's command PID is the provisional group id even before the
    // private publication file can be trusted. Kill that group before the SDK-PID
    // fallback, then prove no group member survived before rejecting startup.
    await this.forceKillGroup(sandbox, handle, handle.pid)
    this.markQuiescent()
  }

  private async terminateRemote(): Promise<void> {
    try {
      await this.terminateRemoteInSandbox()
    } catch (error: unknown) {
      if (error instanceof SandboxNotFoundError) {
        this.markQuiescent()
        return
      }
      throw error
    }
  }

  private async terminateRemoteInSandbox(): Promise<void> {
    const handle = await this.commandState.promise
    if (handle === undefined) {
      this.markQuiescent()
      return
    }
    if (!isValidProcessId(handle.pid) && this.remotePid <= 0) {
      await handle.kill()
      this.markQuiescent()
      return
    }
    const sandbox = await this.runtime.getSandbox()
    const processGroupId = this.remotePid > 0 ? this.remotePid : handle.pid
    await this.terminateGroup(sandbox, handle, processGroupId)
  }

  private async terminateGroup(sandbox: Sandbox, handle: CommandHandle, processGroupId: number): Promise<void> {
    this.terminationSignal = 'SIGTERM'
    try {
      await signalRemoteGroups(sandbox, this.controlEnvs, [processGroupId], 'TERM')
      if (await this.waitForGroupExit(sandbox, processGroupId)) {
        this.markQuiescent()
        return
      }
    } catch (_gracefulTerminationFailure) {
      // Failed TERM delivery or observation cannot prove exit; force cleanup still owns the group.
    }
    this.terminationSignal = 'SIGKILL'
    await this.forceKillGroup(sandbox, handle, processGroupId)
    this.markQuiescent()
  }

  private async forceKillGroup(sandbox: Sandbox, handle: CommandHandle, processGroupId: number): Promise<void> {
    try {
      await signalRemoteGroups(sandbox, this.controlEnvs, [processGroupId], 'KILL')
    } catch (_processGroupKillFailure) {
      // SDK kill and the final liveness probe remain independent cleanup paths.
    }
    try {
      await handle.kill()
    } catch (_sdkKillFailure) {
      // The final liveness probe, not either transport's self-report, proves cleanup.
    }
    if (await this.waitForGroupExit(sandbox, processGroupId)) return
    throw new Error(`subprocess-e2b: remote process group ${processGroupId} remained live after force termination`)
  }

  private async waitForGroupExit(sandbox: Sandbox, processGroupId: number): Promise<boolean> {
    const deadline = Date.now() + this.spec.graceMs
    while (await this.groupAlive(sandbox, processGroupId)) {
      if (Date.now() >= deadline) return false
      await waitTick(this.pollMs)
    }
    return true
  }

  private throwTerminationFailure(): void {
    if (this.terminationFailure !== undefined) throw this.terminationFailure
  }

  private async groupAlive(sandbox: Sandbox, pid: number, signal?: AbortSignal): Promise<boolean> {
    const result = await sandbox.commands.run(
      `set -o pipefail; ps -eo pgid=,stat= | awk '$1 == ${pid} && $2 !~ /^[ZXx]/ { live=1 } END { if (live) print "live" }'`,
      commandOpts(this.controlEnvs, signal),
    ).catch((error: unknown) => {
      if (signal?.aborted === true) return undefined
      if (error instanceof SandboxNotFoundError) return { exitCode: 0, stdout: '', stderr: '' }
      throw error
    })
    return result?.stdout.trim() === 'live'
  }

  private async finalizeSpills(sandbox: Sandbox): Promise<void> {
    const removals: Promise<void>[] = []
    const collect = (mode: SubprocessOutputMode, reader: E2BOutputReader | undefined, path: string): void => {
      if (!hasSpill(mode)) return
      // A spill mode is a collect mode, so construction always created its reader.
      const size = (reader as E2BOutputReader).size
      if (this.outputDrainExpired || size <= mode.maxBytes || size > mode.spill.maxBytes) {
        removals.push(sandbox.files.remove(path).catch((_adapterPrivateSpillRemovalFailure: unknown) => {
          // The command outcome is authoritative; owner teardown bounds private residue.
        }))
      }
    }
    collect(this.spec.stdio.stdout, this.stdoutReader, this.paths.stdout)
    collect(this.spec.stdio.stderr, this.stderrReader, this.paths.stderr)
    await Promise.all(removals)
  }

  private async removeFailedState(sandbox: Sandbox): Promise<void> {
    const failures: Error[] = []
    for (const path of [this.paths.environment, this.stateDir]) {
      try {
        await sandbox.files.remove(path)
      } catch (error: unknown) {
        if (!(error instanceof FileNotFoundError)) failures.push(asError(error))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'subprocess-e2b: failed to remove private command state')
    }
  }
}

import { randomUUID } from 'node:crypto'

import { posix } from 'node:path'

import { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { SubprocessRuntime } from '@ejunz/ea-core/subprocess'

import { MAX_TIMER_DELAY_MS } from '@ejunz/ea-core/timeout'

import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
} from '@ejunz/ea-core/subprocess'

import { e2bControlEnvs, quoteE2BShellArg } from '@ejunz/ea-core/e2b'

export interface Config {
  /** Remote status/liveness poll cadence in milliseconds; each tick is one control-plane request. */
  pollMs?: number
}

interface SchemaResolvedConfig extends Config {
  pollMs: number
}

function requireRepresentableGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

export class E2BSubprocessRuntime extends SubprocessRuntime {
  static inject = ['e2b']

  static Config: z<Config> = z.object({
    pollMs: z.number().default(20),
  })

  private readonly live = new Set<E2BSubprocessHandle>()
  private readonly pollMs: number
  private disposing = false

  /** Create the E2B subprocess service and bind its disposal policy. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Schemastery fills pollMs before construction; the type does not encode that step.
    const { pollMs } = config as SchemaResolvedConfig
    if (!Number.isSafeInteger(pollMs) || pollMs <= 0) {
      throw new Error('subprocess-e2b: pollMs must be a positive safe integer')
    }
    this.pollMs = pollMs
    ctx.effect(() => async () => {
      this.disposing = true
      const handles = [...this.live]
      const pending: Promise<unknown>[] = []
      for (const handle of handles) {
        handle.terminate()
        pending.push(handle.waitForExit().then(async () => {
          await handle.done.catch(() => undefined)
          this.live.delete(handle)
        }))
      }
      const outcomes = await Promise.allSettled(pending)
      const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected'
        ? [outcome.reason as unknown]
        : [])
      if (failures.length === 1) throw asError(failures[0])
      if (failures.length > 1) throw new AggregateError(failures, 'subprocess-e2b: teardown failed')
    }, 'e2b subprocess teardown')
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-e2b: executable name must be non-empty')
    signal?.throwIfAborted()
    const sandbox = await this.ctx.e2b.getSandbox()
    if (posix.isAbsolute(command)) {
      await sandbox.commands.run(
        `test -f ${quoteE2BShellArg(command)} -a -x ${quoteE2BShellArg(command)}`,
        { envs: e2bControlEnvs(), ...signalOpts(signal) },
      )
      signal?.throwIfAborted()
      return command
    }
    if (command.includes('/')) {
      throw new Error(
        `subprocess-e2b: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const path = env?.PATH
    const prefix = path === undefined ? '' : `PATH=${quoteE2BShellArg(path)} `
    const result = await sandbox.commands.run(
      `${prefix}command -v -- ${quoteE2BShellArg(command)}`,
      { cwd: this.ctx.e2b.cwd, envs: e2bControlEnvs(), ...signalOpts(signal) },
    )
    signal?.throwIfAborted()
    const executable = result.stdout.trim()
    if (executable.includes('\n') || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-e2b: executable ${JSON.stringify(command)} did not resolve to one absolute path`)
    }
    // A relative result comes from a relative PATH entry; the lookup ran with the shared cwd.
    return posix.resolve(this.ctx.e2b.cwd, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    if (this.disposing) throw new Error('subprocess-e2b: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    requireRepresentableGrace(spec.graceMs)
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    }
    const stateDir = posix.join(this.ctx.e2b.runtimeRoot, 'processes', randomUUID())
    const handle = new E2BSubprocessHandle(this.ctx.e2b, spec, stateDir, this.pollMs)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch((_automaticReleaseFailure: unknown) => {
      // Retain the handle so service disposal can retry its cleanup transaction.
    })
    return handle
  }

}

export default E2BSubprocessRuntime

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/subprocess-e2b'
  export const name = 'subprocess-e2b-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
