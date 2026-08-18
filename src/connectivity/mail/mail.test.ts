import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import {
  composeMime,
  isBlocked,
  putStaged,
  resolveAttachments,
  stagedBytesKey,
  stagedMetaKey,
  sweepStaged,
  STAGED_TTL_MS,
  type ResolvedAttachment,
} from './index.ts';

/**
 * The claim under test is one sentence: a caller names a file and the bytes never
 * pass through the model. Everything here is either "the naming works" or "the
 * naming cannot be turned into something it should not reach".
 */

const scratch = async (): Promise<string> => mkdtemp(join(tmpdir(), 'lanes-link-attach-'));

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00, 0xff]);

// SHA-256 of the eleven bytes above, so the digest is asserted against an
// independent value rather than against whatever the code happens to produce.
// Verified out of band: `printf '\x25\x50\x44\x46\x2d\x31\x2e\x34\x0a\x00\xff'
// | shasum -a 256`.
const PDF_SHA256 = '2d0f60e62f80ddea32dc2d6182644881af95907eff64d4404913c9b55de700da';

const only = (attachments: readonly ResolvedAttachment[]): ResolvedAttachment => {
  expect(attachments).toHaveLength(1);
  return attachments[0]!;
};

const BUDGET = { maxTotalBytes: 1_000_000 };

describe('naming exactly one source', () => {
  test('an empty reference says what to give instead of failing vaguely', async () => {
    const failure = resolveAttachments([{}], BUDGET);

    await expect(failure).rejects.toThrow(/names no file/);
    // The message has to carry an example: a caller that got here does not know
    // the shape, and a list of key names alone has not told them.
    await expect(failure).rejects.toThrow(/"path"/);
  });

  test('two sources is an error, not a precedence rule', async () => {
    // Silently preferring one would make the other look like it worked. Which
    // file got attached is exactly the thing nobody would check.
    const failure = resolveAttachments([{ path: '/tmp/a.pdf', data: 'AAAA' }], BUDGET);

    await expect(failure).rejects.toThrow(/names 2 sources \(path, data\)/);
  });

  test('a misspelled key is rejected rather than read as no source at all', async () => {
    // `additionalProperties: false` via a strict object. Without it, `paht` would
    // surface as the far more confusing "names no file".
    await expect(resolveAttachments([{ paht: '/tmp/a.pdf' }], BUDGET)).rejects.toThrow(
      /not shaped right/,
    );
  });

  test('absent attachments resolve to none, so the ordinary send is untouched', async () => {
    expect(await resolveAttachments(undefined, BUDGET)).toEqual([]);
    expect(await resolveAttachments(null, BUDGET)).toEqual([]);
    expect(await resolveAttachments([], BUDGET)).toEqual([]);
  });
});

