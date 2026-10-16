import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Card, Tag } from '@ejunz/ui-next';
import { i18n } from '@/i18n';
import { ActionDialog } from './components/primitives/ActionDialog';
import { useAgentRpc } from './runtime/rpc';
import { useAgentTheme } from './runtime/theme';
// The design tokens (`.eza-app`, with the dark set under `body[data-ds-dark-theme]`)
// and the app-frame baseline both live with the chat page's styles; this page
// renders inside the same frame, so it loads them explicitly rather than
// inheriting them from a sibling's import.
import './tokens.css';
import './page.css';
import './status.css';

/** How often the page re-reads the registry while it is on screen. */
const REFRESH_MS = 10_000;

/** One runtime's row, as the host reports it. */
interface RuntimeStatus {
    runtimeId: string;
    label: string;
    kind: string;
    host: string;
    pid: number;
    version: string;
    attachedSessions: number;
    /** The runtime's own last report said it was live. */
    online: boolean;
    /** That report is still within the host's freshness window. */
    responded: boolean;
    startedAt: number;
    updatedAt: number;
    uptimeMs: number;
    sinceReportMs: number;
}

function formatDuration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return i18n('{0} seconds', seconds);
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return i18n('{0} minutes', minutes);
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return i18n('{0} hours {1} minutes', hours, minutes % 60);
    return i18n('{0} days {1} hours', Math.floor(hours / 24), hours % 24);
}

/** The state a viewer reads, which is the report plus whether it is still current. */
function runtimeState(row: RuntimeStatus): { text: string; tone: 'ok' | 'warn' | 'off' } {
    if (row.responded) return { text: i18n('Online'), tone: 'ok' };
    if (row.online) return { text: i18n('Heartbeat timed out'), tone: 'warn' };
    return { text: i18n('Stopped'), tone: 'off' };
}

export default function AgentStatusPage() {
    const rpc = useAgentRpc();
    const { dark } = useAgentTheme();
    const [items, setItems] = useState<RuntimeStatus[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [dialogError, setDialogError] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<RuntimeStatus | null>(null);
    const [removing, setRemoving] = useState<RuntimeStatus | null>(null);
    const [labelDraft, setLabelDraft] = useState('');

    const load = useCallback(async () => {
        try {
            const value = await rpc('host.status', {}) as { items?: RuntimeStatus[] };
            setItems(Array.isArray(value?.items) ? value.items : []);
            setError(null);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    }, [rpc]);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        const stop = () => {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
        };
        const start = () => {
            if (timer !== null) return;
            void load();
            timer = setInterval(() => { void load(); }, REFRESH_MS);
        };
        const sync = () => {
            if (document.hidden) stop();
            else start();
        };
        sync();
        document.addEventListener('visibilitychange', sync);
        return () => {
            stop();
            document.removeEventListener('visibilitychange', sync);
        };
    }, [load]);

    const confirmRename = async () => {
        if (!renaming) return;
        setBusy(true);
        setDialogError(null);
        try {
            await rpc('host.label', { runtimeId: renaming.runtimeId, label: labelDraft });
            setRenaming(null);
            await load();
        } catch (failure) {
            setDialogError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    const confirmRemove = async () => {
        if (!removing) return;
        setBusy(true);
        setDialogError(null);
        try {
            await rpc('host.remove', { runtimeId: removing.runtimeId });
            setRemoving(null);
            await load();
        } catch (failure) {
            setDialogError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    const rows = items ?? [];

    return (
        <div className="eza-app" data-ds-dark-theme={dark || undefined}>
            <div className="eza-status">
                <header className="eza-status__head">
                    <div>
                        <h1 className="eza-status__title">{i18n('Agent runtimes')}</h1>
                        <p className="eza-status__desc">
                            {i18n('Ejunz-Agent instances that handle this server’s sessions. The embedded instance runs inside the Ejunz process, so each process appears as one row.')}
                        </p>
                    </div>
                    <Button variant="ghost" onClick={() => { void load(); }} disabled={busy}>{i18n('Refresh')}</Button>
                </header>

                {error ? <Callout type="error" title={i18n('Failed to load runtime status')}>{error}</Callout> : null}

                <Card title={i18n('Runtimes ({0})', rows.length)}>
                    {items === null ? (
                        <p className="eza-status__muted">{i18n('Loading...')}</p>
                    ) : rows.length === 0 ? (
                        <p className="eza-status__muted">{i18n('No runtime has reported yet. It starts and registers after the server begins listening.')}</p>
                    ) : (
                        <ul className="eza-status__list">
                            {rows.map((row) => {
                                const state = runtimeState(row);
                                return (
                                    <li key={row.runtimeId} className="eza-status__row">
                                        <div className="eza-status__main">
                                            <div className="eza-status__line">
                                                <span className="eza-status__name">{row.label}</span>
                                                <Tag className={`eza-status__tag eza-status__tag--${state.tone}`}>{state.text}</Tag>
                                                <span className="eza-status__kind">{row.kind}</span>
                                            </div>
                                            <div className="eza-status__facts">
                                                <span>{row.host}:{row.pid}</span>
                                                <span>{i18n('Version {0}', row.version)}</span>
                                                <span>{i18n('{0} sessions', row.attachedSessions)}</span>
                                                <span>{i18n('Uptime: {0}', formatDuration(row.uptimeMs))}</span>
                                                <span>{i18n('Last report: {0} ago', formatDuration(row.sinceReportMs))}</span>
                                            </div>
                                        </div>
                                        <div className="eza-status__actions">
                                            <Button
                                                variant="ghost"
                                                onClick={() => { setDialogError(null); setLabelDraft(row.label); setRenaming(row); }}
                                            >
                                                {i18n('Rename')}
                                            </Button>
                                            {row.responded ? null : (
                                                <Button
                                                    variant="ghost"
                                                    onClick={() => { setDialogError(null); setRemoving(row); }}
                                                >
                                                    {i18n('Delete record')}
                                                </Button>
                                            )}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </Card>

                <ActionDialog
                    open={renaming !== null}
                    title={i18n('Rename runtime')}
                    description={renaming?.runtimeId}
                    inputLabel={i18n('Name')}
                    inputValue={labelDraft}
                    inputPlaceholder={i18n('e.g. builtin@devshell')}
                    confirmLabel={i18n('Save')}
                    busy={busy}
                    error={dialogError}
                    onInputChange={setLabelDraft}
                    onClose={() => { if (!busy) setRenaming(null); }}
                    onConfirm={() => { void confirmRename(); }}
                />

                <ActionDialog
                    open={removing !== null}
                    title={i18n('Delete runtime record')}
                    description={removing === null ? undefined : i18n('Runtime {0} ({1}) no longer reports and its record will be deleted. Running sessions are unaffected.', removing.label, removing.runtimeId)}
                    confirmLabel={i18n('Delete')}
                    danger
                    busy={busy}
                    error={dialogError}
                    onClose={() => { if (!busy) setRemoving(null); }}
                    onConfirm={() => { void confirmRemove(); }}
                />
            </div>
        </div>
    );
}
