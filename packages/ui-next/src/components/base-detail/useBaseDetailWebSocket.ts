import { useCallback, useEffect, useRef, useState } from 'react';
import Sock from '../socket';

export type BaseDetailWsStatus = 'connecting' | 'connected' | 'disconnected';

export interface BaseDetailViewerInfo {
  uid: number;
  uname: string;
  pageType: string;
}

interface Options {
  socketUrl?: string;
  /** ws prefix injected by the server (UiContext.ws_prefix). Falls back to window.UiContext, then '/'. */
  wsPrefix?: string;
  onMessage?: (message: Record<string, any>) => void;
}

function buildWebSocketUrl(socketUrl: string, wsPrefix?: string): string {
  const prefix = wsPrefix
    ?? (typeof window !== 'undefined' ? String((window as any).UiContext?.ws_prefix || '/') : '/');
  const normalizedPrefix = prefix.endsWith('/base/') && socketUrl.startsWith('base/') ? prefix.slice(0, -'base/'.length) : prefix;
  return `${normalizedPrefix}${socketUrl}`;
}

export function useBaseDetailWebSocket({ socketUrl, wsPrefix, onMessage }: Options) {
  const [status, setStatus] = useState<BaseDetailWsStatus>('disconnected');
  const [viewerCount, setViewerCount] = useState(0);
  const [viewers, setViewers] = useState<BaseDetailViewerInfo[]>([]);
  const socketRef = useRef<Sock | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const send = useCallback((message: unknown) => socketRef.current?.send(message), []);

  useEffect(() => {
    if (!socketUrl || typeof window === 'undefined') {
      setStatus('disconnected');
      return undefined;
    }
    let disposed = false;
    setStatus('connecting');
    // Defer socket creation by one tick so React StrictMode's dev double-invoke
    // (setup → cleanup → setup) never creates a socket that is closed again while
    // still connecting — that makes the browser log "WebSocket is closed before
    // the connection is established" for a socket that was never meant to live.
    const timer = window.setTimeout(() => {
      if (disposed) return;
      const socket = new Sock(buildWebSocketUrl(socketUrl, wsPrefix));
      socketRef.current = socket;
      socket.onopen = () => { if (!disposed) setStatus('connected'); };
      socket.onclose = () => { if (!disposed) setStatus('disconnected'); };
      socket.onmessage = (_event, data) => {
        if (disposed) return;
        let message: Record<string, any>;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        if (message.type === 'init' || message.type === 'viewer_count') {
          if (typeof message.viewerCount === 'number') setViewerCount(message.viewerCount);
          if (typeof message.count === 'number') setViewerCount(message.count);
        }
        if (message.type === 'viewers_list' && Array.isArray(message.list)) setViewers(message.list);
        onMessageRef.current?.(message);
      };
    }, 0);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, [socketUrl, wsPrefix]);

  return { status, viewerCount, viewers, send };
}
