import { describe, expect, test } from 'bun:test';
import { catalogueFrom, type CatalogueEntity } from './catalogue.ts';
import { distinguish, matchEntities, type Criteria } from './find.ts';
import { describe as describeCriteria, renderCandidates, renderEntity } from './render.ts';

/**
 * What a name means, and what happens when it means more than one thing.
 *
 * The behaviour under test is a product decision as much as a technical one:
 * several matches is a normal answer. So most of these assert that ambiguity is
 * *preserved* — that nothing collapses two Jans into one — and the rest assert
 * that when it happens, the answer carries enough to settle it.
 *
 * All pure, over literal arrays. That is the point of the seam: ambiguity,
 * preference order and dangling edges are the cases worth covering and none of
 * them needs a store.
 */

function entity(id: string, overrides: Partial<CatalogueEntity> = {}): CatalogueEntity {
  return {
    id,
    type: 'person',
    name: id,
    aliases: [],
    tags: [],
    attributes: [],
    relations: [],
    updatedAt: '2026-08-30T09:00:00.000Z',
    ...overrides,
  };
}

const JAN = entity('jan-bakker', {
  name: 'Jan Bakker',
  aliases: ['Jan', 'JB'],
  tags: ['client'],
  attributes: [
    { kind: 'email', value: 'jan@acme.test', note: 'work' },
    { kind: 'email', value: 'j.bakker@example.net', note: 'personal' },
    { kind: 'github', value: 'janb' },
  ],
  relations: [{ predicate: 'works_at', entity: 'acme-bv', note: 'since 2023' }],
});

const JAN_DE_VRIES = entity('jan-de-vries', {
  name: 'Jan de Vries',
  aliases: ['Jan'],
  attributes: [{ kind: 'email', value: 'jdv@meridian.test' }],
  relations: [{ predicate: 'works_at', entity: 'meridian' }],
  updatedAt: '2026-08-31T09:00:00.000Z',
});

const ACME = entity('acme-bv', { name: 'Acme B.V.', type: 'company', tags: ['client'] });
const MERIDIAN = entity('meridian', { name: 'Meridian Foundation', type: 'company' });
const MARTA = entity('marta-silva', {
  name: 'Marta Silva',
  attributes: [{ kind: 'github', value: 'msilva' }],
  relations: [{ predicate: 'works_at', entity: 'acme-bv' }],
});

const CATALOGUE = catalogueFrom([JAN, JAN_DE_VRIES, ACME, MERIDIAN, MARTA]);

function ids(criteria: Criteria): string[] {
  return matchEntities(CATALOGUE, criteria).candidates.map((one) => one.entity.id);
}

describe('the rank ladder', () => {
  test('an id, a name, an alias and an attribute value each match exactly', () => {
    expect(ids({ query: 'jan-bakker' })).toEqual(['jan-bakker']);
    expect(ids({ query: 'Jan Bakker' })).toEqual(['jan-bakker']);
    expect(ids({ query: 'JB' })).toEqual(['jan-bakker']);
    expect(ids({ query: 'jan@acme.test' })).toEqual(['jan-bakker']);
  });

  test('matching is case- and whitespace-insensitive', () => {
    expect(ids({ query: '  JAN BAKKER ' })).toEqual(['jan-bakker']);
    expect(ids({ query: 'JAN@ACME.TEST' })).toEqual(['jan-bakker']);
  });

  test('an attribute match names its kind, so a wrong one is legible', () => {
    const [candidate] = matchEntities(CATALOGUE, { query: 'janb' }).candidates;
    expect(candidate?.rank).toBe('attribute');
    expect(candidate?.matched).toBe('github');
  });

  test('an alias match names the alias it matched', () => {
    const [candidate] = matchEntities(CATALOGUE, { query: 'JB' }).candidates;
    expect(candidate?.matched).toBe('alias "JB"');
  });

  test('exact suppresses approximate', () => {
    const catalogue = catalogueFrom([
      entity('jan-bakker', { name: 'Jan Bakker', aliases: ['Jan'] }),
      entity('janet-cole', { name: 'Janet Cole' }),
    ]);

    // "Janet Cole" starts with "jan" too. An exact alias match is a different
    // *kind* of answer, so the approximate one is dropped rather than ranked
    // below it — otherwise every lookup of a short name grows a tail.
    expect(matchEntities(catalogue, { query: 'Jan' }).candidates.map((c) => c.entity.id)).toEqual([
      'jan-bakker',
    ]);
  });

  test('with nothing exact, prefix and substring still answer', () => {
    const catalogue = catalogueFrom([
      entity('janet-cole', { name: 'Janet Cole' }),
      entity('marijana-b', { name: 'Marijana B' }),
    ]);

    expect(matchEntities(catalogue, { query: 'jan' }).candidates.map((c) => c.rank)).toEqual([
      'prefix',
      'substring',
    ]);
  });

  test('a tag is never matched by query', () => {
    // `find("client")` must not surface one of eleven clients as if it were a
    // name. The tag filter is how you mean the category.
    expect(ids({ query: 'client' })).toEqual([]);
    expect(ids({ tag: 'client' }).sort()).toEqual(['acme-bv', 'jan-bakker']);
  });

  test('nothing matching is an empty list, not a throw', () => {
    expect(matchEntities(CATALOGUE, { query: 'nobody at all' })).toEqual({
      candidates: [],
      total: 0,
      scanned: 5,
    });
  });
});

