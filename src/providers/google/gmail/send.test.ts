import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProviderWithCapabilities, type ToolResult } from '#connectivity';
import { ProviderRegistry } from '#registry';
import { harnessFor } from '#providers/harness.ts';
import { manifestOf } from '#providers/index.ts';
import { gmail } from './index.ts';
import { gmailSend } from './send.ts';

/**
 * Sending, with the network substituted.
 *
 * There was no send tool here at all before this, and both draft tools accepted
 * only `raw` — the whole assembled message, base64url — so even a plain mail
 * meant the caller building MIME by hand. What these assert is that the caller no
 * longer does that, and that the bytes never appear in anything handed back.
 */

interface Call {
  readonly url: string;
  readonly contentType: string | null;
  readonly body: string;
}

/** A harness whose `fetch` records what went out and answers as Gmail would. */
const sending = (
  options: { answers?: Record<string, unknown>[]; files?: Record<string, Uint8Array> } = {},
) => {
  const calls: Call[] = [];
  const answers = [...(options.answers ?? [])];

  const capability = gmailSend({
    fetch: (async (request: Request) => {
      const body = await request.text();
      calls.push({
        url: request.url,
        contentType: request.headers.get('content-type'),
        body,
      });

      return new Response(JSON.stringify(answers.shift() ?? { id: '18f0a1' }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as never,
  });

  const files = options.files ?? {};
  const harness = harnessFor(
    defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
    'main',
    {
      attachments: {
        stage: async () => ({ handle: 'stg_x', sha256: '', expiresAt: 0 }),
        staged: async () => null,
        asset: async (name: string) =>
          files[name] ? { bytes: files[name]!, filename: name, contentType: null } : null,
      },
    },
  );

  return { calls, harness };
};

const parsed = (result: unknown): Record<string, unknown> =>
  JSON.parse(((result as ToolResult).content[0] as { text: string }).text);

const uploaded = (call: Call): boolean => call.contentType?.startsWith('multipart/related') ?? false;

/**
 * An upload-host body taken apart: the resource Gmail was given, then the message.
 *
 * Split on the boundary the request itself declared, so a body whose delimiters
 * disagree with its own header fails here rather than passing.
 */
const partsOf = (call: Call): { resource: Record<string, unknown>; message: string } => {
  const boundary = /^multipart\/related; boundary=(\S+)$/.exec(call.contentType ?? '')?.[1];
  if (boundary === undefined) throw new Error(`not a multipart body: ${call.contentType}`);

  const [, first = '', second = ''] = call.body.split(`--${boundary}`);
  const content = (part: string) =>
    part.slice(part.indexOf('\r\n\r\n') + 4, part.lastIndexOf('\r\n'));

  return { resource: JSON.parse(content(first)), message: content(second) };
};

/** The resource Gmail was handed, whichever of the two routes it took. */
const resourceOf = (call: Call): Record<string, unknown> =>
  uploaded(call) ? partsOf(call).resource : (JSON.parse(call.body) as Record<string, unknown>);

/** What Gmail was handed, decoded back into the message it represents. */
const rawOf = (call: Call): string => {
  if (uploaded(call)) return partsOf(call).message;
  const body = JSON.parse(call.body) as { raw?: string; message?: { raw?: string } };
  const encoded = body.raw ?? body.message?.raw ?? '';
  return Buffer.from(encoded, 'base64url').toString('utf8');
};

/**
 * What `messages.list` answers when the message being replied to is here.
 *
 * The Message-ID carries `+` and `=` because Gmail's own do, and both are
 * characters a query string can quietly change the meaning of.
 */
const REPLIED_TO = '<a+b=c@example.com>';
const FOUND = { messages: [{ id: '18e0002', threadId: '18e0001' }], resultSizeEstimate: 1 };

describe('the tool the endpoint advertises', () => {
  test('gmail offers send_message, in the write bundle', () => {
    // The real provider, not a fixture: registering a definition rather than a
    // manifest is new, and the wire name comes out of the capability id.
    const registry = new ProviderRegistry();
    registry.register(gmail);

    const send = registry.findCapability('gmail.send_message');

    expect(send).toBeDefined();
    expect(send?.capability?.kind).toBe('tool');
    // `gmail_send_message` on the wire — naming replaces the dot.
    expect(registry.expandBundle('gmail', 'write')).toContain('gmail.send_message');
  });

  test('the discovered tools are untouched by it', () => {
    const registry = new ProviderRegistry();
    registry.register(gmail);
    registry.setDiscovered('gmail', [
      { name: 'users.messages.list', description: '', inputSchema: {}, bundle: 'read' },
    ]);

    expect(registry.capabilities().map((entry) => entry.id).sort()).toEqual([
      'gmail.send_message',
      'gmail.users.messages.list',
    ]);
  });
});

describe('sending a plain message', () => {
  test('composes the MIME here, so the caller never touches base64', async () => {
    const { calls, harness } = sending();

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Hello',
      text: 'Body text.',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(calls[0]!.contentType).toBe('application/json');

    // base64url specifically — Gmail rejects the standard alphabet here.
    const raw = rawOf(calls[0]!);
    expect(raw).toContain('To: sam@example.com');
    expect(raw).toContain('Subject: Hello');
    expect(raw).toContain('Body text.');

    expect(parsed(result)).toMatchObject({ sent: true, recipients: 1 });
  });

  test('no From header is written, because the credential decides it', async () => {
    // Guessing an address risks composing one this account may not send as.
    const { calls, harness } = sending();

    await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Hello',
      text: 'Body',
    });

    expect(rawOf(calls[0]!)).not.toContain('From:');
  });

  test('draft_only saves instead of sending, and nests the message as Gmail expects', async () => {
    const { calls, harness } = sending({ answers: [{ id: 'r-99', message: { id: '18f0b2' } }] });

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Later',
      text: 'Body',
      draft_only: true,
    });

    expect(calls[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(JSON.parse(calls[0]!.body)).toHaveProperty('message.raw');
    expect(parsed(result)).toMatchObject({ drafted: true, draft_id: 'r-99' });
  });

  test('recipients counts cc and bcc, not just to', async () => {
    const { harness } = sending();

    const result = await harness.invoke('send_message', {
      to: ['a@example.com'],
      cc: ['b@example.com', 'c@example.com'],
      bcc: ['d@example.com'],
      subject: 'Hi',
      text: 'Body',
    });

    expect(parsed(result)).toMatchObject({ recipients: 4 });
  });
});

describe('revising a draft', () => {
  test('replaces it in place, rather than leaving a second one behind', async () => {
    const { calls, harness } = sending({ answers: [{ id: 'r-99', message: { id: '18f0c3' } }] });

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Corrected',
      text: 'Now with the right figure.',
      draft_only: true,
      draft_id: 'r-99',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-99');
    expect(rawOf(calls[0]!)).toContain('Now with the right figure.');
    expect(parsed(result)).toMatchObject({ drafted: true, draft_id: 'r-99' });
  });

  test('carries an attachment, which is the whole point of it', async () => {
    // `drafts.update` took a `raw` the caller assembled, so correcting a draft
    // that held a file meant deleting it and composing everything again. The
    // message is recomposed here exactly as it is for a new draft; only the
    // address differs.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-revise-'));
    await writeFile(join(root, 'invoice.pdf'), new Uint8Array([1, 2, 3, 4]));

    const { calls, harness } = sending({ answers: [{ id: 'r-7' }] });

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Invoice, corrected',
      text: 'Attached.',
      draft_only: true,
      draft_id: 'r-7',
      attachments: [{ path: join(root, 'invoice.pdf') }],
    });

    const raw = rawOf(calls[0]!);
    expect(raw).toMatch(/Content-Disposition: attachment; filename="?invoice\.pdf"?/);
    expect(parsed(result)['attachments']).toMatchObject([{ filename: 'invoice.pdf', bytes: 4 }]);
  });

  test('a large revision still goes to the upload host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-revise-big-'));
    await writeFile(join(root, 'big.bin'), new Uint8Array(6 * 1024 * 1024));

    const { calls, harness } = sending({ answers: [{ id: 'r-8' }] });

    await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Large, corrected',
      draft_only: true,
      draft_id: 'r-8',
      attachments: [{ path: join(root, 'big.bin') }],
    });

    expect(calls[0]!.url).toBe(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/r-8?uploadType=multipart',
    );
    // A draft nests its message on this route exactly as on the JSON one; this
    // one answers nothing, so there is no thread to name inside it.
    expect(resourceOf(calls[0]!)).toEqual({ message: {} });
    expect(rawOf(calls[0]!)).toContain('Content-Disposition: attachment');
  });

  test('without draft_only it updates and then sends, by id', async () => {
    // Two requests rather than folding the update into `drafts.send`: if that
    // call does not merge the way one assumed, the *previous* draft goes to
    // real recipients and nothing says so.
    const { calls, harness } = sending({
      answers: [{ id: 'r-12' }, { id: '18f0d4', labelIds: ['SENT'] }],
    });

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Corrected and sent',
      text: 'Body',
      draft_id: 'r-12',
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-12');
    expect(calls[1]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send');
    expect(JSON.parse(calls[1]!.body)).toEqual({ id: 'r-12' });
    expect(parsed(result)).toMatchObject({ sent: true });
  });

  test('a send that fails after a successful revision says the draft is saved', async () => {
    // The two halves leave the mailbox in different states, and only this one
    // is worth retrying as a send rather than composing again.
    let call = 0;
    const capability = gmailSend({
      fetch: (async () => {
        call += 1;
        return call === 1
          ? Response.json({ id: 'r-15' })
          : new Response('{"error":{"message":"Recipient address rejected"}}', { status: 400 });
      }) as never,
    });

    const harness = harnessFor(
      defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
      'main',
    );

    const result = (await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Corrected',
      text: 'Body',
      draft_id: 'r-15',
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('revised but not sent');
    expect(text).toContain('r-15');
    expect(text).toContain('Recipient address rejected');
  });

  test('nothing vendored offers a second way to rewrite a draft', () => {
    // `drafts.update` was removed when this arrived. The guard in
    // `specs/specs.test.ts` is what keeps it out; this asserts the surface an
    // agent actually sees, which is the thing that misled a client before.
    const registry = new ProviderRegistry();
    registry.register(gmail);
    registry.setDiscovered('gmail', [
      { name: 'users.drafts.delete', description: '', inputSchema: {}, bundle: 'write' },
    ]);

    const names = registry.capabilities().map((entry) => entry.id);

    expect(names).toContain('gmail.send_message');
    expect(names).not.toContain('gmail.users.drafts.update');
    expect(names).not.toContain('gmail.users.drafts.create');
  });
});

