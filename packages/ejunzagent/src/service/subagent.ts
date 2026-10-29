import { EjunzAgentError } from '@ejunz/ea/llm'

export class SubagentError extends EjunzAgentError {
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SubagentError'
  }
}

import type { Context } from '@ejunz/cordis'

import type { AgentSetupCommit } from '@ejunz/ea/agent'

import { errorChain } from '@ejunz/ea/llm'

export type ContinuableSetupContribution = (childCtx: Context) => () => void

interface Registration {
  readonly contribution: ContinuableSetupContribution
  removed: boolean
  readonly installations: Set<Installation>
}

interface Installation {
  readonly registration: Registration
  readonly childCtx: Context
  readonly dispose: () => void
  released: boolean
  /** Present until the child reaches residency. */
  transaction: TransactionState | undefined
}

interface TransactionState {
  readonly installations: Installation[]
  invalidated: boolean
}

function isRemoved(registration: Registration): boolean {
  return registration.removed
}

export class SubagentActivationSetupRegistry {
  /** Live contributions in installation order. */
  private readonly registrations = new Set<Registration>()
  /** Child context to its live installations. */
  private readonly byChild = new Map<Context, Set<Installation>>()

  /**
   * Register one contribution.
   * @param contribution - synchronous child-scope installer.
   * @returns an idempotent registration undo.
   * @throws after attempting every installation when any disposer fails.
   */
  register(contribution: ContinuableSetupContribution): () => void {
    const registration: Registration = { contribution, removed: false, installations: new Set() }
    this.registrations.add(registration)
    return () => {
      if (registration.removed) return
      // Close before disposal so a snapshotted apply() cannot install after
      // revocation reports completion.
      registration.removed = true
      this.registrations.delete(registration)
      this.releaseAll([...registration.installations], 'contribution removal')
    }
  }

  /**
   * Install every live contribution into one unpublished child context.
   * @param childCtx - the child's unpublished scoped context.
   * @returns the provisioning commit consumed at Agent publication.
   */
  apply(childCtx: Context): AgentSetupCommit {
    const state: TransactionState = { installations: [], invalidated: false }
    try {
      for (const registration of [...this.registrations]) {
        /* v8 ignore next -- only a synchronous re-entrant revocation of an
         * already-snapshotted registration reaches this guard. */
        if (registration.removed) continue
        const installation: Installation = {
          registration,
          childCtx,
          dispose: registration.contribution(childCtx),
          released: false,
          transaction: state,
        }
        registration.installations.add(installation)
        state.installations.push(installation)
        let indexed = this.byChild.get(childCtx)
        if (indexed === undefined) {
          indexed = new Set()
          this.byChild.set(childCtx, indexed)
        }
        indexed.add(installation)
        // An installer may revoke itself before its installation record exists.
        // Dispose that escaped record and invalidate the provisioning batch.
        if (isRemoved(registration)) this.release(installation)
      }
    } catch (error: unknown) {
      // Keep the installer failure authoritative, but attempt every rollback.
      try {
        this.releaseAll([...state.installations], 'setup rollback')
      } catch (releaseFailure: unknown) {
        /* v8 ignore next -- requires independent installer and rollback faults. */
        void releaseFailure
      }
      throw error
    }
    childCtx.effect(() => () => { this.releaseChild(childCtx) }, 'subagents.activationSetup()')
    return {
      commit: () => {
        if (state.invalidated) {
          throw new SubagentError(
            'a continuable-subagent setup contribution was revoked while this child was being built; '
            + 'the child was not established',
            'ACTIVATION_SETUP_REVOKED',
          )
        }
        for (const installation of state.installations) installation.transaction = undefined
      },
    }
  }

  /** Release every remaining installation owned by one disposed child scope. */
  private releaseChild(childCtx: Context): void {
    const indexed = this.byChild.get(childCtx) ?? []
    this.releaseAll([...indexed], 'child scope disposal')
  }

  /**
   * Release a batch completely before reporting disposer failures.
   * @param installations - records to release.
   * @param during - operation name for diagnostics.
   */
  private releaseAll(installations: readonly Installation[], during: string): void {
    const failures: unknown[] = []
    for (const installation of installations) {
      try {
        this.release(installation)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length === 0) return
    throw new SubagentError(
      `continuable-subagent setup ${during} failed to release ${failures.length} installation(s): `
      + failures.map(failure => errorChain(failure)).join('; '),
      'ACTIVATION_SETUP_RELEASE_FAILED',
    )
  }

  /** Drop one installation from both indices and dispose it exactly once. */
  private release(installation: Installation): void {
    if (installation.released) return
    installation.released = true
    installation.registration.installations.delete(installation)
    const indexed = this.byChild.get(installation.childCtx)
    /* v8 ignore next 4 -- every live installation is indexed until this method removes it. */
    if (indexed !== undefined) {
      indexed.delete(installation)
      if (indexed.size === 0) this.byChild.delete(installation.childCtx)
    }
    if (installation.transaction !== undefined) installation.transaction.invalidated = true
    installation.dispose()
  }
}

export default SubagentActivationSetupRegistry

import type { ContentBlock } from '@ejunz/ea/llm'

import type { SessionEvent } from '@ejunz/ea/session'

export class AssistantOutputFold {
  private message: ContentBlock[] | undefined
  private partial: string[] = []

  /**
   * Fold one session event: a non-empty assistant message becomes the
   * candidate final answer, and a `text-delta` chunk extends the streamed
   * fallback; every other event contributes nothing.
   * @param event - the next observed session event.
   */
  push(event: SessionEvent): void {
    if (event.type === 'assistant/message') {
      const content = event.data.message.content
      if (content.length > 0) this.message = content
    } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'text-delta') {
      this.pushText(event.data.chunk.text)
    }
  }

  /**
   * Extend the streamed fallback with text observed outside session events.
   * @param text - the next streamed text piece (an empty piece is a no-op).
   */
  pushText(text: string): void {
    if (text.length > 0) this.partial.push(text)
  }

  /**
   * Select the final output folded so far.
   * @returns the last non-empty assistant message, else the accumulated
   *   streamed text, or `undefined` when the child produced neither.
   */
  collect(): ContentBlock[] | undefined {
    if (this.message !== undefined) return this.message
    const text = this.partial.join('')
    return text.length > 0 ? [{ type: 'text', text }] : undefined
  }
}

export function finalAssistantOutput(events: readonly SessionEvent[]): ContentBlock[] | undefined {
  // TODO: this folds the complete suffix once per run/epoch settlement. If a
  // long continuable epoch ever profiles hot here, scan backward with early
  // exit for the last non-empty message and fold text deltas only on the
  // no-message fallback.
  const fold = new AssistantOutputFold()
  for (const event of events) fold.push(event)
  return fold.collect()
}

import type { Agent } from '@ejunz/ea/agent'

declare module '@ejunz/ea/agent' {
  interface AgentOptions {
    /** Delegation depth: zero for a top-level agent and parent depth + 1 for a child. */
    subagentDepth?: number
  }
}

export function delegationDepthOf(agent: Agent): number {
  const runtime = agent.options.subagentDepth
  if (runtime !== undefined && (!Number.isSafeInteger(runtime) || runtime < 0 || Object.is(runtime, -0))) {
    throw new TypeError('agent subagentDepth must be a non-negative safe integer')
  }
  // The header value was validated at the session boundary (creation and
  // persistence load both construct through the store).
  return Math.max(agent.session.header.delegationDepth ?? 0, runtime ?? 0)
}

export function assertSubagentMaxDepth(maxDepth: unknown): void {
  if (maxDepth !== undefined && (
    typeof maxDepth !== 'number'
    || !Number.isSafeInteger(maxDepth)
    || maxDepth < 0
    || Object.is(maxDepth, -0)
  )) {
    throw new TypeError('subagent maxDepth must be a non-negative safe integer')
  }
}

import type { Context } from '@ejunz/cordis'

import type { Agent, AgentOptions, CreateAgentOptions } from '@ejunz/ea/agent'

import type { Session, SessionId } from '@ejunz/ea/session'

import type { ToolRestriction } from '@ejunz/ea/tools'

import type {} from '@ejunz/ea/user-approval'

import type {} from '@ejunz/ea/agent-presets'

export class SubagentDepthError extends Error {
  constructor(public readonly attemptedDepth: number, public readonly maxDepth: number) {
    super(`subagent depth ${attemptedDepth} exceeds maxDepth ${maxDepth}`)
    this.name = 'SubagentDepthError'
  }
}

export function resolveChildDepth(parent: Agent, maxDepth: number | undefined): number {
  const childDepth = delegationDepthOf(parent) + 1
  if (!Number.isSafeInteger(childDepth)) {
    throw new RangeError('subagent child depth exceeds the safe-integer range')
  }
  if (maxDepth !== undefined && childDepth > maxDepth) {
    throw new SubagentDepthError(childDepth, maxDepth)
  }
  return childDepth
}

export function resolveChildAgentOptions(
  parent: Agent,
  requested: AgentOptions | undefined,
  childDepth: number,
): AgentOptions {
  const parentProvider = parent.options.provider
  const parentModel = parent.options.model
  const parentMaxTokens = parent.options.maxTokens
  return {
    ...parentProvider !== undefined ? { provider: parentProvider } : {},
    ...parentModel !== undefined ? { model: parentModel } : {},
    ...parentMaxTokens !== undefined ? { maxTokens: parentMaxTokens } : {},
    ...requested,
    subagentDepth: childDepth,
  }
}

export function childSessionMeta(
  parent: Agent,
  childDepth: number,
  lineageSeedLength: number,
): NonNullable<CreateAgentOptions['meta']> {
  const parentHeader = parent.session.header
  const agentPreset = parent.ctx.get('agentPresets')?.composedPreset(parent.ctx)
  return {
    ...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {},
    ...agentPreset === undefined ? {} : { agentPreset },
    parentSession: parentHeader.id,
    // Navigation classification only; the descriptor remains the authority
    // for mode and continuation capability.
    origin: 'subagent',
    // Durable: the recursion budget must survive persistence and resume.
    delegationDepth: childDepth,
    ...lineageSeedLength > 0 ? { seedLength: lineageSeedLength } : {},
  }
}

export interface ChildComposition {
  /** Per-child persona shadowing the deployment persona. */
  readonly persona?: string | undefined
  /** Per-child tool scoping. */
  readonly toolFilter?: ToolRestriction | undefined
}

export const SUBAGENT_DELEGATION_CONTEXT
  = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
    + 'widened from inside this session — operations that require approval are rejected automatically. '
    + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
    + 'limitation in your reply so the delegating agent can handle it.'

export function applyChildComposition(
  childCtx: Context,
  parent: Agent,
  composition: ChildComposition,
): void {
  childCtx.get('agentPresets')?.composeFrom(childCtx, parent.ctx)
  // Order 120: after the approval:policy (115) sentence.
  childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, text: SUBAGENT_DELEGATION_CONTEXT })
  if (composition.persona !== undefined) {
    childCtx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: composition.persona })
  }
  if (composition.toolFilter !== undefined) childCtx.tools.restrict(composition.toolFilter)
}

export interface DelegatedPolicyOverrides {
  /** `'never'` whenever the approval capability is composed, `undefined` otherwise. */
  readonly approvalPolicy: 'never' | undefined
}

export function captureDelegatedPolicyOverrides(parent: Agent): DelegatedPolicyOverrides {
  return {
    approvalPolicy: parent.ctx.get('approval') === undefined ? undefined : 'never',
  }
}

export function appendDelegatedPolicyOverrides(
  childSession: Session,
  overrides: DelegatedPolicyOverrides,
): void {
  if (overrides.approvalPolicy !== undefined) {
    childSession.append('approval/policy', { policy: overrides.approvalPolicy, source: 'delegation' })
  }
}

export interface ChildCreateInputs {
  /** The child's reserved session id. */
  readonly sessionId: SessionId
  /** The delegating parent agent. */
  readonly parent: Agent
  /** The resolved delegation depth. */
  readonly childDepth: number
  /** How many leading seed events came from the parent's log. */
  readonly lineageSeedLength: number
}

export interface SubagentTimingProjection {
  /** Milliseconds accumulated across completed turns after the child's own descriptor. */
  settledMs: number
  /** Same-cut bounds of the currently open turn, when one has not reached `turn/end`. */
  active?: {
    /** Start of the open turn. */
    since: number
    /** Latest event time folded into this projection cut. */
    through: number
  }
}

export type SubagentIdentityProjection =
  | {
    /** A terminal one-shot child. */
    mode: 'one-shot'
    /** Optional durable creation label from the child's descriptor. */
    label?: string
    /**
     * Seq of the `subagent/descriptor` event this identity was folded from.
     * `seq >= header.seedLength` proves the identity comes from the child's
     * OWN log suffix — where a descriptor is immutable once appended — and
     * not from a fork seed's replayed ancestor descriptor.
     */
    seq: number
  }
  | {
    /** A resumable conversation. */
    mode: 'continuable'
    /** Durable creation label from the child's descriptor. */
    label: string
    /** Seq of the folded descriptor event; see the one-shot arm for the own-suffix proof. */
    seq: number
  }

declare module '@ejunz/ea/session-projection/types' {
  interface SessionProjectionMap {
    /** Active-turn duration for a descriptor-backed subagent session. */
    subagentTiming: SubagentTimingProjection
    /**
     * Identity of a descriptor-backed subagent session. `null` ⟺ no valid
     * descriptor (missing, malformed, or unrecognized-version — deliberately
     * undistinguished). The sentinel is deliberately serializable: a
     * value pushed over JSON transports must survive `JSON.stringify`
     * losslessly, where an `undefined` field would be dropped and a stale
     * identity would survive on the receiving side. The entry itself stays
     * non-optional.
     */
    subagent: SubagentIdentityProjection | null
  }
}

import { snapshotJsonValue } from '@ejunz/ea/session'

import type { SessionEvent } from '@ejunz/ea/session'

import type { ToolRestriction } from '@ejunz/ea/tools'

declare module '@ejunz/ea/session/types' {
  interface SessionEventMap {
    /**
     * Durable identity and lifecycle mode of a session-backed subagent child,
     * appended once by the establishing provider inside the child's initial
     * turn, before its first request. Continuable records also carry their
     * resumable composition. Log-only: it carries no `surfaceOp`, never enters
     * model history, and survives compaction.
     */
    'subagent/descriptor': SubagentDescriptorData
  }
}

export const SUBAGENT_DESCRIPTOR_VERSION = 2

interface SubagentDescriptorBase {
  /** Descriptor format version ({@link SUBAGENT_DESCRIPTOR_VERSION}). */
  readonly version: number
  /** Whether the child is a terminal one-shot run or a resumable conversation. */
  readonly mode: 'one-shot' | 'continuable'
  /** The `ctx.subagents` provider name that established the child. */
  readonly provider: string
}

export interface OneShotSubagentDescriptorData extends SubagentDescriptorBase {
  readonly mode: 'one-shot'
  /**
   * The initial delegation's short `description`, kept as the child's durable
   * creation label so enumeration can identify the conversation without
   * replaying parent tool results or exposing the child prompt.
   */
  readonly label?: string
}