describe('ambiguity is preserved, not resolved', () => {
  test('two exact alias matches both come back', () => {
    expect(ids({ query: 'Jan' }).sort()).toEqual(['jan-bakker', 'jan-de-vries']);
  });

  test('ordering within a rank does not promote one of them', () => {
    const matches = matchEntities(CATALOGUE, { query: 'Jan' });

    // Both are rank `alias`. `updatedAt` orders them, which is a presentation
    // choice — and the assertion that matters is that both survive it.
    expect(matches.candidates).toHaveLength(2);
    expect(new Set(matches.candidates.map((one) => one.rank))).toEqual(new Set(['alias']));
  });

  test('a criterion narrows an ambiguity to one', () => {
    expect(ids({ query: 'Jan', related: [{ predicate: 'works_at', entity: 'acme-bv' }] })).toEqual([
      'jan-bakker',
    ]);
    expect(ids({ query: 'Jan', attr: [{ kind: 'github' }] })).toEqual(['jan-bakker']);
  });

  test('limit reports what it cut rather than hiding it', () => {
    const matches = matchEntities(CATALOGUE, { query: 'Jan', limit: 1 });
    expect(matches.candidates).toHaveLength(1);
    expect(matches.total).toBe(2);
  });
});

describe('criteria are AND-ed', () => {
  test('type narrows', () => {
    expect(ids({ type: 'company' }).sort()).toEqual(['acme-bv', 'meridian']);
    expect(ids({ query: 'Jan', type: 'company' })).toEqual([]);
  });

  test('two criteria intersect rather than union', () => {
    // `type: person` alone has three; `tag: client` alone has two. Together,
    // one — which is the whole difference between AND and OR.
    expect(ids({ type: 'person', tag: 'client' })).toEqual(['jan-bakker']);
  });

  test('attr matches a kind with or without a value', () => {
    expect(ids({ attr: [{ kind: 'github' }] }).sort()).toEqual(['jan-bakker', 'marta-silva']);
    expect(ids({ attr: [{ kind: 'github', value: 'msilva' }] })).toEqual(['marta-silva']);
    expect(ids({ attr: [{ kind: 'github', value: 'nobody' }] })).toEqual([]);
  });

  test('no criteria at all lists everything', () => {
    expect(ids({}).length).toBe(5);
  });
});

describe('the related filter', () => {
  test('out — who points at Acme, and not Acme itself', () => {
    // The natural phrasing. "Who works at Acme" wants the employees; returning
    // Acme as well would be a wrong answer wearing the same shape as a right one.
    expect(ids({ related: [{ predicate: 'works_at', entity: 'acme-bv' }] }).sort()).toEqual([
      'jan-bakker',
      'marta-silva',
    ]);
  });

  test('in — who Acme is pointed at by, read from the entity side', () => {
    expect(ids({ related: [{ entity: 'jan-bakker', direction: 'in' }] })).toEqual(['acme-bv']);
  });

  test('any — either direction', () => {
    expect(ids({ related: [{ entity: 'acme-bv', direction: 'any' }] }).sort()).toEqual([
      'jan-bakker',
      'marta-silva',
    ]);
    expect(ids({ related: [{ entity: 'marta-silva', direction: 'any' }] })).toEqual(['acme-bv']);
  });

  test('the predicate is optional', () => {
    expect(ids({ related: [{ entity: 'meridian' }] })).toEqual(['jan-de-vries']);
    expect(ids({ related: [{ predicate: 'knows', entity: 'meridian' }] })).toEqual([]);
  });
});

