import { asText, ResponseAssembler, tokenize, type ImapToken } from './parser.ts';
import { connectTls, type ImapSocket, type SocketFactory } from './socket.ts';

/**
 * An IMAP session, and the policy for how long to keep one.
 *
 * One socket per connection, reused for a burst of tool calls, closed when idle.
 * Not a pool: an IMAP session is *stateful* — the selected mailbox is session
 * state — so a pool needs affinity or a re-SELECT per checkout, and its
 * warm/cold divergence is exactly the thing ADR-002's statelessness asks us not
 * to reason about. One socket has neither problem, and a cold instance simply
 * opens one.
 *
 * Reused rather than opened per call because Apple throttles reconnection far
 * harder than it throttles an open session, and a five-tool agent turn would
 * otherwise be five TLS handshakes and five logins.
 */

export interface ImapCredential {
  readonly username: string;
  readonly password: string;
}

export interface ImapClientOptions {
  readonly host: string;
  readonly port: number;
  readonly credential: () => Promise<ImapCredential>;
  /** Injected in tests; defaults to implicit TLS over Bun's socket. */
  readonly socket?: SocketFactory;
  /** How long a session survives with nothing to do. */
  readonly idleMs?: number;
  readonly signal?: AbortSignal | undefined;
  /**
   * One line to append when the server refuses the credential, in the
   * provider's own words. Declared as `setup.troubleshooting`; this transport
   * must not know which vendor it is talking to.
   */
  readonly troubleshooting?: string | undefined;
}

export interface CommandResult {
  readonly status: 'OK' | 'NO' | 'BAD';
  /** The text after the status word, which is what a server explains itself in. */
  readonly text: string;
  /** Every `*` response the command produced, already tokenised. */
  readonly untagged: readonly ImapToken[][];
}

export class ImapError extends Error {
  constructor(
    message: string,
    readonly status: 'NO' | 'BAD',
  ) {
    super(message);
    this.name = 'ImapError';
  }
}

/**
 * Strip anything secret from a line before it can reach a log or an error.
 *
 * The only real leak channel this connector has. A failed `LOGIN` is exactly
 * when someone wants the trace, and the failing command carries the password —
 * so redaction lives here rather than being remembered at each call site.
 */
export function redactTrace(line: string): string {
  return line
    .replace(/^(\s*\S+\s+LOGIN\s+\S+\s+)\S.*$/i, '$1***')
    .replace(/^(\s*\S+\s+AUTHENTICATE\s+\S+\s+)\S.*$/i, '$1***');
}

/**
 * Quote a string for the wire, escaping what IMAP says must be escaped.
 *
 * CR, LF and NUL are refused rather than escaped, because a quoted string has
 * no way to carry them — RFC 3501 builds the grammar from QUOTED-CHAR, which
 * excludes all three — and `exchange` writes a command as one CRLF-terminated
 * line. Escaping only the backslash and the quote would let a newline end that
 * line early, and the server would read what followed as the next command on an
 * already-authenticated session. `searchCriteria` puts tool arguments through
 * here, so that is reachable from a caller, not just from our own code.
 *
 * Refusing is the whole fix. The RFC's answer for arbitrary octets is a literal
 * (`{n}` and then the bytes), but a literal needs a continuation round-trip and
 * every call site here is a single-shot string — and nothing legitimate, no
 * mailbox name and no search term, carries a bare CR.
 *
 * The value never reaches the message: one of the callers is `LOGIN`.
 */
export function quoted(value: string): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error('An IMAP string cannot contain a carriage return, newline, or NUL byte.');
  }
  return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

export interface ImapClient {
  /**
   * Run a unit of work against a live, authenticated session.
   *
   * Serialised: IMAP has one selected mailbox at a time, so two overlapping
   * callers would silently read each other's folder.
   */
  run<T>(work: (session: ImapSession) => Promise<T>, options?: { retry?: boolean }): Promise<T>;
  close(): Promise<void>;
}

export interface ImapSession {
  readonly capabilities: ReadonlySet<string>;
  readonly username: string;
  command(text: string): Promise<CommandResult>;
  /** Send a command whose argument is a literal — APPEND's message body. */
  commandWithLiteral(prefix: string, literal: Uint8Array): Promise<CommandResult>;
}

