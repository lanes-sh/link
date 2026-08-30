import { describe, expect, test } from 'bun:test';
import { harnessFor, linksOf, textOf } from '#providers/harness.ts';
import { entitiesProvider } from './provider.ts';
import { INDEX_KEY, fingerprintOf, writeCatalogue, type CatalogueEntity } from './catalogue.ts';
import type { CapabilityResult } from '#connectivity';

/**
 * The surface, through the connector the runtime uses rather than by calling
 * handlers directly.
 *
 * Two claims get most of the attention here because they are the ones the
 * component exists for. **Several matches is a normal answer**: no `isError`,
 * the count stated before any candidate, and nothing presenting one of them as
 * the choice. And **what reaches the audit log**: this provider holds third
 * parties' addresses, so the rules about what is kept are asserted against the
 * redaction functions themselves rather than trusted to a comment.
 */

function harness() {
  return harnessFor(entitiesProvider);
}

async function declare(
  h: ReturnType<typeof harness>,
  args: Record<string, unknown>,
): Promise<CapabilityResult> {
  return h.invoke('write', args);
}

const JAN = {
  name: 'Jan Bakker',
  type: 'person',
  aliases: ['Jan'],
  tags: ['client'],
  attributes: [
    { kind: 'email', value: 'jan@acme.test', note: 'work' },
    { kind: 'email', value: 'j.bakker@example.net', note: 'personal' },
    { kind: 'github', value: 'janb' },
  ],
  relations: [{ predicate: 'works_at', entity: 'acme-bv' }],
  notes: 'Prefers email over calls.',
};

describe('the shape of the surface', () => {
  test('reading and writing are different capabilities, and write is not default', () => {
    const bundles = entitiesProvider.manifest.bundles ?? [];
    const read = bundles.find((one) => one.name === 'read');
    const write = bundles.find((one) => one.name === 'write');

    expect(read?.default).toBe(true);
    expect(read?.capabilities).toEqual(['entity', 'find', 'get']);

    // ADR-012 §2. Not default, and it takes all three names to deny — there is
    // no single rule that closes it, which the docs have to say.
    expect(write?.default).toBeFalsy();
    expect(write?.capabilities).toEqual(['write', 'link', 'forget']);
  });

  test('the capability list is exactly what was meant, and a resource is among it', () => {
    expect(entitiesProvider.capabilities.map((one) => one.name)).toEqual([
      'entity',
      'find',
      'get',
      'write',
      'link',
      'forget',
    ]);

    // Without a resource template, `resourceLinkRouter` has no origin to route
    // and every link below reaches the client unreadable.
    const resource = entitiesProvider.capabilities.find((one) => one.kind === 'resource');
    expect(resource?.name).toBe('entity');
  });

  test('no capability name trips the control-plane vocabulary', () => {
    // The seven patterns `control-plane.test.ts` enforces, checked here too so
    // a rename is caught in this file rather than three components away.
    const forbidden = [/policy/i, /(^|[._])(token|bearer)/i, /credential|secret|password/i,
      /(^|[._])config/i, /(^|[._])(connect|authorize|oauth)/i, /audit/i,
      /(^|[._])(grant|revoke|allow|deny)/i];

    for (const capability of entitiesProvider.capabilities) {
      for (const pattern of forbidden) {
        expect(`entities.${capability.name}`).not.toMatch(pattern);
      }
    }
  });
});

describe('one match is an answer', () => {
  test('it returns a link and the text, so a client that ignores links still reads it', async () => {
    const h = harness();
    await declare(h, JAN);

    const result = await h.invoke('find', { query: 'Jan' });

    expect(linksOf(result)).toEqual(['entities://entity/jan-bakker']);
    const text = textOf(result);
    expect(text).toContain('Jan Bakker — person (jan-bakker)');
    expect(text).toContain('jan@acme.test');
    expect(text).toContain('Prefers email over calls.');
    expect('isError' in result && result.isError).toBeFalsy();
  });

  test('an address resolves to the entity that holds it', async () => {
    const h = harness();
    await declare(h, JAN);

    expect(textOf(await h.invoke('find', { query: 'janb' }))).toContain('jan-bakker');
  });
});