describe('a file on this machine', () => {
  test('is read, named, typed, and digested', async () => {
    const root = await scratch();
    await writeFile(join(root, 'invoice.pdf'), PDF);

    const attachment = only(await resolveAttachments([{ path: join(root, 'invoice.pdf') }], BUDGET));

    expect(attachment.filename).toBe('invoice.pdf');
    expect(attachment.contentType).toBe('application/pdf');
    expect(attachment.bytes).toEqual(PDF);
    expect(attachment.sha256).toBe(PDF_SHA256);
    // The origin is what makes an unrestricted path auditable at all.
    expect(attachment.origin).toBe(`path:${join(root, 'invoice.pdf')}`);
  });

  test('an unknown extension falls back rather than guessing', async () => {
    const root = await scratch();
    await writeFile(join(root, 'blob.zzz'), PDF);

    const attachment = only(await resolveAttachments([{ path: join(root, 'blob.zzz') }], BUDGET));

    expect(attachment.contentType).toBe('application/octet-stream');
  });

  test('explicit filename and content_type win over what the path implies', async () => {
    const root = await scratch();
    await writeFile(join(root, 'tmp-9f2c.bin'), PDF);

    const attachment = only(
      await resolveAttachments(
        [{ path: join(root, 'tmp-9f2c.bin'), filename: 'Invoice.pdf', content_type: 'application/pdf' }],
        BUDGET,
      ),
    );

    expect(attachment.filename).toBe('Invoice.pdf');
    expect(attachment.contentType).toBe('application/pdf');
  });

  test('a missing file names the path', async () => {
    await expect(resolveAttachments([{ path: '/nope/missing.pdf' }], BUDGET)).rejects.toThrow(
      /no file at \/nope\/missing\.pdf/,
    );
  });

  test('a directory is refused as a directory', async () => {
    const root = await scratch();
    await mkdir(join(root, 'folder'));

    await expect(resolveAttachments([{ path: join(root, 'folder') }], BUDGET)).rejects.toThrow(
      /is a directory/,
    );
  });

  test('a file over the budget is refused before anything is sent', async () => {
    const root = await scratch();
    await writeFile(join(root, 'big.bin'), new Uint8Array(2048));

    await expect(
      resolveAttachments([{ path: join(root, 'big.bin') }], { maxTotalBytes: 1024 }),
    ).rejects.toThrow(/over the 1024 byte limit/);
  });

  test('several small files can still exceed the budget together', async () => {
    const root = await scratch();
    await writeFile(join(root, 'a.bin'), new Uint8Array(600));
    await writeFile(join(root, 'b.bin'), new Uint8Array(600));

    await expect(
      resolveAttachments([{ path: join(root, 'a.bin') }, { path: join(root, 'b.bin') }], {
        maxTotalBytes: 1024,
      }),
    ).rejects.toThrow(/total more than 1024 bytes/);
  });
});

describe('inline base64, the escape hatch', () => {
  test('decodes standard base64', async () => {
    const attachment = only(
      await resolveAttachments([{ data: Buffer.from(PDF).toString('base64') }], BUDGET),
    );

    expect(attachment.bytes).toEqual(PDF);
    expect(attachment.origin).toBe('inline');
  });

  test('decodes base64url too, because one obvious source of bytes emits it', async () => {
    // A mail API hands attachment content back as base64url (RFC 4648 §5).
    // Refusing it would be a correct-looking failure whose real cost is that the
    // caller re-encodes by hand and gets it subtly wrong.
    const urlAlphabet = Buffer.from(PDF).toString('base64url');
    expect(urlAlphabet).not.toBe(Buffer.from(PDF).toString('base64'));

    expect(only(await resolveAttachments([{ data: urlAlphabet }], BUDGET)).bytes).toEqual(PDF);
  });

  test('rubbish is an error rather than a shorter file', async () => {
    // `Buffer.from(x, 'base64')` drops invalid characters silently, so without a
    // length check a typo becomes a truncated attachment that still sends.
    await expect(resolveAttachments([{ data: 'not base64 at all!!' }], BUDGET)).rejects.toThrow(
      /not valid base64/,
    );
  });
});

describe('a staged handle', () => {
  const stage = async (handle: string, meta: Record<string, unknown>) => {
    const storage = createMemoryBlobStore();
    await storage.put(stagedBytesKey(handle), PDF);
    await storage.put(stagedMetaKey(handle), new TextEncoder().encode(JSON.stringify(meta)));
    return storage;
  };

  test('resolves with the filename and type recorded at upload', async () => {
    const storage = await stage('att_01j7k', {
      filename: 'quote.pdf',
      content_type: 'application/pdf',
    });

    const attachment = only(
      await resolveAttachments([{ handle: 'att_01j7k' }], { ...BUDGET, storage }),
    );

    expect(attachment.filename).toBe('quote.pdf');
    expect(attachment.bytes).toEqual(PDF);
    expect(attachment.origin).toBe('handle:att_01j7k');
  });

  test('an expired handle reads as gone, and says handles expire', async () => {
    const storage = await stage('att_old', {
      filename: 'quote.pdf',
      expires_at: Date.now() - 1000,
    });

    await expect(
      resolveAttachments([{ handle: 'att_old' }], { ...BUDGET, storage }),
    ).rejects.toThrow(/expire/);
  });

  test('an unknown handle does not read as an empty attachment', async () => {
    await expect(
      resolveAttachments([{ handle: 'att_nope' }], {
        ...BUDGET,
        storage: createMemoryBlobStore(),
      }),
    ).rejects.toThrow(/no staged attachment/);
  });

  test('a traversal attempt is refused before it reaches the store', async () => {
    await expect(
      resolveAttachments([{ handle: '../../vault.enc' }], {
        ...BUDGET,
        storage: createMemoryBlobStore(),
      }),
    ).rejects.toThrow(/is not a handle/);
  });
});