export function createImapClient(options: ImapClientOptions): ImapClient {
  const connect = options.socket ?? connectTls;
  const idleMs = options.idleMs ?? 60_000;

  let session: Session | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const disarm = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const arm = (): void => {
    disarm();
    idleTimer = setTimeout(() => {
      void shutdown();
    }, idleMs);
    // An idle timer must never be the reason the process stays alive: the CLI
    // would print its result and then sit there for a minute.
    idleTimer.unref?.();
  };

  const shutdown = async (): Promise<void> => {
    disarm();
    const closing = session;
    session = null;
    await closing?.close();
  };

  const ensure = async (): Promise<Session> => {
    if (session) return session;
    const { username, password } = await options.credential();
    session = await openSession({ ...options, connect, username, password });
    return session;
  };

  return {
    run(work, runOptions) {
      const result = queue.then(async () => {
        disarm();
        try {
          try {
            return await work(await ensure());
          } catch (error) {
            // A server drops an idle connection without warning, so one
            // transparent reopen is the difference between "works" and "works
            // most of the time". Never more than once, and never for a write:
            // a half-sent APPEND replayed would deliver the message twice.
            if (runOptions?.retry === false || !isConnectionLost(error)) throw error;
            await shutdown();
            return await work(await ensure());
          }
        } finally {
          if (session) arm();
        }
      });

      // The queue must not stop on a failure, or one bad call wedges every call
      // after it.
      queue = result.catch(() => undefined);
      return result as Promise<never>;
    },

    close: shutdown,
  };
}