export interface ContinuableSubagentDescriptorData extends SubagentDescriptorBase {
  readonly mode: 'continuable'
  /** The initial delegation's short `description`, used for durable enumeration. */
  readonly label: string
  /** Resolved child `agentOptions.provider`, when one was declared. */
  readonly agentProvider?: string
  /** Resolved child `agentOptions.model`, when one was declared. */
  readonly agentModel?: string
  /** Per-child persona that shadows the deployment persona on resume. */
  readonly persona?: string
  /** Child tool scoping reapplied on resume. */
  readonly toolFilter?: ToolRestriction
}

export type SubagentDescriptorData =
  | OneShotSubagentDescriptorData
  | ContinuableSubagentDescriptorData

interface SubagentDescriptorInputBase {
  /** Whether the child is a terminal one-shot run or a resumable conversation. */
  readonly mode: 'one-shot' | 'continuable'
  /** The `ctx.subagents` provider name that will establish the child. */
  readonly provider: string
}

export interface OneShotSubagentDescriptorInput extends SubagentDescriptorInputBase {
  readonly mode: 'one-shot'
  /** Optional initial delegation `description` used as the durable creation label. */
  readonly label?: string
}

export interface ContinuableSubagentDescriptorInput extends SubagentDescriptorInputBase {
  readonly mode: 'continuable'
  /** Initial delegation `description` used for durable enumeration. */
  readonly label: string
  /** Requested child `agentOptions.provider`. */
  readonly agentProvider?: string
  /** Requested child `agentOptions.model`. */
  readonly agentModel?: string
  /** Requested per-child persona. */
  readonly persona?: string
  /** Requested child tool scoping. */
  readonly toolFilter?: ToolRestriction
}

export type SubagentDescriptorInput =
  | OneShotSubagentDescriptorInput
  | ContinuableSubagentDescriptorInput

const DESCRIPTOR_BASE_KEYS = [
  'version',
  'mode',
  'provider',
  'label',
] as const

const ONE_SHOT_DESCRIPTOR_KEYS = new Set(DESCRIPTOR_BASE_KEYS)

const CONTINUABLE_DESCRIPTOR_KEYS = new Set([
  ...DESCRIPTOR_BASE_KEYS,
  'agentProvider',
  'agentModel',
  'persona',
  'toolFilter',
])

const TOOL_FILTER_KEYS = new Set(['allow', 'deny'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, path: string): void {
  const unknown = Object.keys(value).find(key => !keys.has(key))
  if (unknown !== undefined) {
    throw new Error(`persisted subagent descriptor ${path} has unknown field "${unknown}"`)
  }
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (typeof field !== 'string') {
    throw new Error(`persisted subagent descriptor ${key} must be a string`)
  }
  return field
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.hasOwn(value, key)) return undefined
  const field = value[key]
  if (!Array.isArray(field)) {
    throw new Error(`persisted subagent descriptor toolFilter.${key} must be an array of strings`)
  }
  const items: unknown[] = field
  if (items.some(item => typeof item !== 'string')) {
    throw new Error(`persisted subagent descriptor toolFilter.${key} must be an array of strings`)
  }
  return items as string[]
}

function parseToolFilter(value: unknown): ToolRestriction {
  if (!isRecord(value)) {
    throw new Error('persisted subagent descriptor toolFilter must be an object')
  }
  assertKnownKeys(value, TOOL_FILTER_KEYS, 'toolFilter')
  const allow = optionalStringArray(value, 'allow')
  const deny = optionalStringArray(value, 'deny')
  if (allow === undefined && deny === undefined) {
    throw new Error('persisted subagent descriptor toolFilter must declare allow and/or deny')
  }
  return {
    ...allow !== undefined ? { allow } : {},
    ...deny !== undefined ? { deny } : {},
  }
}

function parseSubagentDescriptor(value: unknown): SubagentDescriptorData | undefined {
  if (!isRecord(value)) {
    throw new Error('persisted subagent descriptor payload must be an object')
  }
  const version = value['version']
  if (typeof version !== 'number') {
    throw new Error('persisted subagent descriptor version must be a number')
  }
  if (version !== SUBAGENT_DESCRIPTOR_VERSION) return undefined

  const mode = value['mode']
  if (mode !== 'one-shot' && mode !== 'continuable') {
    throw new Error('persisted subagent descriptor mode must be "one-shot" or "continuable"')
  }
  assertKnownKeys(
    value,
    mode === 'one-shot' ? ONE_SHOT_DESCRIPTOR_KEYS : CONTINUABLE_DESCRIPTOR_KEYS,
    'payload',
  )
  const provider = value['provider']
  if (typeof provider !== 'string') {
    throw new Error('persisted subagent descriptor provider must be a string')
  }
  if (mode === 'one-shot') {
    const label = optionalString(value, 'label')
    return {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode,
      provider,
      ...label !== undefined ? { label } : {},
    }
  }
  const label = value['label']
  if (typeof label !== 'string') {
    throw new Error('persisted subagent descriptor label must be a string')
  }
  const agentProvider = optionalString(value, 'agentProvider')
  const agentModel = optionalString(value, 'agentModel')
  const persona = optionalString(value, 'persona')
  const toolFilter = Object.hasOwn(value, 'toolFilter')
    ? parseToolFilter(value['toolFilter'])
    : undefined
  return {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode,
    provider,
    label,
    ...agentProvider !== undefined ? { agentProvider } : {},
    ...agentModel !== undefined ? { agentModel } : {},
    ...persona !== undefined ? { persona } : {},
    ...toolFilter !== undefined ? { toolFilter } : {},
  }
}

export function snapshotSubagentDescriptor(
  input: OneShotSubagentDescriptorInput,
): OneShotSubagentDescriptorData

export function snapshotSubagentDescriptor(
  input: ContinuableSubagentDescriptorInput,
): ContinuableSubagentDescriptorData

export function snapshotSubagentDescriptor(input: SubagentDescriptorInput): SubagentDescriptorData {
  const candidate: SubagentDescriptorData = input.mode === 'one-shot'
    ? {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: input.mode,
      provider: input.provider,
      ...input.label !== undefined ? { label: input.label } : {},
    }
    : {
      version: SUBAGENT_DESCRIPTOR_VERSION,
      mode: input.mode,
      provider: input.provider,
      label: input.label,
      ...input.agentProvider !== undefined ? { agentProvider: input.agentProvider } : {},
      ...input.agentModel !== undefined ? { agentModel: input.agentModel } : {},
      ...input.persona !== undefined ? { persona: input.persona } : {},
      ...input.toolFilter !== undefined ? { toolFilter: input.toolFilter } : {},
    }
  const snapshot = snapshotJsonValue(candidate)
  if (snapshot === undefined) {
    throw new Error('subagent descriptor is not losslessly JSON-serializable')
  }
  return snapshot
}

export function foldSubagentDescriptor(events: readonly SessionEvent[]): SubagentDescriptorData | undefined {
  const event = events.find(
    (candidate): candidate is SessionEvent<'subagent/descriptor'> => candidate.type === 'subagent/descriptor',
  )
  if (event === undefined) return undefined
  return parseSubagentDescriptor(event.data)
}

import { Session } from '@ejunz/ea/session'

import type { SessionEvent, SessionId } from '@ejunz/ea/session'

export function seedDescriptorTurn(
  childId: SessionId,
  seed: readonly SessionEvent[] | undefined,
  descriptor: SubagentDescriptorData,
): SessionEvent[] {
  const staged = Session.create(childId, seed)
  staged.append('subagent/descriptor', descriptor)
  return [...staged.events]
}

import type { Agent, AgentOptions } from '@ejunz/ea/agent'

import type { Branded } from '@ejunz/ea/brand'

import type { ContentBlock } from '@ejunz/ea/llm'

import type { SessionEvent, SessionId } from '@ejunz/ea/session'

import type { ObjectJsonSchema, ToolRestriction } from '@ejunz/ea/tools'

export type SubagentRunId = Branded<'SubagentRunId'>

export function SubagentRunId(id: string): SubagentRunId {
  return id as SubagentRunId
}

export interface SubagentRunInfo {
  /** Unique identity shared with the paired terminal event. */
  readonly runId: SubagentRunId
  /**
   * Provider name recorded when the child was first created. The provider may
   * be absent when an accepted one-shot run becomes ready or a persisted
   * Activation cold-resumes, because neither lifecycle depends on continued
   * registration.
   */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Snapshot of whether `SubagentRun.localAgent` was present when start fulfilled. */
  readonly local: boolean
}

export interface SubagentRunEndInfo {
  /** Unique identity shared with the paired start event. */
  readonly runId: SubagentRunId
  /** The same provider name carried by the paired start event. */
  readonly provider: string
  /** The child agent's id. */
  readonly id: SessionId
  /** Snapshot of whether `SubagentRun.localAgent` was present when start fulfilled. */
  readonly local: boolean
  /** The terminal stop reason. */
  readonly stopReason: SubagentResult['stopReason']
  /**
   * The child's final assistant output, selected by the same rule as
   * {@link SubagentResult.output}; absent on infrastructure rejection or when
   * the child produced none.
   */
  readonly lastAssistantMessage?: ContentBlock[]
}

export interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

export interface SubagentStartRequest {
  /** Optional short display label persisted with a session-backed child. */
  readonly label?: string
  /** Content delivered as the child's user message. */
  readonly prompt: ContentBlock[]
  /**
   * The spawning agent. In-process providers derive workspace, lineage, and
   * delegation depth from its durable session state. ACP reads only its cwd,
   * and only when no deployment `cwd` override is configured.
   */
  readonly parent: Agent
  /**
   * Cancellation signal from the spawning context (the tool's `exec.signal`).
   * This is the canonical cancellation channel both before and after startup:
   * a provider rejects `start()` after cleaning partial resources when it
   * fires before the run is published, and cancels the published run's
   * remaining turn work when it fires afterward.
   */
  readonly signal: AbortSignal
  readonly agentOptions?: AgentOptions
  /**
   * Object-rooted JSON Schema within `assertObjectJsonSchema`'s enforced subset. Start rejects
   * unsupported schemas or providers without the capability. Data must be plain host-realm JSON;
   * a successful child returns the matching value as {@link SubagentResult.structured}.
   */
  readonly outputSchema?: ObjectJsonSchema
  /**
   * Optional absolute delegation-depth cap for the child being started: its
   * computed depth must be less than or equal to this non-negative safe
   * integer. Requires {@link SubagentCapabilities.depthLimit}; rejected at
   * start otherwise.
   */
  readonly maxDepth?: number
  /**
   * Optional child tool scoping. Requires {@link SubagentCapabilities.toolFilter};
   * rejected at start otherwise. In-process backends apply it as a scoped
   * `tools.restrict()` in the child's creation window: the named tools vanish
   * from the child's prompt AND refuse to execute (one visibility), with loud
   * unknown-name validation.
   */
  readonly toolFilter?: ToolRestriction
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
}

export interface ResolvedSubagentStartRequest extends SubagentStartRequest {
  /** Detached descriptor a session-backed provider persists in the child log. */
  readonly descriptor: SubagentDescriptorData
}

export interface ContinuableCreateRequest {
  /** The reserved durable child session id, for provider diagnostics. */
  readonly sessionId: SessionId
  /** The delegating parent agent whose history a seeding provider reads. */
  readonly parent: Agent
  /**
   * Caller cancellation, which owns preparation only until the manager accepts
   * the initial prompt into the child's inbox.
   */
  readonly signal: AbortSignal
}

export interface ContinuableCreateSpec {
  /**
   * Completed-turn prefix of the parent's log to seed the child session with,
   * or absent for a fresh child. Same durable contract as
   * `CreateAgentOptions.seed`: contiguous from seq 0, lossless JSON, balanced.
   */
  readonly seed?: readonly SessionEvent[]
}

export interface SubagentStopReasonMap {
  /** The child finished its turn normally. */
  completed: 'completed'
  /** Cancelled through the request signal or disposal. */
  aborted: 'aborted'
  /** Model or transport failure. */
  error: 'error'
  /** The child hit its token ceiling before finishing. */
  'max-tokens': 'max-tokens'
  /** The child declined the task. */
  refusal: 'refusal'
}

export type SubagentStopReason = SubagentStopReasonMap[keyof SubagentStopReasonMap]

export interface SubagentResult {
  /**
   * The child's final assistant output is the content of its last non-empty
   * assistant message. Empty-content messages, including usage-only messages,
   * are skipped. Without a non-empty message, the output is its accumulated
   * assistant text stream, or `[]` when the child produced neither.
   */
  readonly output: ContentBlock[]
  /**
   * The structured result after a requested `outputSchema` was successfully
   * satisfied. Requesting a schema does not guarantee presence: a provider can
   * end with `stopReason: 'error'` when the child fails or finishes without a
   * valid capture. The structured value is validated against the requested
   * output schema by the provider; `unknown` here because the seam is
   * schema-agnostic.
   */
  readonly structured?: unknown
  /** Why the run ended. A non-`completed` reason means `output` may be partial. */
  readonly stopReason: SubagentStopReason
}

export interface SubagentRun {
  /**
   * Parent-scoped run id. For a local run, this MUST equal the published child
   * session id, whose `parentSession` records `request.parent.session.id`; a
   * remote provider mints an id unique in the parent namespace.
   */
  readonly id: SessionId
  /**
   * The exact published in-process child, or `undefined` for a remote run.
   * When present, its id is {@link id}; the provider retains no ownership
   * implication beyond the run's ordinary {@link dispose} contract.
   */
  readonly localAgent: Agent | undefined
  /**
   * Resolves with the child's terminal {@link SubagentResult} when the run
   * settles. Does NOT reject on a child-level failure — a model/transport
   * failure resolves with `stopReason: 'error'` so the consumer maps it to an
   * `isError` tool result. Rejects on an infrastructure fault the seam cannot
   * represent as a stop reason.
   */
  readonly result: Promise<SubagentResult>
  /**
   * Cancel remaining work, reach child quiescence, and release resources.
   * Idempotent.
   */
  dispose(): Promise<void>
}

export interface SubagentProvider {
  /** Unique registry name (e.g. `spawn`, `fork`, `acp`). */
  readonly name: string
  /** The start-time features this provider supports (see {@link SubagentCapabilities}). */
  readonly capabilities: SubagentCapabilities
  /**
   * Whether the child sees the parent's completed-turn prefix. This is descriptive, not a
   * service-validated start capability: the model-facing tool derives truthful wording from it.
   * It says nothing about tool registration, injected services, or authority inheritance.
   */
  readonly inheritsParentContext: boolean
  /**
   * Establish a ONE-SHOT child and return its handle after publication.
   * The service has already validated that every requested start-time
   * capability is supported and resolved `request.descriptor`, so a
   * session-backed implementation appends that descriptor inside the child's
   * initial turn. Before fulfillment, the provider owns setup and cleans any
   * unpublished partial resources before rejecting. Ownership transfers on
   * fulfillment; subsequent turn or infrastructure failure settles through
   * the returned run. Distinct starts may overlap; cancellation, failure,
   * result settlement, and disposal remain independent for each run.
   */
  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun>
  /**
   * OPTIONAL (continuable-creation capability): contribute the detached
   * creation inputs that distinguish this provider's continuable children —
   * only whether the child session is seeded with parent history. Method
   * presence IS the capability: the service rejects continuable starts on
   * providers without it, while a provider that has it may still serve
   * ordinary one-shot delegations.
   *
   * This is the provider's ONLY participation in a continuable child. The
   * continuation manager owns identity reservation, composition, Agent
   * creation, prompt delivery, cold resume, ownership, and disposal, so a
   * provider never sees the child's Agent, handle, turns, or teardown.
   * Distinct preparations may overlap; each follows its own signal and returns
   * data belonging only to `request.sessionId`.
   */
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
}

