import { useEffect, useRef, useState } from 'react';

/** One host the page can run a session on, as the runtime roster reports it. */
export interface HostOption {
    runtimeId: string;
    label: string;
    kind?: string;
    host?: string;
    pid?: number;
    online?: boolean;
    /** Whether this host serves a session that names none, the pre-choice default. */
    fallback?: boolean;
}

/**
 * The host a session runs on, and the list that changes it.
 *
 * The bar states the host in force — the session's own, or the one a session
 * about to be created will use — because a page that runs sessions on several
 * hosts must say which one answers the next message.
 * @param hosts - every known host; ones that are not online are marked, not offered.
 * @param value - the identity of the host in force, or the empty string when the
 * session names none and the page has not resolved the fallback for it.
 * @param onPick - called with the chosen host's identity.
 * @param disabled - whether a switch is refused right now.
 * @param hint - what the choice means, shown beside the control.
 * @returns the host control: the host in force, and the list that changes it.
 */
export function HostPicker({ hosts, value, onPick, disabled, hint }: {
    hosts: HostOption[];
    value: string;
    onPick: (runtimeId: string) => void;
    disabled?: boolean;
    hint?: string;
}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const chosen = hosts.find((host) => host.runtimeId === value);
    const label = chosen?.label ?? value;

    useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false); };
        const onPointerDown = (event: MouseEvent): void => {
            if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
        };
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [open]);

    const selectable = hosts.filter((host) => host.online !== false);
    return <div className="eja-hostBar" ref={rootRef}>
        <button
            type="button"
            className="eja-hostBar__button"
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={disabled === true}
            onClick={() => setOpen((previous) => !previous)}
        >
            <span className="eja-hostBar__caption">主机</span>
            <span className="eja-hostBar__value">{value === '' ? '未选择' : label}</span>
            {value !== '' && chosen?.online === false && <span className="eja-hostBar__offline">不在线</span>}
            <span className="eja-hostBar__caret" aria-hidden="true">▾</span>
        </button>
        {hint !== undefined && hint !== '' && <span className="eja-hostBar__hint">{hint}</span>}
        {open && <div className="eja-hostBar__menu" role="listbox" aria-label="选择 host">
            {selectable.length === 0 && <p className="eja-hostBar__empty">没有在线的 host</p>}
            {selectable.map((host) => <button
                key={host.runtimeId}
                type="button"
                role="option"
                aria-selected={host.runtimeId === value}
                className="eja-hostBar__option"
                data-active={host.runtimeId === value || undefined}
                onClick={() => { setOpen(false); onPick(host.runtimeId); }}
            >
                <span className="eja-hostBar__optionLabel">{host.label}</span>
                <span className="eja-hostBar__optionCode">{host.runtimeId}</span>
            </button>)}
        </div>}
    </div>;
}
