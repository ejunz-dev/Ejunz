import { useMemo, useState } from 'react'
import type { HistoryEntry } from '../../../runtime/conversation'
import { eventsToMessages } from '../../../runtime/conversation'
import type { SessionSummary } from '../../../runtime/session'
import type { ChatMessage } from '../../types'
import { TrajectoryTable } from './TrajectoryTable'
import { TrajectoryTimeline } from './TrajectoryTimeline'
import { TrajectoryToolbar } from './TrajectoryToolbar'
import { deriveTrajectoryLayout } from './layout'
import type { TrajectoryTimelineMode, TrajectoryTimeRange } from './timeline'
import { trajectoryTimelineFocusIndexes } from './timeline'
import { trajectoryRecordId } from './trajectory-record'
import { TrajectorySearchIndex } from './trajectory-search-index'
import css from './views.module.css'

export interface TrajectoryViewProps {
  messages: readonly ChatMessage[]
  history?: readonly HistoryEntry[]
  session?: SessionSummary
  historyHasMore?: boolean
  loadingOlder?: boolean
  onLoadOlder?: () => void | Promise<void>
}

const labels: Record<string, string> = {
  'toolbar.aria': 'Trajectory toolbar',
  'toolbar.duration': 'Duration',
  'toolbar.useActualDuration': 'Use actual duration',
  'toolbar.useEqualWidth': 'Use equal-width operations',
  'toolbar.actualTime': 'Actual time',
  'toolbar.turns': 'Turns',
  'toolbar.expandTurns': 'Expand turns',
  'toolbar.collapseTurns': 'Collapse turns',
  'toolbar.calls': 'Calls',
  'toolbar.host': 'Host',
  'toolbar.expandHosts': 'Expand host segments',
  'toolbar.collapseHosts': 'Collapse host segments',
  'toolbar.expandCalls': 'Expand calls',
  'toolbar.collapseCalls': 'Collapse calls',
  'toolbar.search': 'Search trajectory',
  'toolbar.searchPlaceholder': 'Search',
}

