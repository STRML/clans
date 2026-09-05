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

  it('queues messages that arrive before a handler is attached', async () => {
    server.on('connection', (socket) => socket.send(Uint8Array.of(9, 8, 7)));
    const transport = new WebSocketTransport(`ws://127.0.0.1:${String(PORT)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const received: number[][] = [];
    transport.onMessage((bytes) => received.push([...bytes]));
    expect(received).toEqual([[9, 8, 7]]);
    transport.close();
  });
});
