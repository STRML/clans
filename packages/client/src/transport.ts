export interface Transport {
  send(bytes: Uint8Array): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  close(): void;
}

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
    else if (this.socket.readyState === WebSocket.CONNECTING) this.outgoing.push(bytes);
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