import { randomUUID } from 'node:crypto'

import type { Context } from '@ejunz/cordis'

import type { Agent } from '@ejunz/ea/agent'

import type { ContentBlock } from '@ejunz/ea/llm'

import { foldConsumedWork } from '@ejunz/ea/agent'

import type { SessionEvent, SessionId } from '@ejunz/ea/session'

export interface ActivationTerminal {
  /** Why this epoch's last ordinary turn ended, or `error` when teardown failed. */
  readonly stopReason: SubagentResult['stopReason']
  /** The epoch's final assistant content, absent when it produced none or failed. */
  readonly output?: ContentBlock[]
}

export interface ActivationObserver {
  /**
   * Publish the start edge once the epoch is resident.
   * @param child - the resident child agent, whose log suffix bounds this epoch.
   */
  start(child: Agent): void
  /**
   * Snapshot the child-dependent terminal facts while the child is still
   * registered, because handle disposal unregisters it and consumers resolve it
   * to read the child's own log and scope.
   * @param child - the quiescent child agent about to be released.
   */
  capture(child: Agent): void
  /**
   * Resolve the terminal facts {@link settle} will publish, without publishing
   * them. The manager's parent delivery must run before the ownership release
   * that lets the parent settle, which is earlier than the terminal edge; both
   * therefore read one computation instead of restating the failure rule.
   * @param failure - the teardown or durability failure, or `undefined` on success.
   * @returns this epoch's stop reason and final assistant content.
   */
  terminal(failure: unknown): ActivationTerminal
  /**
   * Publish the terminal edge exactly once, pairing this epoch's {@link start},
   * after the disposal outcome is known. Called only for a resident epoch: a
   * failure before residency publishes no edge, because inventing one would
   * report a lifecycle the child never had.
   * @param failure - the teardown or durability failure, or `undefined` on success.
   */
  settle(failure: unknown): void
}

export type LifecycleEmitter = {
  (name: 'subagent/start', info: SubagentRunInfo, parent: Agent): void
  (name: 'subagent/end', info: SubagentRunEndInfo, parent: Agent): void
  (name: 'subagent/provider-removed', info: string): void
}

export function createLifecycleEmitter(
  ctx: Context,
  carrier: (parent: Agent) => object,
): LifecycleEmitter {
  return (
    name: 'subagent/start' | 'subagent/end' | 'subagent/provider-removed',
    info: SubagentRunInfo | SubagentRunEndInfo | string,
    parent?: Agent,
  ): void => {
    const dispatchArgs: unknown[] = parent === undefined
      ? [name, info]
      : [carrier(parent), name, info]
    for (const callback of ctx.events.dispatch('emit', dispatchArgs)) {
      try {
        const returned: unknown = callback(info)
        void Promise.resolve(returned).catch((error: unknown) => {
          ctx.logger.warn(`subagent: ${name} listener rejected: ${renderThrown(error)}`)
        })
      } catch (error: unknown) {
        ctx.logger.warn(`subagent: ${name} listener threw: ${renderThrown(error)}`)
      }
    }
  }
}

export function observeRun(
  emit: LifecycleEmitter,
  provider: string,
  parent: Agent,
  run: SubagentRun,
): SubagentRun {
  const identity = {
    runId: SubagentRunId(randomUUID()),
    provider,
    id: run.id,
    local: run.localAgent !== undefined,
  }
  // Attach the terminal observer before dispatching start. Promise reactions
  // still run after this synchronous start emission, preserving start → end.
  void run.result.then(
    (result) => {
      emit('subagent/end', {
        ...identity,
        stopReason: result.stopReason,
        // Omit the field when no output exists, matching continuable epochs.
        ...result.output.length === 0 ? {} : { lastAssistantMessage: result.output },
      }, parent)
    },
    () => {
      emit('subagent/end', { ...identity, stopReason: 'error' }, parent)
    },
  )
  emit('subagent/start', identity, parent)
  return run
}

export function createActivationObserver(
  emit: LifecycleEmitter,
  provider: string,
  childId: SessionId,
  parent: Agent,
): ActivationObserver {
  const identity = { runId: SubagentRunId(randomUUID()), provider, id: childId, local: true }
  // A cold resume replays earlier turns, so this epoch's telemetry must come
  // from the suffix it actually produced — never the whole session, which
  // would report a previous epoch's answer when this one opened no turn.
  let boundary = 0
  // Assigned by `capture()`, which the disposal path always runs before
  // `settle()`; a resident epoch therefore always has its facts by then.
  let captured: ActivationTerminal = { stopReason: 'completed' }
  // Teardown failure overrides the epoch's own outcome and withholds its
  // output: an answer this ejunzAgent could not durably release is not a result.
  const terminal = (failure: unknown): ActivationTerminal => failure === undefined
    ? captured
    : { stopReason: 'error' }
  return {
    start: (child: Agent): void => {
      boundary = child.session.events.length
      emit('subagent/start', identity, parent)
    },
    capture: (child: Agent): void => {
      const own = child.session.events.slice(boundary)
      const output = finalAssistantOutput(own)
      captured = {
        stopReason: epochStopReason(own),
        ...output === undefined ? {} : { output },
      }
    },
    terminal,
    settle: (failure: unknown): void => {
      const { stopReason, output } = terminal(failure)
      emit('subagent/end', {
        ...identity,
        stopReason,
        ...output === undefined ? {} : { lastAssistantMessage: output },
      }, parent)
    },
  }
}

function epochStopReason(events: readonly SessionEvent[]): SubagentResult['stopReason'] {
  const { end, droppedUnrun } = foldConsumedWork(events)
  switch (end?.data.reason.kind) {
    case 'max-tokens':
      return 'max-tokens'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'error':
      return 'error'
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // this epoch had claimed: the work was declined, not done.
    case 'blocked':
      return 'refusal'
    // A clean ending and no accounting turn at all share one rule: the epoch
    // finished what it was given unless a cancelled queue says otherwise.
    case undefined:
    case 'completed':
      return droppedUnrun ? 'aborted' : 'completed'
    /* v8 ignore next 3 -- `TurnEndReason` is merge-extensible, so this arm needs a
     * backend that adds a variant; treating an unnameable reason as success would
     * report failed work as completed. */
    default:
      return 'error'
  }
}

