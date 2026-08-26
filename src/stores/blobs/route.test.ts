import { describe, expect, test } from 'bun:test';
import { scopeBlobStore } from './index.ts';
import { routeBlobStore } from './route.ts';
import { createMemoryBlobStore } from './testing.ts';
import { describeBlobStoreContract } from './conformance.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const decode = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);
const keys = async (store: { list(prefix?: string): Promise<{ key: string }[]> }, prefix?: string) =>
  (await store.list(prefix)).map((entry) => entry.key);

/**
 * A store with a route it never uses behaves exactly like the store beneath it,
 * so the whole contract applies unchanged. That is the claim worth asserting:
 * routing is not allowed to be a store with slightly different rules.
 */
describeBlobStoreContract('routed (unused route)', async () => {
  const base = createMemoryBlobStore();
  const store = routeBlobStore(base, [{ prefix: 'elsewhere/', store: createMemoryBlobStore() }]);
  return { open: () => store, dispose: async () => {} };
});

describe('routeBlobStore', () => {
  const build = () => {
    const base = createMemoryBlobStore();
    const routed = createMemoryBlobStore();
    return { base, routed, store: routeBlobStore(base, [{ prefix: 'memory/', store: routed }]) };
  };

  test('a key under the prefix lands in the route, without it', async () => {
    const { base, routed, store } = build();

    await store.put('memory/main/note.md', bytes('routed'));

    expect(decode(await routed.get('main/note.md'))).toBe('routed');
    expect(await base.list()).toEqual([]);
    expect(decode(await store.get('memory/main/note.md'))).toBe('routed');
    expect(await store.has('memory/main/note.md')).toBe(true);
  });

  test('every other key stays on the base', async () => {
    const { base, routed, store } = build();

    await store.put('state.kv/connections.v1/x', bytes('local'));

    expect(decode(await base.get('state.kv/connections.v1/x'))).toBe('local');
    expect(await routed.list()).toEqual([]);
  });

  test('a neighbouring namespace is not swallowed by the prefix', async () => {
    // `memory-archive` starts with `memory`, and would be claimed by a prefix
    // that was not directory-shaped.
    const { base, store } = build();

    await store.put('memory-archive/old.md', bytes('base'));
    expect(decode(await base.get('memory-archive/old.md'))).toBe('base');
  });

  test('deleting through the route leaves the base alone, and vice versa', async () => {
    const { store } = build();

    await store.put('memory/main/note.md', bytes('a'));
    await store.put('audit.log/run/1', bytes('b'));
    await store.delete('memory/main/note.md');

    expect(await store.get('memory/main/note.md')).toBeNull();
    expect(decode(await store.get('audit.log/run/1'))).toBe('b');
  });

  test('a listing under the route is served wholly by it, re-prefixed', async () => {
    const { store } = build();

    await store.put('memory/main/a.md', bytes('a'));
    await store.put('memory/work/b.md', bytes('b'));
    await store.put('skills.d/x.md', bytes('x'));

    expect(await keys(store, 'memory/')).toEqual(['memory/main/a.md', 'memory/work/b.md']);
    expect(await keys(store, 'memory/main/')).toEqual(['memory/main/a.md']);
  });

  test('a listing above the route includes both, sorted, with no duplicates', async () => {
    const { store } = build();

    await store.put('memory/main/a.md', bytes('a'));
    await store.put('audit.log/run/1', bytes('1'));
    await store.put('state.kv/x', bytes('x'));

    expect(await keys(store)).toEqual(['audit.log/run/1', 'memory/main/a.md', 'state.kv/x']);
  });

  test('a listing beside the route excludes it', async () => {
    const { store } = build();

    await store.put('memory/main/a.md', bytes('a'));
    await store.put('state.kv/x', bytes('x'));

    expect(await keys(store, 'state.kv/')).toEqual(['state.kv/x']);
  });

  test('a key the base already holds under the prefix is invisible once routed', async () => {
    // The migration's own failure mode: switching without moving leaves the old
    // bytes on disk, and they must not show through as a half-populated store.
    const base = createMemoryBlobStore();
    await base.put('memory/main/stale.md', bytes('stale'));

    const store = routeBlobStore(base, [{ prefix: 'memory/', store: createMemoryBlobStore() }]);

    expect(await store.get('memory/main/stale.md')).toBeNull();
    expect(await keys(store)).toEqual([]);
  });

  test('routing is decided by where a key lands, not by how it is spelled', async () => {
    const { base, routed, store } = build();

    await store.put('state.kv/../memory/main/note.md', bytes('routed'));

    expect(decode(await routed.get('main/note.md'))).toBe('routed');
    expect(await base.list()).toEqual([]);
  });

  test('scoping composed over a routed store still isolates namespaces', async () => {
    const { store } = build();
    const main = scopeBlobStore(store, 'memory/main');
    const work = scopeBlobStore(store, 'memory/work');

    await main.put('note.md', bytes('from main'));
    await work.put('note.md', bytes('from work'));

    expect(decode(await main.get('note.md'))).toBe('from main');
    expect(decode(await work.get('note.md'))).toBe('from work');
    expect(await keys(main)).toEqual(['note.md']);
  });

  test('no routes is the store itself', () => {
    const base = createMemoryBlobStore();
    expect(routeBlobStore(base, [])).toBe(base);
  });

  test('an empty prefix is refused rather than claiming everything', () => {
    expect(() => routeBlobStore(createMemoryBlobStore(), [{ prefix: '', store: createMemoryBlobStore() }])).toThrow(
      /must not be empty/,
    );
  });

  test('a prefix without a trailing slash is treated as a directory', async () => {
    const routed = createMemoryBlobStore();
    const store = routeBlobStore(createMemoryBlobStore(), [{ prefix: 'memory', store: routed }]);

    await store.put('memory/main/note.md', bytes('routed'));
    expect(decode(await routed.get('main/note.md'))).toBe('routed');
  });
});
