
import type { TrajectoryCellProps } from './trajectory-record'
import { trajectoryRecordId } from './trajectory-record'

const CONTENT_ROW_HEIGHT = 30
const COLLAPSED_SUMMARY_HEIGHT = 20
const TERMINAL_BOUNDARY_HEIGHT = 9

export interface VirtualizableTrajectoryRecord {
  cell: TrajectoryCellProps
  collapsedSummaryKind?: 'turn' | 'assistant' | 'host'
}

export interface TrajectoryVirtualRowEntry<T extends VirtualizableTrajectoryRecord> {
  logicalIndex: number
  record: T
}

export interface TrajectoryVirtualRow<T extends VirtualizableTrajectoryRecord> {
  entries: readonly TrajectoryVirtualRowEntry<T>[]
  height: number
  key: string
}

export function trajectoryVirtualRecordKey(
  record: VirtualizableTrajectoryRecord,
): string {
  const identity = encodeURIComponent(trajectoryRecordId(record.cell))
  return record.collapsedSummaryKind === undefined
    ? identity
    : `${identity}\u0000summary\u0000${record.collapsedSummaryKind}`
}

export function groupTrajectoryVirtualRows<T extends VirtualizableTrajectoryRecord>(
  records: readonly T[],
): readonly TrajectoryVirtualRow<T>[] {
  const rows: TrajectoryVirtualRow<T>[] = []
  let pending: TrajectoryVirtualRowEntry<T>[] = []

  for (const [logicalIndex, record] of records.entries()) {
    const entry = { logicalIndex, record }
    if (record.cell.requestOnly === true) {
      pending.push(entry)
      continue
    }
    const entries = [...pending, entry]
    pending = []
    rows.push({
      entries,
      height: record.collapsedSummaryKind === undefined
        ? CONTENT_ROW_HEIGHT
        : COLLAPSED_SUMMARY_HEIGHT,
      key: trajectoryVirtualRecordKey(record),
    })
  }

  if (pending.length > 0) {
    rows.push({
      entries: pending,
      height: TERMINAL_BOUNDARY_HEIGHT,
      key: pending.map(candidate => trajectoryVirtualRecordKey(candidate.record)).join('|'),
    })
  }

  return rows
}
