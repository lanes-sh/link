import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileAdd } from '../commands/profile.ts';
import { openRuntime, type Runtime } from '../runtime.ts';
import { dataSurface } from './index.ts';
import { listItems, readItem } from './browse.ts';
import { createItem, removeItem, writeItem } from './edit.ts';

/**
 * The data surface, against a real workspace on disk.
 *
 * Plain function calls over a temp `LANES_LINK_HOME`, not the HTTP surface:
 * what is being asserted here is that a write lands where the *provider* reads,
 * which is the failure a route test cannot see. `src/server/read/data.test.ts`
 * covers the transport.
 *
 * A profile created by `profileAdd` arrives with the whole owner layer granted
 * (ADR-050), which is what makes `storeFor` resolve without any further setup.
 */

let home: string;
let runtime: Runtime;

const MEMORY = ['---', 'title: A first note', 'tags:', '  - inbox', '---', '', 'The body.'].join('\n');

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'lanes-data-'));
  process.env['LANES_LINK_HOME'] = home;

  // `profileAdd` writes its JSON to the stdout the reporter uses.
  const write = process.stdout.write.bind(process.stdout);
  try {
    (process.stdout as unknown as { write: () => boolean }).write = (): boolean => true;
    await profileAdd('personal', { targets: ['local'], nonInteractive: true, json: true });
  } finally {
    (process.stdout as unknown as { write: typeof write }).write = write;
  }

  runtime = await openRuntime({ profile: 'personal', target: 'local' });
});

afterAll(async () => {
  await runtime?.close();
  delete process.env['LANES_LINK_HOME'];
  await rm(home, { recursive: true, force: true });
});

describe('memory', () => {
  test('a write round-trips through the store the provider reads', async () => {
    const written = await writeItem(runtime, 'memory', 'a-first-note', MEMORY);
    expect(written.ok).toBe(true);

    // Read back through `readItem`, which goes via `memoryStorage` — the same
    // object `lanes_memory.get` and `lanes link memory get` read through.
    const read = await readItem(runtime, 'memory', 'a-first-note');
    if (!read.ok) throw new Error(read.refusal.message);

    expect(read.value.title).toBe('A first note');
    expect(read.value.tags).toEqual(['inbox']);
    expect(read.value.body).toBe(MEMORY);
  });

  test('a listing shows it, and a query that misses does not', async () => {
    await writeItem(runtime, 'memory', 'a-first-note', MEMORY);

    const all = await listItems(runtime, 'memory', {});
    if (!all.ok) throw new Error(all.refusal.message);
    expect(all.value.map((one) => one.id)).toContain('a-first-note');

    const miss = await listItems(runtime, 'memory', { query: 'nothing-matches-this' });
    if (!miss.ok) throw new Error(miss.refusal.message);
    expect(miss.value).toEqual([]);
  });

  test('a removal takes it out, and removing it twice is not found', async () => {
    await writeItem(runtime, 'memory', 'to-forget', MEMORY);
    expect((await removeItem(runtime, 'memory', 'to-forget')).ok).toBe(true);

    const again = await removeItem(runtime, 'memory', 'to-forget');
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal.status).toBe(404);
  });
});

describe('entities', () => {
  const ENTITY = ['---', 'type: person', 'name: Ada', 'aliases:', '  - ada', '---', '', 'Notes.'].join(
    '\n',
  );

  test('a write leaves the derived index describing the store', async () => {
    const written = await writeItem(runtime, 'entities', 'ada', ENTITY);
    expect(written.ok).toBe(true);

    // `persistEntity` rather than a bare put is the whole point: the index is
    // a cache stamped with a fingerprint of the entity files, and a write that
    // skipped it would leave every later read rebuilding.
    const { indexState } = await import('#providers/entities/catalogue.ts');
    const { storeFor } = await import('./stores.ts');
    const scoped = storeFor(runtime, 'entities');
    if (!scoped.ok) throw new Error(scoped.refusal.message);

    expect((await indexState(scoped.value.store)).current).toBe(true);
  });

  test('a removal leaves the index current too', async () => {
    await writeItem(runtime, 'entities', 'to-drop', ENTITY);
    expect((await removeItem(runtime, 'entities', 'to-drop')).ok).toBe(true);

    const { indexState } = await import('#providers/entities/catalogue.ts');
    const { storeFor } = await import('./stores.ts');
    const scoped = storeFor(runtime, 'entities');
    if (!scoped.ok) throw new Error(scoped.refusal.message);

    expect((await indexState(scoped.value.store)).current).toBe(true);
  });
});

