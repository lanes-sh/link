import { describe, expect, test } from 'bun:test';
import { createImapClient, quoted, redactTrace } from './client.ts';
import type { ImapSocket, SocketFactory } from './socket.ts';

/**
 * A scripted server, in the spirit of `http.test.ts` injecting `fetch`.
 *
 * Each entry says what the client is expected to send and what comes back. The
 * recorded commands are as interesting as the replies: several guarantees this
 * connector makes — never `SELECT` on a read, never `BODY[]` without `.PEEK` —
 * are only observable in what went out.
 */

interface Step {
  readonly expect: RegExp;
  readonly reply: string;
}

interface Fake {
  readonly factory: SocketFactory;
  readonly sent: string[];
  readonly opened: () => number;
}

function fakeServer(greeting: string, steps: readonly Step[]): Fake {
  const sent: string[] = [];
  let opens = 0;

  const factory: SocketFactory = async () => {
    opens++;
    const outbound: string[] = [greeting];
    let step = 0;
    let closed = false;

    const socket: ImapSocket = {
      async write(data) {
        const text = new TextDecoder().decode(data);
        // A literal's payload is written separately and is not a command.
        if (text === '\r\n') return;
        sent.push(text.replace(/\r\n$/, ''));

        const current = steps[step];
        if (!current) return;
        const command = text.replace(/\r\n$/, '');
        // Skip the tag when matching, so tests describe protocol not sequence.
        if (current.expect.test(command.replace(/^a\d+ /, ''))) {
          outbound.push(current.reply);
          step++;
        }
      },
      async read() {
        if (outbound.length > 0) return new TextEncoder().encode(outbound.shift()!);
        // Out of script. Reporting EOF rather than blocking turns "the client
        // sent something unexpected" into an error naming it, instead of a
        // five-second timeout that says nothing.
        closed = true;
        return null;
      },
      async close() {
        closed = true;
      },
    };

    return socket;
  };

  return { factory, sent, opened: () => opens };
}

const GREETING = '* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN] iCloud ready\r\n';

const LOGIN_STEPS: Step[] = [
  { expect: /^AUTHENTICATE PLAIN/, reply: 'a0001 OK authenticated\r\n' },
  { expect: /^CAPABILITY/, reply: '* CAPABILITY IMAP4rev1 MOVE\r\na0002 OK done\r\n' },
];

const clientWith = (steps: readonly Step[], fake = fakeServer(GREETING, [...LOGIN_STEPS, ...steps])) => ({
  fake,
  client: createImapClient({
    host: 'imap.test',
    port: 993,
    socket: fake.factory,
    credential: async () => ({ username: 'ada@example.com', password: 'app-specific' }),
  }),
});

describe('signing in', () => {
  test('prefers SASL PLAIN, which needs no string quoting', async () => {
    // A password containing a quote or a backslash is exactly the case that
    // works in testing and fails for one unlucky person under LOGIN.
    const { client, fake } = clientWith([{ expect: /^NOOP/, reply: 'a0003 OK\r\n' }]);

    await client.run((session) => session.command('NOOP'));

    const auth = fake.sent.find((line) => line.includes('AUTHENTICATE'))!;
    expect(auth).toContain('AUTHENTICATE PLAIN');
    expect(Buffer.from(auth.split(' ').pop()!, 'base64').toString('utf8')).toBe(
      '\0ada@example.com\0app-specific',
    );
    await client.close();
  });

  test('capabilities are re-read after login, because they change', async () => {
    // iCloud advertises MOVE only once authenticated, and `move_messages` is
    // discovered on the strength of it.
    const { client } = clientWith([{ expect: /^NOOP/, reply: 'a0003 OK\r\n' }]);

    const capabilities = await client.run(async (session) => session.capabilities);

    expect(capabilities.has('MOVE')).toBe(true);
    await client.close();
  });

  test("a rejected password shows the provider's own explanation", async () => {
    // The transport cannot say why a login was refused — it must not know which
    // vendor it is talking to. The provider declares that sentence as
    // `lanes_setup.troubleshooting`, and this is the whole of the transport's job:
    // recognise the refusal and hand the sentence on.
    const fake = fakeServer(GREETING, [
      { expect: /^AUTHENTICATE PLAIN/, reply: 'a0001 NO [AUTHENTICATIONFAILED] Invalid\r\n' },
    ]);
    const client = createImapClient({
      host: 'imap.test',
      port: 993,
      socket: fake.factory,
      credential: async () => ({ username: 'someone@example.test', password: 'wrong' }),
      troubleshooting: 'Generate an app-specific password and try again.',
    });

    expect(client.run((session) => session.command('NOOP'))).rejects.toThrow(
      /Generate an app-specific password and try again/,
    );
  });

  test('and says only that it was rejected when the provider declares nothing', async () => {
    const fake = fakeServer(GREETING, [
      { expect: /^AUTHENTICATE PLAIN/, reply: 'a0001 NO [AUTHENTICATIONFAILED] Invalid\r\n' },
    ]);
    const client = createImapClient({
      host: 'imap.test',
      port: 993,
      socket: fake.factory,
      credential: async () => ({ username: 'someone@example.test', password: 'wrong' }),
    });

    expect(client.run((session) => session.command('NOOP'))).rejects.toThrow(
      /rejected the credential for someone@example.test\.$/,
    );
  });
});

