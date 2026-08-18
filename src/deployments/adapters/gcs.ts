import { containedKey, type BlobKey, type BlobMetadata, type BlobStore } from '#stores/blobs';
import { ApplicationDefaultCredentials, type AccessTokenSource } from './gcp-secret-manager.ts';
import { s3ObjectKey, s3Prefix } from './s3.ts';

/**
 * Google Cloud Storage, over its JSON API.
 *
 * **Why this exists beside `s3.ts`, which GCS can also speak.** The S3
 * interoperability API authenticates with HMAC keys, and those have to be
 * created by hand in the console, stored as two credential refs, and rotated
 * separately from everything else. This one authenticates as the service
 * account the deploy already created and already granted `objectAdmin` on the
 * bucket — so the bucket needs no credential of its own, and setting it up is
 * a command rather than a console visit. Setup cost is the thing being
 * optimised; the adapter is 200 lines either way.
 *
 * `s3.ts` stays, and stays the answer for R2, MinIO, Supabase Storage, and
 * AWS. This is the GCP-shaped shortcut, not a replacement.
 *
 * Vendor-named, like `gcp-secret-manager.ts` beside it, because it speaks
 * Google's own API rather than a protocol anyone else implements. ADR-013's
 * rule is that an *adapter for a protocol* takes the protocol's name; a client
 * for one vendor's API cannot honestly claim one. `src/architecture.test.ts`
 * scopes the vendor ban to the code a request passes through, not to
 * `deployments/`.
 *
 * `fetch` and no client library, the same as the Secret Manager adapter: a
 * repository holding live refresh tokens does not add a transitive dependency
 * tree to save a hundred lines of URL building.
 */

/**
 * Declared here rather than imported from `#auth`, which has the same type:
 * `deployments` may not import `auth` (`src/architecture.test.ts`), and a
 * one-line structural type is a smaller cost than a dependency pointing the
 * wrong way. It exists at all because `typeof globalThis.fetch` under Bun's
 * types also carries `preconnect`, so a test double would have to stub a
 * method nothing calls.
 */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const STORAGE_HOST = 'https://storage.googleapis.com';

/** GCS returns at most this many items per list page whatever `maxResults` says. */
const PAGE_SIZE = 1000;

export interface GcsBlobStoreOptions {
  readonly bucket: string;
  /**
   * A key prefix inside the bucket — the bucket-relative equivalent of the
   * filesystem adapter's root, so two profiles sharing one bucket under
   * different prefixes do not see each other's keys.
   */
  readonly prefix?: string;
  readonly tokens?: AccessTokenSource;
  readonly fetch?: FetchLike;
}

export function createGcsBlobStore(options: GcsBlobStoreOptions): BlobStore {
  const call: FetchLike = options.fetch ?? globalThis.fetch;
  const tokens = options.tokens ?? new ApplicationDefaultCredentials();
  const prefix = s3Prefix(options.prefix);
  const bucket = encodeURIComponent(options.bucket);

  // Containment and prefixing are shared with `s3.ts` rather than reimplemented:
  // `#stores/blobs/conformance.ts` asserts that a key one target refuses is not
  // one another accepts, and that can only hold if there is one rule.
  const objectKey = (key: BlobKey): string => s3ObjectKey(options.prefix, key);

  const authorized = async (init: RequestInit = {}): Promise<RequestInit> => ({
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${await tokens.token()}` },
  });

  const request = async (url: string, init: RequestInit = {}): Promise<Response> =>
    call(url, await authorized(init));

  return {
    async put(key, data, putOptions) {
      // `uploadType=media` is the single-request upload: the whole body is the
      // object. Resumable uploads matter above a few megabytes, and nothing
      // here writes one — a memory entry is a Markdown file and an audit event
      // is a few hundred bytes.
      const url =
        `${STORAGE_HOST}/upload/storage/v1/b/${bucket}/o` +
        `?uploadType=media&name=${encodeURIComponent(objectKey(key))}`;

      const response = await request(url, {
        method: 'POST',
        body: data,
        headers: {
          'content-type': putOptions?.contentType ?? 'application/octet-stream',
        },
      });
      if (!response.ok) throw await failure('write', key, response);
    },

    async get(key) {
      const response = await request(objectUrl(bucket, objectKey(key), '?alt=media'));
      // Absence is a value, not an error: `get` returns null and every caller
      // is written against that.
      if (response.status === 404) return null;
      if (!response.ok) throw await failure('read', key, response);

      return new Uint8Array(await response.arrayBuffer());
    },

    async has(key) {
      // Metadata only — no `alt=media`, so this does not pull the body back
      // just to answer a yes-or-no.
      const response = await request(objectUrl(bucket, objectKey(key)));
      if (response.status === 404) return false;
      if (!response.ok) throw await failure('stat', key, response);
      return true;
    },

    async delete(key) {
      const response = await request(objectUrl(bucket, objectKey(key)), { method: 'DELETE' });
      // Deleting what is not there is not a failure. Callers use this to make
      // absence true, and a sweep that raced another sweep must not throw.
      if (response.status === 404) return;
      if (!response.ok) throw await failure('delete', key, response);
    },

    async list(innerPrefix) {
      const found: BlobMetadata[] = [];
      let pageToken: string | undefined;

      do {
        const query = new URLSearchParams({
          prefix: `${prefix}${innerPrefix ?? ''}`,
          maxResults: String(PAGE_SIZE),
        });
        if (pageToken) query.set('pageToken', pageToken);

        const response = await request(`${STORAGE_HOST}/storage/v1/b/${bucket}/o?${query}`);
        if (!response.ok) throw await failure('list', innerPrefix ?? '', response);

        const page = (await response.json()) as {
          items?: Array<{ name: string; size?: string; contentType?: string; updated?: string }>;
          nextPageToken?: string;
        };

        for (const item of page.items ?? []) {
          found.push({
            key: item.name.slice(prefix.length),
            size: Number(item.size ?? 0),
            ...(item.contentType ? { contentType: item.contentType } : {}),
            modifiedAt: item.updated ? new Date(item.updated) : new Date(0),
          });
        }

        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);

      return found;
    },
  };
}

function objectUrl(bucket: string, key: string, suffix = ''): string {
  // The object name is one path segment with its slashes escaped: GCS
  // addresses `a/b.json` as the single name `a%2Fb.json`, and leaving the
  // slash unescaped addresses a different resource that answers 404.
  return `${STORAGE_HOST}/storage/v1/b/${bucket}/o/${encodeURIComponent(key)}${suffix}`;
}

/**
 * A failure that names the operation and the key.
 *
 * `403` is the one worth spelling out: it is what an operator hits when the
 * bucket exists but the service account was never granted `objectAdmin` on it,
 * and the raw message ("does not have storage.objects.create access") does not
 * say which identity was refused or where to fix it.
 */
async function failure(operation: string, key: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => '');
  const detail = body.slice(0, 400);

  if (response.status === 403) {
    return new Error(
      `GCS refused to ${operation} "${key}" (403). The identity this endpoint runs as is not ` +
        'granted roles/storage.objectAdmin on the bucket. `lanes link deploy` grants it to the ' +
        `service account it creates; a local run uses your own gcloud credentials. ${detail}`,
    );
  }
  return new Error(`GCS failed to ${operation} "${key}" (${response.status}). ${detail}`);
}

/** Re-exported so a caller can validate a key without reaching into `#stores/blobs`. */
export { containedKey };
