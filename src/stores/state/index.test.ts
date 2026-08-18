import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemBlobStore } from '#deployments/adapters/filesystem.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import { createRuntimeState, type RuntimeState } from './index.ts';
import { decodeSegment, encodeSegment, keyFromEntry, objectKey } from './keys.ts';

/**
 * There is no adapter suite here, and that is the point.
 *
 * This used to be `conformance.ts`, run against SQLite, Postgres and a
 * hand-written in-memory double, because three implementations had to be held
 * to one contract. There is one implementation now; what varies underneath is
 * the `BlobStore`, and `#stores/blobs/conformance.ts` already holds those to
 * their own contract. Running this over two of them is enough to catch a
 * behaviour that depends on the backing store rather than on this file.
 */

const backings: ReadonlyArray<[string, () => Promise<{ blobs: BlobStore; dispose(): Promise<void> }>]> = [
  ['memory', async () => ({ blobs: createMemoryBlobStore(), dispose: async () => {} })],
  [
    'filesystem',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'lanes-link-state-'));
      return {
        blobs: createFilesystemBlobStore({ root }),
        dispose: () => rm(root, { recursive: true, force: true }),
      };
    },
  ],
];

function ticking(start = Date.UTC(2026, 7, 12, 10, 0, 0)): () => Date {
  let at = start;
  return () => new Date((at += 1000));
}

for (const [name, open] of backings) {
  describe(`runtime state over ${name}`, () => {
    async function use(body: (state: RuntimeState) => Promise<void>): Promise<void> {
      const backing = await open();
      try {
        await body(createRuntimeState(backing.blobs, ticking()));
      } finally {
        await backing.dispose();
      }
    }

    describe('connections', () => {
      test('an upsert round-trips, and reading back gives the same record', async () => {
        await use(async (store) => {
          const written = await store.connections.upsert({
            provider: 'gmail',
            id: 'main',
            displayName: 'Work mail',
            status: 'active',
          });

          expect(await store.connections.get('gmail', 'main')).toEqual(written);
        });
      });

      test('createdAt survives an update, updatedAt does not', async () => {
        await use(async (store) => {
          const first = await store.connections.upsert({
            provider: 'gmail',
            id: 'main',
            displayName: 'Work mail',
            status: 'active',
          });
          const second = await store.connections.upsert({
            provider: 'gmail',
            id: 'main',
            displayName: 'Renamed',
            status: 'active',
          });

          expect(second.createdAt).toEqual(first.createdAt);
          expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
          expect(second.displayName).toBe('Renamed');
        });
      });

      test('an expiry round-trips as a Date, and its absence stays absent', async () => {
        await use(async (store) => {
          const expires = new Date(Date.UTC(2027, 0, 1));
          await store.connections.upsert({
            provider: 'gmail',
            id: 'main',
            displayName: 'Work mail',
            status: 'active',
            credentialExpiresAt: expires,
          });
          await store.connections.upsert({
            provider: 'drive',
            id: 'main',
            displayName: 'Files',
            status: 'active',
          });

          expect((await store.connections.get('gmail', 'main'))?.credentialExpiresAt).toEqual(
            expires,
          );
          expect(await store.connections.get('drive', 'main')).not.toHaveProperty(
            'credentialExpiresAt',
          );
        });
      });

      test('list is ordered by provider then id', async () => {
        await use(async (store) => {
          for (const [provider, id] of [
            ['gmail', 'b'],
            ['drive', 'a'],
            ['gmail', 'a'],
          ] as const) {
            await store.connections.upsert({
              provider,
              id,
              displayName: `${provider}.${id}`,
              status: 'active',
            });
          }

          expect((await store.connections.list()).map((r) => `${r.provider}.${r.id}`)).toEqual([
            'drive.a',
            'gmail.a',
            'gmail.b',
          ]);
        });
      });

      test('setStatus on an unknown connection is a no-op rather than an error', async () => {
        await use(async (store) => {
          await store.connections.setStatus('gmail', 'nope', 'disabled');
          expect(await store.connections.get('gmail', 'nope')).toBeNull();
        });
      });
    });

    describe('provider state', () => {
      test('a value round-trips and delete removes it', async () => {
        await use(async (store) => {
          await store.kv.set('gmail/main', 'cursor', 'abc');
          expect(await store.kv.get('gmail/main', 'cursor')).toBe('abc');

          await store.kv.delete('gmail/main', 'cursor');
          expect(await store.kv.get('gmail/main', 'cursor')).toBeNull();
        });
      });

      test('namespaces do not see each other', async () => {
        await use(async (store) => {
          await store.kv.set('gmail/main', 'k', 'one');
          await store.kv.set('gmail/other', 'k', 'two');

          expect(await store.kv.get('gmail/main', 'k')).toBe('one');
          expect(await store.kv.keys('gmail/other')).toEqual(['k']);
        });
      });

      test('a nested namespace is not a child of its parent', async () => {
        await use(async (store) => {
          // `oauth` and `oauth/tokens` are both real namespaces. Listing the
          // first must not return the second's keys, or a namespace would leak
          // exactly the isolation it exists to provide.
          await store.kv.set('oauth', 'shallow', 'a');
          await store.kv.set('oauth/tokens', 'deep', 'b');

          expect(await store.kv.keys('oauth')).toEqual(['shallow']);
          expect(await store.kv.keys('oauth/tokens')).toEqual(['deep']);

          await store.kv.clearNamespace('oauth');
          expect(await store.kv.get('oauth/tokens', 'deep')).toBe('b');
        });
      });

      test('keys that are not path-safe survive a round trip', async () => {
        await use(async (store) => {
          // Keys come from providers, so they are arbitrary strings. `..` is
          // the one that matters: unescaped it is a traversal, and it is a
          // plausible key rather than an adversarial one.
          for (const key of ['..', 'a/b', 'with space', 'emoji-🔑', 'dot.dot', '%41']) {
            await store.kv.set('example/main', key, `value:${key}`);
            expect(await store.kv.get('example/main', key)).toBe(`value:${key}`);
          }

          expect((await store.kv.keys('example/main')).sort()).toEqual(
            ['%41', '..', 'a/b', 'dot.dot', 'emoji-🔑', 'with space'].sort(),
          );
        });
      });

      test('clearNamespace empties one namespace and leaves the rest', async () => {
        await use(async (store) => {
          await store.kv.set('a/one', 'k', '1');
          await store.kv.set('b/one', 'k', '2');

          await store.kv.clearNamespace('a/one');
          expect(await store.kv.keys('a/one')).toEqual([]);
          expect(await store.kv.get('b/one', 'k')).toBe('2');
        });
      });

      test('reading an absent key is null rather than a throw', async () => {
        await use(async (store) => {
          expect(await store.kv.get('nothing/here', 'k')).toBeNull();
          expect(await store.kv.keys('nothing/here')).toEqual([]);
        });
      });
    });

    describe('cursors', () => {
      test('a cursor round-trips and overwrites', async () => {
        await use(async (store) => {
          expect(await store.cursors.get('gmail/main')).toBeNull();
          await store.cursors.set('gmail/main', 'page-1');
          await store.cursors.set('gmail/main', 'page-2');
          expect(await store.cursors.get('gmail/main')).toBe('page-2');
        });
      });
    });

    test('connections and cursors cannot be reached as provider state', async () => {
      await use(async (store) => {
        // The reserved namespaces carry a dot, and a provider namespace is
        // `<provider>/<connection>` where a provider id is `[a-z][a-z0-9_]*`.
        // So this is not a naming convention a provider could stumble into.
        await store.connections.upsert({
          provider: 'gmail',
          id: 'main',
          displayName: 'Work mail',
          status: 'active',
        });
        await store.cursors.set('gmail/main', 'page-1');

        expect(await store.kv.keys('gmail')).toEqual([]);
        expect(await store.kv.keys('gmail/main')).toEqual([]);
      });
    });
  });
}

