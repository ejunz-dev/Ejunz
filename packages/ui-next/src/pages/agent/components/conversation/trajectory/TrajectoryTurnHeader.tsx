
import css from './TrajectoryTurnHeader.module.css'

const COLUMN_LABELS = ['Input', 'Output', 'Think', 'Time'] as const

export interface TrajectoryTurnHeaderProps {
  turn: number
}

export function TrajectoryTurnHeader({ turn }: TrajectoryTurnHeaderProps) {
  return (
    <div className={css.root}>
      <div className={css.inner}>
        <span className={css.title}>Turn {turn}</span>
        <div className={css.columns} aria-hidden="true">
          {COLUMN_LABELS.map(label => (
            <span key={label} className={css.column}>{label}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