describe('sweeping expired handles', () => {
  const stagedAt = async (handle: string, expiresAt: number) => {
    const storage = createMemoryBlobStore();
    await putStaged(storage, {
      handle,
      bytes: PDF,
      metadata: { filename: 'a.pdf', expires_at: expiresAt },
    });
    return storage;
  };

  test('an expired handle is removed, bytes and sidecar together', async () => {
    // There is no scheduler in this process, so staging sweeps on write. If this
    // did not remove both keys, one of them would accumulate forever.
    const storage = await stagedAt('att_gone', Date.now() - 1000);

    expect(await sweepStaged(storage)).toBe(1);
    expect(await storage.get(stagedBytesKey('att_gone'))).toBeNull();
    expect(await storage.get(stagedMetaKey('att_gone'))).toBeNull();
  });

  test('a live handle is left alone', async () => {
    const storage = await stagedAt('att_live', Date.now() + STAGED_TTL_MS);

    expect(await sweepStaged(storage)).toBe(0);
    expect(await storage.get(stagedBytesKey('att_live'))).not.toBeNull();
  });

  test('a handle with no expiry is left alone rather than guessed at', async () => {
    const storage = createMemoryBlobStore();
    await putStaged(storage, { handle: 'att_forever', bytes: PDF, metadata: { filename: 'a.pdf' } });

    expect(await sweepStaged(storage)).toBe(0);
    expect(await storage.get(stagedBytesKey('att_forever'))).not.toBeNull();
  });

  test('sweeping touches nothing outside the attachments prefix', async () => {
    // The store is scoped per connection, and a provider keeps its own blobs in
    // it. A sweep that reached them would be data loss.
    const storage = await stagedAt('att_gone', Date.now() - 1000);
    await storage.put('notes/keep-me', new TextEncoder().encode('important'));

    await sweepStaged(storage);

    expect(await storage.get('notes/keep-me')).not.toBeNull();
  });
});

describe('a mailbox reference', () => {
  test('is delegated to the provider that owns the mailbox', async () => {
    const attachment = only(
      await resolveAttachments([{ message_id: '<a@b>', attachment_id: 'quote.pdf' }], {
        ...BUDGET,
        mailbox: async ({ messageId, attachmentId }) => {
          expect(messageId).toBe('<a@b>');
          expect(attachmentId).toBe('quote.pdf');
          return { bytes: PDF, filename: 'quote.pdf', contentType: 'application/pdf' };
        },
      }),
    );

    expect(attachment.bytes).toEqual(PDF);
    expect(attachment.origin).toBe('mailbox:<a@b>');
  });

  test('a provider with no mailbox says so and suggests what does work', async () => {
    await expect(
      resolveAttachments([{ message_id: '<a@b>' }], BUDGET),
    ).rejects.toThrow(/cannot resolve/);
  });
});