describe('key encoding', () => {
  test('anything outside the safe set is percent-encoded', () => {
    expect(encodeSegment('plain_key-1')).toBe('plain_key-1');
    expect(encodeSegment('..')).toBe('%2E%2E');
    expect(encodeSegment('a/b')).toBe('a%2Fb');
    expect(encodeSegment('a.b')).toBe('a%2Eb');
  });

  test('every encoding round-trips', () => {
    for (const value of ['..', 'a/b', 'a.b', '  ', '🔑', '%2E', "quote'", 'x'.repeat(200)]) {
      expect(decodeSegment(encodeSegment(value))).toBe(value);
    }
  });

  test('a traversal cannot escape the store', () => {
    // The encoder is the guard here: `containedKey` in the blob layer would
    // also catch it, but a key that reached the adapter as `../../x` would
    // already have left this namespace.
    expect(objectKey('example/main', '../../escape')).toBe(
      'example/main/%2E%2E%2F%2E%2E%2Fescape.json',
    );
  });

  test('an entry below the first level is not a key of the namespace', () => {
    expect(keyFromEntry('oauth/', 'oauth/shallow.json')).toBe('shallow');
    expect(keyFromEntry('oauth/', 'oauth/tokens/deep.json')).toBeNull();
    expect(keyFromEntry('oauth/', 'other/shallow.json')).toBeNull();
  });
});
