import { readFile } from 'node:fs/promises';
import type { BlobStore } from '#stores/blobs';
import { getStaged, isProfileHandle, type StagedFile } from './staging.ts';
import { fetchFromUrl } from './url.ts';
import { basename } from './content-type.ts';
import type { AttachmentRef, ResolveOptions, SharedAttachments, SourceKey } from './attachments.ts';

/**
 * Turning one named source into bytes.
 *
 * Split from `attachments.ts` when the two together passed the file-size budget,
 * along the seam that was already there: that file owns the shape a caller may
 * name and the rule that exactly one source is named, and this one owns what
 * each source then means. The budget found the seam; it did not invent it.
 */

export interface FoundBytes {
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly contentType: string | null;
  readonly origin: string;
}

export async function bytesFor(
  source: SourceKey,
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
      return await fromHandle(ref.handle!, where, options);

    case 'asset':
      return await fromAsset(ref.asset!, where, options.shared);

    case 'message_id':
    case 'uid': {
      if (!options.mailbox) {
        throw new Error(
          `${where} uses ${source}, which only a mail connection can resolve — this one holds no mailbox. ` +
            `Name the file with path, url, handle, or asset instead, or ask the mail connection itself to send it somewhere.`,
        );
      }
      const found = await options.mailbox({
        messageId: ref.message_id,
        mailbox: ref.mailbox,
        uid: ref.uid,
        attachmentId: ref.attachment_id,
      });
      return {
        bytes: found.bytes,
        filename: found.filename,
        contentType: found.contentType,
        origin: source === 'uid' ? `mailbox:${ref.mailbox ?? 'INBOX'}:${ref.uid!}` : `mailbox:${ref.message_id!}`,
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

/**
 * Routed on the prefix, and never tried in both stores.
 *
 * A fallback — read the connection, then the profile — would let
 * `lanes_assets.stage` be handed a mailbox-minted `att_` handle and give back a
 * `stg_` one for the same bytes, promoting a file scoped to one account into
 * every connection in the profile. Routing on the prefix leaves that nowhere to
 * happen, so the isolation holds by construction rather than by review.
 */
async function fromHandle(
  handle: string,
  where: string,
  options: ResolveOptions,
): Promise<FoundBytes> {
  const profile = isProfileHandle(handle);

  const stored = profile
    ? await fromProfileArea(handle, where, options.shared)
    : await fromConnectionArea(handle, where, options.storage);

  if (!stored) {
    throw new Error(
      `${where}: no staged attachment "${handle}". Handles expire, so stage the file again. ` +
        (profile
          ? 'A handle beginning stg_ is staged for this profile by lanes_assets_stage.'
          : 'A handle beginning att_ belongs to one connection; lanes_assets_stage returns one that works anywhere in this profile.'),
    );
  }

  return {
    bytes: stored.bytes,
    filename: stored.filename,
    contentType: stored.contentType,
    origin: `handle:${handle}`,
  };
}

async function fromProfileArea(
  handle: string,
  where: string,
  shared: SharedAttachments | undefined,
): Promise<StagedFile | null> {
  if (!shared?.staged) {
    throw new Error(
      `${where} uses a profile handle, but this endpoint has no profile staging area.`,
    );
  }
  return await shared.staged(handle);
}

async function fromConnectionArea(
  handle: string,
  where: string,
  storage: BlobStore | undefined,
): Promise<StagedFile | null> {
  if (!storage) {
    throw new Error(`${where} uses a handle, but this provider has no staging store.`);
  }
  return await getStaged(storage, handle);
}

async function fromAsset(
  name: string,
  where: string,
  shared: SharedAttachments | undefined,
): Promise<FoundBytes> {
  if (!shared?.asset) {
    throw new Error(
      `${where} names an asset, but this connection cannot reach this profile's files. ` +
        `Name the file with path, url, handle, or data instead.`,
    );
  }

  const stored = await shared.asset(name);
  if (!stored) {
    throw new Error(`${where}: no asset "${name}". lanes_assets_list reports what is kept here.`);
  }

  return {
    bytes: stored.bytes,
    filename: stored.filename ?? name,
    contentType: stored.contentType,
    origin: `asset:${name}`,
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