describe('replying', () => {
  /**
   * Gmail's own document names three conditions for filing a message in a
   * conversation, and the headers are only one of them: the request has to name
   * the thread. Without that a reply carries every header a recipient's client
   * threads by, and still lands in the sender's own mailbox as a conversation of
   * one — which is how this was found.
   */
  test('is filed in the thread that holds the message it answers', async () => {
    const { calls, harness } = sending({ answers: [FOUND, { id: '18f0a1', threadId: '18e0001' }] });

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Yes, go ahead.',
      in_reply_to: REPLIED_TO,
    });

    expect(calls).toHaveLength(2);

    const lookup = new URL(calls[0]!.url);
    expect(lookup.pathname).toBe('/gmail/v1/users/me/messages');
    // Bare, and intact: an unencoded `+` reads as a space, and the search then
    // misses without saying so.
    expect(lookup.searchParams.get('q')).toBe('rfc822msgid:a+b=c@example.com');
    // The list leaves both out by default, and a reply to a message in either is
    // still a reply to it.
    expect(lookup.searchParams.get('includeSpamTrash')).toBe('true');

    expect(calls[1]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(resourceOf(calls[1]!)).toMatchObject({ threadId: '18e0001' });
    const raw = rawOf(calls[1]!);
    expect(raw).toContain('In-Reply-To: <a+b=c@example.com>');
    expect(raw).toContain('References: <a+b=c@example.com>');

    expect(parsed(result)).toMatchObject({ sent: true, thread_id: '18e0001' });
    expect(parsed(result)).not.toHaveProperty('note');
  });

  test('saved as a draft, it nests the thread inside the message', async () => {
    const { calls, harness } = sending({
      answers: [FOUND, { id: 'r-5', message: { id: '18f0b2', threadId: '18e0001' } }],
    });

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Draft reply.',
      in_reply_to: REPLIED_TO,
      draft_only: true,
    });

    expect(calls[1]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts');
    expect(resourceOf(calls[1]!)).toMatchObject({ message: { threadId: '18e0001' } });
    // A draft reports its thread one level down, beside its message id.
    expect(parsed(result)).toMatchObject({ drafted: true, draft_id: 'r-5', thread_id: '18e0001' });
  });

  test('revised, it stays in the thread, and sending it by id adds nothing', async () => {
    // Gmail destroys a draft's message and replaces it with the one supplied, so a
    // revision that does not name the thread again takes the draft out of it.
    const { calls, harness } = sending({
      answers: [FOUND, { id: 'r-12' }, { id: '18f0d4', threadId: '18e0001', labelIds: ['SENT'] }],
    });

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Corrected reply.',
      in_reply_to: REPLIED_TO,
      draft_id: 'r-12',
    });

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-12');
    expect(resourceOf(calls[1]!)).toMatchObject({ message: { threadId: '18e0001' } });
    // The draft already holds the thread, so the send names the draft and nothing else.
    expect(JSON.parse(calls[2]!.body)).toEqual({ id: 'r-12' });
    expect(parsed(result)).toMatchObject({ sent: true, thread_id: '18e0001' });
  });

  test('to a message this mailbox does not hold, it is still sent, and says where it went', async () => {
    // Nothing to join here. The headers still go, for the recipient's client,
    // but in this mailbox it is a conversation of one, and the caller should
    // not report otherwise.
    const { calls, harness } = sending({
      answers: [{ resultSizeEstimate: 0 }, { id: '18f0a1', threadId: '18f0a1' }],
    });

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Body',
      in_reply_to: '<elsewhere@example.com>',
    });

    expect(calls).toHaveLength(2);
    expect(resourceOf(calls[1]!)).not.toHaveProperty('threadId');
    expect(rawOf(calls[1]!)).toContain('In-Reply-To: <elsewhere@example.com>');
    expect(parsed(result)).toMatchObject({ sent: true, thread_id: '18f0a1' });
    expect(String(parsed(result)['note'])).toContain('new conversation');
  });

  test('a thread Gmail was handed and did not use is said, with the condition that failed', async () => {
    // A thread asked for is not a thread joined: Gmail files the reply there
    // only when all three of its conditions hold, and the answer is the one
    // place that says which happened.
    const { harness } = sending({ answers: [FOUND, { id: '18f0a1', threadId: '18f0a1' }] });

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Something else entirely',
      text: 'Body',
      in_reply_to: REPLIED_TO,
    });

    expect(parsed(result)).toMatchObject({ sent: true, thread_id: '18f0a1' });
    expect(String(parsed(result)['note'])).toContain('subject');
  });

  test('what the lookup read is recorded on the send, as identifiers', async () => {
    // A read made by a write, so the write's row says what it read — the same
    // reasoning that gives a mailbox attachment its `origin`.
    const { harness } = sending({ answers: [FOUND, { id: '18f0a1', threadId: '18e0001' }] });

    await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Body',
      in_reply_to: REPLIED_TO,
    });

    expect(harness.annotations()).toEqual({
      in_reply_to: 'a+b=c@example.com',
      thread_id: '18e0001',
    });
  });

  test('two Message-IDs are refused before anything is asked of Gmail', async () => {
    // One message is searched for. The parent's `References` pasted whole would
    // search for neither, and the receipt would then say it is not here.
    const { calls, harness } = sending();

    const result = (await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Body',
      in_reply_to: '<a@example.com> <b@example.com>',
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('names one message');
    expect(text).toContain('Nothing was sent');
    expect(calls).toHaveLength(0);
  });

  test('a message that answers nothing makes no lookup and names no thread', async () => {
    const { calls, harness } = sending({ answers: [{ id: '18f0a1', threadId: '18f0a1' }] });

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Hello',
      text: 'Body',
    });

    expect(calls).toHaveLength(1);
    expect(resourceOf(calls[0]!)).not.toHaveProperty('threadId');
    expect(parsed(result)).toMatchObject({ sent: true, thread_id: '18f0a1' });
    expect(parsed(result)).not.toHaveProperty('note');
    expect(harness.annotations()).toEqual({});
  });

  test('a Message-ID with stray space around it composes one clean header', async () => {
    // nodemailer trims `References` and not `In-Reply-To`, so this reached the
    // header as `< <a+b=c@example.com>` — and the search would have missed.
    const { calls, harness } = sending({ answers: [FOUND, {}] });

    await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Body',
      in_reply_to: ` ${REPLIED_TO} `,
    });

    expect(new URL(calls[0]!.url).searchParams.get('q')).toBe('rfc822msgid:a+b=c@example.com');
    expect(rawOf(calls[1]!)).toContain('In-Reply-To: <a+b=c@example.com>\r\n');
  });

  /** A Gmail that answers the lookup one way and every other request another. */
  const routed = (
    lookup: () => Response,
    verify?: (response: Response) => { retry: boolean } | undefined,
  ) => {
    const calls: string[] = [];
    const seen: number[] = [];

    const capability = gmailSend({
      fetch: (async (request: Request) => {
        calls.push(request.url);
        return new URL(request.url).pathname.endsWith('/messages')
          ? lookup()
          : Response.json({ id: '18f0a1', threadId: '18e0001' });
      }) as never,
    });

    const harness = harnessFor(
      defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
      'main',
      {
        verify: async (response) => {
          seen.push(response.status);
          return verify?.(response);
        },
      },
    );

    return { calls, seen, harness };
  };

  test('a lookup Gmail refuses sends nothing, fetches nothing, and says so', async () => {
    // Before the attachments, which can take tens of seconds: a lookup that is
    // going to fail should fail first. And sending it anyway, unthreaded, would
    // be the failure this whole path exists to prevent.
    const { calls, seen, harness } = routed(
      () => new Response('{"error":{"message":"Backend Error"}}', { status: 500 }),
    );

    const result = (await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Body',
      in_reply_to: REPLIED_TO,
      attachments: [{ message_id: '18eff00' }],
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('500');
    expect(text).toContain('Backend Error');
    expect(text).toContain('Nothing was sent');
    // The lookup and nothing after it: no attachment fetched, nothing submitted.
    expect(calls).toHaveLength(1);
    // Handed to the same check every other refusal gets.
    expect(seen).toEqual([500]);
  });

  test('a lookup refused on a stale token is made once more on a fresh one', async () => {
    // A read, so repeating it is the same read — which is what the http
    // transport does for every generated tool. The send after it is never
    // repeated; the credential tests below hold that half.
    let lookups = 0;
    const { calls, seen, harness } = routed(
      () => {
        lookups += 1;
        return lookups === 1
          ? new Response('{"error":{"code":401,"message":"Invalid Credentials"}}', { status: 401 })
          : Response.json(FOUND);
      },
      (response) => (response.status === 401 ? { retry: true } : undefined),
    );

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Quote',
      text: 'Body',
      in_reply_to: REPLIED_TO,
    });

    expect(lookups).toBe(2);
    expect(seen).toEqual([401]);
    expect(calls).toHaveLength(3);
    expect(parsed(result)).toMatchObject({ sent: true, thread_id: '18e0001' });
  });
});

