import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { putStaged, stagedBytesKey, STAGED_TTL_MS } from '#connectivity/mail';
import { createImapConnector, imapDate, searchCriteria } from './index.ts';
import type { ImapSocket, SocketFactory } from './socket.ts';
import { sendOverSmtp, type OutgoingMessage, type Sender } from './send.ts';
import type { DiscoveryContext } from '#connectivity';
import { icloudMail } from '#providers/icloud/mail/index.ts';

/**
 * The connector, against a scripted server.
 *
 * The recorded commands matter as much as the replies: the two guarantees this
 * connector makes — reading never marks mail read, and nothing here can destroy
 * mail — are only observable in what went out on the wire.
 */

interface Step {
  readonly expect: RegExp;
  readonly reply: string | ((tag: string) => string);
}

const GREETING = '* OK [CAPABILITY IMAP4rev1 SASL-IR AUTH=PLAIN] ready\r\n';

const login = (extra = 'MOVE'): Step[] => [
  { expect: /^AUTHENTICATE PLAIN/, reply: (tag) => `${tag} OK ok\r\n` },
  { expect: /^CAPABILITY/, reply: (tag) => `* CAPABILITY IMAP4rev1 ${extra}\r\n${tag} OK done\r\n` },
];

function server(steps: readonly Step[]): { factory: SocketFactory; sent: string[] } {
  const sent: string[] = [];

  const factory: SocketFactory = async () => {
    const outbound: string[] = [GREETING];
    let cursor = 0;

    const socket: ImapSocket = {
      async write(data) {
        const text = new TextDecoder().decode(data);
        if (text === '\r\n') return;
        const command = text.replace(/\r\n$/, '');
        // An APPEND payload is not a command; it has no tag.
        if (!/^a\d+ /.test(command)) return;
        sent.push(command.replace(/^a\d+ /, ''));

        const tag = command.slice(0, command.indexOf(' '));
        const body = command.replace(/^a\d+ /, '');
        const step = steps[cursor];
        if (step?.expect.test(body)) {
          outbound.push(typeof step.reply === 'function' ? step.reply(tag) : step.reply);
          cursor++;
        }
      },
      async read() {
        if (outbound.length > 0) return new TextEncoder().encode(outbound.shift()!);
        return null;
      },
      async close() {},
    };

    return socket;
  };

  return { factory, sent };
}

const SMTP = { host: 'smtp.test', port: 587, starttls: true, maxMessageBytes: 20 * 1024 * 1024 };

const SEND = { name: 'send_message', target: { operation: 'send_message' } };

/**
 * A connector whose submission step is substituted, so a send can be asserted
 * without a network — the `Sender` seam the existing filing test already uses.
 * The scripted LIST and APPEND cover filing the copy in Sent afterwards.
 */
const sendingConnector = (send: Sender) => {
  const fake = server([
    ...login(),
    {
      expect: /^LIST/,
      reply: (tag) => `* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n${tag} OK done\r\n`,
    },
    { expect: /^APPEND/, reply: (tag) => `${tag} OK appended\r\n` },
  ]);

  return {
    connector: createImapConnector({
      host: 'imap.test',
      port: 993,
      maxBodyBytes: 1000,
      smtp: SMTP,
      socket: fake.factory,
      credential: async () => ({ username: 'ada@example.com', password: 'p' }),
      send,
    }),
  };
};

const connectorWith = (steps: readonly Step[], options: { smtp?: boolean; move?: boolean } = {}) => {
  const fake = server([...login(options.move === false ? '' : 'MOVE'), ...steps]);
  return {
    sent: fake.sent,
    connector: createImapConnector({
      host: 'imap.test',
      port: 993,
      maxBodyBytes: 1000,
      ...(options.smtp === false ? {} : { smtp: SMTP }),
      socket: fake.factory,
      credential: async () => ({ username: 'ada@example.com', password: 'app-specific' }),
    }),
  };
};

/**
 * `discover` reads only the manifest; `invoke` is also handed a provider, and the
 * send path annotates its audit record through it. Modelled here rather than
 * guarded against in the connector — a context without a provider is not a state
 * dispatch can produce.
 */
