import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BlobKey, BlobMetadata, BlobStore } from '#stores/blobs';

/**
 * Filesystem blob store — the `local` target's adapter.
 *
 * Nothing consumes this in M1 or M2: the example and Gmail read providers store
 * no bytes. It exists because the owner layer (M3 — memory attachments, vault
 * documents) is the workload the interface was defined for, and defining
 * storage after providers exist is more expensive than before.
 *
 * Do not add S3, Azure, or GCS adapters until a provider actually writes bytes.
 */

export interface FilesystemBlobStoreOptions {
  readonly root: string;
}

export function createFilesystemBlobStore(options: FilesystemBlobStoreOptions): BlobStore {
  const root = resolve(options.root);

  /**
   * Remove directories a delete has just emptied, up to but never including
   * the root.
   *
   * An object store has no directories: `a/b/c.txt` is one flat key, and
   * removing it leaves nothing called `a/b`. This adapter emulates that
   * interface, so a surviving empty directory is a filesystem artifact leaking
   * through it — and the one that matters is `data/<profile>`, which would
   * otherwise outlive the profile whose objects it held.
   *
   * `rmdir` rather than a recursive remove, and the error swallowed: it fails
   * when the directory is not empty, which is exactly the signal to stop.
   */
  const pruneEmptyParents = async (directory: string): Promise<void> => {
    let current = directory;
    while (current.startsWith(root) && current !== root) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = dirname(current);
    }
  };

  /**
   * Resolve a key to an absolute path, refusing anything that lands outside
   * the root.
   *
   * `scopeBlobStore` already rejects traversal before a key reaches here, but
   * this adapter is also usable directly, and a containment check belongs at
   * the point where a path actually becomes a filesystem operation. Defence in
   * depth is cheap; a provider escaping its directory is not.
   */
  const pathFor = (key: BlobKey): string => {
    const resolved = resolve(root, key);
    const rel = relative(root, resolved);

    if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
      throw new Error(`Blob key resolves outside the store root: ${key}`);
    }
    return resolved;
  };

  return {
    async put(key, data, blobOptions) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });

      // Write-then-rename so a reader never observes a half-written blob, and
      // 0600 from the moment of creation rather than a chmod afterwards, which
      // would leave a window where the bytes are readable.
      //
      // The credential store and the vault already do this; what lands here is
      // everything else a profile owns — the audit log, `state.kv`, memory, and
      // cached mail attachments. Left at the umask default those are 0644 in a
      // 0755 directory, which on a shared machine is every local user's to read.
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, data, { mode: 0o600 });
      await rename(temporary, path);

      // A sidecar only when the extension cannot say it. Every blob written
      // today is Markdown, JSON, or text, so in practice none is written at all
      // — a `note.md` beside a `note.md.meta` recording `text/markdown` was
      // noise in a directory the operator is meant to be able to read.
      if (blobOptions?.contentType && inferContentType(path) !== blobOptions.contentType) {
        await writeFile(`${path}.meta`, JSON.stringify({ contentType: blobOptions.contentType }), {
          mode: 0o600,
        });
      } else {
        // A rewrite may be narrowing a type the extension now covers.
        await rm(`${path}.meta`, { force: true });
      }
    },

    async get(key) {
      const path = pathFor(key);
      if (!existsSync(path)) return null;
      return new Uint8Array(await readFile(path));
    },

    async has(key) {
      return existsSync(pathFor(key));
    },

    async delete(key) {
      const path = pathFor(key);
      await rm(path, { force: true });
      await rm(`${path}.meta`, { force: true });
      await pruneEmptyParents(dirname(path));
    },

    async list(prefix) {
      const results: BlobMetadata[] = [];

      const walk = async (directory: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          return; // Nothing stored yet.
        }

        for (const entry of entries) {
          const absolute = join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(absolute);
            continue;
          }
          if (entry.name.endsWith('.meta') || entry.name.endsWith('.tmp')) continue;

          const key = relative(root, absolute).split(sep).join('/');
          if (prefix && !key.startsWith(prefix)) continue;

          const info = await stat(absolute);
          const contentType = await readContentType(absolute);
          results.push({
            key,
            size: info.size,
            modifiedAt: info.mtime,
            ...(contentType ? { contentType } : {}),
          });
        }
      };

      await walk(root);
      return results.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}

/**
 * What the extension says, for the handful of types anything here stores.
 *
 * Deliberately short: this is not a MIME database, it is the set of things a
 * provider writes, and anything outside it falls back to a sidecar.
 */
const BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

/**
 * Exported so `github.ts` answers identically.
 *
 * That adapter has nowhere to *store* a content type — a sidecar there would be
 * a file in the owner's own repository, listed beside their entries — so the
 * extension is all it has. Sharing the map means a `.md` written locally and
 * the same `.md` in a repository do not report different types, which is what
 * `#stores/blobs/conformance.ts` exists to hold.
 */
export function inferContentType(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? undefined : BY_EXTENSION[path.slice(dot).toLowerCase()];
}

async function readContentType(path: string): Promise<string | undefined> {
  const inferred = inferContentType(path);
  if (inferred) return inferred;

  try {
    const parsed = JSON.parse(await readFile(`${path}.meta`, 'utf8')) as { contentType?: string };
    return parsed.contentType;
  } catch {
    return undefined;
  }
}
