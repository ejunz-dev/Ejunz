export type SocketOpenHandler = (socket: Sock) => void;
export type SocketCloseHandler = (code: number, reason: string) => void;
export type SocketMessageHandler = (event: MessageEvent, data: string) => void;

export default class Sock {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private closed = false;
  private reconnectDelay = 1000;
  readonly url: string;
  onmessage?: SocketMessageHandler;
  onclose?: SocketCloseHandler;
  onopen?: SocketOpenHandler;

  constructor(url: string, _nocookie = false, _shorty = false, options: { maxReconnectionDelay?: number } = {}) {
    const target = new URL(url, window.location.href);
    target.protocol = target.protocol.replace('http', 'ws');
    this.url = target.toString();
    this.maxReconnectionDelay = options.maxReconnectionDelay ?? 10000;
    this.connect();
  }

  private readonly maxReconnectionDelay: number;

  private connect() {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectDelay = 1000;
      this.heartbeatTimer = window.setInterval(() => this.send('ping'), 30000);
      this.onopen?.(this);
    };
    socket.onmessage = (event) => {
      if (event.data === 'pong') return;
      if (event.data === 'ping') {
        this.send('pong');
        return;
      }
      const data = String(event.data);
      try {
        const parsed = JSON.parse(data);
        if (parsed.error === 'PermissionError' || parsed.error === 'PrivilegeError') {
          this.close();
          return;
        }
      } catch {
        // Non-JSON application messages are forwarded unchanged.
      }
      this.onmessage?.(event, data);
    };
    socket.onclose = (event) => {
      this.clearHeartbeat();
      if (this.socket === socket) this.socket = null;
      this.onclose?.(event.code, event.reason);
      if (event.code < 4000) this.scheduleReconnect();
    };
    socket.onerror = () => socket.close();
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectionDelay);
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  on(event: 'message' | 'close' | 'open', callback: (...args: any[]) => void) {
    if (event === 'message') this.onmessage = callback as SocketMessageHandler;
    if (event === 'close') this.onclose = callback as SocketCloseHandler;
    if (event === 'open') this.onopen = callback as SocketOpenHandler;
  }

  send(data: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(typeof data === 'string' ? data : JSON.stringify(data));
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearHeartbeat();
    this.socket?.close();
    this.socket = null;
  }
}
