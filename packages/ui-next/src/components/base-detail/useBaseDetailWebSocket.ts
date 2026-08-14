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
  onMessage?: (message: Record<string, any>) => void;
}

function buildWebSocketUrl(socketUrl: string): string {
  const prefix = typeof window !== 'undefined' ? String((window as any).UiContext?.ws_prefix || '') : '';
  return `${prefix}${socketUrl}`;
}

export function useBaseDetailWebSocket({ socketUrl, onMessage }: Options) {
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
    setStatus('connecting');
    const socket = new Sock(buildWebSocketUrl(socketUrl));
    socketRef.current = socket;
    socket.onopen = () => setStatus('connected');
    socket.onclose = () => setStatus('disconnected');
    socket.onmessage = (_event, data) => {
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
    return () => {
      socket.close();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [socketUrl]);

  return { status, viewerCount, viewers, send };
}