function renderThrown(value: unknown): string {
  try {
    return value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

import { randomUUID } from 'node:crypto'

import type { Context } from '@ejunz/cordis'

import type {
  Agent,
  AgentHandle,
  AgentOptions,
  AgentSetupCommit,
  CreateAgentOptions,
} from '@ejunz/ea/agent'

import { boundContextSummary, createUserMessage, errorChain } from '@ejunz/ea/llm'

import type { ContentBlock, MessageId, MessageSource } from '@ejunz/ea/llm'

import { SessionId } from '@ejunz/ea/session'

import type { SessionEvent } from '@ejunz/ea/session'

import type { SessionPersistence } from '@ejunz/ea/session-persistence'

import type { ToolRestriction } from '@ejunz/ea/tools'

export interface CoordinatorMessageSource {
  readonly kind: 'coordinator'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the agent whose tool call produced the follow-up. */
  readonly senderSessionId: SessionId
}

export interface SubagentReportMessageSource {
  readonly kind: 'subagent-report'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the reporting child. */
  readonly senderSessionId: SessionId
}

export interface SubagentSettledMessageSource {
  readonly kind: 'subagent-settled'
  /** A runtime account shown without expanding the row (`notice` context form). */
  readonly form: 'notice'
  /** One-line account of how the child ended. */
  readonly summary: string
  /** Session id of the child that settled. */
  readonly senderSessionId: SessionId
}

declare module '@ejunz/ea/llm' {
  interface MessageSourceMap {
    coordinator: CoordinatorMessageSource
    'subagent-report': SubagentReportMessageSource
    'subagent-settled': SubagentSettledMessageSource
  }
}

export type SubagentReportDelivery = 'quiet' | 'wakeup'

export interface SubagentReportOptions {
  /** Already-resolved parent scheduling policy. */
  readonly delivery: SubagentReportDelivery
  /** Caller cancellation, owning authorization and admission until acceptance. */
  readonly signal: AbortSignal
}

export interface ContinuableStartSpec {
  /** The `ctx.subagents` provider whose continuable-creation capability establishes the child. */
  readonly provider: string
  /** The initial delegation's short `description`, persisted as the child's creation label. */
  readonly label: string
  /**
   * The delegation request. The manager reserves the stable child id, resolves
   * the durable descriptor, and composes the child itself.
   */
  readonly request: Omit<SubagentStartRequest, 'label' | 'signal' | 'outputSchema'>
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

export interface ContinuableStart {
  /** The durable child session id, stable across activations. */
  readonly childId: SessionId
  /** The accepted initial prompt's inbox message id. */
  readonly messageId: MessageId
}

export type SubagentInterruptAuthority =
  | { readonly kind: 'user'; readonly parentSessionId: SessionId }
  | { readonly kind: 'ancestor'; readonly agent: Agent }

export interface SubagentFollowupOptions {
  /** Durable attribution retained on the delivered message; it grants no authority. */
  readonly source: MessageSource
  /** Caller cancellation, owning the operation only until inbox acceptance. */
  readonly signal: AbortSignal
}

type ActivationState = 'running' | 'waiting' | 'settled'

interface ContinuationHost {
  /**
   * Resolve one provider's continuable-creation contribution, or reject when
   * the provider is unknown or lacks the capability.
   * @param name - the configured provider name.
   * @param request - the reserved identity, delegating parent, and cancellation.
   * @returns the provider's detached creation spec.
   */
  prepareContinuable(name: string, request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>
  /**
   * Build the lifecycle observer for one Activation's residency epoch.
   * @param provider - the provider name recorded in the durable descriptor.
   * @param childId - the durable child session id.
   * @param parent - the exact live direct parent for scoped dispatch.
   * @returns the observer whose edges this epoch publishes.
   */
  observeActivation(provider: string, childId: SessionId, parent: Agent): ActivationObserver
}

interface Activation {
  /** The durable child this Activation is an epoch of. */
  readonly childId: SessionId
  /**
   * The durable direct parent, stored because settlement delivery must resolve
   * that parent after the child handle is gone. {@link ancestry} cannot answer
   * it: a `WeakSet` is not enumerable, and the child's own header is only
   * reachable through a handle disposal has already released.
   */
  readonly parentSession: SessionId
  /** The provider name recorded in the durable descriptor. */
  readonly provider: string
  /** The retained live Agent handle, disposed exactly once at settlement. */
  readonly handle: AgentHandle
  /**
   * Exact live Agent ancestry observed when this Activation materialized.
   * Weak membership preserves host-scope identity across an intermediate
   * ancestor leaving the registry without retaining that ancestor's runtime.
   */
  readonly ancestry: WeakSet<Agent>
  /**
   * Session ids of the child Activations this one owns. Because one Session has
   * at most one live Activation, the id identifies the live child without
   * another runtime-incarnation reference. Non-empty blocks settlement.
   */
  readonly ownedChildren: Set<SessionId>
  /** The lifecycle observer that emits this epoch's start and terminal edges. */
  readonly observer: ActivationObserver
  /**
   * The memoized disposal transaction. Presence IS the admission cutoff: it is
   * assigned synchronously when disposal begins, so no delivery can join a
   * handle being torn down, and a racing delivery awaits it before cold-resuming
   * a new Activation. Every converging releaser shares this one teardown.
   */
  disposal: Promise<void> | undefined
  /**
   * Accepted waking message ids this manager has not yet seen leave the inbox.
   * `Agent.status` is still `idle` in the window between `followup()` and the
   * microtask that admits it, so settlement must not treat that gap as quiet.
   */
  readonly accepted: Set<MessageId>
  /**
   * Whether any delivery to this child was ever accepted. A materialization
   * rolled back before its first acceptance is a child the caller was told does
   * not exist, so its teardown owes the parent no settlement account.
   */
  announced: boolean
  /** Renewed whenever a settlement watcher must re-observe quiescence. */
  poke: PromiseWithResolvers<void>
}

interface MaterializeInputs {
  childId: SessionId
  provider: string
  parent: Agent
  /**
   * Creation inputs; absent for a cold resume, which loads the persisted
   * session — including the delegation policy events a fresh creation seeded,
   * so a resume never re-captures the parent's policy.
   */
  create?: {
    seed: readonly SessionEvent[]
    meta: NonNullable<CreateAgentOptions['meta']>
    /** Approval policy captured at the delegation boundary. */
    delegatedPolicies: DelegatedPolicyOverrides
  }
  agentOptions: AgentOptions
  composition: { persona?: string | undefined; toolFilter?: ToolRestriction | undefined }
  signal: AbortSignal
}

interface Materialization {
  readonly lineage: readonly Agent[]
  readonly settled: Promise<void>
}

function disposalOf(activation: Activation): Promise<void> | undefined {
  return activation.disposal
}

function settlementSummary(childId: SessionId, stopReason: SubagentResult['stopReason']): string {
  const subject = `Background subagent ${childId}`
  switch (stopReason) {
    case 'completed':
      return `${subject} finished and will do no further work unless you send it more.`
    case 'aborted':
      return `${subject} was stopped before it finished.`
    case 'max-tokens':
      return `${subject} ran out of room before it finished.`
    // A pre-step rejection — a hook deny, a policy plugin — discarded input
    // the child had claimed, so the parent must not treat the task as done.
    case 'refusal':
      return `${subject} declined the task.`
    case 'error':
      return `${subject} failed before it finished.`
    /* v8 ignore next 4 -- `SubagentResult['stopReason']` is merge-extensible, so this arm
     * needs a backend that adds a variant; an unnameable ending is reported as unfinished
     * rather than silently as success. */
    default:
      return `${subject} ended abnormally (${String(stopReason)}) before it finished.`
  }
}

type SettlementAttempt =
  | { readonly settling: false }
  | { readonly settling: true; readonly done: Promise<void> }

class ChildLock {
  private tails = new Map<SessionId, Promise<unknown>>()

  /**
   * Run `operation` after every previously queued operation for `childId`.
   * @param childId - the durable child whose operations are linearized.
   * @param operation - the critical section to run in order.
   * @returns the operation's own settlement.
   */
  run<T>(childId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(childId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    // Absorb rejections in the chaining tail so one failed critical section
    // cannot reject an unrelated later caller.
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(childId, tail)
    void tail.then(() => {
      if (this.tails.get(childId) === tail) this.tails.delete(childId)
    })
    return result
  }
}

export class SubagentContinuationManager {
  /** Child session id → its live Activation. Process-local, never durable. */
  private activations = new Map<SessionId, Activation>()
  /** Materializations admitted before drain, tracked through publication or rollback. */
  private readonly materializations = new Set<Materialization>()
  private readonly locks = new ChildLock()
  /** Structural Cordis owner of every Activation handle. */
  private readonly ownerCtx: Context
  /**
   * Exact roots whose host teardown has begun, with the live lineage members
   * observed under each root. Entries remain until that exact root leaves the
   * Agent registry, closing admission throughout its host's teardown without
   * poisoning a later same-id replacement.
   */
  private readonly closingScopes = new Map<Agent, Set<Agent>>()
  private draining = false

  constructor(
    private readonly ctx: Context,
    private readonly host: ContinuationHost,
    private readonly setupRegistry: SubagentActivationSetupRegistry,
  ) {
    // Ordinary Cordis owner effects unwind in reverse registration order, which
    // cannot express the dynamic child graph. Register the private scope's
    // structural disposer FIRST and the drain SECOND, so reverse unwind invokes
    // the drain before releasing the scope; a cleanup effect on the same scope
    // as the Agent handles would let structural handle disposal bypass
    // child-first ordering.
    const scope = ctx.plugin(function activationOwner() {})
    this.ownerCtx = scope.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.closingScopes.delete(agent)
    })
    ctx.effect(function* (this: SubagentContinuationManager) {
      yield scope.dispose
      yield () => this.drain()
    }.bind(this), 'subagents.continuations()')
  }

  /**
   * Start one continuable background child: reserve its durable identity,
   * resolve the provider's detached creation spec, create the child Agent
   * through the private activation-owner scope, establish any continuable-parent
   * ownership, and submit the initial prompt. Resolves when inbox acceptance
   * yields the message id — without waiting for the turn to start or for the
   * message to reach the Session log.
   *
   * Every failure before that acceptance rejects without either id, disposing
   * any created handle and rolling back the Activation and parent ownership.
   * The caller signal owns lookup, materialization, and admission only until
   * acceptance; afterwards the manager owns the Activation independently.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and the accepted initial prompt's message id.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    const request = spec.request
    const parent = request.parent
    this.assertAdmitting(parent)
    this.requirePersistence()
    assertSubagentMaxDepth(request.maxDepth)
    const childId = SessionId(randomUUID())
    const childDepth = resolveChildDepth(parent, request.maxDepth)
    // Snapshot before any await: invalid descriptor JSON rejects the call
    // before a child exists, and the detached value is what reaches the log.
    const agentProvider = request.agentOptions?.provider ?? parent.options.provider
    const agentModel = request.agentOptions?.model ?? parent.options.model
    const descriptor = snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: spec.provider,
      label: spec.label,
      ...agentProvider !== undefined ? { agentProvider } : {},
      ...agentModel !== undefined ? { agentModel } : {},
      ...request.persona !== undefined ? { persona: request.persona } : {},
      ...request.toolFilter !== undefined ? { toolFilter: request.toolFilter } : {},
    })
    // Capture before the first await: a later parent switch belongs to the
    // parent's future, not to this child.
    const delegatedPolicies = captureDelegatedPolicyOverrides(parent)

    const prepared = await this.host.prepareContinuable(spec.provider, {
      sessionId: childId,
      parent,
      signal: spec.signal,
    })
    spec.signal.throwIfAborted()
    this.assertAdmitting(parent)

    const lineageSeedLength = prepared.seed?.length ?? 0
    const seed = seedDescriptorTurn(childId, prepared.seed, descriptor)
    const messageId = await this.locks.run(childId, async () => {
      const activation = await this.materialize({
        childId,
        provider: spec.provider,
        parent,
        create: { seed, meta: childSessionMeta(parent, childDepth, lineageSeedLength), delegatedPolicies },
        agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
        composition: { persona: request.persona, toolFilter: request.toolFilter },
        signal: spec.signal,
      })
      return this.submitMaterialized(
        activation,
        request.prompt,
        { kind: 'user' },
        parent,
        spec.signal,
      )
    })
    return { childId, messageId }
  }

  /**
   * Deliver one later message to a known continuable child as its next FIFO
   * turn. Routing depends only on Activation residency: a `running` Activation
   * enqueues, a `waiting` one wakes the same Agent, and an absent one
   * cold-resumes a new Activation from the persisted Session. The Agent inbox
   * is the only queue, so every accepted message has one observable order.
   *
   * The caller signal owns lookup, materialization, and admission only until
   * inbox acceptance; afterwards the accepted turn cannot be cancelled through
   * this service.
   * @param parent - the exact live direct parent authorizing this delivery.
   * @param childId - the durable child session id.
   * @param content - the user-role content to deliver.
   * @param options - the message source fields and caller cancellation.
   * @returns the accepted message's inbox id.
   * @throws when parent authority, availability, or admission rejects the delivery.
   */
  async followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<MessageId> {
    this.assertAdmitting(parent)
    while (true) {
      const live = await this.locks.run(childId, async () => {
        const activation = this.activations.get(childId)
        if (activation === undefined) return this.coldResume(parent, childId, content, options)
        // A delivery that arrives after the disposal transaction began must not
        // reach a handle being torn down; wait for release, then cold-resume.
        /* v8 ignore next 3 -- the send-versus-dispose cutoff: reaching this arm needs a
         * delivery to observe the transaction inside the same critical section that opened it,
         * which no test can schedule deterministically. The behavior is covered end-to-end by
         * "cold-resumes a delivery that lost the race with final disposal". */
        if (activation.disposal !== undefined) {
          return activation.disposal.then(() => undefined, () => undefined)
        }
        return this.submitAdmitted(activation, content, options.source, parent, options.signal)
      })
      /* v8 ignore start -- only the lost-cutoff arm above returns undefined, so only that
       * race reaches the retry below, which then cold-resumes a new Activation. */
      if (live !== undefined) return live
      this.assertAdmitting(parent)
      options.signal.throwIfAborted()
      /* v8 ignore stop */
    }
  }

  /**
   * Interrupt one live continuable child's current turn. Admission is
   * synchronous and the effect is asynchronous: this authorizes the caller,
   * requests `Agent.cancel(cause, { keepInbox: true })` on the target, and
   * returns without waiting for the target to observe the signal or reach
   * quiescence. The Activation, its handle, accepted unclaimed inbox work, and
   * already-published descendants are untouched; work already claimed into the
   * interrupted turn is not requeued. Once the interrupted driver is idle, a
   * waking send resumes the parked queue.
   *
   * An absent target is an accepted no-op, which uniformly covers natural
   * completion races, repeated requests, one-shot ids, and unknown ids without
   * consulting the durable catalog. A target whose disposal transaction is
   * already open is likewise an accepted no-op after authorization.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   * @throws {SubagentError} `UNAUTHORIZED` when the presented authority does
   *   not own the live target: a stale or self-targeting ancestor caller, a
   *   parent address that is not the live target's durable direct parent, or
   *   an ancestor outside the target's recorded live lineage.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    if (authority.kind === 'ancestor') {
      const caller = authority.agent
      // A stale caller is rejected even when the target is absent, so a
      // replaced same-id Agent can never probe this manager's state.
      if (this.ctx.agents.get(caller.id) !== caller) {
        throw new SubagentError(
          `interrupting "${targetSessionId}" requires the exact live ancestor agent`,
          'UNAUTHORIZED',
        )
      }
      if (caller.id === targetSessionId) {
        throw new SubagentError(
          `agent "${caller.id}" cannot interrupt itself`,
          'UNAUTHORIZED',
        )
      }
    }
    const activation = this.activations.get(targetSessionId)
    if (activation === undefined) return
    if (authority.kind === 'user') {
      if (activation.handle.agent.session.header.parentSession !== authority.parentSessionId) {
        throw new SubagentError(
          `subagent "${targetSessionId}" belongs to another parent session`,
          'UNAUTHORIZED',
        )
      }
    } else if (!activation.ancestry.has(authority.agent)) {
      throw new SubagentError(
        `subagent "${targetSessionId}" is not a live descendant of agent "${authority.agent.id}"`,
        'UNAUTHORIZED',
      )
    }
    // Disposal already stopped the target with a whole-Activation teardown;
    // a second cancel would be a redundant signal on a closing handle.
    if (activation.disposal !== undefined) return
    activation.handle.agent.cancel(
      authority.kind === 'user' ? { kind: 'user' } : { kind: 'parent' },
      { keepInbox: true },
    )
  }

  /**
   * Deliver explicitly selected content from one resident continuable child to
   * its durable direct parent. Sender authorization, parent resolution, and
   * send acceptance share one no-await span. Reporting neither concludes the
   * child's turn nor changes its Activation lifetime.
   * @param child - exact live reporting child; this is the authority credential.
   * @param content - selected model-facing content.
   * @param options - scheduling policy and pre-acceptance cancellation.
   * @returns the stable identity of the message accepted by the parent.
   * @throws {SubagentError} when the sender is unauthorized, the parent is not
   *   live, or continuation admission is closing.
   */
  // oxlint-disable-next-line typescript/require-await -- keep rejection semantics without yielding during admission
  async reportFrom(
    child: Agent,
    content: ContentBlock[],
    options: SubagentReportOptions,
  ): Promise<MessageId> {
    options.signal.throwIfAborted()
    this.assertAdmitting(child)
    const activation = this.authorizeReporter(child)
    const parent = this.resolveReportParent(child)
    return this.deliverReport(activation, parent, content, options.delivery)
  }

  /** Authorize only the exact Agent of one resident Activation. */
  private authorizeReporter(child: Agent): Activation {
    const activation = this.activations.get(child.id)
    if (activation === undefined || activation.handle.agent !== child) {
      throw new SubagentError(
        `agent "${child.id}" is not a live continuable subagent and cannot report`,
        'UNAUTHORIZED',
      )
    }
    /* v8 ignore next 6 -- only a synchronous re-entrant disposer can open this
     * transaction between exact-agent authorization and this no-await cutoff. */
    if (activation.disposal !== undefined) {
      throw new SubagentError(
        `subagent "${child.id}" activation is being disposed; the report was not delivered`,
        'ACTIVATION_CLOSING',
      )
    }
    return activation
  }

  /** Resolve the reporting child's live direct parent from durable lineage. */
  private resolveReportParent(child: Agent): Agent {
    const parentId = child.session.header.parentSession
    /* v8 ignore next -- every continuation-managed child has direct-parent metadata. */
    const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
    if (parent === undefined) {
      throw new SubagentError(
        'direct parent is not live; report was not delivered',
        'PARENT_UNAVAILABLE',
      )
    }
    return parent
  }

  /** Deliver one framed report through the selected parent scheduling preset. */
  private deliverReport(
    activation: Activation,
    parent: Agent,
    content: ContentBlock[],
    delivery: SubagentReportDelivery,
  ): MessageId {
    const message = createUserMessage({
      content: [
        { type: 'text' as const, text: `Background subagent ${activation.childId} reported:` },
        ...content,
      ],
      source: {
        kind: 'subagent-report' as const,
        form: 'relay' as const,
        senderSessionId: activation.childId,
      },
    })
    if (delivery === 'wakeup') {
      this.sendWaking(parent, message, () => { this.sendReport(parent, message, delivery) })
    } else {
      this.sendReport(parent, message, delivery)
    }
    return message.id
  }

  /**
   * Perform one waking send to a parent, accounted against that parent's own
   * Activation when it has one. Registering the id before the send is what
   * keeps a continuation-managed parent from being judged quiescent in the
   * window between `followup()` and the microtask that admits it.
   * @param parent - the exact live parent receiving the waking message.
   * @param message - the message whose id is accounted.
   * @param send - the synchronous waking send to perform.
   */
  private sendWaking(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
    send: () => void,
  ): void {
    const parentActivation = this.activations.get(parent.id)
    if (parentActivation !== undefined && parentActivation.handle.agent === parent) {
      this.admitWaking(parentActivation, message.id, send)
    } else {
      send()
    }
  }

  /** Send one report while translating only the parent's own rejection. */
  private sendReport(
    parent: Agent,
    message: ReturnType<typeof createUserMessage>,
    delivery: SubagentReportDelivery,
  ): void {
    try {
      if (delivery === 'wakeup') parent.followup(message)
      else parent.inject(message)
    } catch (error: unknown) {
      throw new SubagentError(
        'direct parent is not live; report was not delivered',
        'PARENT_UNAVAILABLE',
        { cause: error },
      )
    }
  }

  /**
   * Close admission, await every already-admitted materialization through
   * publication or rollback, then dispose the stable live Activation forest
   * child-first. Sibling branches drain independently: one failure is recorded
   * but never prevents the remaining handles from being attempted, and the
   * aggregate rejects only after every branch settles.
   * @returns once materialization is quiescent and every live Activation released its handle.
   * @throws an aggregate error when any branch failed to release.
   */
  async drain(): Promise<void> {
    // Close admission synchronously before the first await. Materializations
    // already past that cutoff remain tracked until their handle is installed
    // or rollback completes, producing a stable forest for the later snapshot.
    this.draining = true
    await Promise.all([...this.materializations].map(materialization => materialization.settled))
    // Snapshot roots after closing admission: a root is an Activation no live
    // Activation owns, so disposing roots recurses child-first into the forest.
    const owned = new Set<SessionId>()
    for (const activation of this.activations.values()) {
      for (const child of activation.ownedChildren) owned.add(child)
    }
    const roots = [...this.activations.values()].filter(activation => !owned.has(activation.childId))
    await this.disposeRoots(roots, 'activation(s)')
  }

  /**
   * Stop only the continuable descendants of exact live host-owned parents.
   * Admission stays closed for those parent trees until each exact parent
   * leaves the Agent registry; unrelated trees and manager-wide admission stay
   * live.
   * @param parents - exact live roots whose continuable descendants must stop.
   * @returns once every retained descendant Activation released its handle.
   * @throws an aggregate error after all scoped branches settle when any failed.
   */
  async drainDescendants(parents: readonly Agent[]): Promise<void> {
    const roots = new Set(parents.filter(parent => this.ctx.agents.get(parent.id) === parent))
    if (roots.size === 0) return

    // Publish the scoped admission cutoff before the first await. Merge with an
    // earlier call for the same exact root so a converging drain cannot forget
    // descendants whose release is already in flight.
    for (const root of roots) {
      this.closingMembers(root).add(root)
    }

    const targets: Activation[] = []
    for (const activation of this.activations.values()) {
      const lineage = this.liveLineage(activation.handle.agent)
      // Strict descendants only: a continuable Agent may itself be a
      // host-owned root, and its host remains responsible for that root handle.
      const owners = [...roots].filter(root => activation.handle.agent !== root
        && activation.ancestry.has(root))
      if (owners.length === 0) continue
      targets.push(activation)
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        members.add(activation.handle.agent)
        for (const agent of lineage) members.add(agent)
      }
    }
    const materializations = [...this.materializations].filter((materialization) => {
      const owners = [...roots].filter(root => materialization.lineage.includes(root))
      for (const owner of owners) {
        const members = this.closingMembers(owner)
        for (const agent of materialization.lineage) members.add(agent)
      }
      return owners.length > 0
    })

    const ownedTargets = new Set<SessionId>()
    for (const activation of targets) {
      for (const child of activation.ownedChildren) ownedTargets.add(child)
    }
    const targetRoots = targets.filter(activation => !ownedTargets.has(activation.childId))

    // Open every selected transaction before the materialization barrier.
    // Disposal propagates cancellation top-down in the same synchronous span;
    // handle release remains child-first.
    for (const activation of targets) {
      const disposal = this.dispose(activation)
      void disposal.catch(() => undefined)
    }

    await Promise.all(materializations.map(materialization => materialization.settled))
    await this.disposeRoots(targetRoots, 'scoped activation(s)')
  }

  /** Dispose independent roots and report every branch failure after all settle. */
  private async disposeRoots(
    roots: readonly Activation[],
    failureSubject: 'activation(s)' | 'scoped activation(s)',
  ): Promise<void> {
    const failures = await Promise.all(roots.map(async (activation) => {
      try {
        await this.dispose(activation)
        return undefined
      } catch (error: unknown) {
        return error
      }
    }))
    const reasons = failures.filter(failure => failure !== undefined)
    if (reasons.length > 0) {
      throw new SubagentError(
        `continuable subagent teardown failed for ${reasons.length} ${failureSubject}: `
        + reasons.map(reason => errorChain(reason)).join('; '),
        'ACTIVATION_TEARDOWN_FAILED',
      )
    }
  }

  /** Return the retained member set for one exact scoped-teardown root. */
  private closingMembers(root: Agent): Set<Agent> {
    const existing = this.closingScopes.get(root)
    if (existing !== undefined) return existing
    const members = new Set<Agent>()
    this.closingScopes.set(root, members)
    return members
  }

  /**
   * Return the exact currently resolvable ancestry from `agent` upward. The
   * first element is always the supplied identity, even when it is already
   * stale; each ancestor after it must be the registry's current exact entry.
   */
  private liveLineage(agent: Agent): Agent[] {
    const lineage = [agent]
    const seen = new Set<SessionId>([agent.id])
    let parentSession = agent.session.header.parentSession
    while (parentSession !== undefined) {
      const parent = this.ctx.agents.get(parentSession)
      if (parent === undefined || seen.has(parent.id)) break
      lineage.push(parent)
      seen.add(parent.id)
      parentSession = parent.session.header.parentSession
    }
    return lineage
  }

  /**
   * The teardown that closed continuable admission for this agent's lineage.
   * `'manager'` is the whole manager draining; an Agent is the exact scoped root
   * whose forest is closing.
   * @param agent - the agent whose lineage is tested.
   * @returns the closing teardown, or `undefined` while admission is open.
   */
  private closingTeardownFor(agent: Agent): Agent | 'manager' | undefined {
    if (this.draining) return 'manager'
    const lineage = this.liveLineage(agent)
    for (const [root, members] of this.closingScopes) {
      if (members.has(agent) || lineage.includes(root)) return root
    }
    return undefined
  }

  /** Reject new admission once the manager or this exact parent tree began draining. */
  private assertAdmitting(agent: Agent): void {
    const closing = this.closingTeardownFor(agent)
    if (closing === undefined) return
    throw new SubagentError(
      closing === 'manager'
        ? 'continuable subagents are draining; the operation was not admitted'
        : `continuable subagents below parent "${closing.id}" are draining; the operation was not admitted`,
      'DRAINING',
    )
  }

  /**
   * Derive residency from Agent quiescence and the owned-child set. `running`
   * covers an active admission, an open turn, or accepted waking inbox work.
   *
   * `Agent.status` alone is insufficient: it stays `idle` between an accepted
   * waking send and the microtask that admits it, so a synchronous inbox
   * observer would see `settled` while a turn is already queued. `accepted`
   * holds the ids this manager admitted but has not yet seen drained.
   */
  private stateOf(activation: Activation): ActivationState {
    if (activation.handle.agent.status === 'running' || activation.accepted.size > 0) return 'running'
    if (activation.ownedChildren.size > 0) return 'waiting'
    return 'settled'
  }

  /**
   * Cold-resume a persisted child: inspect and authorize its Session, fold the
   * generic descriptor, create the Activation through `ctx.agents.resume()`,
   * and submit the waiting turn. This never dispatches through a subagent
   * provider — the persisted Session already holds the initial prefix and the
   * descriptor is the whole reconstruction input.
   */
  private async coldResume(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<MessageId> {
    const persistence = this.requirePersistence()
    let loaded: Awaited<ReturnType<typeof persistence.inspect>>
    try {
      loaded = await persistence.inspect(childId, options.signal)
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    options.signal.throwIfAborted()
    this.assertAdmitting(parent)
    // Authorize the persisted header before folding: only the durable child's
    // exact live direct parent may continue it.
    this.authorizeLineage(parent, childId, loaded.meta.parentSession)
    // Fold only the child's own suffix: a fork seed replays the parent's log,
    // which may carry an ANCESTOR's descriptor when the parent is itself a
    // continuable child.
    const descriptor = foldSubagentDescriptor(loaded.events.slice(loaded.meta.seedLength ?? 0))
    if (descriptor === undefined || descriptor.mode !== 'continuable') {
      throw new SubagentError(
        `subagent "${childId}" has no supported continuation state and cannot be resumed; `
        + 'do not retry send_message with this id',
        'NOT_RESUMABLE',
      )
    }
    let activation: Activation
    try {
      activation = await this.materialize({
        childId,
        provider: descriptor.provider,
        parent,
        agentOptions: {
          ...descriptor.agentProvider !== undefined ? { provider: descriptor.agentProvider } : {},
          ...descriptor.agentModel !== undefined ? { model: descriptor.agentModel } : {},
        },
        composition: { persona: descriptor.persona, toolFilter: descriptor.toolFilter },
        signal: options.signal,
      })
    } catch (error: unknown) {
      options.signal.throwIfAborted()
      if (error instanceof SubagentError) throw error
      throw new SubagentError(`subagent "${childId}" is unavailable`, 'NOT_RESUMABLE', { cause: error })
    }
    return this.submitMaterialized(activation, content, options.source, parent, options.signal)
  }

  /**
   * Submit to a freshly materialized Activation or roll it back completely.
   * @param activation - the just-published Activation to admit or release.
   * @param content - the initial or resumed message content.
   * @param source - durable fields naming who supplied the accepted message.
   * @param parent - the live direct parent authorizing admission.
   * @param signal - caller cancellation owning admission until acceptance.
   * @returns the accepted inbox message id.
   */
  private async submitMaterialized(
    activation: Activation,
    content: ContentBlock[],
    source: MessageSource,
    parent: Agent,
    signal: AbortSignal,
  ): Promise<MessageId> {
    try {
      return this.submitAdmitted(activation, content, source, parent, signal)
    } catch (error: unknown) {
      /* v8 ignore next -- rollback disposal failures must not mask the
       * pre-acceptance signal, drain, or lifecycle failure. */
      await this.dispose(activation).catch(() => undefined)
      throw error
    }
  }

  /**
   * Create or resume the child Agent through the private activation-owner
   * scope, install the handle in a fresh Activation, and register ownership on
   * a continuation-managed parent. Rejection leaves no Activation, no handle,
   * and no ownership membership.
   */
  private materialize(inputs: MaterializeInputs): Promise<Activation> {
    this.assertAdmitting(inputs.parent)
    const settled = Promise.withResolvers<void>()
    const lineage = this.liveLineage(inputs.parent)
    const materialization: Materialization = {
      lineage,
      settled: settled.promise,
    }
    this.materializations.add(materialization)
    return this.materializeTracked(inputs, lineage).finally(() => {
      this.materializations.delete(materialization)
      settled.resolve()
    })
  }

  /**
   * Perform one tracked materialization. The caller keeps the drain barrier
   * registered until this either returns a resident Activation or finishes
   * rollback.
   */
  private async materializeTracked(
    inputs: MaterializeInputs,
    parentLineage: readonly Agent[],
  ): Promise<Activation> {
    const { childId, provider, parent, create } = inputs
    // No id pre-check here: the child lock serializes each durable child, both
    // callers reach this only after confirming no Activation exists, and
    // `AgentRegistry.enter()` is the authoritative collision boundary for an id
    // some other owner holds — a duplicate would reject there with rollback.
    inputs.signal.throwIfAborted()
    const setup = (childCtx: Context): AgentSetupCommit => {
      // Only fresh creation seeds the delegation policy onto the child's own
      // log (after any fork seed, so fresh policy wins stale seed state); a
      // cold resume replays those persisted events instead.
      if (create !== undefined) {
        appendDelegatedPolicyOverrides((childCtx.agent as Agent).session, create.delegatedPolicies)
      }
      applyChildComposition(childCtx, parent, inputs.composition)
      return this.setupRegistry.apply(childCtx)
    }
    const observer = this.host.observeActivation(provider, childId, parent)
    // Agent creation owns rollback before handle transfer. A rejection leaves
    // no resident Activation and therefore publishes no lifecycle edge.
    const handle: AgentHandle = create === undefined
      ? await this.ownerCtx.agents.resume({
        resumeSessionId: childId,
        agentOptions: inputs.agentOptions,
        signal: inputs.signal,
        setup,
      })
      : await this.ownerCtx.agents.create({
        sessionId: childId,
        meta: create.meta,
        seed: create.seed,
        agentOptions: inputs.agentOptions,
        signal: inputs.signal,
        setup,
      })

    const activation: Activation = {
      childId,
      // The durable lineage, not merely the caller: creation stamps this same
      // agent into the child's header, and cold resume authorized it against
      // the persisted header before materializing.
      parentSession: parent.id,
      provider,
      handle,
      ancestry: new WeakSet([handle.agent, ...parentLineage]),
      ownedChildren: new Set(),
      observer,
      disposal: undefined,
      accepted: new Set(),
      announced: false,
      poke: Promise.withResolvers<void>(),
    }
    // After transfer, any failure must dispose the created handle, remove the
    // Activation, and roll back parent ownership before rejecting.
    this.activations.set(childId, activation)
    try {
      inputs.signal.throwIfAborted()
      this.assertAdmitting(parent)
      this.acquireOwnership(parent, childId)
      // Every accepted id leaves the inbox exactly once, through dequeue or
      // discard. Clearing it there is what lets `stateOf()` distinguish a truly
      // quiet Agent from one whose accepted turn has not been admitted yet.
      // Registered through the child's own scoped context, so scope filtering
      // already restricts both listeners to this exact agent.
      handle.agent.ctx.on('agent/inbox/claimed', ({ message }) => {
        /* v8 ignore next -- a claim of an id this manager never admitted needs
         * another sender on the same child, which no current path allows. */
        if (activation.accepted.delete(message.id)) this.wake(activation)
      })
      handle.agent.ctx.on('agent/inbox/discarded', ({ message }) => {
        if (activation.accepted.delete(message.id)) this.wake(activation)
      })
      // Agent creation committed setup at its publication boundary;
      // revocations from here on are immediate live revocation.
      // Publish the start edge before any turn can run, so observers see this
      // epoch before its first request.
      observer.start(handle.agent)
    } catch (error: unknown) {
      // Listener exceptions are contained by the lifecycle emitter; a start
      // publication throw therefore leaves no residency edge to pair.
      /* v8 ignore next -- rollback failure must not mask the admission failure
       * that prevented this operation from returning an accepted message id. */
      await this.rollbackUnpublished(activation).catch(() => undefined)
      throw error
    }
    this.watchSettlement(activation)
    return activation
  }

  /**
   * Release an Activation whose start edge was not published. The memoized
   * transaction remains in the live map until handle disposal settles, so a
   * concurrent drain or delivery observes the same closing boundary.
   */
  private rollbackUnpublished(activation: Activation): Promise<void> {
    return (activation.disposal ??= (async () => {
      try {
        await activation.handle.dispose()
      } finally {
        this.activations.delete(activation.childId)
        this.releaseOwnership(activation.childId)
      }
    })())
  }

  /**
   * Register the child in a continuation-managed parent's owned set before the
   * child can run, so that parent cannot settle while the child is live. A
   * top-level or other non-continuation Agent has no Activation and stays
   * outside the waiting graph.
   */
  private acquireOwnership(parent: Agent, childId: SessionId): void {
    const parentActivation = this.activations.get(parent.id)
    if (parentActivation === undefined) return
    if (parentActivation.disposal !== undefined) {
      throw new SubagentError(
        `subagent parent "${parent.id}" is being disposed; the child was not established`,
        'ACTIVATION_CLOSING',
      )
    }
    parentActivation.ownedChildren.add(childId)
  }

  /** Remove one child from its live owner's set and let that owner re-check settlement. */
  private releaseOwnership(childId: SessionId): void {
    for (const candidate of this.activations.values()) {
      if (candidate.ownedChildren.delete(childId)) this.wake(candidate)
    }
  }

  /** Let a settlement watcher re-observe quiescence after ownership or inbox changes. */
  private wake(activation: Activation): void {
    activation.poke.resolve()
    activation.poke = Promise.withResolvers<void>()
  }

  /**
   * Submit one message as the child's next FIFO turn and return its accepted
   * inbox id. Acceptance is the operation's success boundary; the manager owns
   * the Activation independently afterwards.
   */
  private submit(
    activation: Activation,
    content: ContentBlock[],
    source: MessageSource,
    parent: Agent,
  ): MessageId {
    // Parent-originated delivery keeps the parent live through ownership, so
    // establish it before the message can enter the child's inbox.
    this.acquireOwnership(parent, activation.childId)
    const message = createUserMessage({ content, source })
    const accepted = this.admitWaking(activation, message.id, () => {
      activation.handle.agent.followup(message)
    })
    // Past this point the caller has an id for this child, so its eventual
    // settlement is something the parent is owed an account of.
    activation.announced = true
    return accepted
  }

  /**
   * Account one waking send across a resident Activation's settlement window.
   * @param activation - Activation receiving waking inbox work.
   * @param messageId - stable identity of the message about to be sent.
   * @param send - synchronous send that publishes one enqueue occurrence.
   * @returns the accepted message id.
   */
  private admitWaking(
    activation: Activation,
    messageId: MessageId,
    send: () => void,
  ): MessageId {
    // `Agent.followup()` publishes inbox events synchronously, so observers must
    // see this Activation as busy before the call begins.
    activation.accepted.add(messageId)
    try {
      send()
    } catch (error: unknown) {
      activation.accepted.delete(messageId)
      throw error
    }
    // Accepted waking work keeps this Activation live until whenIdle() observes
    // the complete waking suffix.
    this.wake(activation)
    return messageId
  }

  /**
   * Cross the final admission cutoff and submit without yielding. Signal abort,
   * manager drain, or Activation disposal that wins before this synchronous
   * span rejects without inbox acceptance.
   */
  private submitAdmitted(
    activation: Activation,
    content: ContentBlock[],
    source: MessageSource,
    parent: Agent,
    signal: AbortSignal,
  ): MessageId {
    signal.throwIfAborted()
    this.assertAdmitting(parent)
    /* v8 ignore next 6 -- only a synchronous re-entrant disposer can change
     * this field between the caller's live check and this no-await boundary. */
    if (disposalOf(activation) !== undefined) {
      throw new SubagentError(
        `subagent "${activation.childId}" activation is being disposed; the message was not accepted`,
        'ACTIVATION_CLOSING',
      )
    }
    this.authorizeLineage(
      parent,
      activation.childId,
      activation.handle.agent.session.header.parentSession,
    )
    return this.submit(activation, content, source, parent)
  }

  /**
   * Authorize one operation against the durable direct-parent lineage. Other
   * agents, ancestors, teams, workflows, and hosts remain rejected until an
   * explicit authority protocol has a production consumer.
   */
  private authorizeLineage(
    parent: Agent,
    childId: SessionId,
    parentSession: SessionId | undefined,
  ): void {
    if (this.ctx.agents.get(parent.id) !== parent) {
      throw new SubagentError(
        `subagent "${childId}" delivery requires the exact live parent agent`,
        'UNAUTHORIZED',
      )
    }
    if (parentSession !== parent.id) {
      throw new SubagentError(`subagent "${childId}" belongs to another parent session`, 'UNAUTHORIZED')
    }
  }

  /**
   * Follow one Activation to settlement: wait for Agent quiescence, then for
   * every owned child to complete disposal, and dispose the handle once both
   * hold. A `next-turn` delivered while `waiting` wakes the same Agent and
   * returns it to `running`, so this re-observes rather than settling early.
   */
  private watchSettlement(activation: Activation): void {
    void (async () => {
      while (disposalOf(activation) === undefined) {
        const poked = activation.poke.promise
        await Promise.race([activation.handle.agent.whenIdle(), poked])
        if (disposalOf(activation) !== undefined) return
        // Re-check settlement INSIDE the child lock and begin disposal in the
        // same critical section, so a concurrent delivery either wins admission
        // before the transaction opens or waits for release and cold-resumes.
        // Deciding outside the lock would let a delivery observe a not-yet
        // resident handle that this watcher is already about to tear down.
        const settling = await this.locks.run<SettlementAttempt>(activation.childId, () => {
          if (disposalOf(activation) !== undefined || this.stateOf(activation) !== 'settled') {
            return Promise.resolve({ settling: false })
          }
          // `dispose()` assigns its memoized transaction synchronously, so
          // admission is closed before this critical section releases.
          return Promise.resolve({ settling: true, done: this.dispose(activation) })
        })
        if (!settling.settling) {
          // Still running, or waiting on descendants: re-observe after the next
          // accepted message or ownership release.
          if (activation.handle.agent.status !== 'running') await poked
          continue
        }
        try {
          await settling.done
        } catch (error: unknown) {
          this.ctx.logger.warn(
            `subagent "${activation.childId}" activation teardown failed: ${errorChain(error)}`,
          )
        }
        return
      }
    })()
  }

  /**
   * Stop one Activation immediately, then release it child-first. The memoized
   * transaction is installed before cancellation or recursive callbacks, so
   * admission and reentrant teardown converge on the same owner.
   *
   * The final session flush is best effort and never prevents handle disposal
   * or ownership release, because retaining a child would permanently pin its
   * ancestors in `waiting`.
   * @param activation - the residency epoch to stop and release.
   * @returns the one disposal transaction owned by this Activation.
   */
  private dispose(activation: Activation): Promise<void> {
    const existing = activation.disposal
    if (existing !== undefined) return existing
    const completion = Promise.withResolvers<void>()
    // Presence is the admission cutoff. Assign it before the async helper starts
    // because that helper cancels Agents and may synchronously re-enter callers.
    activation.disposal = completion.promise
    void this.finishDisposal(activation).then(completion.resolve, completion.reject)
    return completion.promise
  }

  /**
   * Propagate stop synchronously, then finish the child-first release.
   * @param activation - the Activation whose disposal transaction is installed.
   * @returns once the handle and ownership edge are released.
   */
  private async finishDisposal(activation: Activation): Promise<void> {
    this.wake(activation)
    const { childId } = activation
    // Stop top-down before the first await. Slow descendant cleanup may delay
    // release, but it cannot let this ancestor continue model or tool work.
    activation.handle.agent.cancel({ kind: 'parent' })
    const idle = activation.handle.agent.whenIdle()
    const children = [...activation.ownedChildren]
      .map(child => this.activations.get(child))
      .filter((child): child is Activation => child !== undefined)
    const childDisposals = children.map(child => this.dispose(child))

    const failures: SubagentError[] = []
    try {
      // Release remains child-first even though cancellation propagated
      // top-down: every owned child completes before this handle is removed.
      const childFailures = await Promise.all(childDisposals.map(async (disposal) => {
        try {
          await disposal
          return undefined
        } catch (error: unknown) {
          return error
        }
      }))
      const reasons = childFailures.filter(reason => reason !== undefined)
      if (reasons.length > 0) {
        failures.push(new SubagentError(
          `subagent "${childId}" child teardown failed: ${reasons.map(reason => errorChain(reason)).join('; ')}`,
          'ACTIVATION_TEARDOWN_FAILED',
        ))
      }
      // Quiesce before the flush: a turn still running would keep
      // appending events the flush cannot cover.
      await idle
      await this.flushFinalState(activation)
      // Capture the child-dependent edge data while the child is still live:
      // handle disposal unregisters it, and consumers read its log and scope.
      activation.observer.capture(activation.handle.agent)
    } catch (error: unknown) {
      failures.push(new SubagentError(
        `subagent "${childId}" activation teardown failed: ${errorChain(error)}`,
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: error },
      ))
    }
    try {
      await activation.handle.dispose()
    } catch (error: unknown) {
      failures.push(new SubagentError(
        `subagent "${childId}" activation handle disposal failed: ${errorChain(error)}`,
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: error },
      ))
    }

    let failure: SubagentError | undefined
    if (failures.length === 1) {
      failure = failures[0]
    } else if (failures.length > 1) {
      failure = new SubagentError(
        `subagent "${childId}" activation teardown failed at ${failures.length} boundaries: `
        + failures.map(item => errorChain(item)).join('; '),
        'ACTIVATION_TEARDOWN_FAILED',
        { cause: new AggregateError(failures) },
      )
    }
    // Only now is the Activation gone: keeping the entry until disposal settles
    // makes a racing delivery wait for release rather than cold-resume into the
    // still-registered agent.
    this.activations.delete(childId)
    // BEFORE releasing ownership, while the parent still counts this child and
    // therefore cannot be judged settled. Delivering after the release would
    // race a parent watcher that resumes one microtask later, finds itself
    // childless and quiet, and disposes an Agent whose `cancel()` clears the
    // inbox this notice is sitting in.
    this.notifySettlement(activation, activation.observer.terminal(failure))
    // Release ownership even on failure: a retained failed child would pin its
    // ancestors in `waiting` forever.
    this.releaseOwnership(childId)
    // Emit once the disposal outcome is known, so a rejecting scoped cleanup
    // cannot be reported as a successful epoch.
    activation.observer.settle(failure)
    if (failure !== undefined) throw failure
  }

  /**
   * Tell the durable direct parent that this child produced everything it is
   * going to. Unconditional for every child the caller received an id for: it
   * does not consider whether the child reported, because the cases that most
   * need it — a token ceiling, a model failure, cancellation, teardown — are
   * exactly the ones where the child never got to choose. A materialization
   * rolled back before its first acceptance stays silent, since the caller was
   * told that child was not established. A parent that is no longer live is not
   * an error; the child's own Session remains the durable record either way.
   * A parent whose own lineage is already closing receives the notice without a
   * wake, because teardown is not a reason to start a turn.
   *
   * Never blocks disposal. A delivery failure is logged and dropped, because
   * retaining a child to retry a notice would pin its whole ancestry in
   * `waiting` forever.
   * @param activation - the settling Activation, still owned by its parent.
   * @param terminal - how this epoch ended, as the terminal edge will report it.
   */
  private notifySettlement(activation: Activation, terminal: ActivationTerminal): void {
    if (!activation.announced) return
    try {
      const parent = this.ctx.agents.get(activation.parentSession)
      if (parent === undefined) return
      const summary = settlementSummary(activation.childId, terminal.stopReason)
      const message = createUserMessage({
        content: [
          { type: 'text' as const, text: summary },
          ...terminal.output === undefined
            ? [{ type: 'text' as const, text: 'It left no closing message.' }]
            : [{ type: 'text' as const, text: 'Its closing message:' }, ...terminal.output],
        ],
        source: {
          kind: 'subagent-settled' as const,
          form: 'notice' as const,
          summary: boundContextSummary(summary),
          senderSessionId: activation.childId,
        },
      })
      // A parent whose own teardown already began must not be woken. Waking is
      // not a queue operation: `followup()` on a quiescent Agent starts a turn,
      // and `cancel()` does not arm against a later one, so a notice arriving
      // during teardown would spend a model request on an Agent its host is
      // about to dispose — once per tree layer, since each layer's own notice
      // then wakes the layer above it. Injecting delivers to a parent still
      // reading its inbox and records the account in the log either way; it
      // does NOT survive that parent's own disposal, whose `keepInbox: false`
      // cancel durably clears whatever it never claimed.
      if (this.closingTeardownFor(parent) !== undefined) {
        parent.inject(message)
        return
      }
      // An idle parent has nothing else to look at, so it gets one ordinary
      // turn. A busy parent is steered instead of woken: `Inbox.claim()` takes
      // the whole next-step batch at one boundary, so several children settling
      // together cost one step rather than one turn each. Steering rather than
      // injecting closes the window where a driver retires between this status
      // read and the send, which would strand the notice unclaimed.
      this.sendWaking(parent, message, () => {
        if (parent.status === 'idle') parent.followup(message)
        else parent.steer(message)
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" settlement notice was not delivered to its parent: `
        + errorChain(error),
      )
    }
  }

  /**
   * Request a best-effort final session flush after the child is quiescent.
   * Listener failure is logged because flush participation cannot identify a
   * particular persistence backend, and teardown must still release ownership.
   * @param activation - the Activation whose final events should be flushed.
   */
  private async flushFinalState(activation: Activation): Promise<void> {
    const child = activation.handle.agent
    try {
      await child.ctx.sessions.flush(child.session)
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `subagent "${activation.childId}" best-effort final session flush failed; `
        + `the persisted state may be unavailable or stale on resume: ${errorChain(error)}`,
      )
    }
  }

  /** Resolve the persistence service continuable children require, or fail loud. */
  private requirePersistence(): SessionPersistence {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) {
      throw new SubagentError(
        'continuable subagents require session persistence (load a ea-session-persistence backend)',
        'PERSISTENCE_UNAVAILABLE',
      )
    }
    return persistence
  }
}

export type { SubagentDescriptorData }

export default SubagentContinuationManager

import type { Context } from '@ejunz/cordis'

import type { Session, SessionEvent, SessionHeader, SessionId } from '@ejunz/ea/session'

import type { SessionPersistence } from '@ejunz/ea/session-persistence'

import type { SessionProjectionRegistry } from '@ejunz/ea/session-projection'

import type { SessionProjectionCache } from '@ejunz/ea/session-projection-cache'

const COLD_READ_CONCURRENCY = 4

export type SubagentListEntry =
  | {
    readonly kind: 'child'
    /** The durable child session id, stable across Activations. */
    readonly id: SessionId
    /**
     * Store snapshot activity: `running` means the logical record is live in
     * `ctx.sessions`; `inactive` means it exists only in persistence. Neither
     * encodes a durable outcome, and a continuable child may still reject
     * delivery as an ownership conflict.
     */
    readonly activity: 'running' | 'inactive'
    /** Whether a direct descendant has durable `origin: 'subagent'`. */
    readonly hasChildren: boolean
  } & (
    | {
      /** A terminal one-shot child. */
      readonly mode: 'one-shot'
      /** Optional durable creation label from the child's descriptor. */
      readonly label?: string
    }
    | {
      /** A resumable conversation. */
      readonly mode: 'continuable'
      /** Durable creation label from the child's descriptor. */
      readonly label: string
    }
  )
  | {
    readonly kind: 'diagnostic'
    /** The candidate's session id. */
    readonly id: SessionId
    /**
     * Why the candidate has no `child` row: `corrupt` for a settled candidate
     * whose projection fold served no identity (a missing, malformed, or
     * unrecognized-version descriptor — deliberately undistinguished), and
     * for any candidate whose log makes a registered unit's fold or schema
     * throw (deterministic data damage, contained per child); `unavailable`
     * when the candidate's persistence inspection failed (retried on the
     * next listing). `unsupported` is never produced; it remains in the
     * union for consumers that route on it.
     */
    readonly reason: 'corrupt' | 'unsupported' | 'unavailable'
  }

export type SubagentDescendantListEntry = SubagentListEntry & {
  /** Durable direct parent of this candidate in the enumerated tree. */
  readonly parentId: SessionId
  /** Edge distance from the requested root; direct children are `1`. */
  readonly depth: number
}

type CorpusRecord = { readonly header: SessionHeader; readonly live: Session | undefined }

interface ListingRuntime {
  readonly projections: SessionProjectionRegistry
  readonly persistence: SessionPersistence | undefined
  readonly cache: SessionProjectionCache | undefined
  readonly corpus: ReadonlyMap<SessionId, CorpusRecord>
  readonly subagentParents: ReadonlySet<SessionId>
}

interface PositionedCandidate {
  readonly record: CorpusRecord
  readonly parentId: SessionId
  readonly depth: number
}

export async function listChildren(
  ctx: Context,
  parentSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentListEntry[]> {
  const listing = await prepareListing(ctx, signal)
  const candidates = [...listing.corpus.values()]
    .filter(record => record.header.parentSession === parentSessionId
      && record.header.origin === 'subagent')
    .sort(compareCorpusRecords)
  const rows = await resolveCandidateRows(candidates, listing, signal)
  return rows.filter((row): row is SubagentListEntry => row !== undefined)
}

export async function listDescendants(
  ctx: Context,
  rootSessionId: SessionId,
  signal?: AbortSignal,
): Promise<SubagentDescendantListEntry[]> {
  const listing = await prepareListing(ctx, signal)
  const positioned = descendantCandidates(listing.corpus, rootSessionId)
  const rows = await resolveCandidateRows(
    positioned.map(candidate => candidate.record),
    listing,
    signal,
  )
  const entries: SubagentDescendantListEntry[] = []
  positioned.forEach((position, index) => {
    const row = rows[index]
    if (row !== undefined) {
      entries.push({ ...row, parentId: position.parentId, depth: position.depth })
    }
  })
  return entries
}

async function prepareListing(
  ctx: Context,
  signal: AbortSignal | undefined,
): Promise<ListingRuntime> {
  const projections = ctx.get('sessionProjections')
  // Checked before any read, even with zero candidates: mode/label are the
  // row's strong contract, so a missing fold capability is a deterministic
  // deployment configuration error, never an empty success.
  if (projections === undefined) {
    throw new SubagentError(
      'listing subagents requires the sessionProjections registry (load @ejunz/ea/session-projection)',
      'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
    )
  }
  // Strict global read, never the `ctx.sessions` property proxy: the proxy is
  // caller-scope bound, so a consumer plugin without its own `sessions`
  // injection (the model-facing tool, the API proxy) would throw on access.
  const sessions = ctx.get('sessions')
  if (sessions === undefined) {
    throw new SubagentError(
      'listing subagents requires the session store (load @ejunz/ea/session)',
      'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE',
    )
  }
  assertListingNotCancelled(signal)
  const persistence = ctx.get('sessionPersistence')
  // Optional acceleration only: an absent cache service just means every
  // cold candidate takes the authoritative preparation rung, so it carries
  // no error code and no configuration check.
  const cache = ctx.get('sessionProjectionCache')
  let persistedHeaders: readonly SessionHeader[] = []
  if (persistence !== undefined) {
    try {
      persistedHeaders = await persistence.list(signal)
    } catch (error: unknown) {
      // The backend may reject with its own abort failure after observing the
      // forwarded signal; cancellation stays a stable subagent failure.
      assertListingNotCancelled(signal)
      throw error
    }
    assertListingNotCancelled(signal)
  }
  // Live-preferred merge without header reconciliation: a live record wins
  // its id wholesale, exactly as a live-preferred corpus would serve it.
  const corpus = new Map<SessionId, CorpusRecord>()
  for (const header of persistedHeaders) corpus.set(header.id, { header, live: undefined })
  for (const session of sessions.list()) {
    corpus.set(session.header.id, { header: session.header, live: session })
  }
  const subagentParents = new Set<SessionId>()
  for (const record of corpus.values()) {
    if (record.header.origin === 'subagent' && record.header.parentSession !== undefined) {
      subagentParents.add(record.header.parentSession)
    }
  }
  return { projections, persistence, cache, corpus, subagentParents }
}

async function resolveCandidateRows(
  candidates: readonly CorpusRecord[],
  listing: ListingRuntime,
  signal: AbortSignal | undefined,
): Promise<(SubagentListEntry | undefined)[]> {
  const { projections, persistence, cache, subagentParents } = listing
  const rows: (SubagentListEntry | undefined)[] = Array.from({ length: candidates.length })
  const coldReads: { index: number; header: SessionHeader }[] = []
  candidates.forEach((candidate, index) => {
    const childId = candidate.header.id
    if (candidate.live === undefined) {
      coldReads.push({ index, header: candidate.header })
      return
    }
    // The registry's watermark cache serves the live value with zero log
    // reads; a live child without an identity yet is the creation window
    // before the establishing provider appends its descriptor.
    let identity: SubagentIdentityProjection | null | undefined
    try {
      identity = projections.snapshot(candidate.live).values.subagent
    } catch {
      // The snapshot folds EVERY registered unit over this child's log, so
      // any unit's fold or schema can reject damaged payloads. That is
      // deterministic data damage in this one child; it degrades to one
      // corrupt diagnostic instead of failing the whole listing.
      rows[index] = { kind: 'diagnostic', id: childId, reason: 'corrupt' }
      return
    }
    // The unit's serializable no-value sentinel is `null`; `undefined` can
    // only mean the key was dropped at a JSON boundary. Both are no value.
    if (identity === undefined || identity === null) return
    rows[index] = childRow(childId, identity, 'running', subagentParents.has(childId))
  })

  // Cold candidates exist only when persistence listed them, so the narrow
  // re-check is about types, not reachability.
  if (persistence !== undefined && coldReads.length > 0) {
    const queue = [...coldReads]
    await Promise.all(Array.from(
      { length: Math.min(COLD_READ_CONCURRENCY, queue.length) },
      async () => {
        for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
          rows[job.index] = await resolveColdIdentity(
            persistence, projections, cache, job.header,
            subagentParents.has(job.header.id), signal,
          )
        }
      },
    ))
  }
  assertListingNotCancelled(signal)
  return rows
}

function descendantCandidates(
  corpus: ReadonlyMap<SessionId, CorpusRecord>,
  rootSessionId: SessionId,
): PositionedCandidate[] {
  const children = new Map<SessionId, CorpusRecord[]>()
  for (const record of corpus.values()) {
    const parentId = record.header.parentSession
    if (parentId === undefined) continue
    const siblings = children.get(parentId)
    if (siblings === undefined) children.set(parentId, [record])
    else siblings.push(record)
  }
  for (const siblings of children.values()) siblings.sort(compareCorpusRecords)

  const positioned: PositionedCandidate[] = []
  const stack: PositionedCandidate[] = (children.get(rootSessionId) ?? [])
    .map(record => ({ record, parentId: rootSessionId, depth: 1 }))
    .reverse()
  const visited = new Set<SessionId>([rootSessionId])
  while (stack.length > 0) {
    // The length guard proves one frame exists.
    // oxlint-disable-next-line typescript/no-non-null-assertion
    const position = stack.pop()!
    const id = position.record.header.id
    if (visited.has(id)) continue
    visited.add(id)
    if (position.record.header.origin === 'subagent') positioned.push(position)
    const descendants = children.get(id) ?? []
    for (const record of [...descendants].reverse()) {
      stack.push({ record, parentId: id, depth: position.depth + 1 })
    }
  }
  return positioned
}

function compareCorpusRecords(a: CorpusRecord, b: CorpusRecord): number {
  return a.header.createdAt - b.header.createdAt || a.header.id.localeCompare(b.header.id)
}

async function resolveColdIdentity(
  persistence: SessionPersistence,
  projections: SessionProjectionRegistry,
  cache: SessionProjectionCache | undefined,
  header: SessionHeader,
  hasChildren: boolean,
  signal: AbortSignal | undefined,
): Promise<SubagentListEntry> {
  const childId = header.id
  if (cache !== undefined) {
    let cached: SubagentIdentityProjection | null | undefined
    try {
      cached = cache.cachedSnapshot(header)?.values.subagent
    } catch {
      // Unlike the preparation fold below, a throwing cache read renders no
      // verdict: the cache is derived data, so its damage (a poisoned stored
      // row of ANY unit) silently falls through to the authoritative re-fold.
      cached = undefined
    }
    // A child's OWN descriptor is immutable once appended, so a cached
    // identity is final only when the seq gate proves it was folded from the
    // own suffix: a creation-window checkpoint may instead carry a fork
    // seed's replayed ANCESTOR descriptor (seq below `seedLength`), which
    // must not outrank the re-fold. Everything else also falls through to
    // preparation: an absent key (a cut before any descriptor) and the
    // `null` sentinel, whose verdict belongs to the authoritative re-fold,
    // not to a derived row.
    if (cached !== undefined && cached !== null && cached.seq >= (header.seedLength ?? 0)) {
      return childRow(childId, cached, 'inactive', hasChildren)
    }
  }
  assertListingNotCancelled(signal)
  let inspected: { meta: SessionHeader; events: readonly SessionEvent[] }
  try {
    inspected = await persistence.inspect(childId, signal)
  } catch {
    // Per-child isolation: the child vanished or its backend read failed —
    // one diagnostic row, and the listing itself still succeeds.
    assertListingNotCancelled(signal)
    return { kind: 'diagnostic', id: childId, reason: 'unavailable' }
  }
  assertListingNotCancelled(signal)
  // A session id names a slot, not a lifecycle: a child deleted and
  // re-published under another owner between the enumeration and this read
  // must not leak into the old parent's listing.
  if (!sameLifecycle(inspected.meta, header)) {
    return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
  }
  let identity: SubagentIdentityProjection | null | undefined
  try {
    identity = projections.restore({}, inspected.events, 0).snapshot.values.subagent
  } catch {
    // The restore folds EVERY registered unit over this child's log, so any
    // unit's fold or schema can reject damaged payloads — deterministic data
    // damage in this one child, contained as its own corrupt diagnostic.
    return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
  }
  if (identity === undefined || identity === null) {
    return { kind: 'diagnostic', id: childId, reason: 'corrupt' }
  }
  return childRow(childId, identity, 'inactive', hasChildren)
}

function childRow(
  id: SessionId,
  identity: SubagentIdentityProjection,
  activity: 'running' | 'inactive',
  hasChildren: boolean,
): SubagentListEntry {
  return identity.mode === 'one-shot'
    ? {
      kind: 'child',
      id,
      mode: 'one-shot',
      ...identity.label !== undefined ? { label: identity.label } : {},
      activity,
      hasChildren,
    }
    : {
      kind: 'child',
      id,
      mode: 'continuable',
      label: identity.label,
      activity,
      hasChildren,
    }
}

const LIFECYCLE_WITNESS_KEYS = [
  'version', 'id', 'createdAt', 'cwd', 'parentSession', 'seedLength', 'delegationDepth',
] as const

function sameLifecycle(meta: SessionHeader, expected: SessionHeader): boolean {
  return LIFECYCLE_WITNESS_KEYS.every(key => meta[key] === expected[key])
}

function assertListingNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new SubagentError('subagent listing was cancelled', 'CANCELLED')
  }
}

