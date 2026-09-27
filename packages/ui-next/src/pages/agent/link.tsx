import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Card } from '@ejunz/ui-next';
import { useAgentRpc } from './runtime/rpc';
import { useAgentTheme } from './runtime/theme';
import './tokens.css';
import './page.css';
import './status.css';

/** One pairing request, as the host reports it. */
interface LinkStatus {
    code: string;
    label: string;
    host: string;
    pid: number;
    status: 'pending' | 'approved';
    approvedBy?: number;
    createdAt: number;
    expiresAt: number;
    /** Derived by the host: a pending request that can no longer be approved. */
    expired: boolean;
}

/** The code this page is about: the URL's last path segment, whatever domain prefix it carries. */
function codeFromLocation(): string {
    const segments = window.location.pathname.split('/').filter(Boolean);
    return (segments.at(-1) || '').toUpperCase();
}

/** When a request stops being approvable, in words. */
function expiryText(expiresAt: number): string {
    const minutes = Math.max(0, Math.round((expiresAt - Date.now()) / 60000));
    return minutes <= 0 ? '已过期' : `还有 ${minutes} 分钟过期`;
}

export default function AgentLinkPage() {
    const rpc = useAgentRpc();
    const { dark } = useAgentTheme();
    const [code] = useState(codeFromLocation);
    const [link, setLink] = useState<LinkStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        if (!code) {
            setError('这个地址里没有绑定码');
            return;
        }
        try {
            setLink(await rpc('link.status', { code }) as LinkStatus);
            setError(null);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        }
    }, [rpc, code]);

    useEffect(() => { void load(); }, [load]);

    const approve = async () => {
        setBusy(true);
        try {
            await rpc('link.approve', { code });
            await load();
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
            setBusy(false);
        }
    };

    const approved = link?.status === 'approved';
    const approvable = link !== null && !approved && !link.expired;

    return (
        <div className="eja-app" data-ds-dark-theme={dark || undefined}>
            <div className="eja-status">
                <header className="eja-status__head">
                    <div>
                        <h1 className="eja-status__title">绑定 Agent 运行时</h1>
                        <p className="eja-status__desc">
                            一个 Agent 运行时请求在这台服务器上运行。授权后它会拿到凭据，并出现在运行状态列表里。
                        </p>
                    </div>
                </header>

                {error ? <Callout type="error" title="无法读取这个绑定请求">{error}</Callout> : null}

                {link ? (
                    <Card title={link.label}>
                        <ul className="eja-status__list">
                            <li className="eja-status__row">
                                <div className="eja-status__main">
                                    <div className="eja-status__facts">
                                        <span>来源 {link.host}:{link.pid}</span>
                                        <span>绑定码 {link.code}</span>
                                        <span>{approved ? '已授权' : link.expired ? '已过期' : expiryText(link.expiresAt)}</span>
                                    </div>
                                </div>
                                <div className="eja-status__actions">
                                    {approvable ? (
                                        <Button variant="primary" onClick={() => { void approve(); }} disabled={busy}>授权</Button>
                                    ) : (
                                        <Button variant="ghost" onClick={() => { void load(); }} disabled={busy}>刷新</Button>
                                    )}
                                </div>
                            </li>
                        </ul>
                    </Card>
                ) : null}

                {approved ? (
                    <Callout type="info" title="已授权">
                        运行时的日志里会显示它已绑定；这一页可以关掉了。
                    </Callout>
                ) : null}
            </div>
        </div>
    );
}
