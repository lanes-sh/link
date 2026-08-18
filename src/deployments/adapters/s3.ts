import { containedKey } from '#stores/blobs';
import type { BlobMetadata, BlobStore } from '#stores/blobs';

/**
 * S3-compatible blob store — the `cloud` target's adapter.
 *
 * The workload is the owner layer: `providers/owner/src/memory.ts` writes entry
 * bodies as blobs, and Cloud Run's disk does not survive an instance recycle.
 * The filesystem adapter beside this one is not wrong there, it is *silently*
 * wrong — writes succeed and the bytes are gone with the container.
 *
 * `Bun.S3Client` directly, for the reason `postgres.ts` uses `Bun.SQL` and
 * `sqlite.ts` uses `bun:sqlite`: it is a built-in, so this adapter adds no
 * dependency to a repository holding live refresh tokens. See ADR-004.
 *
 * Named for the protocol rather than the vendor, which is ADR-008's rule
 * applied to an adapter: Supabase Storage, Cloudflare R2, MinIO, and AWS differ
 * only in the endpoint. Supabase is what `docs/detailed/deployment-cloudrun.md`
 * documents, because it is already the Postgres host and a second vendor for
 * the blobs would be one more thing to hold.
 *
 * Containment comes from `containedKey`, not from anything here: `..` in an S3
 * key is a literal character sequence rather than a directory operation, so the
 * check is not load-bearing the way `filesystem.ts`'s is. It exists so both
 * adapters answer identically, which is the only reason the shared contract
 * suite can assert containment at all.
 */

export interface S3BlobStoreOptions {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * The S3-compatible service endpoint. Required for anything that is not AWS
   * — Supabase's is `https://<project-ref>.storage.supabase.co/storage/v1/s3`.
   */
  readonly endpoint?: string;
  readonly region?: string;
  /**
   * A key prefix inside the bucket — the bucket-relative equivalent of the
   * filesystem adapter's `root`, and the same unit of separation. Two profiles
   * sharing one bucket under different prefixes do not see each other's keys,
   * and every key this store reports is relative to it.
   */
  readonly prefix?: string;
  /**
   * Keys requested per `ListObjectsV2` call. Defaults to the protocol's own
   * ceiling, and exists so a test can force pagination without writing a
   * thousand objects to prove the continuation-token path is followed.
   */
  readonly pageSize?: number;
}

/**
 * `ListObjectsV2` returns at most 1000 keys per call whatever `maxKeys` says,
 * so a store larger than one page is the normal case rather than the edge one.
 */
const PAGE_SIZE = 1000;

/**
 * Whether a read failed because the object is not there.
 *
 * `get` and `list` return absence rather than throwing it, so this has to
 * separate "no such key" from a credential, network, or bucket error — those
 * must surface. S3 answers `NoSuchKey`; Bun maps some backends' 404 to
 * `ENOENT`, and a `HeadObject` against a missing key is a bare `NoSuchKey`
 * with no body, which some implementations report as `AccessDenied` when the
 * caller lacks `s3:ListBucket`. Only the first two are treated as absence —
 * swallowing `AccessDenied` would turn a misconfigured policy into an empty
 * store, which is the failure this whole adapter exists to prevent.
 */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'NoSuchKey' || code === 'ENOENT';
}

/**
 * A configured prefix as a key prefix: empty, or ending in exactly one slash.
 *
 * Exported for its tests. An operator who writes `lanes-link` rather than
 * `lanes-link/` must not get keys like `lanes-linknote.txt`, and finding that out
 * should not require a bucket.
 *
 * A leading `./` is dropped for the same class of reason. It means "here" to
 * every path API and means a directory named `.` to a bucket, so a target
 * declaring `prefix: ./blobs` would silently address `./blobs/…` while every
 * console, lifecycle rule and IAM condition written against it said `blobs/`.
 * `layout.ts` no longer produces one; this is for the ones an operator writes.
 */
export function s3Prefix(prefix?: string): string {
  if (prefix === undefined || prefix === '') return '';

  const rooted = prefix.replace(/^(?:\.\/)+/, '');
  if (rooted === '') return '';
  return rooted.endsWith('/') ? rooted : `${rooted}/`;
}

/**
 * A caller's key as an object key: containment first, then the prefix.
 *
 * The order is the point. Prefixing first would let a `../` chew back through
 * the prefix into another profile's key space, and the containment check would
 * then see a key that resolves inside the bucket and allow it.
 */
export function s3ObjectKey(prefix: string | undefined, key: string): string {
  return `${s3Prefix(prefix)}${containedKey(key)}`;
}

export function createS3BlobStore(options: S3BlobStoreOptions): BlobStore {
  const prefix = s3Prefix(options.prefix);
  const objectKey = (key: string): string => s3ObjectKey(prefix, key);

  const client = new Bun.S3Client({
    bucket: options.bucket,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
  });

  /**
   * Content type is not in a `ListObjectsV2` response, so it costs one
   * `HeadObject` per key. The filesystem adapter pays the same shape of cost
   * reading its `.meta` sidecars; here each one is a round trip, so they go
   * concurrently and a key that vanishes mid-listing is dropped rather than
   * failing the whole call.
   */
  const describe = async (entry: { key: string }): Promise<BlobMetadata | null> => {
    try {
      const stat = await client.stat(entry.key);
      return {
        key: entry.key.slice(prefix.length),
        size: stat.size,
        modifiedAt: stat.lastModified,
        ...(stat.type ? { contentType: stat.type } : {}),
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };

  return {
    async put(key, data, blobOptions) {
      // Uint8Array rather than the caller's view: `write` takes an
      // ArrayBufferView, and passing one whose byteOffset is non-zero has
      // uploaded the whole backing buffer on some paths.
      const bytes = new Uint8Array(data);
      await client.write(objectKey(key), bytes, {
        ...(blobOptions?.contentType ? { type: blobOptions.contentType } : {}),
      });
    },

    async get(key) {
      try {
        return await client.file(objectKey(key)).bytes();
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async has(key) {
      return client.exists(objectKey(key));
    },

    async delete(key) {
      // S3 DELETE is idempotent: removing an absent key is a success, which is
      // the contract the filesystem adapter gets from `rm --force`.
      await client.delete(objectKey(key));
    },

    async list(innerPrefix) {
      const entries: BlobMetadata[] = [];
      let continuationToken: string | undefined;

      do {
        const page = await client.list({
          maxKeys: options.pageSize ?? PAGE_SIZE,
          prefix: `${prefix}${innerPrefix ?? ''}`,
          ...(continuationToken !== undefined ? { continuationToken } : {}),
        });

        const described = await Promise.all((page.contents ?? []).map(describe));
        for (const entry of described) if (entry) entries.push(entry);

        // `isTruncated` is the authority on whether another page exists; a
        // present `nextContinuationToken` on a final page would otherwise loop.
        continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (continuationToken !== undefined);

      return entries.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}