describe('distinguish', () => {
  test('it drops what every candidate shares and keeps what separates them', () => {
    // Looked up by id rather than by position: the order within a rank is a
    // presentation detail and asserting on it here would test the wrong thing.
    const { candidates } = matchEntities(CATALOGUE, { query: 'Jan' });
    const rows = new Map(
      distinguish(candidates).map((facets, index) => [
        candidates[index]!.entity.id,
        facets.join(' '),
      ]),
    );

    // Both are `type: person`, so type says nothing and is omitted.
    expect(rows.get('jan-bakker')).not.toContain('person');
    expect(rows.get('jan-de-vries')).not.toContain('person');

    // The employer is what actually tells them apart.
    expect(rows.get('jan-bakker')).toContain('acme-bv');
    expect(rows.get('jan-de-vries')).toContain('meridian');
  });

  test('it reports nothing when nothing distinguishes', () => {
    const catalogue = catalogueFrom([
      entity('jan-one', { name: 'Jan', aliases: ['Jan'] }),
      entity('jan-two', { name: 'Jan', aliases: ['Jan'] }),
    ]);

    expect(distinguish(matchEntities(catalogue, { query: 'Jan' }).candidates)).toEqual([[], []]);
  });

  test('it renders the differing value, not just the field name', () => {
    const { candidates } = matchEntities(CATALOGUE, { query: 'Jan' });
    const rows = new Map(
      distinguish(candidates).map((facets, index) => [candidates[index]!.entity.id, facets.join(' ')]),
    );

    // A draft withheld these. "These two differ by email" without saying how is
    // the same ambiguity one level down, and there is nothing to withhold —
    // `find` and `get` are both in the default read bundle.
    expect(rows.get('jan-bakker')).toContain('jan@acme.test');
    expect(rows.get('jan-de-vries')).toContain('jdv@meridian.test');
  });

  test('a field only one candidate has still counts as distinguishing', () => {
    const catalogue = catalogueFrom([
      entity('a-one', { name: 'Same', aliases: ['Same'], tags: ['vip'] }),
      entity('b-two', { name: 'Same', aliases: ['Same'] }),
    ]);

    const [first, second] = distinguish(matchEntities(catalogue, { query: 'Same' }).candidates);
    expect(first).toEqual(['tags vip']);
    expect(second).toEqual([]);
  });
});

describe('rendering one entity', () => {
  test('it prints attributes in file order and marks the preference rule', () => {
    const text = renderEntity(JAN, CATALOGUE, 'Prefers email over calls.');

    expect(text).toContain('Jan Bakker — person (jan-bakker)');
    expect(text).toContain('Also known as Jan, JB.');
    expect(text.indexOf('jan@acme.test')).toBeLessThan(
      text.indexOf('j.bakker@example.net'),
    );
    expect(text).toContain('the first is the default');
    expect(text).toContain('Prefers email over calls.');
  });

  test('the preference sentence is absent when no kind holds two', () => {
    expect(renderEntity(MARTA, CATALOGUE, '')).not.toContain('the first is the default');
  });

  test('a forward edge names the entity it points at', () => {
    expect(renderEntity(JAN, CATALOGUE, '')).toContain('works_at → Acme B.V. (acme-bv) — since 2023');
  });

  test('a backlink appears on the target without being stored there', () => {
    const text = renderEntity(ACME, CATALOGUE, '');
    expect(text).toContain('← works_at Jan Bakker (jan-bakker)');
    expect(text).toContain('← works_at Marta Silva (marta-silva)');
  });

  test('a dangling edge renders as a plain name and says so', () => {
    const catalogue = catalogueFrom([
      entity('jan-bakker', {
        name: 'Jan Bakker',
        relations: [{ predicate: 'works_at', entity: 'not-declared' }],
      }),
    ]);

    // Never a throw and never a dropped line: the owner recorded this, and
    // hiding it would make the graph quietly wrong rather than visibly partial.
    expect(renderEntity(catalogue.entities[0]!, catalogue, '')).toContain(
      'works_at → not-declared (not a declared entity)',
    );
  });
});

describe('rendering several candidates', () => {
  test('the count comes first, before any candidate', () => {
    const matches = matchEntities(CATALOGUE, { query: 'Jan' });
    const text = renderCandidates(matches, { query: 'Jan' }, 'entities.main');

    // A client that truncates must still have seen that there was more than one.
    expect(text.split('\n')[0]).toBe('2 entities match "Jan" on `entities.main`.');
    expect(text.indexOf('2 entities match')).toBeLessThan(text.indexOf('jan-bakker'));
  });

  test('it says to ask, and says the order is not a ranking', () => {
    const matches = matchEntities(CATALOGUE, { query: 'Jan' });
    const text = renderCandidates(matches, { query: 'Jan' }, 'entities.main');

    expect(text).toContain('ask before acting');
    expect(text).toContain('the order is not a ranking');
  });

  test('two candidates that differ by nothing say so', () => {
    const catalogue = catalogueFrom([
      entity('jan-one', { name: 'Jan', aliases: ['Jan'] }),
      entity('jan-two', { name: 'Jan', aliases: ['Jan'] }),
    ]);
    const matches = matchEntities(catalogue, { query: 'Jan' });

    expect(renderCandidates(matches, { query: 'Jan' }, 'entities.main')).toContain(
      'duplicate to merge',
    );
  });

  test('a truncated list says how to see the rest', () => {
    const matches = matchEntities(CATALOGUE, { query: 'Jan', limit: 1 });
    expect(renderCandidates(matches, { query: 'Jan' }, 'entities.main')).toContain('raise `limit`');
  });

  test('criteria are described in the words the caller used', () => {
    expect(describeCriteria({ query: 'Jan', type: 'person' })).toBe('"Jan", type person');
    expect(describeCriteria({ attr: [{ kind: 'github' }] })).toBe('with a github');
    expect(describeCriteria({ related: [{ predicate: 'works_at', entity: 'acme-bv' }] })).toBe(
      'works_at → acme-bv',
    );
    expect(describeCriteria({})).toBe('no criteria');
  });
});
