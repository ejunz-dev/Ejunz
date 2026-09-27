import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Card, Tag } from '@ejunz/ui-next';
import { ActionDialog } from './components/primitives/ActionDialog';
import { useAgentRpc } from './runtime/rpc';
import { useAgentTheme } from './runtime/theme';
// The design tokens (`.eja-app`, with the dark set under `body[data-ds-dark-theme]`)
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
    cwd: string;
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
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`;
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** The state a viewer reads, which is the report plus whether it is still current. */
function runtimeState(row: RuntimeStatus): { text: string; tone: 'ok' | 'warn' | 'off' } {
    if (row.responded) return { text: '在线', tone: 'ok' };
    if (row.online) return { text: '心跳超时', tone: 'warn' };
    return { text: '已停止', tone: 'off' };
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
        <div className="eja-app" data-ds-dark-theme={dark || undefined}>
            <div className="eja-status">
                <header className="eja-status__head">
                    <div>
                        <h1 className="eja-status__title">Agent 运行时</h1>
                        <p className="eja-status__desc">
                            处理本服务器的会话的 Ejunz-Agent 实例。内嵌实例运行在 Ejunz 进程内，因此每个进程一行。
                        </p>
                    </div>
                    <Button variant="ghost" onClick={() => { void load(); }} disabled={busy}>刷新</Button>
                </header>

                {error ? <Callout type="error" title="读取运行时状态失败">{error}</Callout> : null}

                <Card title={`运行时（${rows.length}）`}>
                    {items === null ? (
                        <p className="eja-status__muted">读取中…</p>
                    ) : rows.length === 0 ? (
                        <p className="eja-status__muted">还没有运行时上报过。运行时在服务器开始监听后启动并注册自己。</p>
                    ) : (
                        <ul className="eja-status__list">
                            {rows.map((row) => {
                                const state = runtimeState(row);
                                return (
                                    <li key={row.runtimeId} className="eja-status__row">
                                        <div className="eja-status__main">
                                            <div className="eja-status__line">
                                                <span className="eja-status__name">{row.label}</span>
                                                <Tag className={`eja-status__tag eja-status__tag--${state.tone}`}>{state.text}</Tag>
                                                <span className="eja-status__kind">{row.kind}</span>
                                            </div>
                                            <div className="eja-status__facts">
                                                <span>{row.host}:{row.pid}</span>
                                                <span>版本 {row.version}</span>
                                                <span>会话 {row.attachedSessions}</span>
                                                <span>已运行 {formatDuration(row.uptimeMs)}</span>
                                                <span>上次上报 {formatDuration(row.sinceReportMs)}前</span>
                                            </div>
                                            <div className="eja-status__path" title={row.cwd}>{row.cwd}</div>
                                        </div>
                                        <div className="eja-status__actions">
                                            <Button
                                                variant="ghost"
                                                onClick={() => { setDialogError(null); setLabelDraft(row.label); setRenaming(row); }}
                                            >
                                                重命名
                                            </Button>
                                            {row.responded ? null : (
                                                <Button
                                                    variant="ghost"
                                                    onClick={() => { setDialogError(null); setRemoving(row); }}
                                                >
                                                    删除记录
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
                    title="重命名运行时"
                    description={renaming?.runtimeId}
                    inputLabel="名称"
                    inputValue={labelDraft}
                    inputPlaceholder="例如 builtin@devshell"
                    confirmLabel="保存"
                    busy={busy}
                    error={dialogError}
                    onInputChange={setLabelDraft}
                    onClose={() => { if (!busy) setRenaming(null); }}
                    onConfirm={() => { void confirmRename(); }}
                />

                <ActionDialog
                    open={removing !== null}
                    title="删除运行时记录"
                    description={removing === null ? undefined : `${removing.label}（${removing.runtimeId}）不再上报，其记录将被删除。正在运行的会话不受影响。`}
                    confirmLabel="删除"
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
