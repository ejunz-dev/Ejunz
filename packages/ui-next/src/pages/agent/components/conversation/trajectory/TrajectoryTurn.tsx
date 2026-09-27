
import type { ReactNode } from 'react'
import { TrajectoryTurnHeader } from './TrajectoryTurnHeader'
import css from './TrajectoryTurn.module.css'

export interface TrajectoryTurnProps {
  turn: number
  children?: ReactNode
}

export function TrajectoryTurn({ turn, children }: TrajectoryTurnProps) {
  return (
    <section className={css.root} data-turn={turn}>
      <TrajectoryTurnHeader turn={turn} />
      <div className={css.body}>{children}</div>
    </section>
  )
}
