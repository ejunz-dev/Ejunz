import { useCallback, useEffect, useRef, useState } from 'react';

export type BaseDetailWsStatus = 'connecting' | 'connected' | 'disconnected';

export interface BaseDetailViewerInfo {
  uid: number;
  uname: string;
  pageType: string;
}

interface Options {
  socketUrl?: string;
  onMessage?: (message: Record<string, any>) => void;
}

function buildWebSocketUrl(socketUrl: string): string {
  const prefix = typeof window !== 'undefined' ? String((window as any).UiContext?.ws_prefix || '') : '';
  const url = new URL(`${prefix}${socketUrl}`, window.location.href);
  url.protocol = url.protocol.replace('http', 'ws');
  return url.toString();
}

export function useBaseDetailWebSocket({ socketUrl, onMessage }: Options) {
  const [status, setStatus] = useState<BaseDetailWsStatus>('disconnected');
  const [viewerCount, setViewerCount] = useState(0);
  const [viewers, setViewers] = useState<BaseDetailViewerInfo[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pingTimerRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const send = useCallback((message: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(typeof message === 'string' ? message : JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (!socketUrl || typeof window === 'undefined') {
      setStatus('disconnected');
      return undefined;
    }
    closedRef.current = false;
    let reconnectDelay = 1000;

    const clearTimers = () => {
      if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current !== null) window.clearInterval(pingTimerRef.current);
      reconnectTimerRef.current = null;
      pingTimerRef.current = null;
    };
    const scheduleReconnect = () => {
      if (closedRef.current || reconnectTimerRef.current !== null) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    };
    const connect = () => {
      clearTimers();
      setStatus('connecting');
      let socket: WebSocket;
      try {
        socket = new WebSocket(buildWebSocketUrl(socketUrl));
      } catch {
        setStatus('disconnected');
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      socket.onopen = () => {
        reconnectDelay = 1000;
        setStatus('connected');
        pingTimerRef.current = window.setInterval(() => send('ping'), 30000);
      };
      socket.onmessage = (event) => {
        if (event.data === 'pong') return;
        if (event.data === 'ping') {
          send('pong');
          return;
        }
        let message: Record<string, any>;
        try {
          message = JSON.parse(String(event.data));
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
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        clearTimers();
        setStatus('disconnected');
        scheduleReconnect();
      };
      socket.onerror = () => socket.close();
    };

    connect();
    return () => {
      closedRef.current = true;
      clearTimers();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [send, socketUrl]);

  return { status, viewerCount, viewers, send };
}
