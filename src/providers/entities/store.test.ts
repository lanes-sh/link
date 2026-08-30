import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import {
  allEntities,
  assertEntityId,
  assertKind,
  idFromKey,
  parseEntity,
  readEntity,
  serialiseEntity,
  slugify,
  writeEntity,
  type Entity,
} from './store.ts';

/**
 * The format, held to two rules that pull in opposite directions.
 *
 * **Tolerant read**: this is a directory the owner is invited to edit, so
 * anything that can be salvaged is, and nothing throws. **Strict write**: a
 * `kind` becomes part of how an attribute is matched and rendered, so the
 * spellings that reach a file are held to one shape.
 *
 * The tolerance is tested one level deeper than memory's, because entities have
 * lists inside their frontmatter and a bad row must cost that row rather than
 * the file — and a file must never cost the directory.
 */

const EPOCH = new Date(0).toISOString();

function entity(overrides: Partial<Entity> = {}): Entity {
  return {
    id: 'jan-bakker',
    type: 'person',
    name: 'Jan Bakker',
    aliases: ['Jan'],
    tags: ['client'],
    attributes: [{ kind: 'email', value: 'jan@acme.test', note: 'work' }],
    relations: [{ predicate: 'works_at', entity: 'acme-bv' }],
    updatedAt: '2026-08-30T09:14:22.104Z',
    body: 'Prefers email over calls.',
    bytes: 0,
    ...overrides,
  };
}

async function storeWith(files: Record<string, string>): Promise<BlobStore> {
  const store = createMemoryBlobStore();
  for (const [key, text] of Object.entries(files)) {
    await store.put(key, new TextEncoder().encode(text));
  }
  return store;
}

describe('the document round-trips', () => {
  test('everything written is read back, in the order it was written', () => {
    const original = entity({
      aliases: ['Jan', 'JB'],
      attributes: [
        { kind: 'email', value: 'jan@acme.test', note: 'work' },
        { kind: 'email', value: 'j.bakker@example.net', note: 'personal' },
        { kind: 'github', value: 'janb' },
      ],
    });

    const parsed = parseEntity('jan-bakker', serialiseEntity(original), EPOCH);

    expect(parsed.type).toBe('person');
    expect(parsed.name).toBe('Jan Bakker');
    expect(parsed.aliases).toEqual(['Jan', 'JB']);
    expect(parsed.tags).toEqual(['client']);
    expect(parsed.body).toBe('Prefers email over calls.');
    expect(parsed.updatedAt).toBe('2026-08-30T09:14:22.104Z');
    // Preference order is the whole meaning of the list, so it is asserted as a
    // sequence rather than as a set.
    expect(parsed.attributes).toEqual([
      { kind: 'email', value: 'jan@acme.test', note: 'work' },
      { kind: 'email', value: 'j.bakker@example.net', note: 'personal' },
      { kind: 'github', value: 'janb' },
    ]);
    expect(parsed.relations).toEqual([{ predicate: 'works_at', entity: 'acme-bv' }]);
  });

  test('empty lists are omitted from the file rather than written as []', () => {
    const text = serialiseEntity(
      entity({ aliases: [], tags: [], attributes: [], relations: [], body: '' }),
    );

    expect(text).not.toContain('aliases');
    expect(text).not.toContain('tags');
    expect(text).not.toContain('attributes');
    expect(text).not.toContain('relations');
    expect(text).toContain('name: Jan Bakker');
  });

  test('a relation names an entity that need not exist', () => {
    const text = serialiseEntity(
      entity({ relations: [{ predicate: 'works_at', entity: 'not-declared' }] }),
    );

    // No referential integrity at this layer, deliberately: a dangling edge
    // renders as a plain name (see find.ts), and refusing it here would make
    // declaration order matter.
    expect(parseEntity('jan-bakker', text, EPOCH).relations).toEqual([
      { predicate: 'works_at', entity: 'not-declared' },
    ]);
  });
});