describe('several matches is a normal answer, not a failure', () => {
  async function twoJans() {
    const h = harness();
    await declare(h, JAN);
    await declare(h, {
      name: 'Jan de Vries',
      type: 'person',
      aliases: ['Jan'],
      attributes: [{ kind: 'email', value: 'jdv@meridian.test' }],
      relations: [{ predicate: 'works_at', entity: 'meridian' }],
    });
    return h;
  }

  test('no error is set, and the count comes before any candidate', async () => {
    const result = await (await twoJans()).invoke('find', { query: 'Jan' });

    // An assistant handed two people called Jan asks which one. It does not
    // fail, and a client that truncates must still have seen there were two.
    expect('isError' in result && result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text.split('\n')[0]).toContain('2 entities match');
    expect(text.indexOf('2 entities match')).toBeLessThan(text.indexOf('jan-bakker'));
  });

  test('it says to ask, and that the order is not a ranking', async () => {
    const text = textOf(await (await twoJans()).invoke('find', { query: 'Jan' }));

    expect(text).toContain('ask before acting');
    expect(text).toContain('the order is not a ranking');
  });

  test('it shows what separates them and not what they share', async () => {
    const text = textOf(await (await twoJans()).invoke('find', { query: 'Jan' }));

    expect(text).toContain('acme-bv');
    expect(text).toContain('meridian');
    // Both are people. Saying so twice crowds out the column that decides it.
    expect(text).not.toContain('type person');
  });

  test('every candidate carries a link, so none is privileged', async () => {
    expect(linksOf(await (await twoJans()).invoke('find', { query: 'Jan' })).sort()).toEqual([
      'entities://entity/jan-bakker',
      'entities://entity/jan-de-vries',
    ]);
  });

  test('a criterion narrows the same query to one', async () => {
    const h = await twoJans();
    const result = await h.invoke('find', {
      query: 'Jan',
      related: [{ predicate: 'works_at', entity: 'acme-bv' }],
    });

    expect(linksOf(result)).toEqual(['entities://entity/jan-bakker']);
  });
});

describe('no match', () => {
  test('is not an error either, and says not to invent an address', async () => {
    const h = harness();
    await declare(h, JAN);

    const result = await h.invoke('find', { query: 'Nobody Here' });

    expect('isError' in result && result.isError).toBeFalsy();
    expect(textOf(result)).toContain('Do not use an address that is not here');
  });
});

describe('writing', () => {
  test('a field that is not supplied keeps what is on disk', async () => {
    const h = harness();
    await declare(h, JAN);

    // The lost-update case: a model updating one thing resends the entity
    // without the attributes it forgot.
    await declare(h, { id: 'jan-bakker', name: 'Jan Bakker', tags: ['client', 'vip'] });

    const text = textOf(await h.invoke('get', { id: 'jan-bakker' }));
    expect(text).toContain('jan@acme.test');
    expect(text).toContain('janb');
    expect(text).toContain('Tagged client, vip.');
    expect(text).toContain('Prefers email over calls.');
  });

  test('an empty list clears deliberately', async () => {
    const h = harness();
    await declare(h, JAN);
    await declare(h, { id: 'jan-bakker', name: 'Jan Bakker', attributes: [] });

    expect(textOf(await h.invoke('get', { id: 'jan-bakker' }))).not.toContain('jan@acme.test');
  });

  test('a kind is refused rather than repaired', async () => {
    const h = harness();
    await expect(
      declare(h, { name: 'Jan', attributes: [{ kind: 'E-Mail', value: 'x@example.test' }] }),
    ).rejects.toThrow(/kind/);
  });

  test('link appends one edge without restating the entity', async () => {
    const h = harness();
    await declare(h, JAN);
    await h.invoke('link', { from: 'jan-bakker', predicate: 'knows', to: 'marta-silva' });

    const text = textOf(await h.invoke('get', { id: 'jan-bakker' }));
    expect(text).toContain('works_at → acme-bv');
    expect(text).toContain('knows → marta-silva');
    expect(text).toContain('jan@acme.test');
  });

  test('an edge to an entity that does not exist is kept and said so', async () => {
    const h = harness();
    await declare(h, { name: 'Jan Bakker' });

    const result = await h.invoke('link', {
      from: 'jan-bakker',
      predicate: 'works_at',
      to: 'not-declared',
    });

    expect(textOf(result)).toContain('not declared yet');
    expect(h.annotations()['dangling']).toBe(true);
  });

  test('the reverse of an edge is derived, never written to the other file', async () => {
    const h = harness();
    await declare(h, { id: 'acme-bv', name: 'Acme B.V.', type: 'company' });
    await declare(h, JAN);

    expect(textOf(await h.invoke('get', { id: 'acme-bv' }))).toContain(
      '← works_at Jan Bakker (jan-bakker)',
    );

    // Acme's own document says nothing about Jan.
    const raw = await h.context.storage.get('acme-bv.md');
    expect(new TextDecoder().decode(raw!)).not.toContain('jan');
  });
});