const annotations: Record<string, unknown>[] = [];
const storage = createMemoryBlobStore();
const CONTEXT = {
  manifest: { id: 'icloud_mail' },
  provider: {
    audit: { annotate: (detail: Record<string, unknown>) => annotations.push(detail) },
    // Scoped to this provider and connection by the time a connector sees it,
    // which is what confines a staged handle to the account it was staged for.
    storage,
    // `config` is where a connection keeps its own settings — `from_name` among
    // them, which is how the From header gets a display name.
    connection: {
      id: 'rin_shaw',
      key: 'icloud_mail.rin_shaw',
      displayName: 'ada@example.com',
      config: {},
    },
  },
} as unknown as DiscoveryContext;

const parsed = (result: { content: readonly { text?: string }[] }): Record<string, unknown> =>
  JSON.parse(result.content[0]!.text!);

describe('discovery', () => {
  test('the capability set is fixed, because the protocol fixes it', async () => {
    const { connector } = connectorWith([]);

    const names = (await connector.discover(CONTEXT)).map((c) => c.name).sort();

    expect(names).toEqual([
      'get_message',
      'list_mailboxes',
      'mark_messages',
      'move_messages',
      'search_messages',
      'send_message',
    ]);
    await connector.close?.();
  });

  test('reads and writes land in the right bundles', async () => {
    const { connector } = connectorWith([]);

    const bundles = new Map((await connector.discover(CONTEXT)).map((c) => [c.name, c.bundle]));

    expect(bundles.get('search_messages')).toBe('read');
    expect(bundles.get('get_message')).toBe('read');
    expect(bundles.get('send_message')).toBe('write');
    expect(bundles.get('mark_messages')).toBe('write');
    await connector.close?.();
  });

  test('move is offered only when the server advertises MOVE', async () => {
    // Never emulated with COPY + \Deleted + EXPUNGE: that fallback is how a
    // failed move becomes deleted mail.
    const { connector } = connectorWith([], { move: false });

    const names = (await connector.discover(CONTEXT)).map((c) => c.name);

    expect(names).not.toContain('move_messages');
    await connector.close?.();
  });

  test('send is offered only when the manifest configures SMTP', async () => {
    const { connector } = connectorWith([], { smtp: false });

    const names = (await connector.discover(CONTEXT)).map((c) => c.name);

    expect(names).not.toContain('send_message');
    await connector.close?.();
  });

  test('no capability carries an account-specific target', async () => {
    // The discovery cache is keyed by *provider*, so anything account-shaped in
    // `target` would be served to a second account of the same provider.
    const { connector } = connectorWith([]);

    for (const capability of await connector.discover(CONTEXT)) {
      expect(JSON.stringify(capability.target)).not.toContain('icloud.com');
      expect(Object.keys(capability.target ?? {})).toEqual(['operation']);
    }
    await connector.close?.();
  });
});

describe('reading never marks mail read', () => {
  test('search opens the mailbox with EXAMINE, not SELECT', async () => {
    const { connector, sent } = connectorWith([
      { expect: /^EXAMINE/, reply: (tag) => `${tag} OK [READ-ONLY] done\r\n` },
      { expect: /^UID SEARCH/, reply: (tag) => `* SEARCH 7\r\n${tag} OK done\r\n` },
      {
        expect: /^UID FETCH/,
        reply: (tag) =>
          `* 1 FETCH (UID 7 FLAGS () INTERNALDATE "10-Aug-2026 09:00:00 +0000" RFC822.SIZE 42 ` +
          `ENVELOPE ("Mon, 10 Aug 2026" "Hello" (("Sam" NIL "sam" "example.com")) NIL NIL ` +
          `(("Ada" NIL "ada" "icloud.com")) NIL NIL NIL "<abc@example.com>"))\r\n${tag} OK done\r\n`,
      },
    ]);

    const capability = { name: 'search_messages', target: { operation: 'search_messages' } };
    const result = await connector.invoke(capability as never, { mailbox: 'INBOX' }, CONTEXT as never);

    expect(sent.some((line) => line.startsWith('EXAMINE'))).toBe(true);
    expect(sent.some((line) => line.startsWith('SELECT'))).toBe(false);

    const body = parsed(result as never);
    expect((body['messages'] as unknown[]).length).toBe(1);
    expect((body['messages'] as Record<string, unknown>[])[0]).toMatchObject({
      uid: 7,
      subject: 'Hello',
      from: 'Sam <sam@example.com>',
    });
    await connector.close?.();
  });

  test('fetching a body uses BODY.PEEK, so \\Seen is not set', async () => {
    const raw = 'Subject: Hi\r\nFrom: sam@example.com\r\n\r\nThe body.\r\n';
    const { connector, sent } = connectorWith([
      { expect: /^EXAMINE/, reply: (tag) => `${tag} OK done\r\n` },
      {
        expect: /^UID FETCH/,
        reply: (tag) =>
          `* 1 FETCH (UID 7 FLAGS () BODY[] {${raw.length}}\r\n${raw})\r\n${tag} OK done\r\n`,
      },
    ]);

    const capability = { name: 'get_message', target: { operation: 'get_message' } };
    const result = await connector.invoke(capability as never, { uid: 7 }, CONTEXT as never);

    const fetch = sent.find((line) => line.startsWith('UID FETCH'))!;
    expect(fetch).toContain('BODY.PEEK[]');
    expect(fetch).not.toMatch(/[^.]BODY\[\]/);

    const message = parsed(result as never);
    expect(message).toMatchObject({ subject: 'Hi', from: 'sam@example.com', uid: 7 });
    // Trailing whitespace is the message's, not ours — postal-mime hands back
    // the body as written rather than tidying it.
    expect(String(message['body']).trim()).toBe('The body.');
    await connector.close?.();
  });
});

