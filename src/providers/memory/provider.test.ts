import { describe, expect, test } from 'bun:test';
import { isResourceListResult, isResourceResult, isToolResult } from '#connectivity';
import { memoryProvider } from './provider.ts';
import { harnessFor, linksOf, textOf } from '../harness.ts';

/**
 * Memory.
 *
 * The property this file exists to hold is that **reading and writing are
 * different capabilities** — see the ADR-012 §2 tests at the bottom, and the
 * end-to-end denial in `apps/server/src/owner.test.ts`. The rest is ordinary
 * provider behaviour, plus the storage shape ADR-014 settled: one Markdown file
 * per entry, its metadata in frontmatter, and no index row anywhere.
 */

function memory() {
  return harnessFor(memoryProvider);
}

async function write(
  harness: ReturnType<typeof memory>,
  title: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return harness.invoke('write', { title, text, ...extra });
}

describe('storing and retrieving an entry', () => {
  test('a write is addressable as a resource', async () => {
    const harness = memory();
    await write(harness, 'Standup notes', 'We ship on Friday.');

    const read = await harness.invoke('entry', { uri: 'memory://entry/standup-notes' });

    expect(isResourceResult(read)).toBe(true);
    expect(textOf(read)).toBe('We ship on Friday.');
  });

  test('the id derives from the title, and may be given instead', async () => {
    const harness = memory();
    await write(harness, 'A Long: Title!', 'x');
    await write(harness, 'Anything', 'y', { id: 'chosen' });

    expect(textOf(await harness.invoke('entry', { uri: 'memory://entry/a-long-title' }))).toBe('x');
    expect(textOf(await harness.invoke('entry', { uri: 'memory://entry/chosen' }))).toBe('y');
  });

  test('writing the same id again replaces the entry', async () => {
    const harness = memory();
    await write(harness, 'Note', 'first', { id: 'note' });
    await write(harness, 'Note', 'second', { id: 'note' });

    expect(textOf(await harness.invoke('entry', { uri: 'memory://entry/note' }))).toBe('second');
    expect(isResourceListResult(await harness.invoke('entry'))).toBe(true);
    const listed = await harness.invoke('entry');
    expect(isResourceListResult(listed) && listed.resources).toHaveLength(1);
  });

  test('an entry is one Markdown file, and nothing else — ADR-014', async () => {
    // The index row this used to keep beside the body is gone. It bought a
    // cheaper listing with a second copy of the truth that could disagree with
    // the file it described, and that the owner could not edit.
    const harness = memory();
    await write(harness, 'Note', 'the body text', { id: 'note', tags: ['ops'] });

    expect((await harness.context.storage.list()).map((blob) => blob.key)).toEqual([
      'note.md',
    ]);
    expect(await harness.context.state.keys()).toEqual([]);

    const stored = new TextDecoder().decode((await harness.context.storage.get('note.md'))!);
    expect(stored).toBe(
      `---\ntitle: Note\ntags:\n  - ops\nupdated_at: ${
        stored.match(/updated_at: (\S+)/)![1]
      }\n---\n\nthe body text\n`,
    );
  });

  test('a file the owner wrote by hand is an entry, frontmatter or not', async () => {
    // The whole reason for one file per entry: `<workspace>` is a directory a
    // person is invited to open. A plain Markdown file dropped in there must
    // read as an entry rather than break the listing that would have shown it.
    const harness = memory();
    await harness.context.storage.put(
      'by-hand.md',
      new TextEncoder().encode('Just some notes.'),
    );

    expect(textOf(await harness.invoke('get', { id: 'by-hand' }))).toBe('Just some notes.');

    const listed = await harness.invoke('entry');
    expect(isResourceListResult(listed) && listed.resources).toEqual([
      { uri: 'memory://entry/by-hand', name: 'by-hand' },
    ]);
  });

  test('an edit made in an editor is what the next read returns', async () => {
    const harness = memory();
    await write(harness, 'Note', 'first', { id: 'note' });

    await harness.context.storage.put(
      'note.md',
      new TextEncoder().encode(`---\ntitle: Renamed\n---\n\nedited outside\n`),
    );

    expect(textOf(await harness.invoke('get', { id: 'note' }))).toBe('edited outside');
    const listed = await harness.invoke('entry');
    expect(isResourceListResult(listed) && listed.resources[0]?.name).toBe('Renamed');
  });

  test('a missing entry is an error, not empty contents', async () => {
    const harness = memory();
    await expect(harness.invoke('entry', { uri: 'memory://entry/absent' })).rejects.toThrow(
      /No memory entry "absent"/,
    );
  });

  test('an id that policy could not name is refused', async () => {
    const harness = memory();
    await expect(write(harness, 'x', 'y', { id: 'Not Valid' })).rejects.toThrow(/must be lowercase/);
  });
});