describe('fetching a URL', () => {
  const publicAddress = async () => ['93.184.216.34'];

  test('plain HTTP is refused', async () => {
    await expect(
      resolveAttachments([{ url: 'http://example.com/a.pdf' }], {
        ...BUDGET,
        addresses: publicAddress,
      }),
    ).rejects.toThrow(/must be https/);
  });

  test('a host resolving to the cloud metadata address is refused', async () => {
    // The whole reason this source needs care. On a managed host this address
    // hands out the service account token to anything that asks it.
    await expect(
      resolveAttachments([{ url: 'https://evil.test/a.pdf' }], {
        ...BUDGET,
        addresses: async () => ['169.254.169.254'],
      }),
    ).rejects.toThrow(/link-local/);
  });

  test('one private answer among public ones is still refused', async () => {
    // Checking only the first address is the bug this exists to prevent: the OS
    // may connect to any of them.
    await expect(
      resolveAttachments([{ url: 'https://mixed.test/a.pdf' }], {
        ...BUDGET,
        addresses: async () => ['93.184.216.34', '10.0.0.5'],
      }),
    ).rejects.toThrow(/10\.0\.0\.5/);
  });

  test('a public URL is fetched, named from Content-Disposition, and typed', async () => {
    const attachment = only(
      await resolveAttachments([{ url: 'https://example.com/download' }], {
        ...BUDGET,
        addresses: publicAddress,
        fetch: (async () =>
          new Response(PDF, {
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': 'attachment; filename="report.pdf"',
            },
          })) as never,
      }),
    );

    expect(attachment.filename).toBe('report.pdf');
    expect(attachment.contentType).toBe('application/pdf');
    expect(attachment.bytes).toEqual(PDF);
  });

  test('a redirect to a private address is refused at the hop', async () => {
    // The standard bypass: a public host that 302s to loopback.
    const addresses = async (hostname: string) =>
      hostname === 'inside.test' ? ['127.0.0.1'] : ['93.184.216.34'];

    await expect(
      resolveAttachments([{ url: 'https://example.com/a.pdf' }], {
        ...BUDGET,
        addresses,
        fetch: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://inside.test/secret' },
          })) as never,
      }),
    ).rejects.toThrow(/loopback/);
  });

  test('a body larger than the budget is refused while streaming, not after', async () => {
    // The cap cannot trust Content-Length, so it is enforced as chunks arrive.
    await expect(
      resolveAttachments([{ url: 'https://example.com/big' }], {
        maxTotalBytes: 8,
        addresses: publicAddress,
        fetch: (async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(64));
                controller.close();
              },
            }),
          )) as never,
      }),
    ).rejects.toThrow(/larger than the 8 byte limit/);
  });
});

describe('which addresses are refused', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'cloud metadata'],
    ['0.0.0.0', 'this host'],
    ['100.64.0.1', 'carrier NAT'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['::ffff:127.0.0.1', 'loopback wearing IPv6'],
    ['::ffff:169.254.169.254', 'metadata wearing IPv6'],
    ['64:ff9b::7f00:1', 'loopback behind NAT64'],
    ['::', 'unspecified'],
  ])('%s is blocked (%s)', (address) => {
    expect(isBlocked(address)).toBe(true);
  });

  test.each([['93.184.216.34'], ['8.8.8.8'], ['172.32.0.1'], ['2606:2800:220:1::1'], ['64:ff9b::5db8:d822']])(
    '%s is allowed',
    (address) => {
      expect(isBlocked(address)).toBe(false);
    },
  );

  test('something that is not an address at all is blocked', () => {
    // An octal literal is not a valid address, so it never reaches this check —
    // it fails name resolution instead. Blocked here regardless, because a
    // caller reaching this point with a non-address means something upstream is
    // wrong and connecting anyway is the worse failure.
    expect(isBlocked('0177.0.0.1')).toBe(true);
    expect(isBlocked('not-an-address')).toBe(true);
  });
});

