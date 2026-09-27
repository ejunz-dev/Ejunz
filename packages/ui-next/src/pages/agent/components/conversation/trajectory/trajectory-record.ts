import type { HTMLAttributes } from 'react'
import type { ChatMessage } from '../../types'

export type TrajectoryCellKind = 'system' | 'user' | 'context' | 'compacted' | 'message' | 'tool' | 'subtool'

export interface AssistantMetricDetail {
  timingRecorded: boolean
  stepStartTime: number | null
  firstTokenTime: number | null
  completedTime: number | null
  usageProvided: boolean
  outputTokens: number | null
}

export interface TrajectorySourceBlock {
  type: string
  content: string
  imageSrc?: string
  imageAlt?: string
  callId?: string
  toolName?: string
}

export interface ConversationPromptSnapshot {
  system: string
  tools: readonly { name: string; description: string; parameters: object }[]
}

export interface AssistantRequestConfig {
  provider?: string
  model?: string
  reasoningEffort?: string
  [key: string]: unknown
}

export interface TrajectoryCellProps extends HTMLAttributes<HTMLDivElement> {
  index: number
  recordId?: string
  kind: TrajectoryCellKind
  text: string
  previewMarkdown?: string
  opensTurn?: boolean
  sourceSeq?: number
  host?: string
  hostTransition?: boolean
  messageSource?: unknown
  requestOnly?: boolean
  inputDetail?: string
  promptDetail?: ConversationPromptSnapshot
  previousPromptDetail?: ConversationPromptSnapshot
  outputDetail?: string
  thinkingDetail?: string
  sourceBlocks?: readonly TrajectorySourceBlock[]
  outputBlocks?: readonly TrajectorySourceBlock[]
  schemaDetail?: string
  assistantMetrics?: AssistantMetricDetail
  result?: string
  resultPreviewMarkdown?: string
  callId?: string
  isError?: boolean
  timeSeconds: number | null
  startedAt?: number | null
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  think?: number
  selected?: boolean
  sourceMessage?: ChatMessage
}

export function trajectoryRecordId(cell: TrajectoryCellProps): string {
  if (cell.recordId !== undefined) return cell.recordId
  if (cell.callId !== undefined) return `${cell.kind}:call:${cell.callId}`
  if (cell.sourceSeq !== undefined) return `${cell.kind}:seq:${cell.sourceSeq}`
  return `${cell.kind}:index:${cell.index}`
}

export function formatDurationMillis(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—'
  return `${Math.round(milliseconds).toLocaleString()} ms`
}

export function formatElapsedSeconds(seconds: number | null): string {
  return formatDurationMillis(seconds === null ? null : seconds * 1000)
}
