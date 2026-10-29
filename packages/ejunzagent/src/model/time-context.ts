import { assertNever } from '@ejunz/ea-core/llm'

import type { UserMessage } from '@ejunz/ea-core/llm'

const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+.-]*(?:\/[A-Za-z0-9_+.-]+)+$/

export type BrowserTimeZoneContext =
  | { readonly kind: 'resolved'; readonly timeZone: string }
  | { readonly kind: 'mixed'; readonly timeZones: readonly string[] }
  | { readonly kind: 'missing' }

function browserTimeZone(message: UserMessage): string | undefined {
  const source = message.source
  const value = source.kind === 'user'
    && 'rpcId' in source
    && typeof source.rpcId === 'string'
    && 'clientTimeZone' in source
    && typeof source.clientTimeZone === 'string'
    ? source.clientTimeZone
    : undefined
  if (value === undefined) return undefined
  if (value !== 'UTC' && !IANA_TIME_ZONE.test(value)) {
    throw new TypeError(
      `browser time zone must be canonical UTC or IANA Area/Location: ${JSON.stringify(value)}`,
    )
  }
  let canonical: string
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch (error: unknown) {
    throw new TypeError(`browser time zone is unsupported: ${JSON.stringify(value)}`, { cause: error })
  }
  if (canonical !== value) {
    throw new TypeError(`browser time zone must be canonical: ${JSON.stringify(value)}`)
  }
  return value
}

export function deriveBrowserTimeZoneContext(
  messages: readonly UserMessage[],
): BrowserTimeZoneContext {
  const timeZones = [...new Set(messages.flatMap((message) => {
    const timeZone = browserTimeZone(message)
    return timeZone === undefined ? [] : [timeZone]
  }))].sort()
  const [timeZone, ...remaining] = timeZones
  if (timeZone === undefined) return { kind: 'missing' }
  if (remaining.length === 0) return { kind: 'resolved', timeZone }
  return { kind: 'mixed', timeZones }
}

export function renderBrowserTimeZoneContext(context: BrowserTimeZoneContext): string {
  switch (context.kind) {
    case 'resolved':
      return `Browser time zone for this request: ${context.timeZone}. `
        + 'Interpret otherwise-unqualified dates and times in this zone.'
    case 'mixed':
      return `Browser time zone for this request: mixed ${JSON.stringify(context.timeZones)}. `
        + 'Ask the user to clarify otherwise-unqualified dates and times.'
    case 'missing':
      return 'Browser time zone for this request: unavailable. '
        + 'Ask the user to clarify otherwise-unqualified dates and times.'
    /* v8 ignore next 2 -- the closed BrowserTimeZoneContext union is exhausted above. */
    default:
      return assertNever(context, 'BrowserTimeZoneContext')
  }
}

type TimestampPart = 'day' | 'hour' | 'minute' | 'month' | 'second' | 'timeZoneName' | 'year'

export function createTimestampFormatter(timeZone?: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  })
}

export function formatTimestamp(now: number, formatter: Intl.DateTimeFormat, timeZone: string): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(part => [part.type, part.value]),
  ) as Record<TimestampPart, string>
  const offset = parts.timeZoneName.replace(/^GMT$/, 'GMT+00:00').slice(3)
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}${offset}[${timeZone}]`
}

import type { Context } from '@ejunz/cordis'

import z from '@ejunz/schemastery'

import type { Agent, PreStepDecision } from '@ejunz/ea-core/agent'

import { createUserMessage } from '@ejunz/ea-core/llm'

import type { UserMessage } from '@ejunz/ea-core/llm'

export const name = 'time-context'

export const inject = ['agents']

export interface Config {
  /** Fallback display zone when the open turn has no unique browser zone. Omit to use the process zone. */
  timeZone?: string
  /** Minimum milliseconds between durable injections in one session. Omit or set to 0 to inject at every eligible step. */
  refreshIntervalMs?: number
}

export const Config: z<Config> = z.object({
  timeZone: z.string(),
  refreshIntervalMs: z.number(),
})

function formatDuration(elapsedMs: number): string {
  let seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  const days = Math.floor(seconds / 86_400)
  seconds %= 86_400
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)
  seconds %= 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days}d`)
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  parts.push(`${seconds}s`)
  return parts.join(' ')
}

function precedingMessageTime(agent: Agent): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    switch (event.type) {
      case 'user/message':
      case 'assistant/message':
      case 'tool/result':
        return event.time
      default:
        // Merge-extensible session events: non-surface records are not messages.
        break
    }
  }
  return undefined
}

