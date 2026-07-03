import React, { useState, useEffect, useCallback } from 'react';
import { request, i18n } from 'vj/utils';
import Notification from 'vj/components/notification';

function normalizeMcpServerName(name: string, fallback: string) {
  const sanitize = (value: string) => value.trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return sanitize(name) || sanitize(fallback) || 'ejunz';
}

export function McpSidebarPanel({ themeStyles, baseId, branch }: { themeStyles: any; baseId?: string; branch?: string }) {
  const domainId = (typeof window !== 'undefined' && (window as any).UiContext?.domainId) || 'system';
  const defaultServerName = `ejunz-${domainId}${baseId ? `-${baseId}` : ''}`;
  const [loading, setLoading] = useState(false);
  const [serverName, setServerName] = useState(defaultServerName);
  const [status, setStatus] = useState<string>('pending');

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const qs: string[] = [];
        if (baseId) qs.push(`baseId=${encodeURIComponent(baseId)}`);
        if (branch) qs.push(`branch=${encodeURIComponent(branch)}`);
        const res: any = await request.get(`/d/${domainId}/mcp/sse/token${qs.length ? `?${qs.join('&')}` : ''}`);
        if (cancelled) return;
        setStatus(res?.exists ? (res.status || 'pending') : 'pending');
      } catch { /* ignore polling errors */ }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [domainId, baseId, branch]);

  const copyText = useCallback(async (text: string) => {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      Notification.success(i18n('Copied'));
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        Notification.success(i18n('Copied'));
        return true;
      } catch {
        Notification.error(i18n('Failed to copy'));
        return false;
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, []);

  const copyConnection = useCallback(async () => {
    setLoading(true);
    try {
      const payload: Record<string, any> = {};
      if (baseId) payload.baseId = baseId;
      if (branch) payload.branch = branch;
      if (serverName.trim()) payload.serverName = serverName.trim();
      const res: any = await request.post(`/d/${domainId}/mcp/sse/token`, payload);
      if (!res?.httpBaseUrl && !res?.httpUrl) {
        Notification.error(i18n('Failed to enable MCP server'));
        return;
      }
      const resolvedName = normalizeMcpServerName(serverName, defaultServerName);
      if (res.serverName && res.serverName !== resolvedName) setServerName(res.serverName);
      setStatus(res.status || 'pending');
      await copyText(`claude mcp add --transport http ${resolvedName} ${res.httpBaseUrl || res.httpUrl}`);
    } catch (e: any) {
      Notification.error(e?.message || i18n('Failed to enable MCP server'));
    } finally {
      setLoading(false);
    }
  }, [domainId, baseId, branch, serverName, copyText]);

  return (
    <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary }}>
      <div style={{ fontWeight: 600, color: themeStyles.textSecondary, marginBottom: '8px', padding: '0 8px' }}>
        {i18n('MCP Server')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 8px' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>{i18n('Claude MCP name')}</span>
          <input
            type="text"
            value={serverName}
            onChange={(e) => setServerName(e.currentTarget.value)}
            disabled={loading}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px',
              fontFamily: 'monospace',
              border: `1px solid ${themeStyles.borderSecondary}`,
              borderRadius: '4px',
              background: themeStyles.bgSecondary,
              color: themeStyles.textPrimary,
            }}
          />
        </label>
        <button
          type="button"
          onClick={copyConnection}
          disabled={loading}
          style={{
            padding: '6px 12px',
            borderRadius: '4px',
            border: 'none',
            alignSelf: 'flex-start',
            background: themeStyles.bgButtonActive,
            color: themeStyles.textOnPrimary,
            cursor: loading ? 'default' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? i18n('Copying...') : i18n('Copy connection command')}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: themeStyles.textTertiary }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: status === 'online' ? themeStyles.success : (status === 'offline' ? themeStyles.textTertiary : themeStyles.borderSecondary),
          }} />
          <span>
            {status === 'online' ? i18n('Connected')
              : status === 'offline' ? i18n('Offline')
                : i18n('Not connected yet')}
          </span>
        </div>
      </div>
    </div>
  );
}