describe('reading tolerates a directory a person edits', () => {
  test('a file with no frontmatter is an entity named after its id', () => {
    const parsed = parseEntity('acme-bv', 'Just some notes.\n', EPOCH);

    expect(parsed.name).toBe('acme-bv');
    expect(parsed.type).toBe('');
    expect(parsed.attributes).toEqual([]);
    expect(parsed.body).toBe('Just some notes.');
  });

  test('one malformed attribute is skipped and the rest of the file survives', () => {
    const text = [
      '---',
      'name: Jan Bakker',
      'attributes:',
      '  - { kind: email, value: jan@acme.test }',
      '  - just a string',
      '  - { kind: github }',
      '  - { value: no-kind }',
      '  - { kind: phone, value: "" }',
      '  - { kind: signal, value: janb }',
      '---',
      '',
      'Notes.',
    ].join('\n');

    // The visible failure is an attribute that did not appear. The alternative
    // is an exception that hides every other entity in the directory.
    expect(parseEntity('jan-bakker', text, EPOCH).attributes).toEqual([
      { kind: 'email', value: 'jan@acme.test' },
      { kind: 'signal', value: 'janb' },
    ]);
  });

  test('one malformed relation is skipped the same way', () => {
    const text = [
      '---',
      'name: Jan Bakker',
      'relations:',
      '  - { predicate: works_at, entity: acme-bv }',
      '  - works_at acme-bv',
      '  - { predicate: knows }',
      '  - { entity: marta-silva }',
      '---',
      '',
    ].join('\n');

    expect(parseEntity('jan-bakker', text, EPOCH).relations).toEqual([
      { predicate: 'works_at', entity: 'acme-bv' },
    ]);
  });

  test('attributes written as a mapping are ignored rather than half-read', () => {
    const text = ['---', 'name: Jan', 'attributes:', '  email: jan@example.test', '---', ''].join(
      '\n',
    );

    // Not tolerated, and the file still reads: the list form is what identity
    // uses and what every example shows, and guessing a preference order out of
    // a mapping would invent the one thing the list exists to record.
    expect(parseEntity('jan-bakker', text, EPOCH).attributes).toEqual([]);
    expect(parseEntity('jan-bakker', text, EPOCH).name).toBe('Jan');
  });

  test('a bare string in aliases reads as one alias', () => {
    const text = ['---', 'name: Jan', 'aliases: JB', '---', ''].join('\n');

    expect(parseEntity('jan-bakker', text, EPOCH).aliases).toEqual(['JB']);
  });

  test('a missing updated_at falls back to what the caller supplies', () => {
    expect(parseEntity('jan-bakker', 'notes\n', '2026-01-01T00:00:00.000Z').updatedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});

describe('keys and ids', () => {
  test('idFromKey accepts an entity file and refuses everything else', () => {
    expect(idFromKey('jan-bakker.md')).toBe('jan-bakker');
    expect(idFromKey('acme_bv.md')).toBe('acme_bv');

    // The one predicate that keeps the derived index out of the entity listing,
    // the fingerprint, the resource listing and the CLI listing.
    expect(idFromKey('_index.json')).toBeNull();
    expect(idFromKey('_index.md')).toBeNull();
    expect(idFromKey('jan-bakker.md.meta')).toBeNull();
    expect(idFromKey('Jan-Bakker.md')).toBeNull();
    expect(idFromKey('notes.txt')).toBeNull();
  });

  test('an id is refused rather than repaired', () => {
    expect(() => assertEntityId('jan-bakker')).not.toThrow();
    expect(() => assertEntityId('Jan Bakker')).toThrow(/lowercase/);
    expect(() => assertEntityId('-leading')).toThrow();
  });

  test('a kind is held to identity’s shape on write', () => {
    expect(() => assertKind('email', 'kind')).not.toThrow();
    expect(() => assertKind('works_at', 'predicate')).not.toThrow();
    // Free-form within the shape: a new one must not need a release.
    expect(() => assertKind('bluesky', 'kind')).not.toThrow();

    expect(() => assertKind('Email', 'kind')).toThrow(/kind/);
    expect(() => assertKind('e-mail', 'kind')).toThrow();
    expect(() => assertKind('2fa', 'kind')).toThrow();
  });

  test('slugify derives an id from a name, and always derives something', () => {
    expect(slugify('Jan Bakker')).toBe('jan-bakker');
    expect(slugify('Acme B.V.')).toBe('acme-b-v');
    expect(slugify('  ')).toBe('entity-2');
    expect(slugify('北京公司')).toBe('entity-4');
  });
});

describe('the store', () => {
  test('a written entity reads back through the store', async () => {
    const store = createMemoryBlobStore();
    const bytes = await writeEntity(store, entity());

    const read = await readEntity(store, 'jan-bakker');
    expect(read).not.toBeNull();
    expect(read?.name).toBe('Jan Bakker');
    expect(read?.attributes[0]?.value).toBe('jan@acme.test');
    // The byte length is returned so the catalogue can compute the fingerprint
    // of the state it is creating without listing the store again.
    expect(bytes).toBe(read?.bytes ?? -1);
  });

  test('a missing entity is null, not an error', async () => {
    expect(await readEntity(createMemoryBlobStore(), 'nobody')).toBeNull();
  });

  test('allEntities reads only entity files, newest first', async () => {
    const store = await storeWith({
      'jan-bakker.md': '---\nname: Jan Bakker\nupdated_at: 2026-08-30T00:00:00.000Z\n---\n\n',
      'acme-bv.md': '---\nname: Acme B.V.\nupdated_at: 2026-08-31T00:00:00.000Z\n---\n\n',
      '_index.json': '{"v":1}',
      'notes.txt': 'ignored',
    });

    expect((await allEntities(store)).map((one) => one.id)).toEqual(['acme-bv', 'jan-bakker']);
  });
});
