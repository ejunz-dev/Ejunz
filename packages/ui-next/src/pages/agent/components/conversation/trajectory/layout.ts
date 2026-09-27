import type { ChatMessage } from '../../types'
import type {
  TrajectoryCellKind,
  TrajectoryCellProps,
  TrajectorySourceBlock,
} from './trajectory-record'

export interface TrajectoryGroupModel {
  title: string
  description?: string
  cells: readonly TrajectoryCellProps[]
}

export interface TrajectoryTurnModel {
  turn: number | null
  groups: readonly TrajectoryGroupModel[]
}

export interface TrajectoryLayoutInput {
  messages: readonly ChatMessage[]
}

function flattenMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.flatMap(message => {
    const { children, ...flat } = message
    return [flat, ...(children === undefined ? [] : flattenMessages(children))]
  })
}

function kindOf(message: ChatMessage): TrajectoryCellKind {
  if (message.role === 'assistant') return 'message'
  if (message.role === 'compaction') return 'compacted'
  if (message.role === 'tool') return message.parentCallId === undefined ? 'tool' : 'subtool'
  if (message.role === 'retry') return 'system'
  return message.role
}

function stepOf(message: ChatMessage): number | null {
  const match = message.key.match(/^assistant-(?:stream-)?[^-]+-(\d+)(?:-|$)/)
  return match === null ? null : Number(match[1])
}

function sourceBlocks(message: ChatMessage): readonly TrajectorySourceBlock[] {
  const blocks: TrajectorySourceBlock[] = []
  for (const segment of message.segments ?? []) {
    blocks.push({ type: segment.kind, content: segment.text })
  }
  if (message.toolName !== undefined) {
    blocks.push({
      type: 'tool-call',
      content: message.toolInput ?? '',
      ...(message.callId === undefined ? {} : { callId: message.callId }),
      toolName: message.toolName,
    })
  }
  return blocks
}

function messageText(message: ChatMessage, kind: TrajectoryCellKind): string {
  if (kind === 'compacted') return message.compactionSummary ?? 'Context compacted'
  if (kind === 'tool' || kind === 'subtool') return message.toolName ?? (kind === 'tool' ? 'Tool' : 'Subtool')
  if (kind === 'context') return message.contextSummary ?? message.text
  return message.text
}

function groupTitle(kind: TrajectoryCellKind, step: number): string {
  return kind === 'message' || kind === 'tool' || kind === 'subtool'
    ? `Step ${Math.max(1, step)}`
    : 'Message'
}

function rowCell(message: ChatMessage, index: number, kind: TrajectoryCellKind, duration: number | null, step: number, hostTransition: boolean): TrajectoryCellProps {
  const inputDetail = kind === 'tool' || kind === 'subtool' ? message.toolInput : undefined
  const outputDetail = kind === 'tool' || kind === 'subtool'
    ? message.toolOutput
    : kind === 'message' ? message.text : undefined
  const thinkingDetail = kind === 'message'
    ? message.segments?.filter(segment => segment.kind === 'reasoning').map(segment => segment.text).join('\n\n')
    : undefined
  const markdown = kind === 'message' || kind === 'user' || kind === 'context' ? message.text : undefined
  return {
    index,
    recordId: message.key,
    kind,
    text: messageText(message, kind),
    ...(markdown === undefined || markdown === '' ? {} : { previewMarkdown: markdown }),
    ...(kind === 'user' || kind === 'context' ? { opensTurn: kind === 'user', inputDetail: message.text } : {}),
    sourceSeq: index,
    ...(message.host === undefined ? {} : { host: message.host }),
    ...(hostTransition ? { hostTransition: true } : {}),
    ...(kind === 'context' ? { messageSource: message.contextSource } : {}),
    ...(inputDetail === undefined ? {} : { inputDetail }),
    ...(outputDetail === undefined ? {} : { outputDetail }),
    ...((kind === 'tool' || kind === 'subtool') && outputDetail !== undefined
      ? { result: outputDetail, resultPreviewMarkdown: outputDetail }
      : {}),
    ...(thinkingDetail === undefined || thinkingDetail === '' ? {} : { thinkingDetail }),
    ...(message.compactionSummary === undefined ? {} : { outputDetail: message.compactionSummary, previewMarkdown: message.compactionSummary }),
    ...(message.segments === undefined ? {} : { sourceBlocks: sourceBlocks(message) }),
    ...(message.callId === undefined ? {} : { callId: message.callId }),
    ...(message.toolError ? { isError: true } : {}),
    timeSeconds: duration,
    startedAt: message.time,
    sourceMessage: message,
    ...(kind === 'message' && message.segments !== undefined ? {
      assistantMetrics: {
        timingRecorded: false,
        stepStartTime: null,
        firstTokenTime: null,
        completedTime: message.running ? null : message.time,
        usageProvided: false,
        outputTokens: null,
      },
    } : {}),
    ...(step > 0 ? {} : {}),
  }
}

function description(cells: readonly TrajectoryCellProps[]): string | undefined {
  const tools = new Map<string, number>()
  for (const cell of cells) {
    if (cell.kind !== 'tool' && cell.kind !== 'subtool') continue
    const count = tools.get(cell.text) ?? 0
    tools.set(cell.text, count + 1)
  }
  const values = [...tools].map(([name, count]) => count > 1 ? `${name}×${count}` : name)
  return values.length === 0 ? undefined : values.join(' ')
}

export function deriveTrajectoryLayout(input: TrajectoryLayoutInput | readonly ChatMessage[]): readonly TrajectoryTurnModel[] {
  const messages = 'messages' in input ? input.messages : input
  const flat = flattenMessages(messages)
  const turns = new Map<number | null, Map<string, TrajectoryCellProps[]>>()
  let turn = 0
  let step = 0
  let previousTime: number | null = null
  let previousHost: string | undefined
  let lastAssistantTurn: number | null = null
  flat.forEach((message, index) => {
    const kind = kindOf(message)
    const hostTransition = message.host !== undefined && message.host !== previousHost
    if (message.host !== undefined) previousHost = message.host
    if (kind === 'user') {
      turn += 1
      step = 0
    }
    const parsedStep = stepOf(message)
    if (parsedStep !== null) step = parsedStep
    if (kind === 'message' && parsedStep === null) step += 1
    if (kind === 'message') lastAssistantTurn = Math.max(1, turn)
    const activeTurn = turn === 0 && lastAssistantTurn === null ? null : Math.max(1, turn)
    const duration = previousTime === null ? null : Math.max(0, (message.time - previousTime) / 1000)
    previousTime = message.time
    const title = groupTitle(kind, step)
    const groups = turns.get(activeTurn) ?? new Map<string, TrajectoryCellProps[]>()
    const cells = groups.get(title) ?? []
    cells.push(rowCell(message, index + 1, kind, duration, step, hostTransition))
    groups.set(title, cells)
    turns.set(activeTurn, groups)
  })
  return [...turns.entries()].map(([turnNumber, groups]) => ({
    turn: turnNumber,
    groups: [...groups.entries()].map(([title, cells]) => ({
      title,
      ...(description(cells) === undefined ? {} : { description: description(cells) }),
      cells,
    })),
  }))
}

export function appendTrajectoryPartialLayout(
  turns: readonly TrajectoryTurnModel[],
  _partial: unknown,
  _lastIndex: number,
): readonly TrajectoryTurnModel[] {
  return turns
}
