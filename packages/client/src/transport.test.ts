import net, { type AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketTransport } from './transport.js';

describe('WebSocketTransport', () => {
  let server: WebSocketServer;
  const PORT = 17733;

  beforeEach(async () => {
    server = new WebSocketServer({ port: PORT });
    await new Promise<void>((resolve) => server.once('listening', resolve));
  });
  afterEach(() => server.close());

  it('sends bytes the server receives', async () => {
    const received = new Promise<Uint8Array>((resolve) => {
      server.once('connection', (socket) =>
        socket.once('message', (data) => resolve(new Uint8Array(data as Uint8Array))),
      );
    });
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    transport.send(Uint8Array.of(1, 2, 3));
    expect([...(await received)]).toEqual([1, 2, 3]);
    transport.close();
  });

  it('delivers bytes sent before the socket opened, in order', async () => {
    const received = new Promise<number[][]>((resolve) => {
      const frames: number[][] = [];
      server.once('connection', (socket) =>
        socket.on('message', (data) => {
          frames.push([...new Uint8Array(data as Uint8Array)]);
          if (frames.length === 2) resolve(frames);
        }),
      );
    });
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    // No await: the socket is still CONNECTING, as when NetClient sends its join.
    transport.send(Uint8Array.of(1));
    transport.send(Uint8Array.of(2));
    expect(await received).toEqual([[1], [2]]);
    transport.close();
  });

  it('queues messages that arrive before a handler is attached', async () => {
    server.on('connection', (socket) => socket.send(Uint8Array.of(9, 8, 7)));
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const received: number[][] = [];
    transport.onMessage((bytes) => received.push([...bytes]));
    expect(received).toEqual([[9, 8, 7]]);
    transport.close();
  });

  it('reports open while connecting and closed after close(), and never reopens', async () => {
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    expect(transport.isOpen()).toBe(true); // still CONNECTING
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.isOpen()).toBe(true); // now OPEN
    transport.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.isOpen()).toBe(false);
  });

  it('distinguishes isConnected() (true only once open) from isOpen() (true while connecting too)', async () => {
    // Codex round 14 (PR #4): NetClient.tick() gated advancing its wire sequence number
    // on isOpen(), which is also true while merely CONNECTING. isConnected() exists so a
    // caller can tell "the handshake actually completed" apart from "still attempting".
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    expect(transport.isOpen()).toBe(true); // still CONNECTING
    expect(transport.isConnected()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.isConnected()).toBe(true); // now OPEN
    transport.close();
  });

  it('bounds the pre-open send queue on a socket that never finishes connecting', async () => {
    // Codex round 3 (PR #4): the queue of bytes held for a still-CONNECTING socket had
    // no limit, so a black-holed connection (accepted at the TCP level but never
    // completing the WebSocket upgrade) grew it forever.
    const stalled = net.createServer(() => {
      // Accept the TCP connection but never write an HTTP upgrade response, so the
      // WebSocket handshake -- and readyState -- never leaves CONNECTING.
    });
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const stalledPort = (stalled.address() as AddressInfo).port;
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(stalledPort)}`);
    for (let i = 0; i < 500; i += 1) transport.send(Uint8Array.of(i % 256));
    expect(transport.isOpen()).toBe(true); // still CONNECTING
    const outgoing = (transport as unknown as { outgoing: unknown[] }).outgoing;
    expect(outgoing.length).toBe(128);
    transport.close();
    stalled.close();
  });

  it('flushes the first send plus the most recent ones once open, not the earliest after it', async () => {
    // Codex round 9 (PR #4): the old policy dropped every send attempted once the queue
    // was full, keeping only the earliest ones. A socket slow enough to fill it flushed
    // ancient early-connection input the moment it finally opened, then jumped straight
    // to whatever sequence the client was on by then — a gap the server's 2-tick
    // redundant-sample catch-up cannot recover, so it was permanent and unrecoverable.
    const received = new Promise<number[][]>((resolve) => {
      const frames: number[][] = [];
      server.once('connection', (socket) => {
        socket.on('message', (data) => {
          frames.push([...new Uint8Array(data as Uint8Array)]);
          if (frames.length === 128) resolve(frames);
        });
      });
    });
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    // Byte 0 stands in for the client's Join, always sent first; the rest simulate 500
    // ticks of local prediction while the connection is still slow to complete.
    transport.send(Uint8Array.of(0));
    for (let i = 1; i <= 500; i += 1) transport.send(Uint8Array.of(i % 256));
    const frames = await received;
    expect(frames[0]).toEqual([0]);
    expect(frames[frames.length - 1]).toEqual([500 % 256]);
    transport.close();
  });
});
