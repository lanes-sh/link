import { describe, expect, test } from 'bun:test';
import { scopeBlobStore, type BlobStore } from './index.ts';

/**
 * The `BlobStore` contract, once, run against every adapter.
 *
 * `docs/detailed/init.md` promises that no application-layer code differs between the
 * local and deployed targets. For blobs that promise now has a consumer —
 * `providers/owner/src/memory.ts` stores entry bodies here — and it is only
 * worth something if the adapters actually behave identically. A per-adapter
 * test file cannot say so; it can only say each one passes the tests someone
 * remembered to write for it. This suite is the assertion itself: filesystem,
 * S3, and the in-memory store are held to one set of behaviours, and an
 * adapter that diverges fails here rather than in production on whichever
 * target the operator happened to deploy.
 *
 * Adapter-specific mechanism — write-then-rename, `.meta` sidecars,
 * `ListObjectsV2` pagination — stays in the adapter's own test file. What
 * lives here is behaviour every caller can rely on regardless of where it is
 * running.
 *
 * Not exported from `package.json`: this imports `bun:test`, so it is
 * reachable only by relative path from a test file, the same way `testing.ts`
 * is kept away from application code.
 */

export interface ContractBlobStore {
  /** A handle on this store. */
  open(): BlobStore;
  dispose(): Promise<void>;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

export function describeBlobStoreContract(
  name: string,
  createStore: () => Promise<ContractBlobStore>,
): void {
  /** Open a fresh store, run against it, and clean up either way. */
  const use = async (run: (store: BlobStore) => Promise<void>): Promise<void> => {
    const handle = await createStore();
    try {
      await run(handle.open());
    } finally {
      await handle.dispose();
    }
  };

  describe(`${name}: round trip`, () => {
    test('stores, reads, and deletes', async () => {
      await use(async (store) => {
        expect(await store.get('note.txt')).toBeNull();
        expect(await store.has('note.txt')).toBe(false);

        await store.put('note.txt', bytes('hello'));
        expect(text(await store.get('note.txt'))).toBe('hello');
        expect(await store.has('note.txt')).toBe(true);

        await store.delete('note.txt');
        expect(await store.get('note.txt')).toBeNull();
        expect(await store.has('note.txt')).toBe(false);
      });
    });

    test('accepts a nested key without the caller creating anything first', async () => {
      await use(async (store) => {
        await store.put('a/b/c/deep.txt', bytes('deep'));
        expect(text(await store.get('a/b/c/deep.txt'))).toBe('deep');
      });
    });

    test('overwrites in place', async () => {
      await use(async (store) => {
        await store.put('one.txt', bytes('1'));
        await store.put('one.txt', bytes('overwritten'));

        expect(text(await store.get('one.txt'))).toBe('overwritten');
        expect((await store.list()).map((entry) => entry.key)).toEqual(['one.txt']);
      });
    });

    test('deleting something absent is not an error', async () => {
      await use(async (store) => {
        await store.delete('never-existed.txt');
      });
    });

    test('round-trips binary data unchanged', async () => {
      await use(async (store) => {
        const data = new Uint8Array([0, 1, 2, 253, 254, 255]);

        await store.put('raw.bin', data);
        expect(await store.get('raw.bin')).toEqual(data);
      });
    });

    test('round-trips an empty blob rather than reporting it absent', async () => {
      await use(async (store) => {
        await store.put('empty.bin', new Uint8Array([]));

        expect(await store.has('empty.bin')).toBe(true);
        expect(await store.get('empty.bin')).toEqual(new Uint8Array([]));
      });
    });
  });

  describe(`${name}: listing`, () => {
    test('lists recursively, sorted, with forward-slash keys', async () => {
      await use(async (store) => {
        await store.put('one.txt', bytes('1'));
        await store.put('nested/two.txt', bytes('22'));
        await store.put('nested/deeper/three.txt', bytes('333'));

        expect((await store.list()).map((entry) => entry.key)).toEqual([
          'nested/deeper/three.txt',
          'nested/two.txt',
          'one.txt',
        ]);
      });
    });

    test('filters by prefix and reports sizes', async () => {
      await use(async (store) => {
        await store.put('a/one.txt', bytes('1'));
        await store.put('b/two.txt', bytes('22'));

        const listed = await store.list('a/');
        expect(listed.map((entry) => entry.key)).toEqual(['a/one.txt']);
        expect(listed[0]?.size).toBe(1);
      });
    });

    test('reports the content type it was given', async () => {
      await use(async (store) => {
        await store.put('doc.txt', bytes('x'), { contentType: 'text/plain' });

        const listed = await store.list();
        expect(listed.map((entry) => entry.key)).toEqual(['doc.txt']);
        expect(listed[0]?.contentType).toContain('text/plain');
      });
    });

    test('listing an empty store returns nothing rather than throwing', async () => {
      await use(async (store) => {
        expect(await store.list()).toEqual([]);
      });
    });

    test('a deleted blob leaves the key space', async () => {
      await use(async (store) => {
        await store.put('gone.txt', bytes('x'));
        await store.delete('gone.txt');

        expect(await store.list()).toEqual([]);
      });
    });
  });

  describe(`${name}: containment`, () => {
    test('refuses a key that resolves outside the store root', async () => {
      await use(async (store) => {
        // `scopeBlobStore` rejects these earlier, but an adapter is usable
        // directly and containment belongs where a key becomes an address.
        await expect(store.get('../outside.txt')).rejects.toThrow(/outside the store root/);
        await expect(store.put('a/../../outside.txt', bytes('x'))).rejects.toThrow(
          /outside the store root/,
        );
        await expect(store.delete('../../etc/passwd')).rejects.toThrow(/outside the store root/);
        await expect(store.has('../outside.txt')).rejects.toThrow(/outside the store root/);
      });
    });

    test('refuses a key that resolves to the root itself', async () => {
      await use(async (store) => {
        await expect(store.get('.')).rejects.toThrow(/outside the store root/);
      });
    });

    test('allows a traversal that stays inside, normalised', async () => {
      await use(async (store) => {
        // Weaker than `scopeBlobStore`'s rule on purpose: the namespace
        // boundary refuses a `..` segment outright, an adapter only has to
        // know where the key lands.
        await store.put('a/../b.txt', bytes('inside'));

        expect(text(await store.get('b.txt'))).toBe('inside');
        expect((await store.list()).map((entry) => entry.key)).toEqual(['b.txt']);
      });
    });
  });

  describe(`${name}: composed with namespace scoping`, () => {
    test('two connections on one store cannot see each other', async () => {
      await use(async (base) => {
        const a = scopeBlobStore(base, 'example/a');
        const b = scopeBlobStore(base, 'example/b');

        await a.put('note.txt', bytes('from a'));
        await b.put('note.txt', bytes('from b'));

        expect(text(await a.get('note.txt'))).toBe('from a');
        expect(text(await b.get('note.txt'))).toBe('from b');
        expect((await a.list()).map((entry) => entry.key)).toEqual(['note.txt']);
        expect(await a.has('note.txt')).toBe(true);
      });
    });

    test('deleting through one namespace leaves the other alone', async () => {
      await use(async (base) => {
        const a = scopeBlobStore(base, 'example/a');
        const b = scopeBlobStore(base, 'example/b');

        await a.put('note.txt', bytes('from a'));
        await b.put('note.txt', bytes('from b'));
        await a.delete('note.txt');

        expect(await a.get('note.txt')).toBeNull();
        expect(text(await b.get('note.txt'))).toBe('from b');
      });
    });
  });
}
