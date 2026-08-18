/**
 * An in-memory `BlobStore` for tests.
 *
 * Test-only, behind a separate entry point so application code cannot reach it
 * by accident. The filesystem and S3 adapters are the real ones.
 *
 * It goes through `containedKey` like they do. A Map cannot be escaped, so
 * containment buys it no safety — but a provider exercised against this store
 * and shipped against a real one must not discover that a key it relies on is
 * refused in production. `conformance.ts` holds all three to the one rule.
 */

import { containedKey, type BlobMetadata, type BlobStore } from './index.ts';

export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, { data: Uint8Array; contentType?: string; modifiedAt: Date }>();

  return {
    async put(key, data, options) {
      blobs.set(containedKey(key), {
        data,
        ...(options?.contentType ? { contentType: options.contentType } : {}),
        modifiedAt: new Date(),
      });
    },
    async get(key) {
      return blobs.get(containedKey(key))?.data ?? null;
    },
    async has(key) {
      return blobs.has(containedKey(key));
    },
    async delete(key) {
      blobs.delete(containedKey(key));
    },
    async list(prefix) {
      const out: BlobMetadata[] = [];
      for (const [key, blob] of blobs) {
        if (prefix && !key.startsWith(prefix)) continue;
        out.push({
          key,
          size: blob.data.byteLength,
          modifiedAt: blob.modifiedAt,
          ...(blob.contentType ? { contentType: blob.contentType } : {}),
        });
      }
      return out.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
