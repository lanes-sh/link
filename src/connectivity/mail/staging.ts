import { randomBytes } from 'node:crypto';
import type { BlobStore } from '#stores/blobs';

/**
 * Staged attachments — bytes handed to the endpoint out of band, then named by
 * an opaque handle.
 *
 * This is the source that survives the endpoint not being on the caller's
 * machine. A `path` means nothing to a container, so on a hosted deployment the
 * bytes have to arrive some other way, and MCP offers none: there is no
 * client-to-server binary channel in any released version of the protocol, and
 * `roots` never carried bytes even before it was deprecated. Every serious
 * treatment of the problem lands on the same shape — upload out of band, get a
 * handle, pass the handle as an ordinary argument — which is also what the
 * protocol's own draft file-transfer proposal settles on.
 *
 * Two blobs per handle rather than one framed payload: `BlobStore.get` returns
 * bytes and nothing else, so the filename and type live in a sidecar and the
 * payload stays byte-exact.
 */

export const STAGED_PREFIX = 'attachments/';

export const stagedBytesKey = (handle: string): string => `${STAGED_PREFIX}${handle}`;
export const stagedMetaKey = (handle: string): string => `${STAGED_PREFIX}${handle}.json`;

/** How long a staged file stays fetchable. Long enough to compose a mail around. */
export const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Handles are checked against this before they reach the store.
 *
 * `assertSafeKey` would already reject traversal, but a caller-supplied handle
 * deserves a readable refusal rather than an internal invariant surfacing as a
 * tool error.
 */
const HANDLE = /^[A-Za-z0-9_-]{1,128}$/;

export interface StagedMetadata {
  readonly filename?: string;
  readonly content_type?: string;
  readonly sha256?: string;
  readonly expires_at?: number;
}

export interface StagedFile {
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly contentType: string | null;
}

export function isHandle(value: string): boolean {
  return HANDLE.test(value);
}

/** `att_` plus 128 bits, which is unguessable and still fits on one line. */
export function newHandle(): string {
  return `att_${randomBytes(16).toString('hex')}`;
}

export async function putStaged(
  storage: BlobStore,
  input: {
    readonly handle: string;
    readonly bytes: Uint8Array;
    readonly metadata: StagedMetadata;
  },
): Promise<void> {
  await storage.put(stagedBytesKey(input.handle), input.bytes, {
    contentType: input.metadata.content_type ?? 'application/octet-stream',
  });
  await storage.put(
    stagedMetaKey(input.handle),
    new TextEncoder().encode(JSON.stringify(input.metadata)),
    { contentType: 'application/json' },
  );
}

/** Null for both "never staged" and "staged and expired" — the caller cannot act on the difference. */
export async function getStaged(
  storage: BlobStore,
  handle: string,
): Promise<StagedFile | null> {
  if (!isHandle(handle)) throw new Error(`"${handle}" is not a handle.`);

  const bytes = await storage.get(stagedBytesKey(handle));
  if (!bytes) return null;

  const meta = await storage.get(stagedMetaKey(handle));
  if (!meta) return { bytes, filename: null, contentType: null };

  let parsed: StagedMetadata;
  try {
    parsed = JSON.parse(new TextDecoder().decode(meta)) as StagedMetadata;
  } catch {
    // Unreadable sidecar. The payload is still the payload, so serve it rather
    // than losing a file to a corrupt metadata write.
    return { bytes, filename: null, contentType: null };
  }

  if (parsed.expires_at !== undefined && parsed.expires_at < Date.now()) return null;

  return {
    bytes,
    filename: parsed.filename ?? null,
    contentType: parsed.content_type ?? null,
  };
}

/**
 * Drop everything past its expiry.
 *
 * Swept on write rather than on a timer: there is no scheduler in this process,
 * and staging is the only thing that creates the garbage, so the moment someone
 * stages a file is both the cheapest and the most reliable time to clear the
 * last batch.
 */
export async function sweepStaged(storage: BlobStore): Promise<number> {
  const now = Date.now();
  let removed = 0;

  for (const blob of await storage.list(STAGED_PREFIX)) {
    if (!blob.key.endsWith('.json')) continue;

    const meta = await storage.get(blob.key);
    if (!meta) continue;

    let expiresAt: number | undefined;
    try {
      expiresAt = (JSON.parse(new TextDecoder().decode(meta)) as StagedMetadata).expires_at;
    } catch {
      continue;
    }
    if (expiresAt === undefined || expiresAt >= now) continue;

    const handle = blob.key.slice(STAGED_PREFIX.length, -'.json'.length);
    await storage.delete(stagedBytesKey(handle));
    await storage.delete(blob.key);
    removed += 1;
  }

  return removed;
}
