import type { CSSProperties } from 'react';

export type StateDotState = 'done' | 'warning' | 'ongoing' | 'error';

const MATRIX_CELLS: readonly (readonly [number, number])[] = [
    [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
];

export function StateDot({ state, size = 10, className }: {
    state: StateDotState;
    size?: number;
    className?: string;
}) {
    const classes = [className].filter(Boolean).join(' ');
    if (state === 'ongoing') {
        return <svg
            className={`eja-stateDotMatrix${classes ? ` ${classes}` : ''}`}
            data-state="ongoing"
            width={size}
            height={size}
            viewBox="0 0 10 10"
            shapeRendering="crispEdges"
            aria-hidden="true"
        >
            {MATRIX_CELLS.map(([x, y], index) => <rect
                key={`${x}-${y}`}
                className="eja-stateDotCell"
                x={x}
                y={y}
                width="2"
                height="2"
                style={{ '--eja-state-dot-delay': `${(index - MATRIX_CELLS.length) * 125}ms` } as CSSProperties}
            />)}
        </svg>;
    }
    return <span
        className={`eja-stateDot${classes ? ` ${classes}` : ''}`}
        data-state={state}
        style={{ width: size, height: size }}
        aria-hidden="true"
    />;
}