describe('listing', () => {
  test('enumerates entries newest first, with their titles', async () => {
    const harness = memory();
    await write(harness, 'Older', 'a', { id: 'older' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await write(harness, 'Newer', 'b', { id: 'newer' });

    const listed = await harness.invoke('entry');

    expect(isResourceListResult(listed) && listed.resources).toEqual([
      { uri: 'memory://entry/newer', name: 'Newer' },
      { uri: 'memory://entry/older', name: 'Older' },
    ]);
  });
});

describe('search', () => {
  test('matches the body, and says where', async () => {
    const harness = memory();
    await write(harness, 'Standup', 'The deploy window is Thursday evening.', { id: 'standup' });

    const found = await harness.invoke('search', { query: 'thursday' });

    // A link rather than a URI spelled into the text: core routes it to the
    // profile and connection, which a provider must not learn.
    expect(linksOf(found)).toEqual(['memory://entry/standup']);
    expect(textOf(found)).toContain('Thursday evening');
  });

  test('matches a title or a tag without reading any body', async () => {
    const harness = memory();
    await write(harness, 'Deploy runbook', 'unrelated content', { id: 'r', tags: ['ops'] });

    expect(linksOf(await harness.invoke('search', { query: 'runbook' }))).toEqual([
      'memory://entry/r',
    ]);
    expect(linksOf(await harness.invoke('search', { query: 'ops' }))).toEqual(['memory://entry/r']);
  });

  test('a tag filter narrows before matching', async () => {
    const harness = memory();
    await write(harness, 'One', 'shared word', { id: 'one', tags: ['ops'] });
    await write(harness, 'Two', 'shared word', { id: 'two', tags: ['personal'] });

    const found = linksOf(await harness.invoke('search', { query: 'shared', tag: 'ops' }));

    expect(found).toEqual(['memory://entry/one']);
  });

  test('no match says so rather than returning nothing', async () => {
    const harness = memory();
    await write(harness, 'One', 'content', { id: 'one' });

    expect(textOf(await harness.invoke('search', { query: 'absent' }))).toContain('No memory entry');
  });

  test('records what it scanned, since the cost is a full scan', async () => {
    // Stated in the audit annotation rather than implied: the metadata a search
    // needs is inside each document, so there is nothing cheaper to consult
    // than reading all of them.
    const harness = memory();
    await write(harness, 'One', 'a', { id: 'one' });
    await write(harness, 'Two', 'b', { id: 'two' });

    await harness.invoke('search', { query: 'a' });

    expect(harness.annotations()['scanned']).toBe(2);
  });

  test('honours its limit', async () => {
    const harness = memory();
    for (const index of [1, 2, 3]) await write(harness, `N${index}`, 'match', { id: `n${index}` });

    const found = await harness.invoke('search', { query: 'match', limit: 2 });

    expect(linksOf(found)).toHaveLength(2);
  });
});

describe('forgetting', () => {
  test('removes the file', async () => {
    const harness = memory();
    await write(harness, 'Note', 'content', { id: 'note' });

    expect(textOf(await harness.invoke('forget', { id: 'note' }))).toContain('Forgot');
    expect(await harness.context.storage.list()).toEqual([]);
  });

  test('forgetting what is not there is an error, not a silent success', async () => {
    const harness = memory();
    const result = await harness.invoke('forget', { id: 'absent' });

    expect(isToolResult(result) && result.isError).toBe(true);
  });
});

describe('reading and writing are separate capabilities — ADR-012 §2', () => {
  // An injected instruction written once is re-served to every future session,
  // including to a different agent. A read-only memory cannot do that, which is
  // why the write half has its own ids and its own bundle.
  const names = memoryProvider.capabilities.map((capability) => capability.name);
  const bundles = memoryProvider.manifest.bundles ?? [];

  test('write and forget are distinct ids from every read', () => {
    expect(names).toContain('write');
    expect(names).toContain('forget');
    expect(names).toContain('search');
    expect(names).toContain('entry');
  });

  test('they are not in the default bundle', () => {
    const fallback = bundles.find((bundle) => bundle.default) ?? bundles[0];

    expect(fallback?.name).toBe('read');
    expect(fallback?.capabilities).not.toContain('write');
    expect(fallback?.capabilities).not.toContain('forget');

    const writeBundle = bundles.find((bundle) => bundle.name === 'write');
    expect(writeBundle?.capabilities.sort()).toEqual(['forget', 'write']);
  });
});

describe('what reaches the audit log', () => {
  test('an entry body is never a recorded argument', () => {
    const write = memoryProvider.capabilities.find((capability) => capability.name === 'write')!;
    const redacted = write.redact!({ title: 'T', text: 'the secret body', tags: ['a'] });

    expect(redacted['title']).toBe('T');
    expect(redacted['text']).toBe('<string:15>');
    expect(JSON.stringify(redacted)).not.toContain('the secret body');
  });

  test('a search query is kept, because it is the question rather than the answer', () => {
    const search = memoryProvider.capabilities.find((capability) => capability.name === 'search')!;
    const redacted = search.redact!({ query: 'salary review', tag: 'work', limit: 10 });

    // What an agent went looking for is the thing this log exists to answer.
    // Withheld, every search read alike and a calendar lookup could not be told
    // from a rummage through someone's medical notes.
    expect(redacted['query']).toBe('salary review');
    expect(redacted['tag']).toBe('work');
  });

  test('keeping the query does not start keeping what it found', () => {
    // The pairing is the whole argument for the line above: the question is
    // recorded and the answer is not. `entry` and `get` keep an address and an
    // id, and no capability on this provider keeps a body.
    const bodies = memoryProvider.capabilities
      .filter((capability) => capability.name === 'entry' || capability.name === 'get')
      .map((capability) => capability.redact!({ uri: 'memory://entry/x', id: 'x', body: 'secret' }));

    for (const redacted of bodies) expect(redacted['body']).toBe('<string:6>');
  });

  test('a resource read records its address but not its contents', () => {
    const entry = memoryProvider.capabilities.find((capability) => capability.name === 'entry')!;

    expect(entry.redact!({ uri: 'memory://entry/standup' })['uri']).toBe('memory://entry/standup');
  });
});
