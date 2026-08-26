import { containedKey, type BlobKey, type BlobMetadata, type BlobStore } from '#stores/blobs';
import { inferContentType } from './filesystem.ts';
import type { GithubRepository } from './github-repo.ts';

/**
 * A GitHub repository as a `BlobStore`.
 *
 * The one thing a profile can put here is what the owner wrote — memory entries
 * and skills. Not state, not the audit log, not the credential store, and never
 * the vault; `src/profile/knowledge.ts` says why, and says it as a schema with
 * no field to set rather than as a default.
 *
 * **The API, not a clone.** A clone would be faster and would work offline, and
 * it fails on the property this interface exists to provide: a container
 * filesystem is discarded on every revision, so a deployed endpoint's clone
 * would be re-fetched at best and silently empty at worst. That is precisely
 * the bug ADR-014 §2 fixed for the vault, and re-introducing it for memory is
 * not worth the latency. It also needs a `git` binary, which the image does not
 * carry. ADR-041.
 *
 * Vendor-named, like `gcs.ts` and `gcp-secret-manager.ts` beside it: ADR-013's
 * rule is that an adapter for a *protocol* takes the protocol's name, and a
 * client for one vendor's API cannot honestly claim one.
 *
 * **Several of these share one `GithubRepository`.** Memory and skills are two
 * roots in one repository, and pointing both at one client means one head, one
 * tree, and one blob cache between them.
 */

export interface GithubBlobStoreOptions {
  readonly repository: GithubRepository;
  /**
   * A directory inside the repository that this store is rooted at — `memory`,
   * `skills`, or those under a profile's own `path` prefix. Keys never see it.
   */
  readonly root?: string | undefined;
  /** What a write commit says it did. `%s` is the key. */
  readonly message?: ((operation: 'store' | 'remove', key: string) => string) | undefined;
}

const DEFAULT_MESSAGE = (operation: 'store' | 'remove', key: string): string =>
  `${operation === 'store' ? 'Store' : 'Remove'} ${key}`;

export function createGithubBlobStore(options: GithubBlobStoreOptions): BlobStore {
  const repository = options.repository;
  const message = options.message ?? DEFAULT_MESSAGE;
  const root = (options.root ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  const prefix = root === '' ? '' : `${root}/`;

  /**
   * A key becomes a path in the repository.
   *
   * `containedKey` is `#stores/blobs`', not a second rule written here.
   * `conformance.ts` asserts that a key one target refuses is not one another
   * accepts, and that can only hold while there is exactly one answer to what
   * a key resolves to.
   */
  const pathFor = (key: BlobKey): string => `${prefix}${containedKey(key)}`;

  /** The reverse, for a listing. Null when the path is outside this root. */
  const keyFor = (path: string): BlobKey | null =>
    path.startsWith(prefix) ? path.slice(prefix.length) : null;

  return {
    async put(key, data, putOptions) {
      // `putOptions.contentType` is accepted and not stored, which is the one
      // place this adapter cannot match the others. There is nowhere to put it:
      // a sidecar would be a file in the owner's own repository, listed beside
      // their entries and loaded as one. `list` infers from the extension
      // instead, using the same map the filesystem adapter infers from — which
      // covers every type anything here writes.
      void putOptions;
      await repository.writeFile(pathFor(key), data, message('store', key));
    },

    async get(key) {
      const path = pathFor(key);
      const { entries } = await repository.entries();
      const entry = entries.get(path);
      // Absence is a value, not an error — every caller is written against null.
      if (!entry) return null;

      // An empty file has a real blob and zero bytes; `blob` returns the empty
      // array rather than null, which is the case `conformance.ts` pins.
      return repository.blob(entry.sha);
    },

    async has(key) {
      const path = pathFor(key);
      return (await repository.entries()).entries.has(path);
    },

    async delete(key) {
      // Deleting what is not there is not a failure: callers use this to make
      // absence true, and a sweep racing another sweep must not throw.
      await repository.deleteFile(pathFor(key), message('remove', key));
    },

    async list(innerPrefix) {
      const { entries, committedAt } = await repository.entries();
      const wanted = innerPrefix ?? '';
      const found: BlobMetadata[] = [];

      for (const entry of entries.values()) {
        const key = keyFor(entry.path);
        if (key === null || !key.startsWith(wanted)) continue;

        const contentType = inferContentType(key);
        found.push({
          key,
          size: entry.size,
          ...(contentType ? { contentType } : {}),
          // The branch tip's date, the same for every entry in one listing.
          // Per-file timestamps would be one `GET /commits?path=…` each, and
          // nothing needs them: `skillFingerprint` only needs this to change
          // when the tree does, and memory uses it as a fallback for a
          // hand-written file with no `updated_at` in its frontmatter.
          modifiedAt: committedAt,
        });
      }

      return found.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
