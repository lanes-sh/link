import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { BlobStore } from '#stores/blobs';
import type { ResolvedAttachment } from './message.ts';
import type { StagedFile } from './staging.ts';
import type { AddressLookup } from './url.ts';
import { guessContentType } from './content-type.ts';
import { bytesFor } from './sources.ts';

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
 *   uid         the same, addressed the way the mailbox itself addresses it
 *   data        base64 inline — the escape hatch, not the path
 *
 * `path` is deliberately unrestricted: no allowlist, no confinement to a root.
 * The endpoint already holds its owner's credentials, so the filesystem is
 * treated the same way, and `https://lanes.sh/docs/link/creating-a-provider`'s note that provider
 * code is trusted code applies here too. What makes that defensible is the audit
 * trail rather than a sandbox — every resolved attachment carries its origin and
 * a SHA-256, and the manifest's `redact` block keeps both, so "was this file ever
 * mailed out" stays an answerable question. Nothing here ever returns bytes to
 * the caller; see `receiptFor`.
 */

/** The source keys, in the order they are reported when a caller supplies two. */
const SOURCE_KEYS = ['path', 'url', 'handle', 'asset', 'message_id', 'uid', 'data'] as const;

/** Which source a reference named. */
export type SourceKey = (typeof SOURCE_KEYS)[number];

export const attachmentRefSchema = z
  .strictObject({
    path: z
      .string()
      .optional()
      .describe('Path to a file on the machine running this endpoint. Read as-is.'),
    url: z.string().optional().describe('HTTPS URL. The endpoint fetches it; you do not.'),
    handle: z
      .string()
      .optional()
      .describe(
        'Handle from lanes_assets_stage, an upload to POST /attachments, or a get_attachment.',
      ),
    asset: z
      .string()
      .optional()
      .describe('A file this profile keeps by name, as lanes_assets_list reports it.'),
    message_id: z
      .string()
      .optional()
      .describe('Re-attach an attachment already on a message in this mailbox.'),
    uid: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Re-attach from a message named by its mailbox UID, as search_messages and get_message report it. Pair with mailbox. Prefer this to message_id on a mailbox that has both: it addresses the message directly instead of searching every folder for a header.',
      ),
    mailbox: z
      .string()
      .optional()
      .describe('Which mailbox the uid belongs to. Defaults to INBOX.'),
    attachment_id: z
      .string()
      .optional()
      .describe('Which attachment on that message. Required with message_id or uid where the provider ids them.'),
    data: z
      .string()
      .optional()
      .describe(
        'Base64 file content. Right when the file exists nowhere this endpoint can reach — and then hold it once with lanes_assets_stage and name the handle afterwards, rather than encoding it into every call.',
      ),
    filename: z.string().optional().describe('Overrides the name derived from the source.'),
    content_type: z.string().optional().describe('Overrides the type derived from the source.'),
  })
  .describe(
    'One attachment, named by exactly one of path, url, handle, asset, message_id, uid, or data.',
  );

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

/**
 * Pulls bytes for `message_id` or `uid` out of the mailbox the caller is already in.
 *
 * Two ways to name the message, because the two protocols name it differently
 * and only one of them can do both. A `uid` is what IMAP itself uses and what
 * `search_messages` and `get_message` already report, so it addresses a message
 * directly; a `messageId` has to be *searched* for, folder by folder, and a
 * server whose `HEADER MESSAGE-ID` matching is unreliable fails that search on a
 * message it is holding. Gmail's REST API has no uid and takes its own id.
 *
 * Exactly one arrives set. An implementation that cannot serve the one it is
 * given should say so naming the other, rather than returning nothing.
 */
export type MailboxAttachmentSource = (reference: {
  readonly messageId: string | undefined;
  readonly mailbox: string | undefined;
  readonly uid: number | undefined;
  readonly attachmentId: string | undefined;
}) => Promise<{
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly contentType: string | null;
}>;

/**
 * The two lookups a connection-scoped store cannot serve.
 *
 * Both reach past `<provider>/<connection>` to something the *profile* holds, so
 * neither is built here: dispatch binds them and hands them over on the context,
 * which is what keeps `#providers` unable to reach another connection on its own.
 *
 * What makes the crossing safe is not the plumbing but what may pass through it.
 * A profile-level handle only ever holds bytes the caller supplied (`data`,
 * `url`, `path`) or bytes the profile already owns (`asset`) — never bytes read
 * out of a third party's account. `get_attachment` keeps minting a
 * connection-scoped handle for exactly that reason, so a mailbox attachment
 * stays where it landed and nothing promotes it.
 */
export interface SharedAttachments {
  /** A handle staged for the whole profile, not for one connection. */
  readonly staged?: ((handle: string) => Promise<StagedFile | null>) | undefined;
  /** A file this profile keeps by name in `lanes_assets`. */
  readonly asset?: ((name: string) => Promise<StagedFile | null>) | undefined;
}

/** The same, plus the write half. Only dispatch builds one. */
export interface AttachmentBridge extends SharedAttachments {
  stage(input: {
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly contentType: string;
  }): Promise<{ readonly handle: string; readonly sha256: string; readonly expiresAt: number }>;
}

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
  /**
   * What the connection-scoped store cannot see. Supplied by dispatch on
   * `ProviderContext.attachments` and passed straight through — a provider
   * neither builds one nor can widen the one it is given.
   */
  readonly shared?: SharedAttachments | undefined;
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
