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
});
