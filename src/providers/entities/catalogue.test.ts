import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import {
  INDEX_KEY,
  fingerprintAfter,
  fingerprintOf,
  indexState,
  openCatalogue,
  rebuildCatalogue,
  writeCatalogue,
  type CatalogueEntity,
} from './catalogue.ts';
import { entityKey, serialiseEntity, type Entity } from './store.ts';

/**
 * The index is a cache, and every test here is about that word.
 *
 * A cache may be absent, truncated, of the wrong version or simply behind, and
 * in all four cases the right behaviour is the same: rebuild from the files and
 * answer correctly. What it may never do is be *believed* when the files have
 * moved on — which is what the fingerprint is for, and what most of this file
 * measures.
 *
 * The counting proxy is the point of several of these. "Zero entity reads" is
 * the entire claim the index makes, and asserting on a return value cannot
 * distinguish an index that was used from one that was rebuilt behind it.
 */

const NOW = '2026-08-30T09:14:22.104Z';

function counting(store: BlobStore): { store: BlobStore; reads: () => number } {
  let reads = 0;

  return {
    reads: () => reads,
    store: {
      ...store,
      async get(key) {
        // The index itself is not an entity read: it is the thing being tested,
        // and counting it would make "zero reads" impossible to state.
        if (key !== INDEX_KEY) reads += 1;
        return store.get(key);
      },
    },
  };
}

function entity(id: string, overrides: Partial<Entity> = {}): Entity {
  return {
    id,
    type: 'person',
    name: id,
    aliases: [],
    tags: [],
    attributes: [],
    relations: [],
    updatedAt: NOW,
    body: '',
    bytes: 0,
    ...overrides,
  };
}

async function storeOf(...entities: Entity[]): Promise<BlobStore> {
  const store = createMemoryBlobStore();
  for (const one of entities) {
    const { id: _id, bytes: _bytes, ...rest } = one;
    await store.put(entityKey(one.id), new TextEncoder().encode(serialiseEntity(rest)));
  }
  return store;
}

/** Build and persist an index that is correct for what is in the store. */
async function indexed(store: BlobStore): Promise<void> {
  const catalogue = await rebuildCatalogue(store);
  await writeCatalogue(store, catalogue.entities, catalogue.fingerprint, NOW);
}

describe('a valid index is used, and costs no entity reads', () => {
  test('the whole claim: zero reads when the fingerprint matches', async () => {
    const store = await storeOf(
      entity('jan-bakker', { name: 'Jan Bakker' }),
      entity('acme-bv', { name: 'Acme B.V.', type: 'company' }),
    );
    await indexed(store);

    const counted = counting(store);
    const catalogue = await openCatalogue(counted.store);

    expect(counted.reads()).toBe(0);
    expect(catalogue.fromIndex).toBe(true);
    expect(catalogue.byId.get('jan-bakker')?.name).toBe('Jan Bakker');
    expect(catalogue.byId.get('acme-bv')?.type).toBe('company');
  });

  test('a rebuild reads every entity, so the counter measures something', async () => {
    const store = await storeOf(entity('jan-bakker'), entity('acme-bv'));

    const counted = counting(store);
    const catalogue = await openCatalogue(counted.store);

    expect(counted.reads()).toBe(2);
    expect(catalogue.fromIndex).toBe(false);
  });
});