describe('sending with an attachment', () => {
  test('a path is read here and lands in the message as a MIME part', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-'));
    await writeFile(join(root, 'invoice.pdf'), new Uint8Array([1, 2, 3, 4]));

    const { calls, harness } = sending();

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Invoice',
      text: 'Attached.',
      attachments: [{ path: join(root, 'invoice.pdf') }],
    });

    const raw = rawOf(calls[0]!);
    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('Content-Type: application/pdf');
    expect(raw).toMatch(/Content-Disposition: attachment; filename="?invoice\.pdf"?/);

    // A receipt, never the bytes.
    expect(parsed(result)['attachments']).toEqual([
      {
        filename: 'invoice.pdf',
        bytes: 4,
        content_type: 'application/pdf',
        sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
      },
    ]);
  });

  test('what was attached is annotated for the audit log, with its origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-'));
    await writeFile(join(root, 'invoice.pdf'), new Uint8Array([1, 2, 3, 4]));

    const { harness } = sending();

    await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Invoice',
      attachments: [{ path: join(root, 'invoice.pdf') }],
    });

    expect(harness.annotations()).toEqual({
      attachments: [
        {
          filename: 'invoice.pdf',
          bytes: 4,
          content_type: 'application/pdf',
          sha256: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
          origin: `path:${join(root, 'invoice.pdf')}`,
        },
      ],
    });
  });

  test('a missing file is refused before anything is submitted', async () => {
    const { calls, harness } = sending();

    const result = (await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Invoice',
      attachments: [{ path: '/nope/missing.pdf' }],
    })) as ToolResult;

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('/nope/missing.pdf');
    // Nothing left. A half-sent mail is worse than a refused one.
    expect(calls).toHaveLength(0);
  });

  test('an attachment already in the mailbox is fetched and re-attached', async () => {
    // The case the original report actually needed: a PDF arrived by mail and
    // forwarding it should not route the bytes through the model. Gmail hands
    // attachment content back as base64url, which is the trap — the standard
    // alphabet would corrupt the file while still producing one.
    const calls: Call[] = [];
    const pdf = Buffer.from([0xff, 0xfe, 0x03, 0x04]);

    const capability = gmailSend({
      fetch: (async (request: Request) => {
        calls.push({
          url: request.url,
          contentType: request.headers.get('content-type'),
          body: await request.text(),
        });

        if (request.url.includes('/attachments/')) {
          return Response.json({ data: pdf.toString('base64url'), size: pdf.byteLength });
        }
        if (request.url.includes('format=full')) {
          return Response.json({
            payload: {
              mimeType: 'multipart/mixed',
              parts: [
                { mimeType: 'text/plain', body: {} },
                {
                  mimeType: 'application/pdf',
                  filename: 'quote.pdf',
                  body: { attachmentId: 'ANGjdJ8', size: pdf.byteLength },
                },
              ],
            },
          });
        }
        return Response.json({ id: '18f0a1' });
      }) as never,
    });

    const harness = harnessFor(
      defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
      'main',
    );

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Fwd: Quote',
      text: 'See attached.',
      attachments: [{ message_id: '18eff00' }],
    });

    // Message metadata, then the attachment body, then the send.
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain('format=full');
    expect(calls[1]!.url).toContain('/attachments/ANGjdJ8');

    const raw = rawOf(calls[2]!);
    expect(raw).toMatch(/Content-Disposition: attachment; filename="?quote\.pdf"?/);
    // The bytes survived the alphabet round trip.
    expect(raw).toContain(pdf.toString('base64'));

    expect(parsed(result)['attachments']).toMatchObject([
      { filename: 'quote.pdf', bytes: 4, content_type: 'application/pdf' },
    ]);
  });

  test('an ambiguous mailbox reference lists what is there', async () => {
    const capability = gmailSend({
      fetch: (async (request: Request) =>
        request.url.includes('format=full')
          ? Response.json({
              payload: {
                parts: [
                  { filename: 'a.pdf', body: { attachmentId: 'x1' } },
                  { filename: 'b.pdf', body: { attachmentId: 'x2' } },
                ],
              },
            })
          : Response.json({ id: '1' })) as never,
    });

    const harness = harnessFor(
      defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
      'main',
    );

    const result = (await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Fwd',
      attachments: [{ message_id: '18eff00' }],
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('attachment_id is needed');
    expect(text).toContain('a.pdf, b.pdf');
  });
});