describe('composing the message', () => {
  const attachment: ResolvedAttachment = {
    filename: 'invoice.pdf',
    contentType: 'application/pdf',
    bytes: new Uint8Array(200).fill(0x41),
    sha256: 'x',
    origin: 'test',
  };

  test('an attachment becomes a multipart/mixed part that a mail client will show', async () => {
    const composed = await composeMime({
      from: 'ada@example.com',
      message: {
        to: ['sam@example.com'],
        subject: 'Invoice',
        text: 'Attached.',
        attachments: [attachment],
      },
    });

    const raw = new TextDecoder().decode(composed.raw);

    expect(raw).toContain('multipart/mixed');
    expect(raw).toContain('Content-Type: application/pdf');
    // Quoting is optional for a filename that is already a valid MIME token
    // (RFC 2183), and nodemailer omits it. Asserting either form keeps the test
    // about the header being present and correct rather than about its spelling.
    expect(raw).toMatch(/Content-Disposition: attachment; filename="?invoice\.pdf"?/);
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    expect(raw).toContain('Attached.');
    expect(composed.messageId).toMatch(/^<.+>$/);
  });

  test('a filename needing encoding is encoded rather than emitted raw', async () => {
    // A space or a non-ASCII character in a filename is where a hand-rolled
    // builder produces a header that parses as something else entirely.
    const composed = await composeMime({
      from: 'ada@example.com',
      message: {
        to: ['sam@example.com'],
        subject: 'Invoice',
        attachments: [{ ...attachment, filename: 'räkning april.pdf' }],
      },
    });

    const raw = new TextDecoder().decode(composed.raw);

    expect(raw).toContain('Content-Disposition: attachment');
    // RFC 2231 continuations (`filename*0*=utf-8''…`) are what nodemailer emits;
    // RFC 2047 encoded-words would also be correct. What must not happen is the
    // raw bytes landing in the header.
    expect(raw).toMatch(/filename\*?\d*\*?=/);
    expect(raw).not.toContain('räkning april.pdf');
  });

  test('base64 is wrapped at 76 columns, because RFC 2045 §6.8 requires it', async () => {
    // Long unwrapped lines are accepted by enough servers to look fine and
    // rejected or truncated by enough others to corrupt a file in the field.
    const composed = await composeMime({
      from: 'ada@example.com',
      message: { to: ['sam@example.com'], subject: 'Invoice', attachments: [attachment] },
    });

    const lines = new TextDecoder().decode(composed.raw).split('\r\n');

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  test('a display name is written beside the address', async () => {
    // Without this the From header is a bare address, which is what makes a sent
    // message read as machine-generated. Not a spam signal on its own — alignment
    // and DKIM decide that — but it is the difference between mail from a person
    // and mail from a process.
    const composed = await composeMime({
      from: 'ada@example.com',
      fromName: 'Ada Lovelace',
      message: { to: ['sam@example.com'], subject: 'Hi', text: 'Body' },
    });

    expect(new TextDecoder().decode(composed.raw)).toContain(
      'From: Ada Lovelace <ada@example.com>',
    );
  });

  test('a name needing encoding is encoded, not emitted raw', async () => {
    // A comma would split the header into two addresses and an accent is not
    // 7-bit, which is why the name is handed over structured rather than joined.
    const composed = await composeMime({
      from: 'ada@example.com',
      fromName: 'Bäcker, Ada',
      message: { to: ['sam@example.com'], subject: 'Hi', text: 'Body' },
    });

    const raw = new TextDecoder().decode(composed.raw);
    const from = raw.split('\r\n').find((line) => line.startsWith('From:'))!;

    expect(from).toContain('<ada@example.com>');
    expect(from).not.toContain('Bäcker, Ada');
    expect(from).toMatch(/=\?UTF-8\?|"/);
  });

  test('no name leaves a bare address rather than inventing one', async () => {
    const composed = await composeMime({
      from: 'ada@example.com',
      message: { to: ['sam@example.com'], subject: 'Hi', text: 'Body' },
    });

    expect(new TextDecoder().decode(composed.raw)).toContain('From: ada@example.com');
  });

  test('a name with no address writes no From at all', async () => {
    // A display name alone is not a header. This is the Gmail default: omit it
    // and let the vendor fill in the account's own name.
    const composed = await composeMime({
      fromName: 'Ada Lovelace',
      message: { to: ['sam@example.com'], subject: 'Hi', text: 'Body' },
    });

    expect(new TextDecoder().decode(composed.raw)).not.toContain('From:');
  });

  test('no attachments composes a plain message, not an empty multipart', async () => {
    const composed = await composeMime({
      from: 'ada@example.com',
      message: { to: ['sam@example.com'], subject: 'Hi', text: 'Body' },
    });

    expect(new TextDecoder().decode(composed.raw)).not.toContain('multipart');
  });

  test('a reply sets both threading headers', async () => {
    // Clients that read only one of them are common enough that setting just
    // In-Reply-To orphans the reply.
    const composed = await composeMime({
      from: 'ada@example.com',
      message: {
        to: ['sam@example.com'],
        subject: 'Re: Invoice',
        text: 'Yes',
        inReplyTo: '<original@example.com>',
      },
    });

    const raw = new TextDecoder().decode(composed.raw);

    expect(raw).toContain('In-Reply-To: <original@example.com>');
    expect(raw).toContain('References: <original@example.com>');
  });
});
