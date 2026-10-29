import type { Branded } from '@ejunz/ea/brand'

export type GoalId = Branded<'GoalId'>

export interface GoalRef {
  /** Stable goal identity. */
  readonly id: GoalId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

export interface CreateGoalRequest {
  readonly objective: string
  readonly maxGoalRounds?: number
}

export interface CreateGoalResult {
  readonly ref: GoalRef
}

export interface EditGoalRequest {
  readonly objective?: string
  readonly maxGoalRounds?: number
}

export type GoalPhase =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'

export interface GoalBlockReason {
  /** Stable lower-kebab-case classification chosen by the blocking policy. */
  readonly code: string
  /** Non-empty explanation shown to humans and models. */
  readonly message: string
}

export interface GoalSnapshot extends GoalRef {
  /** Human-requested completion objective. */
  readonly objective: string
  /** Durable lifecycle phase. */
  readonly phase: GoalPhase
  /** Present exactly while `phase` is `blocked`. */
  readonly blockedReason?: GoalBlockReason
  /** Total admitted goal-round cap. */
  readonly maxGoalRounds: number
}

export type GoalActivation = 'armed' | 'disarmed'

export interface GoalView extends GoalSnapshot {
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
  /** Process-local continuation eligibility; never persisted. */
  readonly activation: GoalActivation
}

export interface GoalProjection {
  /** Current durable goal snapshot (the CAS ref for mutations rides on it). */
  readonly goal: GoalSnapshot
  /** Highest admitted round number for this goal. */
  readonly roundsStarted: number
  /** Epoch milliseconds of the create mutation. */
  readonly createdAt: number
  /** Epoch milliseconds of the latest mutation. */
  readonly updatedAt: number
}

declare module '@ejunz/ea/session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The session's current goal (the latest `goal/change` whole value), or
     * `null` before the first create and after a clear tombstone.
     * Whole-value rule: every goal change carries the complete post-change
     * state, so the fold is last-wins.
     */
    goal: GoalProjection | null
  }
}

import type { Agent } from '@ejunz/ea/agent'

export type GoalOperation =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'
  | 'clear'

export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: Exclude<GoalOperation, 'clear'>
  readonly goal: GoalSnapshot
  readonly roundsStarted: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface GoalClearChangeMeta {
  readonly kind: 'goal/change'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: GoalRef
  readonly clearedAt: number
}

export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta

export interface GoalMessageSource {
  readonly kind: 'goal'
  readonly goalId: GoalId
  readonly revision: number
  /** Positive admitted continuation round. */
  readonly round: number
}

declare module '@ejunz/ea/llm' {
  interface MessageSourceMap {
    goal: GoalMessageSource
  }
}

declare module '@ejunz/ea/session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation goal state or clear tombstone.
     */
    'goal/change': GoalChangeMeta
  }
}

export interface FoldedGoal {
  /** Current goal, absent after a clear or before the first create. */
  readonly goal?: GoalSnapshot
  /** Highest admitted round for the current goal. */
  readonly roundsStarted: number
  /** Current goal creation time, absent without a current goal. */
  readonly createdAt?: number
  /** Current goal mutation time, absent without a current goal. */
  readonly updatedAt?: number
  /** Latest mutation ref, including a clear tombstone. */
  readonly lastRef?: GoalRef
}

export interface GoalChanged {
  readonly operation: GoalOperation
  readonly ref: GoalRef
  /** Absent for a clear tombstone. */
  readonly goal?: GoalView
}

export type GoalErrorCode =
  | 'GOAL_AGENT_NOT_LIVE'
  | 'GOAL_NOT_FOUND'
  | 'GOAL_ALREADY_EXISTS'
  | 'GOAL_STALE_REVISION'
  | 'GOAL_INVALID_OBJECTIVE'
  | 'GOAL_INVALID_MAX_ROUNDS'
  | 'GOAL_INVALID_BLOCK_REASON'
  | 'GOAL_INVALID_EDIT'
  | 'GOAL_INVALID_TRANSITION'

