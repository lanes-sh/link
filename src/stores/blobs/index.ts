import { posix } from 'node:path';

/**
 * Blob storage.
 *
 * No provider consumes this in M1 or M2 — the example and Gmail read providers
 * store no bytes. The interface and the filesystem adapter exist now because
 * the owner layer (M3: memory attachments, vault documents) is the workload it
 * was defined for, and because retrofitting a storage interface after
 * providers exist is more expensive than defining it before.
 *
 * Do not add S3, Azure, or GCS adapters until a provider actually writes bytes.
 */

/** A blob key. Always relative to whatever namespace the caller was scoped to. */
export type BlobKey = string;

export interface BlobMetadata {
  readonly key: BlobKey;
  readonly size: number;
  readonly contentType?: string;
  readonly modifiedAt: Date;
}

export interface BlobStore {
  put(key: BlobKey, data: Uint8Array, options?: { contentType?: string }): Promise<void>;
  get(key: BlobKey): Promise<Uint8Array | null>;
  has(key: BlobKey): Promise<boolean>;
  delete(key: BlobKey): Promise<void>;
  list(prefix?: string): Promise<BlobMetadata[]>;
}

/**
 * Restrict a store to a key namespace.
 *
 * Providers never receive a raw `BlobStore`; they receive one scoped to
 * `<provider>/<connection>`, so one connection's bytes are not addressable from
 * another. The scoping is enforced here rather than trusted to the provider.
 */
export function scopeBlobStore(base: BlobStore, namespace: string): BlobStore {
  const prefix = normaliseNamespace(namespace);
  const scoped = (key: BlobKey): BlobKey => {
    assertSafeKey(key);
    return `${prefix}${key}`;
  };

  // Every method is `async` on purpose. A key-validation failure must surface
  // as a rejected promise, matching the declared interface — if these threw
  // synchronously, callers would have to both try/catch and .catch() the same
  // call, and one of the two would inevitably be forgotten.
  return {
    async put(key, data, options) {
      return base.put(scoped(key), data, options);
    },
    async get(key) {
      return base.get(scoped(key));
    },
    async has(key) {
      return base.has(scoped(key));
    },
    async delete(key) {
      return base.delete(scoped(key));
    },
    async list(innerPrefix) {
      const entries = await base.list(`${prefix}${innerPrefix ?? ''}`);
      return entries.map((entry) => ({ ...entry, key: entry.key.slice(prefix.length) }));
    },
  };
}

function normaliseNamespace(namespace: string): string {
  if (namespace.length === 0) throw new Error('Blob namespace must not be empty');
  return namespace.endsWith('/') ? namespace : `${namespace}/`;
}

/**
 * A virtual root deep enough that `..` can actually escape it.
 *
 * `posix.resolve('/', '../x')` clamps to `/x` — the traversal disappears
 * instead of being caught — so resolving against `/` would silently accept
 * every key a real store rejects.
 */
const CONTAINMENT_ROOT = '/blobs';

/**
 * Resolve a key to its canonical form, refusing anything that escapes the
 * store.
 *
 * This is the *adapter's* containment rule, and it is deliberately not
 * `assertSafeKey` above. That one guards the namespace boundary and so refuses
 * a `..` segment outright, because a provider writing one has a bug worth
 * surfacing. This one asks the weaker question an adapter has to ask — does
 * the key, once resolved, still land inside the store — so `a/../b` normalises
 * to `b` rather than failing.
 *
 * It lives here so every adapter answers identically. An operator who switches
 * targets must not find that a key their local store refused is one their
 * deployed store happily writes; `conformance.ts` asserts exactly that, and it
 * can only do so if there is one rule rather than one per adapter.
 */
export function containedKey(key: BlobKey): BlobKey {
  if (key.includes('\0')) throw new Error('Blob key must not contain a NUL byte');

  const resolved = posix.resolve(CONTAINMENT_ROOT, key);
  const relative = posix.relative(CONTAINMENT_ROOT, resolved);

  if (relative === '' || relative === '..' || relative.startsWith('../')) {
    throw new Error(`Blob key resolves outside the store root: ${key}`);
  }
  return relative;
}

/**
 * A provider must not be able to escape its namespace with `../`, an absolute
 * path, or a NUL byte. This is a boundary, so it throws rather than sanitising
 * — silently rewriting a traversal attempt hides a provider bug.
 */
function assertSafeKey(key: BlobKey): void {
  if (key.length === 0) throw new Error('Blob key must not be empty');
  if (key.startsWith('/')) throw new Error(`Blob key must be relative: ${key}`);
  if (key.includes('\0')) throw new Error('Blob key must not contain a NUL byte');
  if (key.split('/').includes('..')) {
    throw new Error(`Blob key must not traverse outside its namespace: ${key}`);
  }
}