describe('the session is reused', () => {
  test('five calls open one socket', async () => {
    // The point of holding a session. Reopening per call is a TLS handshake and
    // a login each time, against a server that throttles precisely that.
    // Tags continue from the two the login spent, and must match exactly: a
    // reply the client cannot attribute is one it keeps waiting for.
    const steps = Array.from({ length: 5 }, (_unused, index) => ({
      expect: /^NOOP/,
      reply: `a${String(index + 3).padStart(4, '0')} OK\r\n`,
    }));
    const { client, fake } = clientWith(steps);

    for (let index = 0; index < 5; index++) {
      await client.run((session) => session.command('NOOP'));
    }

    expect(fake.opened()).toBe(1);
    await client.close();
  });

  test('close sends LOGOUT rather than dropping the socket', async () => {
    const { client, fake } = clientWith([{ expect: /^NOOP/, reply: 'a0003 OK\r\n' }]);

    await client.run((session) => session.command('NOOP'));
    await client.close();

    expect(fake.sent.some((line) => line.includes('LOGOUT'))).toBe(true);
  });

  test('a failing call does not wedge the calls after it', async () => {
    const { client } = clientWith([
      { expect: /^BAD-COMMAND/, reply: 'a0003 BAD nope\r\n' },
      { expect: /^NOOP/, reply: 'a0004 OK\r\n' },
    ]);

    expect(client.run((session) => session.command('BAD-COMMAND'))).rejects.toThrow(/BAD/);
    await client.run((session) => session.command('NOOP'));

    await client.close();
  });
});

describe('redaction', () => {
  test('a LOGIN line keeps the user and loses the password', () => {
    expect(redactTrace('a0001 LOGIN ada@example.com hunter2')).toBe('a0001 LOGIN ada@example.com ***');
  });

  test('an AUTHENTICATE initial response is not a trace of the credential', () => {
    const secret = Buffer.from('\0will\0hunter2', 'utf8').toString('base64');
    expect(redactTrace(`a0001 AUTHENTICATE PLAIN ${secret}`)).not.toContain(secret);
  });

  test('an ordinary command is left readable', () => {
    expect(redactTrace('a0003 UID SEARCH SINCE 1-Aug-2026')).toBe('a0003 UID SEARCH SINCE 1-Aug-2026');
  });

  test('a failed login carries neither the password nor its base64', async () => {
    const password = 'hunter2';
    const encoded = Buffer.from(`\0ada@example.com\0${password}`, 'utf8').toString('base64');
    const fake = fakeServer(GREETING, [
      { expect: /^AUTHENTICATE PLAIN/, reply: 'a0001 NO [AUTHENTICATIONFAILED] Invalid\r\n' },
    ]);
    const client = createImapClient({
      host: 'imap.test',
      port: 993,
      socket: fake.factory,
      credential: async () => ({ username: 'ada@example.com', password }),
    });

    const message = await client
      .run((session) => session.command('NOOP'))
      .then(() => '')
      .catch((error: Error) => error.message);

    expect(message).not.toContain(password);
    expect(message).not.toContain(encoded);
  });
});

describe('quoting', () => {
  test('escapes what IMAP requires and nothing else', () => {
    expect(quoted('plain')).toBe('"plain"');
    expect(quoted('with "quote"')).toBe('"with \\"quote\\""');
    expect(quoted('back\\slash')).toBe('"back\\\\slash"');
  });

  // A command goes out as one CRLF-terminated line, so a newline that survives
  // quoting is a second command on an authenticated session. Search terms come
  // from a tool argument, which makes this reachable from a caller.
  test('refuses the bytes that would end the line early', () => {
    for (const injected of ['a\r\nZ1 SELECT INBOX', 'a\nZ1 NOOP', 'a\rZ1 NOOP', 'a\u0000b']) {
      expect(() => quoted(injected)).toThrow(/carriage return, newline, or NUL/);
    }
  });

  test('does not put the rejected value in the message — LOGIN comes through here', () => {
    const thrown = ((): Error => {
      try {
        quoted('hunter2\r\nZ1 NOOP');
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected quoted() to refuse this');
    })();

    expect(thrown.message).not.toContain('hunter2');
  });
});
