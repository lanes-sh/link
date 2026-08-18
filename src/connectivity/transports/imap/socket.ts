/**
 * The one place this connector touches a socket.
 *
 * Behind an interface for the same reason `HttpConnectorOptions.fetch` is: a
 * test needs to drive the protocol without a server, and the protocol is where
 * the bugs are. Everything above this file speaks in bytes and never learns
 * whether they came from Bun, from Node, or from an array in a test.
 */

export interface ImapSocket {
  write(data: Uint8Array): Promise<void>;
  /** The next chunk, or null once the peer has gone away. */
  read(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface SocketTarget {
  readonly host: string;
  readonly port: number;
  readonly signal?: AbortSignal | undefined;
}

export type SocketFactory = (target: SocketTarget) => Promise<ImapSocket>;

/**
 * Connect over implicit TLS.
 *
 * There is no plaintext option, and the manifest schema has no flag for one.
 * IMAP's `LOGIN` puts the password on the wire in the clear, so a cleartext
 * session is not a degraded mode — it is a credential disclosure, and offering
 * it as configuration invites someone to reach for it while debugging.
 */
export const connectTls: SocketFactory = async (target) => {
  const incoming: Uint8Array[] = [];
  let waiting: ((chunk: Uint8Array | null) => void) | null = null;
  let draining: (() => void) | null = null;
  let ended = false;
  let failure: Error | null = null;

  const deliver = (chunk: Uint8Array | null): void => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(chunk);
      return;
    }
    if (chunk) incoming.push(chunk);
  };

  const socket = await Bun.connect({
    hostname: target.host,
    port: target.port,
    tls: true,
    socket: {
      data(_socket, data) {
        deliver(new Uint8Array(data));
      },
      drain() {
        const resume = draining;
        draining = null;
        resume?.();
      },
      close() {
        ended = true;
        deliver(null);
      },
      error(_socket, error) {
        failure = error;
        ended = true;
        deliver(null);
      },
    },
  });

  return {
    async write(data) {
      // Written in a loop because a large APPEND — saving a sent message back
      // to the mailbox — will not fit in the socket's buffer in one go, and a
      // short write that goes unnoticed truncates the message.
      let offset = 0;
      while (offset < data.length) {
        const written = socket.write(data.subarray(offset));
        if (written > 0) {
          offset += written;
          continue;
        }
        if (ended) throw failure ?? new Error('The connection closed while sending.');
        await new Promise<void>((resolve) => {
          draining = resolve;
        });
      }
    },

    async read() {
      if (incoming.length > 0) return incoming.shift()!;
      if (ended) {
        if (failure) throw failure;
        return null;
      }
      return new Promise<Uint8Array | null>((resolve) => {
        waiting = resolve;
        target.signal?.addEventListener('abort', () => resolve(null), { once: true });
      });
    },

    async close() {
      ended = true;
      socket.end();
    },
  };
};