import { z } from 'zod'

import type { ProjectionDefinition } from '@ejunz/ea/session-projection'

import type { SessionEvent } from '@ejunz/ea/session'

interface TimingState {
  /** Milliseconds accumulated across completed post-descriptor turns. */
  settledMs: number
  /** Current open interval kept paired inside the fold. */
  active?: { since: number; through: number }
  /** Latest pre-descriptor turn start, promoted when the child's own descriptor arrives. */
  pendingTurnStart?: number
  /** Whether the fold has crossed a descriptor in this logical log. */
  descriptorSeen: boolean
}

const projectionSchema = z.object({
  settledMs: z.number().int().nonnegative(),
  active: z.object({
    since: z.number().int().nonnegative(),
    through: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict() as unknown as z.ZodType<SubagentTimingProjection>

export const subagentTimingProjectionDefinition:
ProjectionDefinition<'subagentTiming', TimingState> = {
  key: 'subagentTiming',
  schema: projectionSchema,
  init: () => ({ descriptorSeen: false, settledMs: 0 }),
  apply: (state, event) => {
    if (event.type === 'turn/start') {
      return state.descriptorSeen
        ? { ...state, active: { since: event.time, through: event.time } }
        : { ...state, pendingTurnStart: event.time }
    }
    if (event.type === 'subagent/descriptor') {
      const activeSince = state.active?.since ?? state.pendingTurnStart
      return {
        descriptorSeen: true,
        settledMs: 0,
        ...(activeSince === undefined
          ? {}
          : { active: { since: activeSince, through: event.time } }),
      }
    }
    if (event.type === 'turn/end') {
      if (!state.descriptorSeen) {
        if (state.pendingTurnStart === undefined) return state
        const { pendingTurnStart: _closed, ...next } = state
        return next
      }
      if (state.active === undefined) return state
      const { active, ...rest } = state
      return {
        ...rest,
        settledMs: state.settledMs + Math.max(0, event.time - active.since),
      }
    }
    if (state.active === undefined) return state
    return { ...state, active: { ...state.active, through: event.time } }
  },
  view: state => ({
    settledMs: state.settledMs,
    ...(state.active === undefined ? {} : { active: state.active }),
  }),
  stateVersion: 2,
}

interface IdentityState {
  /** Identity from the last valid descriptor; absent before one, and after an invalid one. */
  identity?: SubagentIdentityProjection
}

const identitySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('one-shot'),
    label: z.string().optional(),
    seq: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    mode: z.literal('continuable'),
    label: z.string(),
    seq: z.number().int().nonnegative(),
  }).strict(),
]).nullable() as unknown as z.ZodType<SubagentIdentityProjection | null>