function isConnectionLost(error: unknown): boolean {
  // A protocol-level NO/BAD is the server answering, not the socket dying —
  // retrying it would just ask the same rejected question again.
  if (error instanceof ImapError) return false;
  return true;
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

interface Session extends ImapSession {
  close(): Promise<void>;
}

async function openSession(input: {
  host: string;
  port: number;
  username: string;
  password: string;
  connect: SocketFactory;
  signal?: AbortSignal | undefined;
  troubleshooting?: string | undefined;
}): Promise<Session> {
  const socket = await input.connect({
    host: input.host,
    port: input.port,
    signal: input.signal,
  });

  const assembler = new ResponseAssembler();
  const encoder = new TextEncoder();
  let tag = 0;
  let capabilities = new Set<string>();

  const readResponse = async (): Promise<Uint8Array> => {
    for (;;) {
      const ready = assembler.next();
      if (ready) return ready;

      const chunk = await socket.read();
      if (chunk === null) throw new Error('The IMAP connection closed unexpectedly.');
      assembler.push(chunk);
    }
  };

  /** Send a command and collect everything up to its tagged completion. */
  const exchange = async (text: string, literal?: Uint8Array): Promise<CommandResult> => {
    const label = `a${String(++tag).padStart(4, '0')}`;
    const untagged: ImapToken[][] = [];

    await socket.write(encoder.encode(`${label} ${text}\r\n`));

    for (;;) {
      const response = await readResponse();
      const tokens = tokenize(response);
      const first = asText(tokens[0]);

      // A continuation (`+ `) means the server is ready for the literal it was
      // told to expect. Only APPEND takes this path.
      if (first === '+') {
        if (literal) {
          await socket.write(literal);
          await socket.write(encoder.encode('\r\n'));
        }
        continue;
      }

      if (first === '*') {
        untagged.push(tokens);
        if (asText(tokens[1]) === 'OK') collectCapabilities(tokens, capabilities);
        continue;
      }

      if (first === label) {
        const status = (asText(tokens[1]) ?? 'BAD') as CommandResult['status'];
        const rest = tokens
          .slice(2)
          .map((token) => asText(token) ?? '')
          .join(' ')
          .trim();
        return { status, text: rest, untagged };
      }

      // A tagged response for someone else cannot happen — commands are
      // serialised — so this is a server we do not understand. Keep reading
      // rather than hanging on a mismatch.
      untagged.push(tokens);
    }
  };

  const run = async (text: string, literal?: Uint8Array): Promise<CommandResult> => {
    const result = await exchange(text, literal);
    if (result.status !== 'OK') {
      throw new ImapError(`${redactTrace(text)} → ${result.status} ${result.text}`, result.status);
    }
    return result;
  };

  // The greeting arrives unprompted and usually carries CAPABILITY, which saves
  // a round trip — iCloud's does.
  const greeting = tokenize(await readResponse());
  collectCapabilities(greeting, capabilities);

  if (capabilities.size === 0) {
    const result = await run('CAPABILITY');
    for (const tokens of result.untagged) collectCapabilities(tokens, capabilities);
  }

  await authenticate(run, capabilities, input.username, input.password, input.troubleshooting);

  // Re-read: a server may advertise more once authenticated (iCloud adds MOVE).
  const after = await run('CAPABILITY');
  const refreshed = new Set<string>();
  for (const tokens of after.untagged) collectCapabilities(tokens, refreshed);
  if (refreshed.size > 0) capabilities = refreshed;

  return {
    capabilities,
    username: input.username,
    command: (text) => run(text),
    commandWithLiteral: (prefix, literal) => run(prefix, literal),
    async close() {
      // Announced but not awaited. LOGOUT is a courtesy — it lets the server
      // release the mailbox rather than reaping a dropped connection — and its
      // reply tells us nothing we can act on, since we are closing regardless.
      // Waiting for one would let a server that never answers wedge shutdown.
      try {
        await socket.write(encoder.encode(`a${String(++tag).padStart(4, '0')} LOGOUT\r\n`));
      } catch {
        // Already gone, which is the outcome we wanted.
      }
      await socket.close();
    },
  };
}

/**
 * Log in, preferring SASL PLAIN.
 *
 * `AUTHENTICATE PLAIN` with an initial response (SASL-IR) sends the credential
 * base64-encoded in one line, which sidesteps IMAP's string quoting entirely —
 * `LOGIN` would need the password quoted and escaped, and a password containing
 * a quote or a backslash is exactly the kind of thing that works in testing and
 * fails for one unlucky person.
 */
async function authenticate(
  run: (text: string) => Promise<CommandResult>,
  capabilities: ReadonlySet<string>,
  username: string,
  password: string,
  troubleshooting: string | undefined,
): Promise<void> {
  const attempt = async (): Promise<void> => {
    if (capabilities.has('SASL-IR') && capabilities.has('AUTH=PLAIN')) {
      const initial = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
      await run(`AUTHENTICATE PLAIN ${initial}`);
      return;
    }
    await run(`LOGIN ${quoted(username)} ${quoted(password)}`);
  };

  try {
    await attempt();
  } catch (error) {
    throw asAuthenticationError(error, username, troubleshooting);
  }
}

/**
 * Translate a rejected login into the sentence that actually fixes it.
 *
 * The reason a login was refused is nearly always vendor-specific and never
 * visible in what the server returns, so the *provider* supplies that sentence
 * (`setup.troubleshooting`) and this only decides when to show it.
 */
function asAuthenticationError(
  error: unknown,
  username: string,
  troubleshooting: string | undefined,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!/AUTHENTICATIONFAILED|LOGIN failed|Invalid credentials|→ NO/i.test(message)) {
    return error instanceof Error ? error : new Error(message);
  }

  return new Error(
    `The mail server rejected the credential for ${username}.` +
      (troubleshooting ? `\n  ${troubleshooting}` : ''),
  );
}

/** Pull `[CAPABILITY ...]` or an untagged `CAPABILITY` line into the set. */
function collectCapabilities(tokens: readonly ImapToken[], into: Set<string>): void {
  for (const token of tokens) {
    const text = asText(token);
    if (!text) continue;

    if (text.startsWith('[CAPABILITY ')) {
      for (const name of text.slice('[CAPABILITY '.length, -1).split(/\s+/)) {
        if (name) into.add(name.toUpperCase());
      }
      continue;
    }

    if (text === 'CAPABILITY') {
      const start = tokens.indexOf(token) + 1;
      for (const rest of tokens.slice(start)) {
        const name = asText(rest);
        if (name) into.add(name.toUpperCase());
      }
      return;
    }
  }
}