describe('a message too large for a JSON field', () => {
  test('goes to the upload host, raw, behind the resource it belongs to', async () => {
    // Lifts the ceiling from "what fits in a JSON string" to Gmail's own 35 MiB.
    // `raw` is base64url inside JSON, so a large message would otherwise be a
    // third bigger again and meet a generic request limit first.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-big-'));
    await writeFile(join(root, 'big.bin'), new Uint8Array(6 * 1024 * 1024));

    const { calls, harness } = sending();

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Large',
      text: 'Attached.',
      attachments: [{ path: join(root, 'big.bin') }],
    });

    expect(calls[0]!.url).toBe(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart',
    );
    expect(calls[0]!.contentType).toMatch(/^multipart\/related; boundary=/);
    // The resource the JSON route would have sent, less `raw` — and this message
    // answers nothing, so there is nothing in it.
    expect(resourceOf(calls[0]!)).toEqual({});
    // Raw MIME, not base64url of it.
    expect(rawOf(calls[0]!)).toContain('Content-Disposition: attachment');
    expect(parsed(result)).toMatchObject({ sent: true });
  });

  test('a large reply carries its thread there, which a media upload could not', async () => {
    // `uploadType=media` carries the bytes and nothing else, which made this the
    // one route that lost the thread even once the JSON route kept it.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-big-reply-'));
    await writeFile(join(root, 'big.bin'), new Uint8Array(6 * 1024 * 1024));

    const { calls, harness } = sending({ answers: [FOUND, { id: '18f0a1', threadId: '18e0001' }] });

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Large',
      text: 'Attached.',
      in_reply_to: REPLIED_TO,
      attachments: [{ path: join(root, 'big.bin') }],
    });

    expect(calls[1]!.url).toBe(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart',
    );
    expect(resourceOf(calls[1]!)).toEqual({ threadId: '18e0001' });
    expect(rawOf(calls[1]!)).toContain('In-Reply-To: <a+b=c@example.com>');
    expect(parsed(result)).toMatchObject({ sent: true, thread_id: '18e0001' });
  });

  test('a large reply draft, and a large revision of one, name the thread inside the message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-big-draft-'));
    await writeFile(join(root, 'big.bin'), new Uint8Array(6 * 1024 * 1024));
    const reply = {
      to: ['ada.lovelace@example.com'],
      subject: 'Re: Large',
      in_reply_to: REPLIED_TO,
      draft_only: true,
      attachments: [{ path: join(root, 'big.bin') }],
    };

    const created = sending({ answers: [FOUND, { id: 'r-9', message: { id: '18f0b2' } }] });
    await created.harness.invoke('send_message', reply);

    expect(created.calls[1]!.url).toBe(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts?uploadType=multipart',
    );
    expect(resourceOf(created.calls[1]!)).toEqual({ message: { threadId: '18e0001' } });

    const revised = sending({ answers: [FOUND, { id: 'r-9' }] });
    await revised.harness.invoke('send_message', { ...reply, draft_id: 'r-9' });

    expect(revised.calls[1]!.url).toBe(
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/r-9?uploadType=multipart',
    );
    expect(resourceOf(revised.calls[1]!)).toEqual({ message: { threadId: '18e0001' } });
  });

  test('the boundary occurs only as the delimiters', async () => {
    // A boundary inside a part ends that part there (RFC 2046 §5.1.1), so it is
    // checked against the message rather than trusted to be unlikely.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-big-boundary-'));
    await writeFile(join(root, 'big.bin'), new Uint8Array(6 * 1024 * 1024));

    const { calls, harness } = sending();

    await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Large',
      attachments: [{ path: join(root, 'big.bin') }],
    });

    const boundary = /boundary=(\S+)$/.exec(calls[0]!.contentType ?? '')?.[1];
    expect(boundary).toBeDefined();
    // Two part openings and the close, and nowhere else.
    expect(calls[0]!.body.split(`--${boundary}`)).toHaveLength(4);
    expect(calls[0]!.body.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });

  test('past what Gmail accepts at all, it is refused rather than attempted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-gmail-huge-'));
    // Over three quarters of the 35 MiB ceiling, which is the raw weight that
    // still fits once base64 expansion is counted.
    await writeFile(join(root, 'huge.bin'), new Uint8Array(28 * 1024 * 1024));

    const { calls, harness } = sending();

    const result = (await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Too large',
      attachments: [{ path: join(root, 'huge.bin') }],
    })) as ToolResult;

    expect(result.isError).toBe(true);
    // Refused at the resolver, before composing — 27,525,120 is 3/4 of Gmail's
    // 36,700,160. The exact post-composition check against the full ceiling is
    // the backstop behind this one, and only it knows the true encoded size; the
    // same guard on the SMTP side is asserted directly in the IMAP tests.
    expect((result.content[0] as { text: string }).text).toContain('27525120');
    expect(calls).toHaveLength(0);
  });
});