function descriptorIdentity(event: SessionEvent): SubagentIdentityProjection | undefined {
  let descriptor: SubagentDescriptorData | undefined
  try {
    descriptor = foldSubagentDescriptor([event])
  } catch {
    // Only a malformed current-version payload throws in descriptor parsing;
    // a projection fold must never throw, so damage folds to no value.
    descriptor = undefined
  }
  if (descriptor === undefined) return undefined
  return descriptor.mode === 'one-shot'
    ? {
      mode: 'one-shot',
      ...descriptor.label !== undefined ? { label: descriptor.label } : {},
      seq: event.seq,
    }
    : { mode: 'continuable', label: descriptor.label, seq: event.seq }
}

export const subagentIdentityProjectionDefinition:
ProjectionDefinition<'subagent', IdentityState> = {
  key: 'subagent',
  schema: identitySchema,
  init: () => ({}),
  apply: (state, event) => {
    if (event.type !== 'subagent/descriptor') return state
    const identity = descriptorIdentity(event)
    return identity === undefined ? {} : { identity }
  },
  view: state => state.identity ?? null,
  // Bumped when the identity gained its `seq` field: an older checkpoint row
  // would replay into a value the schema rejects, so it must refold instead.
  stateVersion: 2,
}

import { accessSync, constants, statSync } from 'node:fs'

