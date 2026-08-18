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
const sending = (options: { answers?: Record<string, unknown>[] } = {}) => {
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

  const harness = harnessFor(
    defineProviderWithCapabilities({ manifest: manifestOf(gmail), capabilities: [capability] }),
    'main',
  );

  return { calls, harness };
};

const parsed = (result: unknown): Record<string, unknown> =>
  JSON.parse(((result as ToolResult).content[0] as { text: string }).text);

/** What Gmail was handed, decoded back into the message it represents. */
const rawOf = (call: Call): string => {
  if (call.contentType === 'message/rfc822') return call.body;
  const body = JSON.parse(call.body) as { raw?: string; message?: { raw?: string } };
  const encoded = body.raw ?? body.message?.raw ?? '';
  return Buffer.from(encoded, 'base64url').toString('utf8');
};

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
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/r-8?uploadType=media',
    );
    expect(calls[0]!.contentType).toBe('message/rfc822');
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
  test('goes to the upload host as message/rfc822 instead', async () => {
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
      'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media',
    );
    expect(calls[0]!.contentType).toBe('message/rfc822');
    // Raw MIME, not base64url of it.
    expect(calls[0]!.body).toContain('Content-Disposition: attachment');
    expect(parsed(result)).toMatchObject({ sent: true });
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