describe('when Gmail refuses', () => {
  test('the status and body come back rather than a bare failure', async () => {
    const capability = gmailSend({
      fetch: (async () =>
        new Response('{"error":{"message":"Invalid to header"}}', { status: 400 })) as never,
    });

    const harness = harnessFor(
      defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
      'main',
    );

    const result = (await harness.invoke('send_message', {
      to: ['nonsense'],
      subject: 'Hi',
      text: 'Body',
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('400');
    expect(text).toContain('Invalid to header');
  });
});

describe('a file this profile keeps', () => {
  test('is attached by name, and the log records the asset store as its origin', async () => {
    const { calls, harness } = sending({
      files: { 'invoice-2026.pdf': new Uint8Array([1, 2, 3, 4]) },
    });

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Invoice',
      text: 'Attached.',
      attachments: [{ asset: 'invoice-2026.pdf' }],
    });

    expect(rawOf(calls[0]!)).toMatch(
      /Content-Disposition: attachment; filename="?invoice-2026\.pdf"?/,
    );
    // A receipt, never the bytes — and the log says which store it came out of.
    expect(parsed(result)['attachments']).toMatchObject([
      { filename: 'invoice-2026.pdf', bytes: 4 },
    ]);
    expect(harness.annotations()).toMatchObject({
      attachments: [{ filename: 'invoice-2026.pdf', origin: 'asset:invoice-2026.pdf' }],
    });
  });

  test('a name this profile does not keep refuses instead of sending an empty file', async () => {
    const { calls, harness } = sending();

    const result = await harness.invoke('send_message', {
      to: ['sam@example.com'],
      subject: 'Invoice',
      attachments: [{ asset: 'gone.pdf' }],
    });

    expect(JSON.stringify(result)).toMatch(/no asset .*gone\.pdf/);
    expect(calls).toHaveLength(0);
  });
});

describe('a credential the vendor refuses mid-send', () => {
  /**
   * This capability is authored, so it calls Gmail itself and skipped the one
   * thing every transported call gets: a refused token being distrusted. Left
   * as it was, a send that came back 401 left that token trusted for the rest
   * of the hour — and sending is exactly where an agent then retries.
   */
  const refusing = () => {
    const seen: number[] = [];
    const capability = gmailSend({
      fetch: (async () =>
        new Response('{"error":{"code":401,"message":"Invalid Credentials"}}', {
          status: 401,
          statusText: 'Unauthorized',
        })) as never,
    });

    const harness = harnessFor(
      defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
      'main',
      { verify: async (response) => void seen.push(response.status) },
    );

    return { seen, harness };
  };

  test('is handed back for the same check a transported reply gets', async () => {
    const { seen, harness } = refusing();

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'x',
      text: 'y',
    });

    expect((result as ToolResult).isError).toBe(true);
    expect(seen).toEqual([401]);
  });

  /**
   * Distrust without retry, and the asymmetry is deliberate: a send that was
   * refused may still have been delivered, so repeating it is not a decision
   * this layer gets to make. The connection is repaired for the *next* call.
   */
  test('and the send is not repeated', async () => {
    const { seen, harness } = refusing();

    await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'x',
      text: 'y',
    });

    expect(seen).toHaveLength(1);
  });

  test('not even when the verifier offers a fresh token', async () => {
    // Reads take that offer — the thread lookup does — and a send never does,
    // because the one that was refused may still have been delivered.
    let submitted = 0;
    const capability = gmailSend({
      fetch: (async () => {
        submitted += 1;
        return new Response('{"error":{"code":401,"message":"Invalid Credentials"}}', {
          status: 401,
        });
      }) as never,
    });

    const harness = harnessFor(
      defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
      'main',
      { verify: async () => ({ retry: true }) },
    );

    const result = await harness.invoke('send_message', {
      to: ['ada.lovelace@example.com'],
      subject: 'x',
      text: 'y',
    });

    expect((result as ToolResult).isError).toBe(true);
    expect(submitted).toBe(1);
  });
});