import { isAbsolute, resolve } from 'node:path'

import type { ContentBlock } from '@ejunz/ea/llm'

export const NO_START_CAPABILITIES: SubagentCapabilities = Object.freeze({
  outputSchema: false,
  depthLimit: false,
  toolFilter: false,
  persona: false,
})

export function assertPositiveFinite(prefix: string, name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${prefix}: ${name} must be a positive finite number`)
  }
}

function isEnterableDirectory(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    // statSync/accessSync throw only filesystem access errors here
    // (ENOENT/EACCES/ENOTDIR/…), and every one of them means the path cannot
    // serve as the child's cwd.
    return false
  }
}

export function assertUsableCwd(prefix: string, label: string, cwd: string): string {
  if (!isAbsolute(cwd)) {
    throw new Error(`${prefix}: ${label} must be an absolute path: ${cwd}`)
  }
  if (!isEnterableDirectory(cwd)) {
    throw new Error(`${prefix}: ${label} is not an accessible directory: ${cwd}`)
  }
  return cwd
}

export function validateConfiguredCwd(prefix: string, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  if (cwd === '') {
    throw new Error(`${prefix}: config cwd must not be empty — omit the key to inherit the parent session cwd`)
  }
  return assertUsableCwd(prefix, 'config cwd', resolve(cwd))
}

export function resolveChildCwd(prefix: string, configured: string | undefined, parentCwd: string | undefined): string {
  if (configured !== undefined) return configured
  if (parentCwd === undefined) {
    throw new Error(`${prefix}: no working directory for the child — configure \`cwd\` or delegate from a parent session that has one`)
  }
  return assertUsableCwd(prefix, 'parent session cwd', parentCwd)
}

function toError(value: unknown): Error {
  // The rejecting surfaces (wire clients, spawn failures) only throw
  // `Error`s; the `String(value)` arm is a defensive fallback for a non-Error
  // throw the typed surfaces cannot produce.
  /* v8 ignore next */
  return value instanceof Error ? value : new Error(String(value))
}

export interface RunResultSettlement {
  /** The turn attempt (typically racing local cancellation); returns the terminal result. */
  attempt: () => Promise<SubagentResult>
  /** Snapshot the provider exposes when cancellation or failure wins settlement. */
  collectOutput: () => ContentBlock[]
  /** Whether local cancellation settled before the attempt's outcome is observed. */
  cancelled: () => boolean
  /** Diagnostic sink for a failure flattened to a stop reason; a throw from it is contained. */
  onError?: ((error: Error, stopReason: SubagentStopReason) => void) | undefined
  /** The request's cancellation signal (the listener is removed at settlement). */
  signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  onAbort: () => void
}

export async function settleRunResult(parts: RunResultSettlement): Promise<SubagentResult> {
  try {
    const result = await parts.attempt()
    return parts.cancelled()
      ? { output: parts.collectOutput(), stopReason: 'aborted' }
      : result
  } catch (error: unknown) {
    // Cover a rejection already queued when cancellation arrives.
    if (parts.cancelled()) return { output: parts.collectOutput(), stopReason: 'aborted' }
    // Flatten post-publication transport failures while preserving diagnostics.
    try {
      parts.onError?.(toError(error), 'error')
    } catch {
      // The diagnostic sink cannot reject the run result.
    }
    return { output: parts.collectOutput(), stopReason: 'error' }
  } finally {
    parts.signal.removeEventListener('abort', parts.onAbort)
  }
}

export interface SubprocessRunHandleParts {
  /** The parent-scoped run id. */
  id: SubagentRun['id']
  /** The flattened, never-rejecting result (the seam contract). */
  result: Promise<SubagentResult>
  /** The request's cancellation signal (the listener is removed on dispose). */
  signal: AbortSignal
  /** The abort listener registered on {@link signal} at start. */
  onAbort: () => void
  /** Settle local cancellation so {@link result} resolves without the child. */
  requestCancel: () => void
  /** Tear the child process down to quiescence (backend-owned ladder). */
  teardown: () => Promise<void>
}

export function subprocessRunHandle(parts: SubprocessRunHandleParts): SubagentRun {
  let disposal: Promise<void> | undefined
  return {
    id: parts.id,
    localAgent: undefined,
    result: parts.result,
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      parts.signal.removeEventListener('abort', parts.onAbort)
      parts.requestCancel()
      disposal = parts.teardown()
      return disposal
    },
  }
}

import type { ContentBlock } from '@ejunz/ea/llm'

import type { JobOutcome } from '@ejunz/ea/jobs'