describe('skills', () => {
  test('a document with no description is refused, and nothing is written', async () => {
    const refusal = await writeItem(runtime, 'skills', 'broken', '---\ntitle: no description\n---\n\nBody.');

    expect(refusal.ok).toBe(false);
    // A `400` carrying the parser's own message, not the surface's one error.
    // "not paired" for a bad `description:` would send somebody to re-run a
    // pairing command that was never the problem.
    if (!refusal.ok) expect(refusal.refusal.status).toBe(400);

    expect((await readItem(runtime, 'skills', 'broken')).ok).toBe(false);
  });

  test('a valid skill round-trips whole, frontmatter included', async () => {
    const document = ['---', 'description: Review a diff.', '---', '', 'Read the diff.'].join('\n');
    expect((await writeItem(runtime, 'skills', 'review-diff', document)).ok).toBe(true);

    const read = await readItem(runtime, 'skills', 'review-diff');
    if (!read.ok) throw new Error(read.refusal.message);
    expect(read.value.body).toContain('description: Review a diff.');
    expect(read.value.summary).toBe('Review a diff.');
  });
});

describe('the vault', () => {
  test('lists by name and never carries a value', async () => {
    await runtime.vault.put('lan1', { id: 'api_key', value: 'secret-value', description: 'A key' });

    const listed = await listItems(runtime, 'vault', {});
    if (!listed.ok) throw new Error(listed.refusal.message);

    const row = listed.value.find((one) => one.id === 'api_key');
    expect(row?.summary).toBe('A key');
    expect(JSON.stringify(listed.value)).not.toContain('secret-value');
  });

  test('opens, says why the value is not here, and refuses every write', async () => {
    await runtime.vault.put('lan1', { id: 'api_key', value: 'secret-value' });

    const read = await readItem(runtime, 'vault', 'api_key');
    if (!read.ok) throw new Error(read.refusal.message);
    expect(read.value.body).toBeNull();
    expect(read.value.readOnly).toContain('never returned to a browser');
    expect(JSON.stringify(read.value)).not.toContain('secret-value');

    // Not `405`, and not a message naming the vault: the same answer an
    // unroutable path gets, so nothing is confirmed to a page that is not the
    // dashboard (ADR-069).
    for (const attempt of [
      await writeItem(runtime, 'vault', 'api_key', 'anything'),
      await removeItem(runtime, 'vault', 'api_key'),
      await createItem(runtime, 'vault', '---\ntitle: x\n---\n'),
    ]) {
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.refusal.status).toBe(404);
    }
  });
});

describe('creating', () => {
  test('derives the id from the document rather than taking one', async () => {
    const created = await createItem(
      runtime,
      'memory',
      '---\ntitle: Derived From Title\n---\n\nBody.',
    );
    if (!created.ok) throw new Error(created.refusal.message);

    expect(created.value.id).toBe('derived-from-title');
  });

  test('refuses a document with no title to derive one from', async () => {
    const refusal = await createItem(runtime, 'memory', 'No frontmatter at all.');
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.refusal.status).toBe(400);
  });
});

describe('the surface a route holds', () => {
  test('a profile this endpoint does not serve is not found', async () => {
    const surface = dataSurface(() => new Map([['personal', runtime]]));

    const answer = await surface.list({ profile: 'work', store: 'memory' });
    expect(answer.ok).toBe(false);
    // Not "no such profile". A caller who may not read `/state` learns nothing
    // about which profiles exist.
    if (!answer.ok) expect(answer.refusal).toEqual({
      status: 404,
      error: 'not_found',
      message: 'Not found.',
    });
  });

  test('reads through the generation it is asked at, not the one it was built with', async () => {
    let current = new Map<string, Runtime>();
    const surface = dataSurface(() => current);

    expect((await surface.list({ profile: 'personal', store: 'memory' })).ok).toBe(false);

    current = new Map([['personal', runtime]]);
    expect((await surface.list({ profile: 'personal', store: 'memory' })).ok).toBe(true);
  });
});