describe('nothing here can destroy mail', () => {
  test('\\Deleted is dropped from a flag change', async () => {
    const { connector, sent } = connectorWith([
      { expect: /^SELECT/, reply: (tag) => `${tag} OK done\r\n` },
      { expect: /^UID STORE/, reply: (tag) => `${tag} OK done\r\n` },
    ]);

    const capability = { name: 'mark_messages', target: { operation: 'mark_messages' } };
    await connector.invoke(
      capability as never,
      { uids: [7], add_flags: ['\\Seen', '\\Deleted'] },
      CONTEXT as never,
    );

    const store = sent.find((line) => line.startsWith('UID STORE'))!;
    expect(store).toContain('\\Seen');
    expect(store).not.toContain('\\Deleted');
    await connector.close?.();
  });

  test('a flag change of only \\Deleted is refused outright', async () => {
    const { connector, sent } = connectorWith([]);

    const capability = { name: 'mark_messages', target: { operation: 'mark_messages' } };
    const result = await connector.invoke(
      capability as never,
      { uids: [7], add_flags: ['\\Deleted'] },
      CONTEXT as never,
    );

    expect(result.isError).toBe(true);
    expect(sent.some((line) => line.startsWith('UID STORE'))).toBe(false);
    await connector.close?.();
  });

  test('no capability schema offers EXPUNGE or \\Deleted', async () => {
    const { connector } = connectorWith([]);

    const schemas = JSON.stringify(await connector.discover(CONTEXT));

    expect(schemas).not.toContain('EXPUNGE');
    expect(schemas).not.toContain('Deleted');
    await connector.close?.();
  });
});