declare module '@ejunz/cordis' {
  interface Events {
    /**
     * Goal mutation accepted by one live agent. The matching `goal/change`
     * session event has already committed. Listener failures are contained.
     * Scope-filtered dispatch (`@ejunz/ea/scope`): agent-scoped listeners receive only that agent.
     * @param payload.agent - agent whose session owns the goal.
     * @param payload.change - fresh current projection or clear tombstone.
     * @mode emit
     */
    'goal/changed'(this: import('@ejunz/ea/scope').Scoped<Agent>, payload: { agent: Agent; change: GoalChanged }): void
  }
}

import { EjunzAgentError } from '@ejunz/ea/llm'

export const GOAL_CHANGE_VERSION = 1

export function GoalId(id: string): GoalIdType {
  return id as GoalIdType
}

export class GoalError extends EjunzAgentError {
  /**
   * @param message - human-readable rejection reason.
   * @param code - stable machine-routable classification.
   */
  // Keep the constructor to narrow EjunzAgentError's string code at this boundary.
  // oxlint-disable-next-line typescript/no-useless-constructor -- type-only narrowing
  constructor(message: string, code: GoalErrorCode) {
    super(message, code)
  }
}

import type { MessageSource } from '@ejunz/ea/llm'

import type { SessionEvent } from '@ejunz/ea/session'

const SNAPSHOT_OPERATIONS: ReadonlySet<Exclude<GoalOperation, 'clear'>> = new Set([
  'create',
  'edit',
  'pause',
  'resume',
  'complete',
  'block',
])

const PHASES: ReadonlySet<GoalPhase> = new Set(['active', 'paused', 'blocked', 'complete'])

export interface GoalFoldState {
  goal: GoalSnapshot | undefined
  roundsStarted: number
  createdAt: number | undefined
  updatedAt: number | undefined
  lastRef: GoalRef | undefined
  seenGoalIds: Set<GoalSnapshot['id']>
}

export function emptyGoalFoldState(): GoalFoldState {
  return {
    goal: undefined,
    roundsStarted: 0,
    createdAt: undefined,
    updatedAt: undefined,
    lastRef: undefined,
    seenGoalIds: new Set(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`goal change ${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`goal change ${field} must be a non-negative safe integer`)
  }
  return value
}

function decodeBlockReason(value: unknown): GoalBlockReason {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'code,message') {
    throw new Error('goal change goal.blockedReason must have exactly code and message fields')
  }
  if (typeof value['code'] !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value['code'])) {
    throw new Error('goal change goal.blockedReason.code must be lower-kebab-case')
  }
  if (typeof value['message'] !== 'string' || value['message'].trim().length === 0
    || value['message'] !== value['message'].trim()) {
    throw new Error('goal change goal.blockedReason.message must be non-empty and normalized')
  }
  return { code: value['code'], message: value['message'] }
}

function decodeSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) throw new Error('goal change goal must be a record')
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal change goal.id must be a non-empty string')
  }
  if (typeof value['objective'] !== 'string' || value['objective'].trim().length === 0
    || value['objective'] !== value['objective'].trim()) {
    throw new Error('goal change goal.objective must be non-empty and normalized')
  }
  if (typeof value['phase'] !== 'string' || !PHASES.has(value['phase'] as GoalPhase)) {
    throw new Error('goal change goal.phase is invalid')
  }
  const phase = value['phase'] as GoalPhase
  const expectedKeys = phase === 'blocked'
    ? 'blockedReason,id,maxGoalRounds,objective,phase,revision'
    : 'id,maxGoalRounds,objective,phase,revision'
  if (Object.keys(value).sort().join(',') !== expectedKeys) {
    throw new Error(`goal change goal for phase ${phase} must have exactly ${expectedKeys} fields`)
  }
  return {
    id: GoalId(value['id']),
    revision: positiveInteger(value['revision'], 'goal.revision'),
    objective: value['objective'],
    phase,
    maxGoalRounds: positiveInteger(value['maxGoalRounds'], 'goal.maxGoalRounds'),
    ...phase === 'blocked' ? { blockedReason: decodeBlockReason(value['blockedReason']) } : {},
  }
}

function decodeRef(value: unknown): GoalRef {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== 'id,revision') {
    throw new Error('goal clear tombstone must have exactly id and revision fields')
  }
  if (typeof value['id'] !== 'string' || value['id'].length === 0) {
    throw new Error('goal clear tombstone id must be a non-empty string')
  }
  return { id: GoalId(value['id']), revision: positiveInteger(value['revision'], 'cleared.revision') }
}

export function decodeGoalChange(value: unknown): GoalChangeMeta | undefined {
  if (!isRecord(value) || value['kind'] !== 'goal/change') return undefined
  if (value['version'] !== GOAL_CHANGE_VERSION) {
    throw new Error(`unsupported goal change version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    const allowed = ['cleared', 'clearedAt', 'kind', 'operation', 'version']
    if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) {
      throw new Error(`goal clear change must have exactly ${allowed.sort().join(',')} fields`)
    }
    return {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: decodeRef(value['cleared']),
      clearedAt: nonNegativeInteger(value['clearedAt'], 'clearedAt'),
    } satisfies GoalClearChangeMeta
  }
  if (typeof value['operation'] !== 'string'
    || !SNAPSHOT_OPERATIONS.has(value['operation'] as Exclude<GoalOperation, 'clear'>)) {
    throw new Error('goal change operation is invalid')
  }
  const allowed = ['createdAt', 'goal', 'kind', 'operation', 'roundsStarted', 'updatedAt', 'version']
  if (Object.keys(value).sort().join(',') !== allowed.sort().join(',')) {
    throw new Error(`goal snapshot change must have exactly ${allowed.sort().join(',')} fields`)
  }
  const createdAt = nonNegativeInteger(value['createdAt'], 'createdAt')
  const updatedAt = nonNegativeInteger(value['updatedAt'], 'updatedAt')
  if (updatedAt < createdAt) throw new Error('goal change updatedAt cannot precede createdAt')
  return {
    kind: 'goal/change',
    version: GOAL_CHANGE_VERSION,
    operation: value['operation'] as Exclude<GoalOperation, 'clear'>,
    goal: decodeSnapshot(value['goal']),
    roundsStarted: nonNegativeInteger(value['roundsStarted'], 'roundsStarted'),
    createdAt,
    updatedAt,
  } satisfies GoalSnapshotChangeMeta
}