describe('the index is not believed once the files move on', () => {
  test('an entity edited to a different size invalidates it', async () => {
    const store = await storeOf(entity('jan-bakker', { name: 'Jan' }));
    await indexed(store);

    // What a person does in an editor, or on GitHub — neither of which goes
    // anywhere near the index.
    const { id: _id, bytes: _b, ...rest } = entity('jan-bakker', { name: 'Jan Bakker Senior' });
    await store.put(entityKey('jan-bakker'), new TextEncoder().encode(serialiseEntity(rest)));

    const catalogue = await openCatalogue(store);
    expect(catalogue.fromIndex).toBe(false);
    expect(catalogue.byId.get('jan-bakker')?.name).toBe('Jan Bakker Senior');
  });

  test('a new entity invalidates it', async () => {
    const store = await storeOf(entity('jan-bakker'));
    await indexed(store);
    const { id: _id, bytes: _b, ...rest } = entity('acme-bv');
    await store.put(entityKey('acme-bv'), new TextEncoder().encode(serialiseEntity(rest)));

    expect((await openCatalogue(store)).fromIndex).toBe(false);
  });

  test('a deleted entity invalidates it', async () => {
    const store = await storeOf(entity('jan-bakker'), entity('acme-bv'));
    await indexed(store);
    await store.delete(entityKey('acme-bv'));

    const catalogue = await openCatalogue(store);
    expect(catalogue.fromIndex).toBe(false);
    expect(catalogue.byId.has('acme-bv')).toBe(false);
  });

  test('a truncated index rebuilds silently and correctly', async () => {
    const store = await storeOf(entity('jan-bakker', { name: 'Jan Bakker' }));
    await indexed(store);
    await store.put(INDEX_KEY, new TextEncoder().encode('{"v":1,"fingerpr'));

    const catalogue = await openCatalogue(store);
    expect(catalogue.fromIndex).toBe(false);
    expect(catalogue.byId.get('jan-bakker')?.name).toBe('Jan Bakker');
  });

  test('an index from a future version rebuilds', async () => {
    const store = await storeOf(entity('jan-bakker'));
    await indexed(store);

    const document = JSON.parse(new TextDecoder().decode((await store.get(INDEX_KEY))!));
    await store.put(INDEX_KEY, new TextEncoder().encode(JSON.stringify({ ...document, v: 2 })));

    expect((await openCatalogue(store)).fromIndex).toBe(false);
  });

  test('an index whose rows are malformed rebuilds rather than answering partially', async () => {
    const store = await storeOf(entity('jan-bakker'));
    await indexed(store);

    const document = JSON.parse(new TextDecoder().decode((await store.get(INDEX_KEY))!));
    await store.put(
      INDEX_KEY,
      new TextEncoder().encode(JSON.stringify({ ...document, entities: [{ id: 'jan-bakker' }] })),
    );

    // Unlike an entity document, this file is machine-written: a salvageable
    // half of it is a partial answer with nothing saying so.
    expect((await openCatalogue(store)).fromIndex).toBe(false);
  });

  test('a hand-written index with a matching fingerprint IS served — the known hole', async () => {
    const store = await storeOf(entity('jan-bakker', { name: 'Jan Bakker' }));
    const fingerprint = fingerprintOf(await store.list());

    const wrong: CatalogueEntity[] = [
      {
        id: 'jan-bakker',
        type: 'person',
        name: 'Somebody Else',
        aliases: [],
        tags: [],
        attributes: [{ kind: 'email', value: 'wrong@example.test' }],
        relations: [],
        updatedAt: NOW,
      },
    ];
    await writeCatalogue(store, wrong, fingerprint, NOW);

    // Pinned rather than pretended away. The fingerprint stamps the *entity
    // files*, so an index edited on its own passes it. This is the cost of
    // committing the index beside the documents, and it is why `find` confirms
    // a single match against its file before an agent acts on it.
    const catalogue = await openCatalogue(store);
    expect(catalogue.fromIndex).toBe(true);
    expect(catalogue.byId.get('jan-bakker')?.name).toBe('Somebody Else');
  });
});

