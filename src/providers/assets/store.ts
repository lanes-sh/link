import { createHash } from 'node:crypto';
import { guessContentType } from '#connectivity/mail';
import type { BlobStore } from '#connectivity';

/**
 * How an asset is stored, and the only place that knows.
 *
 * **The key is the filename.** `invoice-2026-03.pdf` is stored at
 * `assets/<connection>/invoice-2026-03.pdf`, and that is the whole of the
 * layout — no id, no prefix, no sidecar, no index. `BlobStore.list()` already
 * reports size and mtime, and the content type follows from the extension, so
 * every fact a listing needs is either the key itself or something the store
 * already had. Nothing is written twice and nothing can disagree.
 *
 * That is memory's design carried over rather than a new one: ADR-014 reversed
 * an index-plus-body split for exactly this reason, and it applies harder here,
 * because a sidecar holding an asset's name would be a second name for a file
 * that already has one. What the owner sees under
 * `~/.lanes-link/data/<profile>/assets/main/` is a directory of their files,
 * with their names, openable by anything.
 *
 * The cost is that an asset carries no description, and that is deliberate:
 * "the March invoice is in assets as invoice-2026-03.pdf" is a memory entry.
 * Prose in a store with no way to search it would be worse than either.
 */

/**
 * What may be a name, and why it is narrower than a filename.
 *
 * No path separator, so the namespace stays flat: `scopeBlobStore` would happily
 * accept `a/b` and create a directory, and a listing that nests is one where
 * `list()`'s single prefix scan stops describing what is there. No leading dot,
 * because a dotfile is invisible in exactly the directory the owner is meant to
 * be able to read. No control characters, which are not names.
 *
 * Spaces and unicode are allowed. Refusing them would reject the names files
 * actually have, and the name is percent-encoded at the one boundary that needs
 * it — a resource URI — rather than being restricted to survive it.
 */
const MAX_NAME = 200;
const CONTROL = /[\x00-\x1F\x7F]/;

export function assertAssetName(name: string): void {
  const why = nameProblem(name);
  if (why) throw new Error(`Asset name ${JSON.stringify(name)} ${why}`);
}

function nameProblem(name: string): string | null {
  if (name.length === 0) return 'must not be empty.';
  if (name.length > MAX_NAME) return `must be at most ${MAX_NAME} characters.`;
  if (name.includes('/') || name.includes('\\')) {
    return 'must not contain a path separator — assets are a flat set of files, not a tree.';
  }
  if (name.startsWith('.')) return 'must not start with a dot.';
  if (CONTROL.test(name)) return 'must not contain control characters.';
  return null;
}

/** Whether a listed key is an asset. Anything unnameable is skipped, not repaired. */
export function nameFromKey(key: string): string | null {
  return nameProblem(key) === null ? key : null;
}

export interface Asset {
  readonly name: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly modifiedAt: string;
}

/**
 * Every asset, newest first.
 *
 * One `list()` and no reads at all, which is the payoff for the key being the
 * filename: memory has to open every entry to list it, and this does not.
 */
export async function allAssets(storage: BlobStore): Promise<Asset[]> {
  return (await storage.list())
    .flatMap((blob) => {
      const name = nameFromKey(blob.key);
      return name === null
        ? []
        : [
            {
              name,
              bytes: blob.size,
              contentType: blob.contentType ?? guessContentType(name),
              modifiedAt: blob.modifiedAt.toISOString(),
            },
          ];
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || a.name.localeCompare(b.name));
}

export async function findAsset(storage: BlobStore, name: string): Promise<Asset | null> {
  return (await allAssets(storage)).find((asset) => asset.name === name) ?? null;
}

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Whether these bytes can be handed to a model as text.
 *
 * Two questions, and both have to pass. The declared type has to be a text one
 * — `text/*`, or a structured type that is text by construction — and the bytes
 * have to contain no NUL, because a mislabelled binary is common and a content
 * type is a claim rather than an observation. Failing either means the asset is
 * described instead of returned, which is the honest answer: `ResourceContents`
 * carries text and nothing else, and base64 into a conversation is the cost this
 * whole mechanism exists to avoid.
 */
export function isTextual(contentType: string, bytes: Uint8Array): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();

  const declared =
    type.startsWith('text/') ||
    type.endsWith('+json') ||
    type.endsWith('+xml') ||
    ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(
      type,
    );

  return declared && !bytes.includes(0);
}

/** `invoice.pdf  application/pdf  184 KB  2026-08-27` */
export function describeAsset(asset: Asset): string {
  return `${asset.name}  ${asset.contentType}  ${humanBytes(asset.bytes)}  ${asset.modifiedAt.slice(0, 10)}`;
}

export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The pieces `lanes link assets` needs to reach the same bytes the provider does. */
export const assetStorage = {
  all: allAssets,
  find: findAsset,
  describe: describeAsset,
  humanBytes,
  digest: digestOf,
  assertName: assertAssetName,
  nameFromKey,
  isTextual,
};
