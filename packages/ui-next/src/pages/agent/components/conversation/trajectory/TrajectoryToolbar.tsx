
import { IconSearchOutline16 } from './trajectory-primitives'
import css from './TrajectoryToolbar.module.css'

export interface TrajectoryToolbarProps {
  actualDuration: boolean
  onActualDurationChange: (actualDuration: boolean) => void
  actualTime: boolean
  onActualTimeChange: (actualTime: boolean) => void
  allTurnsCollapsed: boolean
  onToggleAllTurns: () => void
  allAssistantsCollapsed: boolean
  onToggleAllAssistants: () => void
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  allHostsCollapsed: boolean
  onToggleAllHosts: () => void
  t: (key: string) => string
}

export function TrajectoryToolbar({
  actualDuration,
  onActualDurationChange,
  actualTime,
  onActualTimeChange,
  allTurnsCollapsed,
  onToggleAllTurns,
  allAssistantsCollapsed,
  onToggleAllAssistants,
  searchQuery,
  onSearchQueryChange,
  allHostsCollapsed,
  onToggleAllHosts,
  t,
}: TrajectoryToolbarProps) {
  return (
    <div className={css.root} role="toolbar" aria-label={t('toolbar.aria')}>
      <div className={css.inner}>
        <div className={css.actions}>
          <button
            type="button"
            className={css.toggle}
            aria-label={t('toolbar.useActualDuration')}
            aria-pressed={actualDuration}
            title={actualDuration ? t('toolbar.useEqualWidth') : t('toolbar.useActualDuration')}
            onClick={() => { onActualDurationChange(!actualDuration) }}
          >
            <svg
              className={css.toggleIcon}
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="5.25" />
              <path d="M8 4.75V8l2.25 1.5" />
            </svg>
            {t('toolbar.duration')}
          </button>
          <button
            type="button"
            className={css.control}
            role="switch"
            aria-checked={actualTime}
            hidden
            onClick={() => { onActualTimeChange(!actualTime) }}
          >
            <span>{t('toolbar.actualTime')}</span>
            <span className={css.controlTrack} data-on={actualTime || undefined} aria-hidden="true">
              <span className={css.controlThumb} />
            </span>
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns')}
            aria-pressed={allTurnsCollapsed}
            title={allTurnsCollapsed ? t('toolbar.expandTurns') : t('toolbar.collapseTurns')}
            onClick={onToggleAllTurns}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allTurnsCollapsed ? '⊞' : '⊟'}
            </span>
            {t('toolbar.turns')}
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls')}
            aria-pressed={allAssistantsCollapsed}
            title={allAssistantsCollapsed ? t('toolbar.expandCalls') : t('toolbar.collapseCalls')}
            onClick={onToggleAllAssistants}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allAssistantsCollapsed ? '⊞' : '⊟'}
            </span>
            {t('toolbar.calls')}
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allHostsCollapsed ? t('toolbar.expandHosts') : t('toolbar.collapseHosts')}
            aria-pressed={allHostsCollapsed}
            title={allHostsCollapsed ? t('toolbar.expandHosts') : t('toolbar.collapseHosts')}
            onClick={onToggleAllHosts}
          >
            <span className={css.actionIcon} aria-hidden="true">
              {allHostsCollapsed ? '⊞' : '⊟'}
            </span>
            {t('toolbar.host')}
          </button>
        </div>
        <div className={css.search}>
          <IconSearchOutline16 size={11} className={css.searchIcon} />
          <input
            type="search"
            className={css.searchInput}
            aria-label={t('toolbar.search')}
            placeholder={t('toolbar.searchPlaceholder')}
            value={searchQuery}
            onChange={(event) => { onSearchQueryChange(event.currentTarget.value) }}
          />
        </div>
      </div>
    </div>
  )
}