function goalSource(source: MessageSource): GoalMessageSource | undefined {
  if (source.kind !== 'goal') return undefined
  if (typeof source.goalId !== 'string' || source.goalId.length === 0
    || !Number.isSafeInteger(source.revision) || source.revision < 1
    || !Number.isSafeInteger(source.round) || source.round < 1) {
    throw new Error('goal message source is invalid')
  }
  return source
}

function requireSameDefinition(current: GoalSnapshot, next: GoalSnapshot, operation: GoalOperation): void {
  if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
    throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`)
  }
}

function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
  if (next.id !== current.id || next.revision !== current.revision + 1) {
    throw new Error(`goal ${operation} must advance the current goal by one revision`)
  }
}

function validateSnapshotTransition(
  state: GoalFoldState,
  change: GoalSnapshotChangeMeta,
  current: GoalSnapshot,
): void {
  const next = change.goal
  requireNextRevision(current, next, change.operation)
  /* v8 ignore next -- a current goal established by this fold always has an updatedAt */
  if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt')
  if (change.createdAt !== state.createdAt
    || change.updatedAt < state.updatedAt
    || change.roundsStarted !== state.roundsStarted) {
    throw new Error(`goal ${change.operation} does not preserve the current counters and timestamps`)
  }
  switch (change.operation) {
    case 'edit':
      if (next.phase !== current.phase
        || JSON.stringify(next.blockedReason) !== JSON.stringify(current.blockedReason)) {
        throw new Error('goal edit cannot change phase or blocked reason')
      }
      break
    case 'pause':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'paused') throw new Error('goal pause has an invalid phase transition')
      break
    case 'resume': {
      requireSameDefinition(current, next, change.operation)
      const resumable: ReadonlySet<GoalPhase> = new Set([
        'active',
        'paused',
        'blocked',
      ])
      if (!resumable.has(current.phase) || next.phase !== 'active' || state.roundsStarted >= next.maxGoalRounds) {
        throw new Error('goal resume has an invalid phase transition or exhausted round budget')
      }
      break
    }
    case 'complete':
      requireSameDefinition(current, next, change.operation)
      if (current.phase === 'complete' || next.phase !== 'complete') throw new Error('goal complete has an invalid phase transition')
      break
    case 'block':
      requireSameDefinition(current, next, change.operation)
      if (current.phase !== 'active' || next.phase !== 'blocked') throw new Error('goal block has an invalid phase transition')
      break
    /* v8 ignore start -- the caller excludes create and GoalOperation is closed; these arms retain fail-loud exhaustiveness */
    case 'create':
      throw new Error('goal create cannot be validated as a current-goal transition')
    default:
      change.operation satisfies never
      throw new Error('unknown goal snapshot operation')
    /* v8 ignore stop */
  }
}

export function goalChangeRef(change: GoalChangeMeta): GoalRef {
  return change.operation === 'clear'
    ? change.cleared
    : { id: change.goal.id, revision: change.goal.revision }
}

export function applyGoalChange(state: GoalFoldState, change: GoalChangeMeta): void {
  const ref = goalChangeRef(change)
  if (change.operation === 'clear') {
    const current = state.goal
    if (current === undefined) throw new Error('goal clear requires a current goal')
    requireNextRevision(current, change.cleared, change.operation)
    /* v8 ignore next -- a current goal established by this fold always has an updatedAt */
    if (state.updatedAt === undefined) throw new Error('current goal fold lacks updatedAt')
    if (change.clearedAt < state.updatedAt) {
      throw new Error('goal clear timestamp cannot precede the current goal update')
    }
    state.goal = undefined
    state.roundsStarted = 0
    state.createdAt = undefined
    state.updatedAt = undefined
    state.lastRef = ref
    return
  }
  if (change.operation === 'create') {
    if (change.goal.revision !== 1 || change.goal.phase !== 'active' || change.roundsStarted !== 0
      || (state.goal !== undefined && state.goal.phase !== 'complete')
      || state.seenGoalIds.has(change.goal.id)) {
      throw new Error('goal create requires a fresh active revision-one goal with zero rounds')
    }
    state.seenGoalIds.add(change.goal.id)
  } else {
    const current = state.goal
    if (current === undefined) throw new Error(`goal ${change.operation} requires a current goal`)
    validateSnapshotTransition(state, change, current)
  }
  state.goal = change.goal
  state.roundsStarted = change.roundsStarted
  state.createdAt = change.createdAt
  state.updatedAt = change.updatedAt
  state.lastRef = ref
}

export function applyGoalEvent(state: GoalFoldState, event: SessionEvent): void {
  if (event.type === 'goal/change') {
    const change = decodeGoalChange(event.data)
    /* v8 ignore next -- the event's declared payload always identifies itself as a goal change. */
    if (change === undefined) throw new Error(`goal change at session event ${event.seq} has an invalid kind`)
    applyGoalChange(state, change)
    return
  }
  if (event.type === 'user/message') {
    const source = goalSource(event.data.source)
    if (source === undefined) return
    const current = state.goal
    if (current === undefined || current.phase !== 'active' || source.goalId !== current.id
      || source.revision !== current.revision || source.round !== state.roundsStarted + 1
      || source.round > current.maxGoalRounds) {
      throw new Error(`goal round at session event ${event.seq} is not the next admitted round of the active goal`)
    }
    state.roundsStarted = source.round
  }
}

export function foldGoal(events: readonly SessionEvent[]): FoldedGoal {
  const state = emptyGoalFoldState()
  for (const event of events) applyGoalEvent(state, event)
  return {
    ...state.goal === undefined ? {} : { goal: { ...state.goal } },
    roundsStarted: state.roundsStarted,
    ...state.createdAt === undefined ? {} : { createdAt: state.createdAt },
    ...state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt },
    ...state.lastRef === undefined ? {} : { lastRef: { ...state.lastRef } },
  }
}

import { randomUUID } from 'node:crypto'

import { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import { z as zod } from 'zod'

import type { ZodType } from 'zod'

import { agentEvents } from '@ejunz/ea/agent'

import type { Agent } from '@ejunz/ea/agent'

import type { Session, SessionEvent } from '@ejunz/ea/session'

import { TypertRemoteService, Remote } from '@ejunz/ea/typert-protocol'

import type {} from '@ejunz/ea/session-projection'

declare module '@ejunz/cordis' {
  interface Context {
    goals: GoalService
  }
}

const goalProjectionSchema: ZodType<GoalProjection | null> = zod.union([
  zod.object({
    goal: zod.object({
      id: zod.string().min(1),
      revision: zod.number().int().positive(),
      objective: zod.string().min(1),
      phase: zod.union([zod.literal('active'), zod.literal('paused'), zod.literal('blocked'), zod.literal('complete')]),
      blockedReason: zod.object({ code: zod.string(), message: zod.string() }).optional(),
      maxGoalRounds: zod.number().int().positive(),
    }),
    roundsStarted: zod.number().int().nonnegative(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
  }),
  zod.null(),
]) as ZodType<GoalProjection | null>

export function applyGoalProjection(state: GoalProjection | null, event: SessionEvent): GoalProjection | null {
  if (event.type !== 'goal/change') return state
  let change: GoalChangeMeta | undefined
  try {
    change = decodeGoalChange(event.data)
  } catch (_invalidPersistedGoalChange) {
    return state
  }
  if (change === undefined) return state
  return change.operation === 'clear'
    ? null
    : {
      goal: change.goal,
      roundsStarted: change.roundsStarted,
      createdAt: change.createdAt,
      updatedAt: change.updatedAt,
    }
}

export interface Config {
  /** Total rounds used when a create request omits its own cap. */
  defaultMaxGoalRounds?: number
}

export interface ResolvedConfig {
  /** Validated positive safe-integer default round cap. */
  defaultMaxGoalRounds: number
}

interface GoalCache {
  readonly state: GoalFoldState
  activation: GoalActivation
  observedSeq: number
  pendingActivation: { readonly seq: number; readonly activation: GoalActivation } | undefined
}

interface ResolvedCreateGoal {
  readonly objective: string
  readonly maxGoalRounds: number
}

function resolveMaxGoalRounds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GoalError('maxGoalRounds must be a positive safe integer', 'GOAL_INVALID_MAX_ROUNDS')
  }
  return value
}

function resolveObjective(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GoalError('goal objective must be a non-empty string', 'GOAL_INVALID_OBJECTIVE')
  }
  return value.trim()
}

function resolveCreateGoal(request: CreateGoalRequest, defaultMaxGoalRounds: number): ResolvedCreateGoal {
  return {
    objective: resolveObjective(request.objective),
    maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds ?? defaultMaxGoalRounds),
  }
}

function resolveBlockReason(reason: unknown): GoalBlockReason {
  const record = typeof reason === 'object' && reason !== null && !Array.isArray(reason)
    ? reason as Record<string, unknown>
    : undefined
  const code = record?.['code']
  const message = record?.['message']
  if (typeof code !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code)
    || typeof message !== 'string' || message.trim().length === 0) {
    throw new GoalError(
      'goal block reason requires a lower-kebab-case code and a non-empty message',
      'GOAL_INVALID_BLOCK_REASON',
    )
  }
  return { code, message: message.trim() }
}

export class GoalService extends TypertRemoteService {
  static inject = ['agents']

  static Config: z<Config> = z.object({
    defaultMaxGoalRounds: z.number().default(256),
  })

  private readonly resolved: ResolvedConfig
  private readonly caches = new WeakMap<Session, GoalCache>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'goals')
    this.resolved = {
      defaultMaxGoalRounds: resolveMaxGoalRounds(config.defaultMaxGoalRounds ?? 256),
    }
    ctx.on('agent/session-start', ({ agent }) => {
      this.cache(agent.session).activation = 'disarmed'
    })
    // The `goal` projection unit: last-wins fold of goal/change whole values
    // (see applyGoalProjection). The unit child activates only when a
    // projection registry is composed (headless assemblies stay unaffected).
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      projectionCtx.sessionProjections.register<'goal', GoalProjection | null>({
        key: 'goal',
        schema: goalProjectionSchema,
        init: () => null,
        apply: applyGoalProjection,
        view: state => state,
        stateVersion: 4,
      })
    })
  }

  /**
   * Read the current goal for one exact live agent.
   * @param agent - owning live agent.
   * @returns a fresh view or `undefined` when no goal is current.
   * @throws {@link GoalError} when the agent is not the registry's live instance.
   */
  get(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    return this.view(cache)
  }

  /**
   * Remove process-local continuation authority without changing durable goal
   * phase or revision. Lifecycle owners use this before unloading a driver;
   * a later human-authorized {@link resume} records the new activation edge.
   * @param agent - owning live agent.
   * @returns a fresh disarmed view, or `undefined` when no goal is current.
   */
  disarm(agent: Agent): GoalView | undefined {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    cache.activation = 'disarmed'
    return this.view(cache)
  }

  /**
   * Create and arm a goal. A completed goal may be replaced; every other
   * current phase must be cleared or resumed instead.
   * @param agent - owning live agent.
   * @param request - objective and optional round cap.
   * @returns the created live view.
   */
  create(agent: Agent, request: CreateGoalRequest): GoalView {
    const spec = resolveCreateGoal(request, this.resolved.defaultMaxGoalRounds)
    const cache = this.prepareMutation(agent)
    const current = cache.state.goal
    if (current !== undefined && current.phase !== 'complete') {
      throw new GoalError(`goal "${current.id}" already exists with phase "${current.phase}"`, 'GOAL_ALREADY_EXISTS')
    }
    const now = Date.now()
    const goal: GoalSnapshot = {
      id: GoalId(`goal-${randomUUID()}`),
      revision: 1,
      objective: spec.objective,
      phase: 'active',
      maxGoalRounds: spec.maxGoalRounds,
    }
    return this.commitSnapshot(agent, cache, 'create', goal, 0, now, now, 'armed')
  }

  /**
   * Edit objective and/or round cap without changing phase.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param request - at least one replacement field.
   * @returns the edited view.
   */
  @Remote('edit')
  edit(agent: Agent, ref: GoalRef, request: EditGoalRequest): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    if (request.objective === undefined && request.maxGoalRounds === undefined) {
      throw new GoalError('goal edit requires objective and/or maxGoalRounds', 'GOAL_INVALID_EDIT')
    }
    const goal: GoalSnapshot = {
      ...current,
      revision: current.revision + 1,
      ...request.objective === undefined ? {} : { objective: resolveObjective(request.objective) },
      ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: resolveMaxGoalRounds(request.maxGoalRounds) },
    }
    return this.commitCurrent(agent, cache, 'edit', goal, cache.activation)
  }

  /**
   * Pause an active goal and disarm automatic continuation.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the paused view.
   */
  @Remote('pause')
  pause(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(agent, ref, 'pause', ['active'], 'paused', 'disarmed')
  }

  /**
   * Resume and arm a stopped goal, or rearm an active goal after a
   * session-start edge, while its round budget still has capacity.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the active view.
   */
  @Remote('resume')
  resume(agent: Agent, ref: GoalRef): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    const resumable: readonly GoalPhase[] = ['active', 'paused', 'blocked']
    if (!resumable.includes(current.phase)) {
      throw this.transitionError(current, 'resume', resumable)
    }
    if (current.phase === 'active' && cache.activation === 'armed') {
      throw new GoalError(`goal "${current.id}" is already active and armed`, 'GOAL_INVALID_TRANSITION')
    }
    if (cache.state.roundsStarted >= current.maxGoalRounds) {
      throw new GoalError(
        `goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
        'GOAL_INVALID_TRANSITION',
      )
    }
    return this.commitCurrent(agent, cache, 'resume', this.withPhase(current, 'active'), 'armed')
  }

  /**
   * Mark a current non-complete goal complete and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the completed view.
   */
  @Remote('complete')
  complete(agent: Agent, ref: GoalRef): GoalView {
    return this.transition(
      agent,
      ref,
      'complete',
      ['active', 'paused', 'blocked'],
      'complete',
      'disarmed',
    )
  }

  /**
   * Mark an active goal blocked and disarm it.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @param reason - policy-owned stable code and human-readable explanation.
   * @returns the blocked view with its durable reason.
   */
  block(agent: Agent, ref: GoalRef, reason: GoalBlockReason): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    if (current.phase !== 'active') {
      throw this.transitionError(current, 'block', ['active'])
    }
    return this.commitCurrent(
      agent,
      cache,
      'block',
      { ...this.withPhase(current, 'blocked'), blockedReason: resolveBlockReason(reason) },
      'disarmed',
    )
  }

  /**
   * Clear the current goal while retaining a durable tombstone and history.
   * @param agent - owning live agent.
   * @param ref - expected current revision.
   * @returns the tombstone ref whose revision is one past the cleared snapshot.
   */
  @Remote('clear')
  clear(agent: Agent, ref: GoalRef): GoalRef {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    const tombstone: GoalRef = { id: current.id, revision: current.revision + 1 }
    const change: GoalClearChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation: 'clear',
      cleared: tombstone,
      clearedAt: this.nextMutationTime(cache),
    }
    this.commit(agent, cache, change, 'disarmed')
    return { ...tombstone }
  }

  /** Resolve and validate the cache used by a mutation. */
  private prepareMutation(agent: Agent): GoalCache {
    this.assertLive(agent)
    const cache = this.cache(agent.session)
    this.sync(agent.session, cache)
    return cache
  }

  /** Reject stale or missing current-state refs. */
  private expectCurrent(cache: GoalCache, ref: GoalRef): GoalSnapshot {
    const current = cache.state.goal
    if (current === undefined) throw new GoalError('no current goal', 'GOAL_NOT_FOUND')
    if (ref.id !== current.id || ref.revision !== current.revision) {
      throw new GoalError(
        `stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
        'GOAL_STALE_REVISION',
      )
    }
    return current
  }

  /** Enforce exact live-agent identity rather than trusting a matching id. */
  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new GoalError(`agent "${agent.id}" is not live in this registry`, 'GOAL_AGENT_NOT_LIVE')
    }
  }

  /** Return the per-session cache, folding a seed once with activation disarmed. */
  private cache(session: Session): GoalCache {
    let cache = this.caches.get(session)
    if (cache !== undefined) return cache
    const state = emptyGoalFoldState()
    for (const event of session.events) applyGoalEvent(state, event)
    cache = {
      state,
      activation: 'disarmed',
      observedSeq: session.seq,
      pendingActivation: undefined,
    }
    this.caches.set(session, cache)
    return cache
  }

  /** Incrementally observe durable events and reconcile local activation intent. */
  private sync(session: Session, cache: GoalCache): void {
    for (const event of session.events.slice(cache.observedSeq)) {
      applyGoalEvent(cache.state, event)
      if (event.type === 'goal/change') {
        cache.activation = cache.pendingActivation?.seq === event.seq
          ? cache.pendingActivation.activation
          : 'disarmed'
      }
      cache.observedSeq += 1
    }
  }

  /** Build a new revision with one replacement phase. */
  private withPhase(current: GoalSnapshot, phase: GoalPhase): GoalSnapshot {
    return {
      id: current.id,
      revision: current.revision + 1,
      objective: current.objective,
      phase,
      maxGoalRounds: current.maxGoalRounds,
    }
  }

  /** Shared validated phase transition. */
  private transition(
    agent: Agent,
    ref: GoalRef,
    operation: Exclude<GoalOperation, 'create' | 'edit' | 'clear'>,
    allowed: readonly GoalPhase[],
    phase: GoalPhase,
    activation: GoalActivation,
  ): GoalView {
    const cache = this.prepareMutation(agent)
    const current = this.expectCurrent(cache, ref)
    if (!allowed.includes(current.phase)) throw this.transitionError(current, operation, allowed)
    return this.commitCurrent(agent, cache, operation, this.withPhase(current, phase), activation)
  }

  /** Render a stable invalid-transition error. */
  private transitionError(current: GoalSnapshot, operation: GoalOperation, allowed: readonly GoalPhase[]): GoalError {
    return new GoalError(
      `cannot ${operation} goal "${current.id}" from phase "${current.phase}"; expected ${allowed.join(' or ')}`,
      'GOAL_INVALID_TRANSITION',
    )
  }

  /** Commit a mutation that retains the current goal's derived counters/times. */
  private commitCurrent(
    agent: Agent,
    cache: GoalCache,
    operation: Exclude<GoalOperation, 'create' | 'clear'>,
    goal: GoalSnapshot,
    activation: GoalActivation,
  ): GoalView {
    const createdAt = cache.state.createdAt
    /* v8 ignore next -- strict replay and every snapshot commit set createdAt whenever a current goal exists */
    if (createdAt === undefined) throw new Error('current goal cache lacks createdAt')
    return this.commitSnapshot(
      agent,
      cache,
      operation,
      goal,
      cache.state.roundsStarted,
      createdAt,
      this.nextMutationTime(cache),
      activation,
    )
  }

  /** Clamp a current goal's next timestamp across backward wall-clock movement. */
  private nextMutationTime(cache: GoalCache): number {
    const updatedAt = cache.state.updatedAt
    /* v8 ignore next -- strict replay and every snapshot commit set updatedAt whenever a current goal exists */
    if (updatedAt === undefined) throw new Error('current goal cache lacks updatedAt')
    return Math.max(Date.now(), updatedAt)
  }

  /** Build and commit one full-snapshot mutation. */
  private commitSnapshot(
    agent: Agent,
    cache: GoalCache,
    operation: Exclude<GoalOperation, 'clear'>,
    goal: GoalSnapshot,
    roundsStarted: number,
    createdAt: number,
    updatedAt: number,
    activation: GoalActivation,
  ): GoalView {
    const change: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: GOAL_CHANGE_VERSION,
      operation,
      goal,
      roundsStarted,
      createdAt,
      updatedAt,
    }
    this.commit(agent, cache, change, activation)
    const view = this.view(cache)
    /* v8 ignore next -- the durable goal event installs the snapshot before this read */
    if (view === undefined) throw new Error('snapshot commit cleared the goal unexpectedly')
    return view
  }

  /** Commit one mutation into the goal log, cache, and live event stream. */
  private commit(agent: Agent, cache: GoalCache, change: GoalChangeMeta, activation: GoalActivation): void {
    const ref = goalChangeRef(change)
    cache.pendingActivation = { seq: agent.session.seq, activation }
    try {
      agent.session.append('goal/change', change)
      this.sync(agent.session, cache)
    } finally {
      cache.pendingActivation = undefined
    }
    const goal = this.view(cache)
    const notification: GoalChanged = {
      operation: change.operation,
      ref: { ...ref },
      ...goal === undefined ? {} : { goal },
    }
    agentEvents(this.ctx, agent).emit('goal/changed', { change: notification })
  }

  /** Build a detached current view. */
  private view(cache: GoalCache): GoalView | undefined {
    const goal = cache.state.goal
    const createdAt = cache.state.createdAt
    const updatedAt = cache.state.updatedAt
    if (goal === undefined) return undefined
    /* v8 ignore next 3 -- strict replay and snapshot commits establish both timestamps with every current goal */
    if (createdAt === undefined || updatedAt === undefined) {
      throw new Error(`goal "${goal.id}" cache lacks timestamps`)
    }
    return {
      ...goal,
      roundsStarted: cache.state.roundsStarted,
      createdAt,
      updatedAt,
      activation: cache.activation,
    }
  }

  /**
   * Create one Goal through the remote boundary.
   * @param agent - exact live Agent resolved from the wire identity.
   * @param request - objective and optional round cap.
   * @returns the created Goal identity.
   */
  @Remote('create')
  remoteExportCreate(agent: Agent, request: CreateGoalRequest): CreateGoalResult {
    const view = this.create(agent, request)
    return { ref: { id: view.id, revision: view.revision } }
  }
}

export default GoalService

import type { InvariantInstaller } from '@ejunz/ea/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea/goal'
  export const name = 'goal-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