describe('forget does not cascade', () => {
  test('it reports who still points at what it removed', async () => {
    const h = harness();
    await declare(h, { id: 'acme-bv', name: 'Acme B.V.', type: 'company' });
    await declare(h, JAN);

    const result = await h.invoke('forget', { id: 'acme-bv' });

    // A delete that rewrote five other people's files could not be reviewed as
    // one change. Naming them is what keeps the breakage from being silent.
    expect(textOf(result)).toContain('Still referenced by jan-bakker');
    expect(h.annotations()['referenced_by']).toBe(1);

    const jan = textOf(await h.invoke('get', { id: 'jan-bakker' }));
    expect(jan).toContain('works_at → acme-bv (not a declared entity)');
  });

  test('removing something absent is an error, and says so', async () => {
    const result = await harness().invoke('forget', { id: 'nobody' });
    expect('isError' in result && result.isError).toBe(true);
  });
});

describe('the index is maintained by writes and trusted by reads', () => {
  test('a write leaves an index that the next read uses', async () => {
    const h = harness();
    await declare(h, JAN);

    const index = await h.context.storage.get(INDEX_KEY);
    expect(index).not.toBeNull();

    const document = JSON.parse(new TextDecoder().decode(index!));
    expect(document.fingerprint).toBe(fingerprintOf(await h.context.storage.list()));
    // What matches and what distinguishes, and nothing that only renders.
    expect(JSON.stringify(document)).not.toContain('Prefers email over calls');
  });

  test('an index that disagrees with a file cannot produce a confident wrong answer', async () => {
    const h = harness();
    await declare(h, JAN);

    // The hole the fingerprint cannot close: the index is edited on its own, so
    // it still stamps the untouched entity files and is served.
    const wrong: CatalogueEntity[] = [
      {
        id: 'jan-bakker',
        type: 'person',
        name: 'Jan Bakker',
        aliases: ['Jan'],
        tags: [],
        attributes: [{ kind: 'email', value: 'attacker@example.test' }],
        relations: [],
        updatedAt: '2026-08-30T09:14:22.104Z',
      },
    ];
    await writeCatalogue(
      h.context.storage,
      wrong,
      fingerprintOf(await h.context.storage.list()),
      '2026-08-30T09:14:22.104Z',
    );

    // One candidate, about to be acted on: the file is opened and compared, the
    // catalogue is rebuilt, and the answer comes from the document on disk.
    const text = textOf(await h.invoke('find', { query: 'Jan' }));
    expect(text).toContain('jan@acme.test');
    expect(text).not.toContain('attacker@example.test');
  });
});

describe('what reaches the audit log', () => {
  function redact(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const capability = entitiesProvider.capabilities.find((one) => one.name === name);
    return capability!.redact!(args);
  }

  test('a lookup query is withheld, and the ids that came back are recorded', async () => {
    const recorded = redact('find', { query: 'jan@acme.test', type: 'person', limit: 5 });

    // The query is routinely a third party's address, typed by someone who
    // never wrote it down — memory withholds its own for the same reason.
    expect(JSON.stringify(recorded)).not.toContain('jan@acme.test');
    expect(recorded['type']).toBe('person');
    expect(recorded['limit']).toBe(5);

    const h = harness();
    await declare(h, JAN);
    await h.invoke('find', { query: 'Jan' });

    // The outcome is the useful record, and is stable across spellings.
    expect(h.annotations()['candidates']).toEqual(['jan-bakker']);
    expect(h.annotations()['matched']).toBe(1);
  });

  test('an attribute value never reaches the log, but its kind does', async () => {
    const recorded = redact('write', {
      id: 'jan-bakker',
      name: 'Jan Bakker',
      type: 'person',
      tags: ['client'],
      attributes: [{ kind: 'email', value: 'jan@acme.test' }],
      notes: 'Prefers email over calls.',
    });

    const serialised = JSON.stringify(recorded);
    expect(serialised).not.toContain('jan@acme.test');
    expect(serialised).not.toContain('Prefers email over calls');
    // The id and the name are addresses, and `id` is derived from `name` —
    // keeping one while withholding the other would be theatre.
    expect(recorded['id']).toBe('jan-bakker');
    expect(recorded['name']).toBe('Jan Bakker');

    const h = harness();
    await declare(h, JAN);

    // `redact` cannot express "keep the shape, drop the values"; `annotate`
    // records what changed without putting an address in the chain. ADR-017.
    expect(h.annotations()['kinds']).toEqual(['email', 'github']);
    expect(h.annotations()['attributes']).toBe(3);
    expect(h.annotations()['entity']).toBe('jan-bakker');
  });

  test('a relation is recorded by its ends, which are ids and not content', () => {
    const recorded = redact('link', {
      from: 'jan-bakker',
      predicate: 'works_at',
      to: 'acme-bv',
      note: 'introduced by a mutual client',
    });

    expect(recorded['from']).toBe('jan-bakker');
    expect(recorded['predicate']).toBe('works_at');
    expect(recorded['to']).toBe('acme-bv');
    expect(JSON.stringify(recorded)).not.toContain('mutual client');
  });
});
