import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { BlobStore } from '#stores/blobs';
import type { ResolvedAttachment } from './message.ts';
import { getStaged } from './staging.ts';
import { fetchFromUrl, type AddressLookup } from './url.ts';

/**
 * Turning a named attachment into bytes.
 *
 * The whole point of this file is that **the bytes never pass through the model**.
 * Before it existed, the only way to attach anything was for the caller to emit
 * base64 in the tool call, which puts a 239 KB PDF at roughly 320,000 characters
 * — past what a model can write in one message, and absurd even when it fits.
 *
 * So a caller names a file and the endpoint fetches it. Each reference carries
 * exactly one source key:
 *
 *   path        a file on the machine running this endpoint
 *   url         fetched over HTTPS, with the checks in `url.ts`
 *   handle      bytes staged earlier through the upload route
 *   message_id  an attachment already sitting in the mailbox being used
 *   data        base64 inline — the escape hatch, not the path
 *
 * `path` is deliberately unrestricted: no allowlist, no confinement to a root.
 * The endpoint already holds its owner's credentials, so the filesystem is
 * treated the same way, and `docs/detailed/creating-a-provider.md`'s note that provider
 * code is trusted code applies here too. What makes that defensible is the audit
 * trail rather than a sandbox — every resolved attachment carries its origin and
 * a SHA-256, and the manifest's `redact` block keeps both, so "was this file ever
 * mailed out" stays an answerable question. Nothing here ever returns bytes to
 * the caller; see `receiptFor`.
 */

/** The source keys, in the order they are reported when a caller supplies two. */
const SOURCE_KEYS = ['path', 'url', 'handle', 'message_id', 'data'] as const;

export const attachmentRefSchema = z
  .strictObject({
    path: z
      .string()
      .optional()
      .describe('Path to a file on the machine running this endpoint. Read as-is.'),
    url: z.string().optional().describe('HTTPS URL. The endpoint fetches it; you do not.'),
    handle: z.string().optional().describe('Handle returned by a staged upload.'),
    message_id: z
      .string()
      .optional()
      .describe('Re-attach an attachment already on a message in this mailbox.'),
    attachment_id: z
      .string()
      .optional()
      .describe('Which attachment on that message. Required with message_id where the provider ids them.'),
    data: z
      .string()
      .optional()
      .describe(
        'Base64 file content, for small files only. Prefer path, url, handle, or message_id — those keep the bytes out of the conversation entirely.',
      ),
    filename: z.string().optional().describe('Overrides the name derived from the source.'),
    content_type: z.string().optional().describe('Overrides the type derived from the source.'),
  })
  .describe('One attachment, named by exactly one of path, url, handle, message_id, or data.');

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

/**
 * The same shape as JSON Schema, for connectors whose capabilities are
 * discovered rather than authored.
 *
 * Generated from the Zod schema rather than written twice: `imap` declares raw
 * JSON Schema and a hand-written provider declares Zod, and two hand-maintained
 * copies of one shape drift the moment a key is added to one of them.
 */
export const attachmentsJsonSchema = ((): Record<string, unknown> => {
  // `$schema` is meaningful at the root of a document and noise on a property,
  // which is the only place this is ever embedded.
  const { $schema: _root, ...schema } = z.toJSONSchema(z.array(attachmentRefSchema), {
    io: 'input',
  }) as Record<string, unknown>;
  return schema;
})();

/** Pulls bytes for `message_id` out of whatever mailbox the caller is already in. */
export type MailboxAttachmentSource = (reference: {
  readonly messageId: string;
  readonly attachmentId: string | undefined;
}) => Promise<{
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly contentType: string | null;
}>;

