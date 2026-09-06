export interface Transport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  close(): void;
  /** False once the connection has closed (or failed to open); never reopens. */
  isOpen(): boolean;
  /**
   * True only once the handshake has actually completed -- unlike isOpen(), false while
   * still CONNECTING. A caller that advances a wire sequence number per call (NetClient's
   * tick()) must gate on this, not isOpen(): the server's fresh session always expects a
   * client's first real message to start near sequence 1, and isOpen() being true for a
   * merely-attempting connection let that counter run up during however long the
   * handshake took, sometimes past MAX_SEQUENCE_JUMP before a single byte was ever sent.
   */
  isConnected(): boolean;
}

// Bounds the pre-open send queue below. A socket that never finishes connecting (a
// black-holed network path, a server that never accepts) would otherwise let this grow
// forever, since nothing ever flushes or trims it except a successful 'open'.
const MAX_QUEUED_BEFORE_OPEN = 128;
// Codex round 15 (PR #4), the client-side sibling of the server's backpressure-policy.ts:
// socket.send() queued unconditionally once OPEN, with nothing checking bufferedAmount.
// A server (or the network path to it) that stops draining after the handshake completes
// -- not just during CONNECTING, which MAX_QUEUED_BEFORE_OPEN already bounds -- let this
// tab's own outgoing backlog grow forever. 1 MB mirrors the server's bound.
const MAX_BUFFERED_BYTES = 1_000_000;

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
      // An unresponsive peer isn't worth continuing to queue writes for it may never
      // read; closing bounds this tab's own memory the same way the server bounds a
      // slow client's, rather than growing an unbounded backlog silently.
      if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        this.socket.close();
        return;
      }
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

  isConnected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
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
