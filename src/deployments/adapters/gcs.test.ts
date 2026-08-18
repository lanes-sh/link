import { describe, expect, test } from 'bun:test';
import { describeBlobStoreContract } from '#stores/blobs/conformance.ts';
import type { AccessTokenSource } from './gcp-secret-manager.ts';
import { createGcsBlobStore, type FetchLike } from './gcs.ts';

/**
 * The behavioural half runs against a stand-in for GCS, not against nothing.
 *
 * A conformance suite that skips unless someone exports a bucket name is a
 * suite that never runs, and the parts of this adapter most likely to be wrong
 * — how an object name is escaped into a URL, which status means absence,
 * whether the pagination loop terminates — are exactly the parts a stand-in
 * can check. The real-bucket run below is still there for the half a fake
 * cannot vouch for: that Google agrees with this reading of its API.
 */

interface StoredObject {
  readonly data: Uint8Array;
  readonly contentType: string;
  readonly updated: string;
}

/**
 * Enough of the GCS JSON API to be wrong in the same ways it is.
 *
 * Notably it pages at two objects rather than a thousand, because a
 * pagination loop that is never asked to take a second lap is a loop nobody
 * has tested.
 */
function fakeGcs(options: { pageSize?: number } = {}) {
  const objects = new Map<string, StoredObject>();
  const pageSize = options.pageSize ?? 2;
  let calls = 0;

  const fetch: FetchLike = async (input, init) => {
    calls += 1;
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';

    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (url.pathname.startsWith('/upload/storage/v1/b/') && method === 'POST') {
      const name = url.searchParams.get('name')!;
      const headers = new Headers(init?.headers);
      objects.set(name, {
        data: new Uint8Array(init?.body as ArrayBuffer),
        contentType: headers.get('content-type') ?? 'application/octet-stream',
        updated: '2026-08-12T10:00:00.000Z',
      });
      return json({ name });
    }

    // A listing: `/storage/v1/b/<bucket>/o` with no object name after it.
    const listing = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o$/);
    if (listing && method === 'GET') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const token = url.searchParams.get('pageToken');
      const names = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();

      const from = token ? names.indexOf(token) : 0;
      const page = names.slice(from, from + pageSize);
      const next = names[from + pageSize];

      return json({
        items: page.map((name) => ({
          name,
          size: String(objects.get(name)!.data.byteLength),
          contentType: objects.get(name)!.contentType,
          updated: objects.get(name)!.updated,
        })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }

    const single = url.pathname.match(/^\/storage\/v1\/b\/[^/]+\/o\/(.+)$/);
    if (single) {
      const name = decodeURIComponent(single[1]!);
      const stored = objects.get(name);

      if (method === 'DELETE') {
        if (!stored) return json({ error: { message: 'Not Found' } }, 404);
        objects.delete(name);
        return new Response(null, { status: 204 });
      }
      if (!stored) return json({ error: { message: 'Not Found' } }, 404);
      if (url.searchParams.get('alt') === 'media') {
        return new Response(stored.data, { status: 200 });
      }
      return json({ name, size: String(stored.data.byteLength) });
    }

    return json({ error: { message: `unexpected ${method} ${url.pathname}` } }, 400);
  };

  const tokens: AccessTokenSource = { token: async () => 'test-token' };
  return { fetch, tokens, objects, calls: () => calls };
}

describeBlobStoreContract('gcs (fake)', async () => {
  const gcs = fakeGcs();
  return {
    open: () => createGcsBlobStore({ bucket: 'test-bucket', fetch: gcs.fetch, tokens: gcs.tokens }),
    dispose: async () => {},
  };
});

describeBlobStoreContract('gcs (fake, prefixed)', async () => {
  const gcs = fakeGcs();
  return {
    open: () =>
      createGcsBlobStore({
        bucket: 'test-bucket',
        prefix: 'data/personal',
        fetch: gcs.fetch,
        tokens: gcs.tokens,
      }),
    dispose: async () => {},
  };
});

describe('gcs: the requests it makes', () => {
  const body = new TextEncoder().encode('hello');

  test('a slash in the key is escaped into one object name', async () => {
    // GCS addresses `a/b.json` as the single name `a%2Fb.json`. Leaving the
    // slash unescaped addresses a different resource, which answers 404 — so
    // this fails as a missing object rather than as a bad URL.
    const seen: string[] = [];
    const gcs = fakeGcs();
    const store = createGcsBlobStore({
      bucket: 'b',
      tokens: gcs.tokens,
      fetch: async (input, init) => {
        seen.push(typeof input === 'string' ? input : input.toString());
        return gcs.fetch(input, init);
      },
    });

    await store.put('2026/08/12/event.json', body);
    await store.get('2026/08/12/event.json');

    expect(seen[0]).toContain('name=2026%2F08%2F12%2Fevent.json');
    expect(seen[1]).toContain('/o/2026%2F08%2F12%2Fevent.json?alt=media');
  });

  test('the prefix is applied to writes and stripped from listings', async () => {
    const gcs = fakeGcs();
    const store = createGcsBlobStore({
      bucket: 'b',
      prefix: 'data/personal',
      fetch: gcs.fetch,
      tokens: gcs.tokens,
    });

    await store.put('state.kv/a.json', body);

    expect([...gcs.objects.keys()]).toEqual(['data/personal/state.kv/a.json']);
    expect((await store.list()).map((entry) => entry.key)).toEqual(['state.kv/a.json']);
  });

  test('listing follows every page', async () => {
    const gcs = fakeGcs({ pageSize: 2 });
    const store = createGcsBlobStore({ bucket: 'b', fetch: gcs.fetch, tokens: gcs.tokens });

    for (let i = 0; i < 5; i += 1) await store.put(`k${i}.json`, body);

    expect((await store.list()).map((entry) => entry.key)).toEqual([
      'k0.json',
      'k1.json',
      'k2.json',
      'k3.json',
      'k4.json',
    ]);
  });

  test('a missing object reads as absent and deletes without complaint', async () => {
    const gcs = fakeGcs();
    const store = createGcsBlobStore({ bucket: 'b', fetch: gcs.fetch, tokens: gcs.tokens });

    expect(await store.get('nope.json')).toBeNull();
    expect(await store.has('nope.json')).toBe(false);
    // A sweep that raced another sweep must not throw.
    await store.delete('nope.json');
  });

  test('a 403 names the grant that is missing, not just the status', async () => {
    // The failure an operator actually hits: the bucket exists, and the
    // identity was never granted objectAdmin on it. Google's own message does
    // not say which identity or where to fix it.
    const store = createGcsBlobStore({
      bucket: 'b',
      tokens: { token: async () => 't' },
      fetch: async () =>
        new Response('does not have storage.objects.create access', { status: 403 }),
    });

    await expect(store.put('k.json', body)).rejects.toThrow(/roles\/storage\.objectAdmin/);
    await expect(store.put('k.json', body)).rejects.toThrow(/lanes link deploy/);
  });

  test('an unexpected status carries the body rather than swallowing it', async () => {
    const store = createGcsBlobStore({
      bucket: 'b',
      tokens: { token: async () => 't' },
      fetch: async () => new Response('bucket does not exist', { status: 404 }),
    });

    // 404 is absence for `get`, but never for `list` — a bucket that is not
    // there must not read as a bucket that is empty.
    await expect(store.list()).rejects.toThrow(/bucket does not exist/);
  });

  test('every request carries a bearer token', async () => {
    const seen: Array<string | null> = [];
    const gcs = fakeGcs();
    const store = createGcsBlobStore({
      bucket: 'b',
      tokens: { token: async () => 'minted-token' },
      fetch: async (input, init) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return gcs.fetch(input, init);
      },
    });

    await store.put('k.json', body);
    expect(seen).toEqual(['Bearer minted-token']);
  });
});

/**
 * Against a real bucket, when one is offered.
 *
 * Gated the way the Postgres suite used to be: the value of this run is that
 * Google agrees with the reading of its API above, and that cannot be faked.
 * It needs `gcloud auth application-default login` or a service account, and a
 * bucket the identity may write to.
 */
const realBucket = process.env['LANES_LINK_TEST_GCS_BUCKET'];

if (realBucket) {
  describeBlobStoreContract('gcs (real bucket)', async () => {
    const prefix = `test-${crypto.randomUUID()}`;
    const store = createGcsBlobStore({ bucket: realBucket, prefix });
    return {
      open: () => store,
      dispose: async () => {
        for (const entry of await store.list()) await store.delete(entry.key);
      },
    };
  });
} else {
  describe('gcs (real bucket)', () => {
    test.skip('needs LANES_LINK_TEST_GCS_BUCKET and application default credentials', () => {});
  });
}
