
import css from './TrajectoryGroupHeader.module.css'

export interface TrajectoryGroupHeaderProps {
  title: string
  description?: string
}

export function TrajectoryGroupHeader({ title, description }: TrajectoryGroupHeaderProps) {
  return (
    <div className={css.root}>
      <span className={css.title}>{title}</span>
      {description !== undefined && description !== ''
        ? <span className={css.description}>{description}</span>
        : null}
    </div>
  )
}