function finalText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function runOutcome(result: SubagentResult): JobOutcome {
  switch (result.stopReason) {
    case 'completed':
      return { status: 'completed', output: finalText(result.output) }
    case 'aborted':
      return { status: 'killed' }
    case 'error':
    case 'max-tokens':
    case 'refusal':
      return { status: 'failed', detail: result.stopReason }
    // Merge-extensible reasons remain failures with their raw detail.
    default:
      return { status: 'failed', detail: String(result.stopReason) }
  }
}

export async function settleRun(run: SubagentRun): Promise<JobOutcome> {
  let outcome: JobOutcome
  try {
    outcome = runOutcome(await run.result)
  } catch (error: unknown) {
    outcome = { status: 'failed', detail: String(error) }
  }
  try {
    await run.dispose()
  } catch (error: unknown) {
    const prefix = outcome.detail === undefined ? '' : `${outcome.detail}; `
    return { status: 'failed', detail: `${prefix}dispose failed: ${String(error)}` }
  }
  return outcome
}

import { Context, Service } from '@ejunz/cordis'

import { scopeTarget } from '@ejunz/ea/scope'

import type { Scoped } from '@ejunz/ea/scope'

import { assertObjectJsonSchema } from '@ejunz/ea/tools'

import type { ContentBlock, MessageId } from '@ejunz/ea/llm'

import type { Agent } from '@ejunz/ea/agent'

import type { SessionId } from '@ejunz/ea/session'

declare module '@ejunz/cordis' {
  interface Context {
    subagents: SubagentRuntime
  }

  interface Events {
    /**
     * A provider became resolvable in the registry.
     * @param provider - the registered provider.
     * @mode emit
     */
    'subagent/provider-added'(provider: SubagentProvider): void
    /**
     * A provider left the registry. Accepted runs remain holder-owned.
     * @param name - the provider name that no longer resolves.
     * @mode emit
     */
    'subagent/provider-removed'(name: string): void
    /**
     * A provider established a published child. For in-process providers,
     * `ctx.agents.get(info.id)` resolves during this notification.
     * Scope-filtered dispatch keys the carrier by the delegating parent, so a
     * parent-scoped listener observes only its own delegations. Paired with
     * `subagent/end`.
     * @param info - the provider and published child identity.
     * @eaScopeScan unsupported
     * @mode emit
     */
    'subagent/start'(this: Scoped<SubagentRuntime>, info: SubagentRunInfo): void
    /**
     * A published child settled. Scope-filtered dispatch uses the same delegating
     * parent carrier as `subagent/start`, so the lifecycle pair reaches the
     * same scoped audience.
     * @param info - the run identity and terminal outcome.
     * @eaScopeScan unsupported
     * @mode emit
     */
    'subagent/end'(this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo): void
  }
}

export class SubagentRuntime extends Service {
  private providers = new Map<string, SubagentProvider>()
  private continuations: SubagentContinuationManager | undefined
  /** Deployment contributions composed into unpublished continuable children. */
  private readonly setupRegistry = new SubagentActivationSetupRegistry()
  /**
   * The contained lifecycle-edge publisher. Built here because scoped dispatch
   * keys its carrier by this exact service instance, whose own context filter
   * composes into the carrier.
   */
  private readonly emitLifecycle: LifecycleEmitter

  constructor(ctx: Context) {
    super(ctx, 'subagents')
    this.emitLifecycle = createLifecycleEmitter(this.ctx, parent => scopeTarget(this, parent))
    ctx.inject(['agents'], (childCtx: Context) => {
      const manager = new SubagentContinuationManager(childCtx, {
        prepareContinuable: (name, request) => this.prepareContinuable(name, request),
        observeActivation: (provider, childId, parent) => this.observeActivation(provider, childId, parent),
      }, this.setupRegistry)
      this.continuations = manager
      childCtx.effect(() => () => {
        /* v8 ignore else -- one injected binding owns the slot until its fiber disposes. */
        if (this.continuations === manager) this.continuations = undefined
      }, 'subagents.continuationBinding()')
    })
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register(subagentTimingProjectionDefinition)
      projectionCtx.sessionProjections.register(subagentIdentityProjectionDefinition)
    })
  }

  /**
   * Establish one durable continuable child and deliver its initial prompt.
   * Resolves when the child's inbox accepts that prompt, without waiting for the
   * turn to start or for the message to reach the Session log; any earlier
   * failure rejects with no ids and rolls back the child entirely.
   * @param spec - provider, delegation request, and caller cancellation.
   * @returns the durable child id and the accepted prompt's message id.
   * @throws when continuation services are unavailable or materialization fails.
   */
  async startContinuable(spec: ContinuableStartSpec): Promise<ContinuableStart> {
    return this.requireContinuations().startContinuable(spec)
  }

  /**
   * Deliver one later message to a continuable child as its next FIFO turn. A
   * resident child's Agent inbox accepts it directly (waking a `waiting`
   * Activation), while an absent one is cold-resumed from its persisted
   * Session. The Agent inbox is the only queue, so every accepted message has
   * one observable order.
   * @param parent - the exact live direct parent authorizing this delivery.
   * @param childId - durable child session id.
   * @param content - user-role content to deliver.
   * @param options - the message source fields and caller cancellation, which stops the
   *   operation only before inbox acceptance.
   * @returns the accepted message's inbox id.
   * @throws when continuation services are unavailable, parent authority is
   *   rejected, or the message was not admitted.
   */
  async followup(
    parent: Agent,
    childId: SessionId,
    content: ContentBlock[],
    options: SubagentFollowupOptions,
  ): Promise<MessageId> {
    return this.requireContinuations().followup(parent, childId, content, options)
  }

  /**
   * Interrupt one live continuable child's current turn under a human parent
   * address or an exact live ancestor Agent. Fire-and-return: the cancel
   * signal is issued before this returns, but the target may keep running
   * until it observes the signal. Unclaimed pending inbox work, the Activation,
   * and published descendants are preserved; claimed work is not requeued.
   * Once the interrupted driver is idle, a waking send resumes the parked FIFO
   * queue. An absent target — including a one-shot or unknown id —
   * is an accepted no-op, as is a manager-less composition, which cannot own a
   * live Activation.
   * @param targetSessionId - the durable child session id to interrupt.
   * @param authority - the human parent address or exact live ancestor Agent.
   * @throws {SubagentError} `UNAUTHORIZED` when the authority does not own the
   *   live target.
   */
  interrupt(targetSessionId: SessionId, authority: SubagentInterruptAuthority): void {
    this.continuations?.interrupt(targetSessionId, authority)
  }

  /**
   * Deliver selected content from one live continuable child to its durable
   * direct parent. The child is the authority credential; callers cannot name a
   * recipient. Reporting does not conclude the child's turn or Activation.
   * @param child - exact live reporting child.
   * @param content - selected model-facing content.
   * @param options - parent scheduling and pre-acceptance cancellation.
   * @returns the stable identity of the parent-accepted message.
   * @throws when continuation services are unavailable, sender authorization
   *   fails, or the direct parent is not live.
   */
  async reportFrom(
    child: Agent,
    content: ContentBlock[],
    options: SubagentReportOptions,
  ): Promise<MessageId> {
    return this.requireContinuations().reportFrom(child, content, options)
  }

  /**
   * Compose one deployment capability into every continuable child's
   * unpublished creation context on fresh creation and cold resume. Grants wait
   * for the next Activation; removing the contribution revokes every resident
   * installation immediately.
   * @param contribution - synchronous child-scope installer.
   * @returns the exact Cordis effect disposer.
   */
  registerContinuableSetup(contribution: ContinuableSetupContribution): () => void {
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(
      () => this.setupRegistry.register(contribution),
      'subagents.registerContinuableSetup()',
    )
  }

  /**
   * Close continuable admission below exact live parent Agents, stop only their
   * visible descendant Activations synchronously, then await admitted scoped
   * materializations and release those forests child-first. The scoped cutoff
   * lasts until each exact parent leaves the registry; unrelated parent trees
   * remain live.
   * @param parents - exact host-owned parent Agents entering teardown.
   * @returns once every retained descendant Activation released its `AgentHandle`.
   * @throws an aggregate error after all branches settle when any failed.
   */
  async drainContinuableDescendants(parents: readonly Agent[]): Promise<void> {
    const manager = this.continuations
    // Absent continuation services means nothing was ever materialized.
    if (manager === undefined) return
    await manager.drainDescendants(parents)
  }

  /**
   * Enumerate the parent's direct session-backed subagents without loading or
   * resuming an Agent and without any query service: the listing merges the live
   * session store with optional session persistence (live-preferred) and
   * serves each child's durable mode/label from the registered `subagent`
   * projection unit down a three-rung ladder — the registry's watermark
   * snapshot for a live child; for a cold one, a durable projection-cache
   * row when the optional cache serves an own-suffix identity (its `seq`
   * gate proves the value postdates the fork seed, where a child's own
   * descriptor is immutable once appended), else one persistence inspection
   * folded through the registry. The
   * projection fold is the single classification authority; per-child
   * diagnostics relay a fold that served no identity or a failed inspection,
   * never a list-time descriptor parse. Absent persistence, enumeration is
   * live-only (a cold child cannot be resumed then either, so its absence is
   * capability absence, not an error). This service consults no Agent
   * registrations, Activations, or providers.
   *
   * Every persistence read receives `signal`, and the listing rechecks
   * cancellation around each of those awaits. Read rejections that settle
   * after an abort become a stable `SubagentError` with code `CANCELLED`.
   * @param parentSessionId - parent session whose direct children are listed.
   * @param signal - caller-owned cancellation forwarded to persistence reads
   *   and observed around every read await.
   * @returns children and per-child diagnostics ordered by `createdAt`, then id.
   * @throws {@link SubagentError} when the projection registry or the session
   *   store is not mounted, or the caller cancels the listing.
   */
  listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentListEntry[]> {
    return listSubagentChildren(this.ctx, parentSessionId, signal)
  }

  /**
   * Enumerate the root's complete session-backed subagent tree in stable
   * pre-order from one live-preferred corpus, without loading or resuming an
   * Agent. Ordinary sessions and one-shot children remain traversal nodes so
   * continuable descendants below them are discovered; each returned entry
   * adds its durable `parentId` and root-relative `depth`. Identity resolution,
   * diagnostics, optional persistence, and cancellation follow the same
   * projection-backed contract as {@link listChildren}.
   * @param rootSessionId - session whose complete descendant tree is listed.
   * @param signal - caller-owned cancellation forwarded to persistence reads
   *   and observed around every read await.
   * @returns children and per-candidate diagnostics with tree position, in
   *   stable pre-order.
   * @throws {@link SubagentError} under the same conditions as {@link listChildren}.
   */
  listDescendants(rootSessionId: SessionId, signal?: AbortSignal): Promise<SubagentDescendantListEntry[]> {
    return listSubagentDescendants(this.ctx, rootSessionId, signal)
  }

  /**
   * Register a provider under its name. Registration is effect-scoped and HMR
   * safe; removing a provider blocks new starts but does not revoke runs that
   * were already returned to their holders.
   * @param provider - the trusted provider implementation.
   * @returns the exact Cordis effect disposer.
   */
  registerProvider(provider: SubagentProvider): () => void {
    const name = provider.name
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return this.ctx.effect(function* (this: SubagentRuntime) {
      if (this.providers.has(name)) {
        throw new SubagentError(`a subagent provider named "${name}" is already registered`, 'DUPLICATE_PROVIDER')
      }
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.emitLifecycle('subagent/provider-removed', name)
      }
      // A throwing added-listener unwinds the yielded rollback, matching the
      // repository's fail-loud registration semantics.
      this.ctx.emit('subagent/provider-added', provider)
    }.bind(this), 'subagents.registerProvider()')
  }

  /**
   * Look up a provider by name.
   * @param name - the provider name.
   * @returns the provider, or undefined when absent.
   */
  getProvider(name: string): SubagentProvider | undefined {
    return this.providers.get(name)
  }

  /**
   * List registered provider names in insertion order.
   * @returns the registered names.
   */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Establish a published child on the named provider. Capability and semantic
   * checks run before delegation. Provider ownership lasts until its promise
   * fulfills; a rejection therefore has no run for the caller to dispose and
   * emits no run lifecycle events. Post-publication turn and infrastructure
   * failures settle through the returned run.
   * @param name - the provider to use.
   * @param request - child label, prompt, parent, signal, and optional capabilities.
   * @returns the published holder-owned run.
   */
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const provider = this.expectProvider(name)
    this.assertCapabilities(provider, request)
    assertSubagentMaxDepth(request.maxDepth)
    if (request.outputSchema !== undefined) assertObjectJsonSchema(request.outputSchema)
    const descriptor = snapshotSubagentDescriptor({
      mode: 'one-shot',
      provider: name,
      ...request.label !== undefined ? { label: request.label } : {},
    })
    const resolved: ResolvedSubagentStartRequest = { ...request, descriptor }
    return observeRun(this.emitLifecycle, name, request.parent, await provider.start(resolved))
  }

  /**
   * Resolve one provider's detached continuable-creation contribution. Method
   * presence on the provider IS the capability, so a provider without it is
   * rejected before the manager reserves any child resources.
   */
  private async prepareContinuable(
    name: string,
    request: ContinuableCreateRequest,
  ): Promise<ContinuableCreateSpec> {
    const provider = this.expectProvider(name)
    if (provider.prepareContinuable === undefined) {
      throw new SubagentError(
        `subagent provider "${provider.name}" does not support continuable children `
        + '(no prepareContinuable capability)',
        'UNSUPPORTED_CAPABILITY',
      )
    }
    return provider.prepareContinuable(request)
  }

  /** Look up a provider for dispatch or fail loud. */
  private expectProvider(name: string): SubagentProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) {
      throw new SubagentError(`no subagent provider registered for "${name}"`, 'NO_PROVIDER')
    }
    return provider
  }

  /** Resolve the optional continuable-subagent manager or fail loud. */
  private requireContinuations(): SubagentContinuationManager {
    if (this.continuations === undefined) {
      throw new SubagentError(
        'continuable subagents require the agents service',
        'CONTINUATION_UNAVAILABLE',
      )
    }
    return this.continuations
  }

  /**
   * Build the lifecycle observer for one continuable Activation's residency
   * epoch, so the manager publishes its edges without owning event dispatch.
   */
  private observeActivation(
    provider: string,
    childId: SessionId,
    parent: Agent,
  ): ActivationObserver {
    return createActivationObserver(this.emitLifecycle, provider, childId, parent)
  }

  /** Reject the first requested capability that the provider lacks. */
  private assertCapabilities(provider: SubagentProvider, request: SubagentStartRequest): void {
    const needs: { when: boolean; cap: keyof SubagentCapabilities }[] = [
      { when: request.outputSchema !== undefined, cap: 'outputSchema' },
      { when: request.maxDepth !== undefined, cap: 'depthLimit' },
      { when: request.toolFilter !== undefined, cap: 'toolFilter' },
      { when: request.persona !== undefined, cap: 'persona' },
    ]
    for (const { when, cap } of needs) {
      if (when && !provider.capabilities[cap]) {
        throw new SubagentError(
          `subagent provider "${provider.name}" does not support the "${cap}" capability`,
          'UNSUPPORTED_CAPABILITY',
        )
      }
    }
  }
}

export default SubagentRuntime

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/subagent'
  export const name = 'subagent-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
