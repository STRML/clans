export interface Transport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  close(): void;
  /** False once the connection has closed (or failed to open); never reopens. */
  isOpen(): boolean;
}

// Bounds the pre-open send queue below. A socket that never finishes connecting (a
// black-holed network path, a server that never accepts) would otherwise let this grow
// forever, since nothing ever flushes or trims it except a successful 'open'.
const MAX_QUEUED_BEFORE_OPEN = 128;

export class WebSocketTransport implements Transport {
  private readonly socket: WebSocket;
  private handler: ((bytes: Uint8Array) => void) | null = null;
  private readonly queue: Uint8Array[] = [];
  /** Bytes sent before the socket opened. The join is sent synchronously on construction. */
  private readonly outgoing: Uint8Array[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', (event: MessageEvent) => {
      this.deliver(new Uint8Array(event.data as ArrayBuffer));
    });
    this.socket.addEventListener('open', () => {
      for (const bytes of this.outgoing) this.socket.send(bytes);
      this.outgoing.length = 0;
    });
  }

  private deliver(bytes: Uint8Array): void {
    if (this.handler) this.handler(bytes);
    else this.queue.push(bytes);
  }

  send(bytes: Uint8Array): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(bytes);
      return;
    }
    if (this.socket.readyState !== WebSocket.CONNECTING) return;
    this.outgoing.push(bytes);
    // Codex round 9 (PR #4): dropping every attempted send once at capacity (keeping only
    // the earliest ones) meant a socket slow enough to fill this queue flushed ancient
    // early-connection input the moment it finally opened, then jumped straight to
    // whatever sequence the client was on by then. The server's redundant-sample catch-up
    // only ever recovers the 2 most recent ticks, so that gap was permanent. Evicting from
    // just after the protected first entry instead keeps the first send (the client's
    // Join — losing it would silently strand the connection with no Welcome ever coming
    // back) plus the MOST RECENT input, so what eventually flushes reflects where the
    // client actually is, not where it was when the connection attempt started.
    if (this.outgoing.length > MAX_QUEUED_BEFORE_OPEN) this.outgoing.splice(1, 1);
  }

  isOpen(): boolean {
    return (
      this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING
    );
  }

  onMessage(handler: (bytes: Uint8Array) => void): void {
    this.handler = handler;
    while (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) handler(next);
    }
  }

  close(): void {
    this.socket.close();
  }
}