export interface ResolveOptions {
  /**
   * Total raw bytes allowed across every attachment.
   *
   * Raw rather than encoded, and the caller derives it from whatever its vendor
   * accepts: base64 inflates by 4/3, so a 20 MB message ceiling is about 14.5 MB
   * of files. The composed message is checked exactly afterwards — this is the
   * early, cheap refusal that avoids reading 40 MB to then reject it.
   */
  readonly maxTotalBytes: number;
  readonly storage?: BlobStore | undefined;
  readonly mailbox?: MailboxAttachmentSource | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly addresses?: AddressLookup | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Resolve every reference, or throw explaining which one failed and why.
 *
 * Takes `unknown` on purpose. One caller has already validated against this
 * schema and the other has not — `imap` reads its arguments as raw casts, so
 * this is the only gate on that path and has to behave like one.
 */
export async function resolveAttachments(
  input: unknown,
  options: ResolveOptions,
): Promise<ResolvedAttachment[]> {
  if (input === undefined || input === null) return [];

  const parsed = z.array(attachmentRefSchema).safeParse(input);
  if (!parsed.success) {
    throw new Error(`attachments is not shaped right: ${parsed.error.issues[0]?.message}`);
  }

  const resolved: ResolvedAttachment[] = [];
  let total = 0;

  for (const [index, ref] of parsed.data.entries()) {
    const where = `attachments[${index}]`;
    const attachment = await resolveOne(ref, where, options);

    total += attachment.bytes.byteLength;
    if (total > options.maxTotalBytes) {
      throw new Error(
        `Attachments total more than ${options.maxTotalBytes} bytes, which is over what this account accepts for one message.`,
      );
    }

    resolved.push(attachment);
  }

  return resolved;
}

async function resolveOne(
  ref: AttachmentRef,
  where: string,
  options: ResolveOptions,
): Promise<ResolvedAttachment> {
  const present = SOURCE_KEYS.filter((key) => ref[key] !== undefined && ref[key] !== '');

  if (present.length === 0) {
    throw new Error(
      `${where} names no file. Give exactly one of ${SOURCE_KEYS.join(', ')}, e.g. { "path": "/Users/you/invoice.pdf" }.`,
    );
  }
  if (present.length > 1) {
    throw new Error(
      `${where} names ${present.length} sources (${present.join(', ')}). Give exactly one — they are alternatives, not layers.`,
    );
  }

  const found = await bytesFor(present[0]!, ref, where, options);

  const filename = ref.filename ?? found.filename ?? 'attachment';
  return {
    filename,
    contentType: ref.content_type ?? found.contentType ?? guessContentType(filename),
    bytes: found.bytes,
    sha256: createHash('sha256').update(found.bytes).digest('hex'),
    origin: found.origin,
  };
}

interface FoundBytes {
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly origin: string;
}

async function bytesFor(
  source: (typeof SOURCE_KEYS)[number],
  ref: AttachmentRef,
  where: string,
  options: ResolveOptions,
): Promise<FoundBytes> {
  switch (source) {
    case 'path':
      return await fromPath(ref.path!, where, options.maxTotalBytes);

    case 'url': {
      const fetched = await fetchFromUrl({
        url: ref.url!,
        maxBytes: options.maxTotalBytes,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.addresses ? { addresses: options.addresses } : {}),
        signal: options.signal,
      });
      return {
        bytes: fetched.bytes,
        filename: fetched.filename ?? basename(new URL(ref.url!).pathname),
        contentType: fetched.contentType,
        origin: `url:${ref.url!}`,
      };
    }

    case 'handle':
      return await fromHandle(ref.handle!, where, options.storage);

    case 'message_id': {
      if (!options.mailbox) {
        throw new Error(
          `${where} uses message_id, which this provider cannot resolve. Fetch the attachment and stage it, or use path or url.`,
        );
      }
      const found = await options.mailbox({
        messageId: ref.message_id!,
        attachmentId: ref.attachment_id,
      });
      return {
        bytes: found.bytes,
        filename: found.filename,
        contentType: found.contentType,
        origin: `mailbox:${ref.message_id!}`,
      };
    }

    case 'data': {
      const bytes = decodeBase64(ref.data!, where);
      return { bytes, filename: null, contentType: null, origin: 'inline' };
    }
  }
}

async function fromPath(path: string, where: string, maxBytes: number): Promise<FoundBytes> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch (failure) {
    const code = (failure as { code?: string }).code;
    if (code === 'ENOENT') throw new Error(`${where}: no file at ${path}.`);
    if (code === 'EACCES') throw new Error(`${where}: ${path} is not readable by this endpoint.`);
    if (code === 'EISDIR') throw new Error(`${where}: ${path} is a directory, not a file.`);
    throw new Error(`${where}: could not read ${path} — ${(failure as Error).message}`);
  }

  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `${where}: ${path} is ${bytes.byteLength} bytes, over the ${maxBytes} byte limit for one message.`,
    );
  }

  return {
    bytes,
    filename: basename(path),
    contentType: null,
    origin: `path:${path}`,
  };
}

async function fromHandle(
  handle: string,
  where: string,
  storage: BlobStore | undefined,
): Promise<FoundBytes> {
  if (!storage) {
    throw new Error(`${where} uses a handle, but this provider has no staging store.`);
  }

  const stored = await getStaged(storage, handle);
  if (!stored) {
    throw new Error(
      `${where}: no staged attachment "${handle}". Handles expire, so stage the file again.`,
    );
  }

  return {
    bytes: stored.bytes,
    filename: stored.filename,
    contentType: stored.contentType,
    origin: `handle:${handle}`,
  };
}

function decodeBase64(value: string, where: string): Uint8Array {
  // Both alphabets, because the two obvious places a caller gets base64 from
  // disagree: a mail API hands back base64url (RFC 4648 §5) while every
  // general-purpose encoder emits the standard one. Rejecting the former would
  // be a correct-looking failure with a corrupt-file outcome.
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/').replaceAll(/\s+/g, '');

  try {
    const buffer = Buffer.from(normalized, 'base64');
    // Buffer.from is lenient and silently drops invalid characters, so a typo
    // becomes a shorter file rather than an error. Re-encoding and comparing
    // lengths catches that.
    const expected = Math.floor((normalized.replace(/=+$/, '').length * 3) / 4);
    if (buffer.byteLength !== expected) throw new Error('not base64');
    return new Uint8Array(buffer);
  } catch {
    throw new Error(`${where}: data is not valid base64.`);
  }
}

function basename(path: string): string | null {
  const name = path.split(/[/\\]/).pop();
  return name ? decodeURIComponent(name) : null;
}

/**
 * Type from the filename, since three of the five sources do not report one.
 *
 * A table rather than `Bun.file().type`, which would resolve this in one line:
 * Bun-specific APIs are confined to two named files, and a mail composer is not
 * one of them. Deliberately short — what an attachment actually is, not a mime
 * database. Anything unlisted becomes `application/octet-stream`, which every
 * mail client handles as "a file", so the failure mode is a generic icon rather
 * than a broken attachment.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  tiff: 'image/tiff',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // `.pages`, `.numbers` and `.key` are absent on purpose. Their registered
  // media types carry a vendor name, and `architecture.test.ts` refuses one
  // anywhere a request passes through — correctly, even though an IANA type is
  // not the vendor *knowledge* that rule is aimed at. They fall through to
  // octet-stream, which mail clients show as a file and the recipient's system
  // opens by extension anyway. Adding them back will fail the suite.
};

function guessContentType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  return (extension ? CONTENT_TYPES[extension] : undefined) ?? 'application/octet-stream';
}
