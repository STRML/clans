// A slow or unresponsive client that never drains its socket would otherwise let Node
// queue every snapshot write forever: socket.send() just appends to an internal buffer
// when the OS socket can't keep up, with nothing here ever checking it. One such client
// can grow unbounded server memory on its own, with no other symptom until it does.
// bufferedAmount is the OS-level backlog of bytes not yet flushed to the network; 1 MB is
// comfortably above any realistic single-tick snapshot burst to every connected client.
export const MAX_BUFFERED_BYTES = 1_000_000;

/**
 * True once a client's outgoing backlog is large enough that it is no longer keeping up.
 * The caller's job is to stop sending to (and disconnect) such a client rather than keep
 * queuing writes it may never read.
 */
export function isClientOverloaded(bufferedAmount: number): boolean {
  return bufferedAmount > MAX_BUFFERED_BYTES;
}
