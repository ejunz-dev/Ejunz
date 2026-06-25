import React, { useState, useEffect, useCallback } from 'react';
import { request, i18n, domainScopedPath } from 'vj/utils';
import Notification from 'vj/components/notification';

export function McpSidebarPanel({ themeStyles, baseId, branch }: { themeStyles: any; baseId?: string; branch?: string }) {
  const domainId = (typeof window !== 'undefined' && (window as any).UiContext?.domainId) || 'system';
  const [loading, setLoading] = useState(false);
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [httpUrl, setHttpUrl] = useState('');
  const [httpCommand, setHttpCommand] = useState('');
  const [mid, setMid] = useState<number | null>(null);
  const [edgeUrl, setEdgeUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('pending');
  const [copied, setCopied] = useState('');

  const enable = useCallback(async () => {
    setLoading(true);
    try {
      const payload: Record<string, any> = {};
      if (baseId) payload.baseId = baseId;
      if (branch) payload.branch = branch;
      const res: any = await request.post(`/d/${domainId}/mcp/sse/token`, payload);
      if (res?.url || res?.httpUrl) {
        setUrl(res.url || '');
        setCommand(res.command || '');
        setHttpUrl(res.httpUrl || '');
        setHttpCommand(res.httpCommand || '');
        setMid(typeof res.mid === 'number' ? res.mid : null);
        setEdgeUrl(res.edgeUrl || null);
        setStatus(res.status || 'pending');
      } else Notification.error(i18n('Failed to enable MCP server'));
    } catch (e: any) {
      Notification.error(e?.message || i18n('Failed to enable MCP server'));
    } finally {
      setLoading(false);
    }
  }, [domainId, baseId, branch]);

  useEffect(() => {
    if (!url && !httpUrl && !loading) enable();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!url && !httpUrl) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const qs: string[] = [];
        if (baseId) qs.push(`baseId=${encodeURIComponent(baseId)}`);
        if (branch) qs.push(`branch=${encodeURIComponent(branch)}`);
        const res: any = await request.get(`/d/${domainId}/mcp/sse/token${qs.length ? `?${qs.join('&')}` : ''}`);
        if (cancelled || !res?.exists) return;
        if (typeof res.mid === 'number') setMid(res.mid);
        setEdgeUrl(res.edgeUrl || null);
        setStatus(res.status || 'pending');
      } catch { /* ignore polling errors */ }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [url, httpUrl, domainId, baseId, branch]);

  const copyText = useCallback(async (text: string, key: string) => {
    if (!text) return;
    const mark = () => { setCopied(key); setTimeout(() => setCopied(''), 1500); };
    try {
      await navigator.clipboard.writeText(text);
      mark();
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); mark(); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  }, []);

  return (
    <div style={{ padding: '8px', fontSize: '12px', color: themeStyles.textPrimary }}>
      <div style={{ fontWeight: 600, color: themeStyles.textSecondary, marginBottom: '8px', padding: '0 8px' }}>
        {i18n('MCP Server')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 8px' }}>
        <div style={{ fontSize: '11px', color: themeStyles.textSecondary, lineHeight: 1.5 }}>
          {i18n('Use Streamable HTTP (recommended). If you previously added an SSE server in Claude Code, remove it first, then run the HTTP command below.')}
        </div>
        {loading ? (
          <div style={{ fontSize: '12px', color: themeStyles.textSecondary, padding: '4px 0' }}>
            {i18n('Generating link...')}
          </div>
        ) : (httpUrl || url) ? (
          <>
            {httpCommand ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>{i18n('Claude Code command · HTTP (recommended)')}</span>
                <textarea
                  readOnly
                  value={httpCommand}
                  rows={3}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '6px 8px',
                    fontFamily: 'monospace',
                    fontSize: '11px',
                    resize: 'vertical',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    borderRadius: '4px',
                    background: themeStyles.bgSecondary,
                    color: themeStyles.textPrimary,
                  }}
                />
                <button
                  type="button"
                  onClick={() => copyText(httpCommand, 'http-cmd')}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '4px',
                    border: 'none',
                    alignSelf: 'flex-start',
                    background: copied === 'http-cmd' ? themeStyles.success : themeStyles.bgButtonActive,
                    color: themeStyles.textOnPrimary,
                    cursor: 'pointer',
                  }}
                >
                  {copied === 'http-cmd' ? i18n('Copied') : i18n('Copy HTTP command')}
                </button>
              </label>
            ) : null}
            {httpUrl ? (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <span style={{ color: themeStyles.textSecondary, fontSize: '11px' }}>{i18n('Connection URL · HTTP')}</span>
                <input
                  type="text"
                  readOnly
                  value={httpUrl}
                  onFocus={(e) => e.currentTarget.select()}
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
            ) : null}
            {command ? (
              <details style={{ fontSize: '11px', color: themeStyles.textSecondary }}>
                <summary style={{ cursor: 'pointer', marginBottom: '6px' }}>{i18n('Legacy SSE (may break after server reload)')}</summary>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                  <span>{i18n('Claude Code command · SSE')}</span>
                  <textarea
                    readOnly
                    value={command}
                    rows={2}
                    onFocus={(e) => e.currentTarget.select()}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '6px 8px',
                      fontFamily: 'monospace',
                      fontSize: '11px',
                      resize: 'vertical',
                      border: `1px solid ${themeStyles.borderSecondary}`,
                      borderRadius: '4px',
                      background: themeStyles.bgSecondary,
                      color: themeStyles.textPrimary,
                    }}
                  />
                </label>
                {url ? (
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span>{i18n('Connection URL · SSE')}</span>
                    <input
                      type="text"
                      readOnly
                      value={url}
                      onFocus={(e) => e.currentTarget.select()}
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
                ) : null}
              </details>
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {httpUrl ? (
                <button
                  type="button"
                  onClick={() => copyText(httpUrl, 'http-url')}
                  style={{
                    padding: '6px 12px',
                    borderRadius: '4px',
                    border: 'none',
                    background: copied === 'http-url' ? themeStyles.success : themeStyles.bgButtonActive,
                    color: themeStyles.textOnPrimary,
                    cursor: 'pointer',
                  }}
                >
                  {copied === 'http-url' ? i18n('Copied') : i18n('Copy HTTP link')}
                </button>
              ) : null}
              <button
                type="button"
                onClick={enable}
                style={{
                  padding: '6px 12px',
                  borderRadius: '4px',
                  border: `1px solid ${themeStyles.borderSecondary}`,
                  background: themeStyles.bgSecondary,
                  color: themeStyles.textSecondary,
                  cursor: 'pointer',
                }}
              >
                {i18n('Regenerate')}
              </button>
              {mid ? (
                <a
                  href={`/d/${domainId}/mcp/${mid}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: '6px 12px',
                    borderRadius: '4px',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    background: themeStyles.bgSecondary,
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                    textDecoration: 'none',
                  }}
                >
                  {i18n('Open MCP page')}
                </a>
              ) : null}
              {edgeUrl ? (
                <a
                  href={edgeUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: '6px 12px',
                    borderRadius: '4px',
                    border: `1px solid ${themeStyles.borderSecondary}`,
                    background: themeStyles.bgSecondary,
                    color: themeStyles.textSecondary,
                    cursor: 'pointer',
                    textDecoration: 'none',
                  }}
                >
                  {i18n('Open Edge page')}
                </a>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: themeStyles.textTertiary }}>
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: status === 'online' ? themeStyles.success : (status === 'offline' ? themeStyles.textTertiary : themeStyles.borderSecondary),
              }} />
              <span>
                {status === 'online' ? i18n('Connected (edge registered)')
                  : status === 'offline' ? i18n('Used before, currently offline')
                    : i18n('Not connected yet')}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: themeStyles.textTertiary, lineHeight: 1.5 }}>
              {i18n('This endpoint exposes CRUD tools for this base\'s outline nodes and cards.')}
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={enable}
            style={{
              padding: '6px 12px',
              borderRadius: '4px',
              border: 'none',
              background: themeStyles.bgButtonActive,
              color: themeStyles.textOnPrimary,
              cursor: 'pointer',
              alignSelf: 'flex-start',
            }}
          >
            {i18n('Enable MCP Server')}
          </button>
        )}
      </div>
    </div>
  );
}