export function TrajectoryView({
  messages,
  history,
  session,
  historyHasMore = false,
  loadingOlder = false,
  onLoadOlder,
}: TrajectoryViewProps) {
  const sourceMessages = messages.length > 0
    ? messages
    : history === undefined ? messages : eventsToMessages([...history])
  const turns = useMemo(() => deriveTrajectoryLayout(sourceMessages), [sourceMessages])
  const [actualDuration, setActualDuration] = useState(false)
  const [actualTime, setActualTime] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set())
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(new Set())
  const [collapsedHosts, setCollapsedHosts] = useState<ReadonlySet<number>>(new Set())
  const [selectedTimelineIndex, setSelectedTimelineIndex] = useState<number | null>(null)
  const [timelineRange, setTimelineRange] = useState<TrajectoryTimeRange | null>(null)
  const searchIndex = useMemo(() => {
    const index = new TrajectorySearchIndex()
    index.update([turns])
    return index
  }, [turns])
  const matches = useMemo(() => searchIndex.search(searchQuery), [searchIndex, searchQuery])
  const searchMatchIndexes = useMemo(() => {
    if (matches === null) return null
    return new Set(turns.flatMap(turn => turn.groups.flatMap(group => group.cells)
      .filter(cell => matches.has(trajectoryRecordId(cell))).map(cell => cell.index)))
  }, [matches, turns])
  const timelineMode: TrajectoryTimelineMode = actualDuration
    ? actualTime ? 'actual' : 'duration'
    : actualTime ? 'time' : 'sequence'
  const timelineFocusIndexes = timelineRange === null
    ? null
    : trajectoryTimelineFocusIndexes(turns, timelineRange, timelineMode)
  const collapsibleTurns = useMemo(() => turns
    .filter(turn => turn.turn !== null && turn.groups.flatMap(group => group.cells).filter(cell => cell.kind !== 'system').length > 1)
    .flatMap(turn => turn.turn === null ? [] : [turn.turn]), [turns])
  const collapsibleAssistants = useMemo(() => turns.flatMap(turn => {
    const cells = turn.groups.flatMap(group => group.cells)
    return cells.flatMap((cell, index) => cell.kind === 'message'
      && (cells[index + 1]?.kind === 'tool' || cells[index + 1]?.kind === 'subtool')
      ? [trajectoryRecordId(cell)] : [])
  }), [turns])
  const collapsibleHostStarts = useMemo(() => {
    const cells = turns.flatMap(turn => turn.groups.flatMap(group => group.cells))
    const starts: number[] = []
    let segmentStart: number | undefined
    let segmentLength = 0
    const flush = () => {
      if (segmentStart !== undefined && segmentLength > 1) starts.push(segmentStart)
    }
    for (const cell of cells) {
      if (cell.hostTransition && cell.host !== undefined) {
        flush()
        segmentStart = cell.index
        segmentLength = cell.requestOnly === true ? 0 : 1
      } else if (segmentStart !== undefined && cell.requestOnly !== true) {
        segmentLength += 1
      }
    }
    flush()
    return starts
  }, [turns])
  const allTurnsCollapsed = collapsibleTurns.length > 0 && collapsibleTurns.every(turn => collapsedTurns.has(turn))
  const allAssistantsCollapsed = collapsibleAssistants.length > 0 && collapsibleAssistants.every(id => collapsedAssistants.has(id))
  const allHostsCollapsed = collapsibleHostStarts.length > 0 && collapsibleHostStarts.every(id => collapsedHosts.has(id))
  const toggleTurn = (turn: number) => setCollapsedTurns(current => {
    const next = new Set(current)
    if (next.has(turn)) next.delete(turn)
    else next.add(turn)
    return next
  })
  const toggleAssistant = (id: string) => setCollapsedAssistants(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleHost = (id: number) => setCollapsedHosts(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const toggleAllTurns = () => setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(collapsibleTurns))
  const toggleAllAssistants = () => setCollapsedAssistants(allAssistantsCollapsed ? new Set() : new Set(collapsibleAssistants))
  const toggleAllHosts = () => setCollapsedHosts(allHostsCollapsed ? new Set() : new Set(collapsibleHostStarts))
  return <div className={css.root} data-conversation-composer-overlay data-session-id={session?.sessionId}>
    <TrajectoryToolbar
      actualDuration={actualDuration}
      onActualDurationChange={value => { setActualDuration(value); setTimelineRange(null) }}
      actualTime={actualTime}
      onActualTimeChange={value => { setActualTime(value); setTimelineRange(null) }}
      allTurnsCollapsed={allTurnsCollapsed}
      onToggleAllTurns={toggleAllTurns}
      allAssistantsCollapsed={allAssistantsCollapsed}
      onToggleAllAssistants={toggleAllAssistants}
      searchQuery={searchQuery}
      onSearchQueryChange={setSearchQuery}
      allHostsCollapsed={allHostsCollapsed}
      onToggleAllHosts={toggleAllHosts}
      t={(key) => labels[key] ?? key}
    />
    <TrajectoryTimeline
      turns={turns}
      mode={timelineMode}
      range={timelineRange}
      hasEarlierRecords={historyHasMore}
      onLoadEarlier={async () => { await onLoadOlder?.(); return true }}
      selectedIndex={selectedTimelineIndex}
      searchMatchIndexes={searchMatchIndexes}
      onRangeChange={setTimelineRange}
      onRecordSelect={index => { setTimelineRange(null); setSelectedTimelineIndex(index) }}
      onRecordFocus={setSelectedTimelineIndex}
    />
    <div className={css.ledger}>
      <TrajectoryTable
        turns={turns}
        collapsedHosts={collapsedHosts}
        onToggleHost={toggleHost}
        timelineFocusIndexes={timelineFocusIndexes}
        searchMatchIndexes={searchMatchIndexes}
        onSelectedIndexChange={setSelectedTimelineIndex}
        onRecordSelect={setSelectedTimelineIndex}
        historyLoading={false}
        olderHistoryLoading={loadingOlder}
        hasOlderRecords={historyHasMore}
        onLoadOlder={async () => { await onLoadOlder?.(); return true }}
        onClearSelection={() => { setTimelineRange(null); setSelectedTimelineIndex(null) }}
        collapsedTurns={collapsedTurns}
        onToggleTurn={toggleTurn}
        collapsedAssistants={collapsedAssistants}
        onToggleAssistant={toggleAssistant}
      />
    </div>
  </div>
}