describe('moving by special-use flag', () => {
  const MOVE = { name: 'move_messages', target: { operation: 'move_messages' } };

  test('finds the junk mailbox when the server calls it "Spam"', async () => {
    // The whole point. iCloud names it `Junk`, Gmail `[Gmail]/Spam`, a German
    // Dovecot `Werbung` — an agent told to "mark this as spam" cannot know
    // which, and guessing wrong moves mail into a mailbox that does not exist.
    const { connector, sent } = connectorWith([
      {
        expect: /^LIST/,
        reply: (tag) =>
          `* LIST (\\HasNoChildren \\Junk) "/" "Spam"\r\n` +
          `* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`,
      },
      { expect: /^SELECT/, reply: (tag) => `${tag} OK done\r\n` },
      { expect: /^UID MOVE/, reply: (tag) => `${tag} OK moved\r\n` },
    ]);

    const result = await connector.invoke(
      MOVE as never,
      { uids: [7], destination_flag: '\\Junk' },
      CONTEXT as never,
    );

    expect(sent.some((line) => line === 'UID MOVE 7 "Spam"')).toBe(true);
    expect(parsed(result as never)['to']).toBe('Spam');
    await connector.close?.();
  });

  test('an exact destination still works, and skips the lookup', async () => {
    const { connector, sent } = connectorWith([
      { expect: /^SELECT/, reply: (tag) => `${tag} OK done\r\n` },
      { expect: /^UID MOVE/, reply: (tag) => `${tag} OK moved\r\n` },
    ]);

    await connector.invoke(
      MOVE as never,
      { uids: [7], destination: 'Archive' },
      CONTEXT as never,
    );

    expect(sent.some((line) => line === 'UID MOVE 7 "Archive"')).toBe(true);
    expect(sent.some((line) => line.startsWith('LIST'))).toBe(false);
    await connector.close?.();
  });

  test('both destinations at once is refused, with nothing moved', async () => {
    // Refused rather than resolved by precedence: silently preferring one makes
    // the other look like it worked, and where the mail went is the last thing
    // anyone checks.
    const { connector, sent } = connectorWith([]);

    const result = await connector.invoke(
      MOVE as never,
      { uids: [7], destination: 'Archive', destination_flag: '\\Junk' },
      CONTEXT as never,
    );

    expect(result.isError).toBe(true);
    expect(sent.some((line) => line.startsWith('UID MOVE'))).toBe(false);
    await connector.close?.();
  });

  test('neither destination is refused', async () => {
    const { connector, sent } = connectorWith([]);

    const result = await connector.invoke(MOVE as never, { uids: [7] }, CONTEXT as never);

    expect(result.isError).toBe(true);
    expect(sent.some((line) => line.startsWith('UID MOVE'))).toBe(false);
    await connector.close?.();
  });

  test('a flag no mailbox advertises names what LIST did report', async () => {
    const { connector, sent } = connectorWith([
      {
        expect: /^LIST/,
        reply: (tag) =>
          `* LIST (\\HasNoChildren) "/" "INBOX"\r\n` +
          `* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n${tag} OK done\r\n`,
      },
      {
        expect: /^LIST/,
        reply: (tag) =>
          `* LIST (\\HasNoChildren) "/" "INBOX"\r\n` +
          `* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n${tag} OK done\r\n`,
      },
    ]);

    const result = await connector.invoke(
      MOVE as never,
      { uids: [7], destination_flag: '\\Junk' },
      CONTEXT as never,
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Sent Messages');
    expect(sent.some((line) => line.startsWith('UID MOVE'))).toBe(false);
    await connector.close?.();
  });

  test('the move is never emulated with COPY', async () => {
    const { connector, sent } = connectorWith([
      {
        expect: /^LIST/,
        reply: (tag) => `* LIST (\\Junk) "/" "Junk"\r\n${tag} OK done\r\n`,
      },
      { expect: /^SELECT/, reply: (tag) => `${tag} OK done\r\n` },
      { expect: /^UID MOVE/, reply: (tag) => `${tag} OK moved\r\n` },
    ]);

    await connector.invoke(
      MOVE as never,
      { uids: [7], destination_flag: '\\Junk' },
      CONTEXT as never,
    );

    expect(sent.some((line) => line.includes('COPY'))).toBe(false);
    expect(sent.some((line) => line.includes('EXPUNGE'))).toBe(false);
    await connector.close?.();
  });
});

/**
 * The guard `cli/tools.test.ts` cannot provide.
 *
 * That file checks every `redact` key against a real argument name, and says so
 * explicitly: "Only `http` providers are checked, because only they have a
 * discoverable schema to check against." An `imap` provider has one too — it is
 * just built in code rather than read from a document — so the one manifest
 * relying on it has been unguarded, and a typo there withholds a value while
 * looking exactly like working redaction.
 *
 * `destination_flag` is what made this worth closing: adding an argument to a
 * capability and forgetting its redact entry is the ordinary way this breaks.
 */
describe('the iCloud mail redact block names real arguments', () => {
  test('every key and every argument it lists exists', async () => {
    const { connector } = connectorWith([]);
    const capabilities = await connector.discover(CONTEXT);
    await connector.close?.();

    const schemas = new Map(
      capabilities.map((capability) => [
        capability.name,
        Object.keys(
          ((capability.inputSchema as Record<string, unknown>)['properties'] ??
            {}) as Record<string, unknown>,
        ),
      ]),
    );

    const declared = icloudMail.redact ?? {};
    const wrong: string[] = [];

    for (const [name, keys] of Object.entries(declared)) {
      const properties = schemas.get(name);
      if (!properties) {
        wrong.push(`${name} is not a capability`);
        continue;
      }
      for (const key of keys) {
        if (!properties.includes(key)) wrong.push(`${name}.${key} is not an argument`);
      }
    }

    expect(wrong).toEqual([]);
  });
});

describe('sending', () => {
  test('files the copy in the mailbox flagged \\Sent, not one named "Sent"', async () => {
    // iCloud calls it `Sent Messages`, Gmail `[Gmail]/Sent Mail`, a German
    // Dovecot `Gesendet`. Matching on the name is how filing silently stops.
    const { connector, sent } = connectorWith([
      {
        expect: /^LIST/,
        reply: (tag) =>
          '* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n' +
          `* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`,
      },
      { expect: /^APPEND/, reply: (tag) => `${tag} OK appended\r\n` },
    ]);

    const send: Sender = async () => ({
      messageId: '<generated@icloud.com>',
      raw: new TextEncoder().encode('Subject: Hi\r\n\r\nBody\r\n'),
    });

    const withSender = createImapConnector({
      host: 'imap.test',
      port: 993,
      maxBodyBytes: 1000,
      smtp: SMTP,
      socket: server([...login(),
        {
          expect: /^LIST/,
          reply: (tag) =>
            '* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n' +
            `${tag} OK done\r\n`,
        },
        { expect: /^APPEND/, reply: (tag) => `${tag} OK appended\r\n` },
      ]).factory,
      credential: async () => ({ username: 'ada@example.com', password: 'p' }),
      send,
    });

    const capability = { name: 'send_message', target: { operation: 'send_message' } };
    const result = await withSender.invoke(
      capability as never,
      { to: ['sam@example.com'], subject: 'Hi', text: 'Body' },
      CONTEXT as never,
    );

    expect(parsed(result as never)).toMatchObject({ sent: true, filed_in: 'Sent Messages' });
    await withSender.close?.();
    void sent;
    await connector.close?.();
  });

  test('an attachment is read from disk and never asked of the caller', async () => {
    // The whole point: the caller names a path, and the bytes are resolved here.
    // A 239 KB PDF as base64 in a tool call is ~320,000 characters, which is what
    // made attaching anything impossible before this existed.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-send-'));
    await writeFile(join(root, 'invoice.pdf'), new Uint8Array([1, 2, 3, 4]));

    let handed: OutgoingMessage | undefined;
    const { connector } = sendingConnector(async ({ message }) => {
      handed = message;
      return { messageId: '<generated@icloud.com>', raw: new TextEncoder().encode('raw') };
    });

    const result = await connector.invoke(
      SEND as never,
      {
        to: ['sam@example.com'],
        subject: 'Invoice',
        text: 'Attached.',
        attachments: [{ path: join(root, 'invoice.pdf') }],
      },
      CONTEXT as never,
    );

    expect(handed?.attachments).toHaveLength(1);
    expect(handed?.attachments?.[0]).toMatchObject({
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
    });
    expect(handed?.attachments?.[0]?.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));

    // The result is a receipt. Handing the bytes back would undo the point, and
    // with unrestricted paths it would make this a general file-read tool.
    const body = parsed(result as never);
    expect(body['attachments']).toEqual([
      {
        filename: 'invoice.pdf',
        bytes: 4,
        content_type: 'application/pdf',
        sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      },
    ]);
    await connector.close?.();
  });

  test('what was attached lands in the audit record, including where it came from', async () => {
    // This is what makes an unrestricted `path` defensible. The manifest's
    // `redact` block cannot express it — `keepKeys` keeps an argument verbatim,
    // and the raw argument may be an inline base64 file — so the resolved facts
    // are annotated instead. Without this, "was id_rsa ever mailed out" has no
    // answer.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-audit-'));
    await writeFile(join(root, 'invoice.pdf'), new Uint8Array([1, 2, 3, 4]));

    annotations.length = 0;
    const { connector } = sendingConnector(async () => ({
      messageId: '<generated@icloud.com>',
      raw: new TextEncoder().encode('raw'),
    }));

    await connector.invoke(
      SEND as never,
      {
        to: ['sam@example.com'],
        subject: 'Invoice',
        attachments: [{ path: join(root, 'invoice.pdf') }],
      },
      CONTEXT as never,
    );

    expect(annotations).toEqual([
      {
        attachments: [
          {
            filename: 'invoice.pdf',
            bytes: 4,
            content_type: 'application/pdf',
            sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
            origin: `path:${join(root, 'invoice.pdf')}`,
          },
        ],
      },
    ]);
    await connector.close?.();
  });

  test('an inline attachment records its digest but never its content', async () => {
    // The one source whose argument really is the file. Keeping it verbatim would
    // put the whole base64 blob in the log.
    annotations.length = 0;
    const { connector } = sendingConnector(async () => ({
      messageId: '<generated@icloud.com>',
      raw: new TextEncoder().encode('raw'),
    }));

    await connector.invoke(
      SEND as never,
      {
        to: ['sam@example.com'],
        subject: 'Hi',
        attachments: [{ data: Buffer.from([1, 2, 3, 4]).toString('base64'), filename: 'a.pdf' }],
      },
      CONTEXT as never,
    );

    const recorded = JSON.stringify(annotations);
    expect(recorded).toContain('9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a');
    expect(recorded).toContain('inline');
    expect(recorded).not.toContain(Buffer.from([1, 2, 3, 4]).toString('base64'));
    await connector.close?.();
  });

  test('the connection supplies the display name, so no caller has to remember it', async () => {
    // SMTP submits exactly what is composed — there is no server-side step that
    // fills in the account's own name, the way an HTTP mail API does — so without
    // this the From header is a bare address on every message.
    let handed: { from: string; fromName?: string | undefined } | undefined;
    const { connector } = sendingConnector(async ({ from, fromName }) => {
      handed = { from, fromName };
      return { messageId: '<x@icloud.com>', raw: new TextEncoder().encode('raw') };
    });

    const named = {
      ...(CONTEXT as unknown as { provider: Record<string, unknown> }),
      provider: {
        ...(CONTEXT as unknown as { provider: Record<string, unknown> }).provider,
        connection: { id: 'a', key: 'icloud_mail.a', displayName: 'x', config: { from_name: 'Ada Lovelace' } },
      },
    };

    await connector.invoke(SEND as never, { to: ['sam@example.com'], subject: 'Hi' }, named as never);

    expect(handed?.fromName).toBe('Ada Lovelace');
    // The envelope address is unchanged: MAIL FROM is a routing identity, and a
    // display name there is a protocol error.
    expect(handed?.from).toBe('ada@example.com');
    await connector.close?.();
  });

  test('the call overrides the connection default', async () => {
    let handed: string | undefined;
    const { connector } = sendingConnector(async ({ fromName }) => {
      handed = fromName;
      return { messageId: '<x@icloud.com>', raw: new TextEncoder().encode('raw') };
    });

    await connector.invoke(
      SEND as never,
      { to: ['sam@example.com'], subject: 'Hi', from_name: 'Lanes Support' },
      CONTEXT as never,
    );

    expect(handed).toBe('Lanes Support');
    await connector.close?.();
  });

  test('with neither, no name is invented', async () => {
    let handed: { fromName?: string | undefined } | undefined;
    const { connector } = sendingConnector(async ({ fromName }) => {
      handed = { fromName };
      return { messageId: '<x@icloud.com>', raw: new TextEncoder().encode('raw') };
    });

    await connector.invoke(SEND as never, { to: ['sam@example.com'], subject: 'Hi' }, CONTEXT as never);

    expect(handed?.fromName).toBeUndefined();
    await connector.close?.();
  });

  test('a staged handle resolves from the connection store', async () => {
    // The source that survives the endpoint not being on the caller's machine: a
    // `path` means nothing to a container, so on a hosted deployment the bytes
    // arrive out of band and travel as a handle.
    await putStaged(storage, {
      handle: 'att_deadbeef',
      bytes: new Uint8Array([9, 8, 7]),
      metadata: {
        filename: 'staged.pdf',
        content_type: 'application/pdf',
        expires_at: Date.now() + STAGED_TTL_MS,
      },
    });

    let handed: OutgoingMessage | undefined;
    const { connector } = sendingConnector(async ({ message }) => {
      handed = message;
      return { messageId: '<generated@icloud.com>', raw: new TextEncoder().encode('raw') };
    });

    const result = await connector.invoke(
      SEND as never,
      {
        to: ['sam@example.com'],
        subject: 'Staged',
        attachments: [{ handle: 'att_deadbeef' }],
      },
      CONTEXT as never,
    );

    expect(handed?.attachments?.[0]).toMatchObject({
      filename: 'staged.pdf',
      contentType: 'application/pdf',
    });
    expect(handed?.attachments?.[0]?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(parsed(result as never)['attachments']).toMatchObject([{ filename: 'staged.pdf' }]);
    await connector.close?.();
  });

  test('a handle nobody staged says handles expire rather than sending nothing', async () => {
    const { connector } = sendingConnector(async () => {
      throw new Error('should never be reached');
    });

    const result = await connector.invoke(
      SEND as never,
      { to: ['sam@example.com'], subject: 'Hi', attachments: [{ handle: 'att_nothere' }] },
      CONTEXT as never,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/expire/);
    await connector.close?.();
  });

  test('the bytes and the sidecar live under one prefix, so a sweep can find them', async () => {
    await putStaged(storage, {
      handle: 'att_layout',
      bytes: new Uint8Array([1]),
      metadata: { filename: 'a.bin' },
    });

    expect(stagedBytesKey('att_layout')).toBe('attachments/att_layout');
    expect((await storage.list('attachments/')).map((blob) => blob.key)).toContain(
      'attachments/att_layout.json',
    );
  });

  test('a path that does not exist is a readable tool error, not a crash', async () => {
    const { connector } = sendingConnector(async () => {
      throw new Error('should never be reached');
    });

    const result = await connector.invoke(
      SEND as never,
      { to: ['sam@example.com'], subject: 'Hi', attachments: [{ path: '/nope/missing.pdf' }] },
      CONTEXT as never,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('/nope/missing.pdf');
    await connector.close?.();
  });

  test('naming two sources for one attachment is refused before sending', async () => {
    const { connector } = sendingConnector(async () => {
      throw new Error('should never be reached');
    });

    const result = await connector.invoke(
      SEND as never,
      {
        to: ['sam@example.com'],
        subject: 'Hi',
        attachments: [{ path: '/tmp/a.pdf', url: 'https://example.com/a.pdf' }],
      },
      CONTEXT as never,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/names 2 sources/);
    await connector.close?.();
  });

  test('a send with no SMTP configured says so rather than failing obscurely', async () => {
    const { connector } = connectorWith([], { smtp: false });

    const result = await connector.invoke(
      SEND as never,
      { to: ['sam@example.com'], subject: 'Hi' },
      CONTEXT as never,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('cannot send');
    await connector.close?.();
  });

  test('a message over the host limit is refused before a socket is opened', async () => {
    // Refused between composing and submitting, which is the only place the real
    // encoded size exists. A message rejected part-way through DATA reads like a
    // dropped connection, and a caller that cannot tell the difference retries.
    const failure = sendOverSmtp({
      target: { host: 'smtp.test', port: 587, starttls: true, maxMessageBytes: 64 },
      credential: { username: 'ada@example.com', password: 'p' },
      from: 'ada@example.com',
      message: {
        to: ['sam@example.com'],
        subject: 'Invoice',
        attachments: [
          {
            filename: 'big.bin',
            contentType: 'application/octet-stream',
            bytes: new Uint8Array(4096),
            sha256: 'x',
            origin: 'test',
          },
        ],
      },
    });

    // No socket factory is involved at all: reaching the network would hang or
    // throw a connection error instead, so the message is proof it stopped early.
    await expect(failure).rejects.toThrow(/accepts 64/);
    await expect(failure).rejects.toThrow(/base64/);
  });
});

describe('search criteria', () => {
  test('an empty search is ALL, not an empty command', () => {
    expect(searchCriteria({})).toBe('ALL');
  });

  test('terms are quoted, so a search for a quote does not break the command', () => {
    expect(searchCriteria({ subject: 'a "quoted" thing' })).toBe('SUBJECT "a \\"quoted\\" thing"');
  });

  // The four search terms are the only tool arguments that reach the wire as a
  // quoted string, so they are where a CRLF would buy a second command on an
  // authenticated session — `\\Deleted` and `EXPUNGE` are withheld everywhere else.
  test.each(['from', 'to', 'subject', 'text'])('a CRLF in %s is refused, not sent', (key) => {
    expect(() =>
      searchCriteria({ [key]: 'x\r\nZ1 SELECT INBOX\r\nZ2 UID STORE 1:* +FLAGS (\\Deleted)' }),
    ).toThrow(/carriage return, newline, or NUL/);
  });

  test('dates become the format IMAP accepts', () => {
    // IMAP wants `1-Aug-2026` and rejects an ISO date without explaining.
    expect(imapDate('2026-08-01')).toBe('1-Aug-2026');
    expect(imapDate('2026-12-25')).toBe('25-Dec-2026');
    expect(imapDate('not a date')).toBeUndefined();
  });

  test('flags and dates combine', () => {
    expect(searchCriteria({ unseen: true, since: '2026-08-01', from: 'sam' })).toBe(
      'FROM "sam" SINCE 1-Aug-2026 UNSEEN',
    );
  });
});