function precedingStepContextTime(agent: Agent, turn: number): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'turn/start' && event.data.turn === turn) return undefined
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === name) {
      return event.time
    }
  }
  return undefined
}

function latestInjectionTime(agent: Agent): number | undefined {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === name) {
      return event.time
    }
  }
  return undefined
}

function requestMessages(agent: Agent, turn: number, proposed: readonly UserMessage[]): UserMessage[] {
  const start = agent.session.events.findLastIndex(
    event => event.type === 'turn/start' && event.data.turn === turn,
  )
  const entered = start < 0
    ? []
    : agent.session.events.slice(start + 1)
      .flatMap(event => event.type === 'user/message' ? [event.data] : [])
  return [...entered, ...proposed]
}

function renderText(
  now: number,
  turn: number,
  step: number,
  previous: number | undefined,
  formatter: Intl.DateTimeFormat,
  timeZone: string,
  browserContext: BrowserTimeZoneContext,
): string {
  const elapsed = previous === undefined ? 'unavailable' : formatDuration(now - previous)
  const baseline = step === 1 ? 'model-visible message' : 'step context'
  const browserText = renderBrowserTimeZoneContext(browserContext)
  return `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}\n`
    + `${browserText}\n`
    + `Elapsed since the preceding ${baseline}: ${elapsed}.`
}

function validateRefreshInterval(refreshIntervalMs: number | undefined): void {
  if (refreshIntervalMs !== undefined && (
    !Number.isSafeInteger(refreshIntervalMs)
    || refreshIntervalMs < 0
  )) {
    throw new TypeError(
      `time-context: refreshIntervalMs must be a non-negative safe integer, got ${String(refreshIntervalMs)}`,
    )
  }
}

export function apply(ctx: Context, config: Config): void {
  const timeZone = config.timeZone
  const refreshIntervalMs = config.refreshIntervalMs
  validateRefreshInterval(refreshIntervalMs)
  let fallbackFormatter: Intl.DateTimeFormat
  try {
    fallbackFormatter = createTimestampFormatter(timeZone)
  } catch (error: unknown) {
    const message = timeZone === undefined
      ? 'time-context: failed to resolve the system time zone'
      : `time-context: invalid IANA timeZone ${JSON.stringify(timeZone)}`
    throw new Error(message, { cause: error })
  }
  const fallbackTimeZone = fallbackFormatter.resolvedOptions().timeZone
  const formatters = new Map<string, Intl.DateTimeFormat>([[fallbackTimeZone, fallbackFormatter]])

  /** Resolve and cache one request-local timestamp formatter. */
  const formatterFor = (selectedTimeZone: string): Intl.DateTimeFormat => {
    const existing = formatters.get(selectedTimeZone)
    if (existing !== undefined) return existing
    const created = createTimestampFormatter(selectedTimeZone)
    formatters.set(selectedTimeZone, created)
    return created
  }

  ctx.on('agent/pre-step', async (
    { agent, turn, step, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const now = Date.now()
    if (refreshIntervalMs !== undefined && refreshIntervalMs > 0) {
      const lastInjection = latestInjectionTime(agent)
      if (lastInjection !== undefined
        && now >= lastInjection
        && now - lastInjection < refreshIntervalMs) return decision
    }
    const previous = step === 1
      ? precedingMessageTime(agent)
      : precedingStepContextTime(agent, turn)
    const messages = requestMessages(agent, turn, decision.messages)
    const browser = deriveBrowserTimeZoneContext(messages)
    const selectedTimeZone = browser.kind === 'resolved' ? browser.timeZone : fallbackTimeZone
    const text = renderText(
      now,
      turn,
      step,
      previous,
      formatterFor(selectedTimeZone),
      selectedTimeZone,
      browser,
    )
    return {
      kind: 'enter',
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
        }),
      ],
    }
  }, { prepend: true })
}

import type { InvariantInstaller } from '@ejunz/ea-core/invariants'
import type { Context as InvariantContext } from '@ejunz/cordis'

namespace __invariant {
  const PACKAGE_NAME = '@ejunz/ea-core/time-context'
  export const name = 'time-context-invariant'
  export const inject = ['invariants']
  const install: InvariantInstaller = () => {}
  export const apply = (ctx: InvariantContext): Promise<() => void> =>
    Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
}

export import __invariant_companion = __invariant
