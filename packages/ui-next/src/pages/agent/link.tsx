import { useCallback, useEffect, useState } from 'react';
import { Button, Callout, Card } from '@ejunz/ui-next';
import { i18n } from '@/i18n';
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
    return minutes <= 0 ? i18n('Expired') : i18n('Expires in {0} minutes', minutes);
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
            setError(i18n('This URL has no pairing code.'));
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
        <div className="ea-app" data-ds-dark-theme={dark || undefined}>
            <div className="ea-status">
                <header className="ea-status__head">
                    <div>
                        <h1 className="ea-status__title">{i18n('Link an Agent runtime')}</h1>
                        <p className="ea-status__desc">
                            {i18n('An Agent runtime is requesting permission to run on this server. After approval, it will receive credentials and appear in the runtime status list.')}
                        </p>
                    </div>
                </header>

                {error ? <Callout type="error" title={i18n('Could not read this pairing request')}>{error}</Callout> : null}

                {link ? (
                    <Card title={link.label}>
                        <ul className="ea-status__list">
                            <li className="ea-status__row">
                                <div className="ea-status__main">
                                    <div className="ea-status__facts">
                                        <span>{i18n('Source: {0}:{1}', link.host, link.pid)}</span>
                                        <span>{i18n('Pairing code: {0}', link.code)}</span>
                                        <span>{approved ? i18n('Approved') : link.expired ? i18n('Expired') : expiryText(link.expiresAt)}</span>
                                    </div>
                                </div>
                                <div className="ea-status__actions">
                                    {approvable ? (
                                        <Button variant="primary" onClick={() => { void approve(); }} disabled={busy}>{i18n('Approve')}</Button>
                                    ) : (
                                        <Button variant="ghost" onClick={() => { void load(); }} disabled={busy}>{i18n('Refresh')}</Button>
                                    )}
                                </div>
                            </li>
                        </ul>
                    </Card>
                ) : null}

                {approved ? (
                    <Callout type="info" title={i18n('Approved')}>
                        {i18n('The runtime logs will show that it is linked. You can close this page.')}
                    </Callout>
                ) : null}
            </div>
        </div>
    );
}
