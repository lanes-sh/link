import { describe, expect, test } from 'bun:test';
import { describeBlobStoreContract, type ContractBlobStore } from '#stores/blobs/conformance.ts';
import { createS3BlobStore, s3ObjectKey, s3Prefix } from './s3.ts';


/**
 * S3, against a real server.
 *
 * There is no embedded S3 and no mock: a fake would prove nothing about the
 * adapter, since everything interesting here — `ListObjectsV2` pagination and
 * its continuation tokens, what a missing key answers, whether a content type
 * survives a round trip — is server behaviour. So the contract suite runs only
 * when the environment names a bucket, and the file says so loudly when it does
 * not, rather than passing quietly.
 *
 *   docker run --rm -p 9000:9000 -e MINIO_ROOT_USER=lanes-link \
 *     -e MINIO_ROOT_PASSWORD=lanes-link-secret \
 *     minio/minio server /data
 *   docker exec -i $(docker ps -q -f ancestor=minio/minio) \
 *     mc alias set local http://127.0.0.1:9000 lanes-link lanes-link-secret
 *   # then create the bucket, and:
 *
 *   LANES_LINK_TEST_S3_BUCKET=lanes-link-test \
 *   LANES_LINK_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   LANES_LINK_TEST_S3_ACCESS_KEY_ID=lanes-link \
 *   LANES_LINK_TEST_S3_SECRET_ACCESS_KEY=lanes-link-secret \
 *     bun test
 *
 * Supabase Storage works too, and is what the deployed target actually uses —
 * point it at the project's S3 endpoint to exercise the configuration
 * `https://lanes.sh/docs/link/deployment-cloudrun` recommends.
 */

const BUCKET_ENV = 'LANES_LINK_TEST_S3_BUCKET';

const config = {
  bucket: process.env[BUCKET_ENV],
  endpoint: process.env['LANES_LINK_TEST_S3_ENDPOINT'],
  accessKeyId: process.env['LANES_LINK_TEST_S3_ACCESS_KEY_ID'],
  secretAccessKey: process.env['LANES_LINK_TEST_S3_SECRET_ACCESS_KEY'],
  region: process.env['LANES_LINK_TEST_S3_REGION'],
};

/**
 * Each store gets its own prefix, so a failed run leaves nothing behind for the
 * next one to trip over and two files could run at once. This is the bucket's
 * version of what `postgres.test.ts` does with a schema per store.
 */
let stores = 0;

function s3Store(settings: {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | undefined;
  region?: string | undefined;
}): () => Promise<ContractBlobStore> {
  return async () => {
    const prefix = `lanes-link-test/${process.pid}-${++stores}/`;
    const open = () =>
      createS3BlobStore({
        bucket: settings.bucket,
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        prefix,
        ...(settings.endpoint !== undefined ? { endpoint: settings.endpoint } : {}),
        ...(settings.region !== undefined ? { region: settings.region } : {}),
      });

    return {
      open,
      async dispose() {
        // There is no recursive delete in the interface, and leaving objects
        // behind would make the next run's `list()` see someone else's keys.
        const store = open();
        const listed = await store.list();
        await Promise.all(listed.map((entry) => store.delete(entry.key)));
      },
    };
  };
}

if (config.bucket && config.accessKeyId && config.secretAccessKey) {
  describeBlobStoreContract(
    's3',
    s3Store({
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      endpoint: config.endpoint,
      region: config.region,
    }),
  );

  describe('s3: the server behaviour the adapter depends on', () => {
    test('lists past one page, following continuation tokens', async () => {
      // ListObjectsV2 caps a response at 1000 keys whatever maxKeys says, so an
      // adapter that ignores isTruncated reports a truncated store as the whole
      // store — and does it silently. pageSize is lowered here rather than
      // writing 1001 objects, so the multi-page path is genuinely exercised:
      // at 5 per page and 12 objects this is three requests, and an adapter
      // that stopped after the first would return 5.
      const prefix = `lanes-link-test/${process.pid}-pagination/`;
      const store = createS3BlobStore({
        bucket: config.bucket!,
        accessKeyId: config.accessKeyId!,
        secretAccessKey: config.secretAccessKey!,
        prefix,
        pageSize: 5,
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.region !== undefined ? { region: config.region } : {}),
      });

      try {
        const keys = Array.from({ length: 12 }, (_, index) => `page/${index}.txt`);
        await Promise.all(keys.map((key) => store.put(key, new TextEncoder().encode(key))));

        const listed = await store.list();
        expect(listed).toHaveLength(12);
        expect(listed.map((entry) => entry.key).sort()).toEqual([...keys].sort());
      } finally {
        const listed = await store.list();
        await Promise.all(listed.map((entry) => store.delete(entry.key)));
      }
    });
  });
} else {
  describe('s3', () => {
    test.skip(`the contract suite needs ${BUCKET_ENV} — see the note at the top of this file`, () => {});
  });
}

describe('s3: object keys', () => {
  test('a prefix gains exactly one trailing slash', () => {
    expect(s3Prefix(undefined)).toBe('');
    expect(s3Prefix('')).toBe('');
    expect(s3Prefix('lanes-link')).toBe('lanes-link/');
    expect(s3Prefix('lanes-link/')).toBe('lanes-link/');
  });

  test('a leading "./" is dropped, because a bucket takes it literally', () => {
    // "Here" to every path API, and a directory named `.` to object storage. A
    // target declaring `prefix: ./blobs` would address `./blobs/…` while every
    // console, lifecycle rule and IAM condition written against it said
    // `blobs/` — and the mismatch is silent until a conditioned grant refuses a
    // write nobody can see the reason for.
    expect(s3Prefix('./blobs')).toBe('blobs/');
    expect(s3Prefix('./data/personal/state.kv')).toBe('data/personal/state.kv/');
    expect(s3Prefix('././blobs/')).toBe('blobs/');
    expect(s3Prefix('./')).toBe('');
  });

  test('the prefix goes on after containment, not before', () => {
    expect(s3ObjectKey('personal', 'note.txt')).toBe('personal/note.txt');

    // Prefixing first would resolve `personal/../work/x` to `work/x` — inside
    // the bucket, so a containment check run afterwards would allow it, and one
    // profile would be addressing another's blobs.
    expect(() => s3ObjectKey('personal', '../work/x')).toThrow(/outside the store root/);
  });

  test('containment is refused before any request is attempted', async () => {
    // Credentials and endpoint are deliberate nonsense: a rejected key must not
    // depend on reaching a server, or a traversal would be refused in tests and
    // attempted in production.
    const store = createS3BlobStore({
      bucket: 'nonexistent',
      accessKeyId: 'nope',
      secretAccessKey: 'nope',
      endpoint: 'http://127.0.0.1:1',
      prefix: 'personal',
    });

    await expect(store.get('../outside.txt')).rejects.toThrow(/outside the store root/);
    await expect(store.has('.')).rejects.toThrow(/outside the store root/);
  });
});