describe('the fingerprint', () => {
  test('ignores the index file, so writing it does not invalidate it', async () => {
    const store = await storeOf(entity('jan-bakker'));
    const before = fingerprintOf(await store.list());

    await indexed(store);
    const after = fingerprintOf(await store.list());

    // The loop, asserted directly: if `_index.json` were in its own
    // fingerprint, the index would be stale the instant it was written.
    expect(after).toBe(before);
    expect((await openCatalogue(store)).fromIndex).toBe(true);
  });

  test('ignores mtime, so a backend reporting one timestamp for every file still matches', async () => {
    const store = await storeOf(entity('jan-bakker'));
    const before = fingerprintOf(await store.list());

    // What the GitHub adapter does: `modifiedAt` is the branch tip, so every
    // file's timestamp moves whenever anything on the branch is committed.
    const listing = (await store.list()).map((blob) => ({
      ...blob,
      modifiedAt: new Date('2030-01-01T00:00:00.000Z'),
    }));

    expect(fingerprintOf(listing)).toBe(before);
  });

  test('fingerprintAfter predicts a put without listing again', async () => {
    const store = await storeOf(entity('jan-bakker'));
    const listing = await store.list();

    const { id: _id, bytes: _b, ...rest } = entity('acme-bv', { name: 'Acme B.V.' });
    const encoded = new TextEncoder().encode(serialiseEntity(rest));
    const predicted = fingerprintAfter(listing, { key: entityKey('acme-bv'), size: encoded.byteLength });

    await store.put(entityKey('acme-bv'), encoded);
    expect(predicted).toBe(fingerprintOf(await store.list()));
  });

  test('fingerprintAfter predicts an overwrite', async () => {
    const store = await storeOf(entity('jan-bakker', { name: 'Jan' }));
    const listing = await store.list();

    const { id: _id, bytes: _b, ...rest } = entity('jan-bakker', { name: 'Jan Bakker Senior' });
    const encoded = new TextEncoder().encode(serialiseEntity(rest));
    const predicted = fingerprintAfter(listing, {
      key: entityKey('jan-bakker'),
      size: encoded.byteLength,
    });

    await store.put(entityKey('jan-bakker'), encoded);
    expect(predicted).toBe(fingerprintOf(await store.list()));
  });

  test('fingerprintAfter predicts a delete', async () => {
    const store = await storeOf(entity('jan-bakker'), entity('acme-bv'));
    const listing = await store.list();

    const predicted = fingerprintAfter(listing, { key: entityKey('acme-bv'), deleted: true });

    await store.delete(entityKey('acme-bv'));
    expect(predicted).toBe(fingerprintOf(await store.list()));
  });

  test('a write predicted and persisted leaves the next read on the fast path', async () => {
    const store = await storeOf(entity('jan-bakker'));
    const catalogue = await openCatalogue(store);

    const { id: _id, bytes: _b, ...rest } = entity('acme-bv', { name: 'Acme B.V.' });
    const encoded = new TextEncoder().encode(serialiseEntity(rest));
    await store.put(entityKey('acme-bv'), encoded);

    const next = fingerprintAfter(catalogue.listing, {
      key: entityKey('acme-bv'),
      size: encoded.byteLength,
    });
    await writeCatalogue(
      store,
      [...catalogue.entities, { ...rest, id: 'acme-bv' }],
      next,
      NOW,
    );

    const counted = counting(store);
    const after = await openCatalogue(counted.store);
    expect(after.fromIndex).toBe(true);
    expect(counted.reads()).toBe(0);
    expect(after.byId.get('acme-bv')?.name).toBe('Acme B.V.');
  });
});

describe('backlinks are derived, never stored', () => {
  test('the reverse of a one-sided edge appears on the target', async () => {
    const store = await storeOf(
      entity('jan-bakker', {
        name: 'Jan Bakker',
        relations: [{ predicate: 'works_at', entity: 'acme-bv', note: 'since 2023' }],
      }),
      entity('acme-bv', { name: 'Acme B.V.', type: 'company' }),
    );

    const catalogue = await openCatalogue(store);

    // Acme's own file says nothing about Jan.
    expect(catalogue.byId.get('acme-bv')?.relations).toEqual([]);
    expect(catalogue.backlinks.get('acme-bv')).toEqual([
      { from: 'jan-bakker', predicate: 'works_at', note: 'since 2023' },
    ]);
  });

  test('an edge to an entity that does not exist is kept, not dropped', async () => {
    const store = await storeOf(
      entity('jan-bakker', { relations: [{ predicate: 'works_at', entity: 'not-declared' }] }),
    );

    const catalogue = await openCatalogue(store);
    expect(catalogue.byId.get('jan-bakker')?.relations).toHaveLength(1);
    expect(catalogue.backlinks.get('not-declared')).toHaveLength(1);
    expect(catalogue.byId.has('not-declared')).toBe(false);
  });

  test('the index path and the rebuild path derive the same backlinks', async () => {
    const store = await storeOf(
      entity('jan-bakker', { relations: [{ predicate: 'works_at', entity: 'acme-bv' }] }),
      entity('marta-silva', { relations: [{ predicate: 'works_at', entity: 'acme-bv' }] }),
      entity('acme-bv', { type: 'company' }),
    );

    const rebuilt = await rebuildCatalogue(store);
    await indexed(store);
    const served = await openCatalogue(store);

    expect(served.fromIndex).toBe(true);
    expect(served.backlinks.get('acme-bv')).toEqual(rebuilt.backlinks.get('acme-bv')!);
  });
});

describe('indexState explains itself', () => {
  test('it names each reason a rebuild was needed', async () => {
    const store = await storeOf(entity('jan-bakker'));
    expect(await indexState(store)).toEqual({ current: false, reason: 'no index file' });

    await indexed(store);
    expect((await indexState(store)).current).toBe(true);

    await store.put(INDEX_KEY, new TextEncoder().encode('not json'));
    expect((await indexState(store)).reason).toContain('could not be read');

    await indexed(store);
    const { id: _id, bytes: _b, ...rest } = entity('acme-bv');
    await store.put(entityKey('acme-bv'), new TextEncoder().encode(serialiseEntity(rest)));
    expect((await indexState(store)).reason).toContain('changed since the index was built');
  });
});
