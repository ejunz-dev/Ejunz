import { useCallback } from 'react';
import { useUiContext } from '@ejunz/ui-next';
import { usePageData } from '../../../context/page-data';

/** Domain URL prefix: the `system` domain is served at the site root. */
export function domainPrefix(domainId: string): string {
    return domainId === 'system' ? '' : `/d/${encodeURIComponent(domainId)}`;
}

/**
 * Call one Ejunz-Agent RPC method for the domain the page is showing.
 *
 * Every page of this plugin reaches the host through the same channel, so the
 * envelope, the domain scoping, and the login redirect live here rather than in
 * each page.
 * @returns the method's value, or a thrown failure carrying the host's message.
 */
export function useAgentRpc(): (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown> {
    const { domainId } = useUiContext();
    const { args } = usePageData();
    const currentDomainId = String(domainId || 'system');
    const prefix = domainPrefix(currentDomainId);
    const hasAgentId = Object.prototype.hasOwnProperty.call(args, 'agentId');
    const agentId = !hasAgentId ? undefined : args.agentId === null ? null : Number.isSafeInteger(Number(args.agentId)) && Number(args.agentId) > 0 ? Number(args.agentId) : null;
    return useCallback(async (method: string, payload: unknown, signal?: AbortSignal) => {
        const res = await fetch(`${prefix}/api/ejunz-agent/rpc/${method}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            ...(signal === undefined ? {} : { signal }),
            body: JSON.stringify({
                type: 'client-request',
                rpcId: `ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                method,
                payload,
                domainId: currentDomainId,
                ...(hasAgentId ? { agentId } : {}),
            }),
        });
        if (res.redirected) {
            window.location.href = res.url;
            throw new Error('登录跳转中');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as {
            type?: string;
            result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
            error?: { code?: string; message?: string };
        };
        if (data.type === 'server-response' && data.result?.ok) return data.result.value;
        const failure = data.result?.error ?? data.error;
        const message = failure?.message || `RPC ${method} failed`;
        throw new Error(failure?.code ? `${failure.code}: ${message}` : message);
    }, [agentId, currentDomainId, hasAgentId, prefix]);
}
