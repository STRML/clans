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
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(bytes);
    else if (this.socket.readyState === WebSocket.CONNECTING) {
      // Drop the newest attempted send once at capacity rather than evicting the
      // oldest: the very first queued frame is the client's Join, and losing that
      // would silently strand the connection with no Welcome ever coming back. A
      // socket connecting this long has already made its queued input samples stale.
      if (this.outgoing.length < MAX_QUEUED_BEFORE_OPEN) this.outgoing.push(bytes);
    }
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