describe('the audit log', () => {
  test('records a write with the identifiers and without the document', async () => {
    const body = '---\ntitle: Logged\n---\n\nA sentence that must not be in the log.';
    await writeItem(runtime, 'memory', 'logged', body);

    const events = await runtime.audit.tail({ limit: 50 });
    const written = events.filter((event) => event.capability === 'memory.write');
    expect(written.length).toBeGreaterThan(0);

    const last = written[written.length - 1]!;
    expect(last.provider).toBe('lanes_memory');
    expect(last.principal).toBe('lanes:dashboard');
    expect(last.arguments).toMatchObject({ id: 'logged', store: 'memory' });
    expect(JSON.stringify(last.arguments)).not.toContain('must not be in the log');
  });

  test('records a removal under the capability an agent would have called', async () => {
    await writeItem(runtime, 'memory', 'logged-removal', MEMORY);
    await removeItem(runtime, 'memory', 'logged-removal');

    const events = await runtime.audit.tail({ limit: 50 });
    expect(events.some((event) => event.capability === 'memory.forget')).toBe(true);
  });
});

describe('ordering', () => {
  test('every store answers most recently touched first', async () => {
    // Written oldest first, so passing this cannot be an accident of insertion
    // order or of the store's own listing. The marker in each title is what the
    // query narrows on, so entries written by the blocks above cannot join in.
    for (const [id, when] of [
      ['ordercheck-older', '2026-01-01T00:00:00.000Z'],
      ['ordercheck-newest', '2026-06-01T00:00:00.000Z'],
      ['ordercheck-middle', '2026-03-01T00:00:00.000Z'],
    ] as const) {
      await writeItem(
        runtime,
        'memory',
        id,
        `---\ntitle: ${id}\nupdated_at: ${when}\n---\n\nBody.`,
      );
    }

    const listed = await listItems(runtime, 'memory', { query: 'ordercheck-' });
    if (!listed.ok) throw new Error(listed.refusal.message);

    expect(listed.value.map((one) => one.id)).toEqual([
      'ordercheck-newest',
      'ordercheck-middle',
      'ordercheck-older',
    ]);
  });

  test('a task list here is ordered by recency, not by what to do next', async () => {
    // `compareTasks` ranks by status and would put the done task last. That rule
    // is right for `lanes link tasks list` and wrong for a browser, which is
    // asked "what changed" rather than "what next" — and the status is on the
    // row either way.
    await writeItem(
      runtime,
      'tasks',
      'ordercheck-done',
      '---\ntitle: ordercheck done recently\nstatus: done\nupdated_at: 2026-06-01T00:00:00.000Z\n---\n\nx',
    );
    await writeItem(
      runtime,
      'tasks',
      'ordercheck-open',
      '---\ntitle: ordercheck open long ago\nstatus: open\nupdated_at: 2026-01-01T00:00:00.000Z\n---\n\nx',
    );

    const listed = await listItems(runtime, 'tasks', { query: 'ordercheck' });
    if (!listed.ok) throw new Error(listed.refusal.message);

    expect(listed.value.map((one) => one.id)).toEqual(['ordercheck-done', 'ordercheck-open']);
  });

  test('an item with no timestamp sorts last, and by name', async () => {
    // Skills carry no `updated_at`. Absent is unknown rather than new, so they
    // fall back to the name their column actually shows.
    for (const name of ['zeta-ordercheck', 'alpha-ordercheck']) {
      await writeItem(runtime, 'skills', name, `---\ndescription: ${name}.\n---\n\nBody.`);
    }

    const listed = await listItems(runtime, 'skills', { query: 'ordercheck' });
    if (!listed.ok) throw new Error(listed.refusal.message);

    expect(listed.value.map((one) => one.id)).toEqual(['alpha-ordercheck', 'zeta-ordercheck']);
  });
});
