import { describe, expect, test } from 'bun:test';
import { CORPUS } from '../bench-corpus.ts';
import { buildIndex, embedQuery, nearness, table } from './index.ts';
import { embed, readTable, similarity } from './table.ts';

/**
 * What the embedding half is for, asserted rather than assumed.
 *
 * The benchmark says the ranking got better; these say *why* it got better, so
 * a regression can be attributed to something. Each one is a property the
 * lexical scoring cannot have: two texts that share no word are near each
 * other, and two that share several are not necessarily.
 */

const loaded = table();
if (!loaded) throw new Error('the vendored table is missing — the package is incomplete');

const index = buildIndex(CORPUS);
if (!index) throw new Error('no index');

function near(a: string, b: string): number {
  const first = embed(a, loaded as NonNullable<typeof loaded>);
  const second = embed(b, loaded as NonNullable<typeof loaded>);
  if (!first || !second) throw new Error(`nothing to embed: ${a} / ${b}`);
  return similarity(first, second);
}

describe('the vendored table', () => {
  test('is the shape it was published as', () => {
    expect(loaded?.dims).toBe(128);
    expect(loaded?.vocabulary.size).toBeGreaterThan(29_000);
    expect(loaded?.weights.length).toBe((loaded?.vocabulary.size ?? 0) * (loaded?.dims ?? 0));
  });

  test('reading it twice gives the same numbers', () => {
    const again = readTable(new URL('./table.lvec', import.meta.url).pathname);
    expect(again.dims).toBe(loaded?.dims);
    expect([...again.weights.slice(0, 64)]).toEqual([...(loaded?.weights.slice(0, 64) ?? [])]);
  });

  test('every vector it produces is a unit vector', () => {
    for (const text of ['latest email in inbox', 'users.messages.list', 'pay someone']) {
      const vector = embed(text, loaded as NonNullable<typeof loaded>);
      expect(vector).toBeDefined();
      const magnitude = Math.sqrt([...(vector as Float32Array)].reduce((sum, v) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 4);
    }
  });

  test('a text with no words it knows has no direction', () => {
    expect(embed('   ', loaded as NonNullable<typeof loaded>)).toBeUndefined();
  });
});

describe('meaning, where words fail', () => {
  /**
   * The pairs that motivated this. Not one of them shares a word, and each is
   * a real vendor/person mismatch taken from the corpus: a mailbox is an inbox,
   * a task is a todo, a subreddit is a community.
   */
  test.each([
    ['inbox', 'mailbox'],
    ['todo', 'task'],
    ['meeting', 'appointment'],
    ['community', 'subreddit'],
    ['document', 'file'],
    ['money owed', 'payment'],
  ])('"%s" is nearer "%s" than an unrelated word', (a, b) => {
    expect(near(a, b)).toBeGreaterThan(near(a, 'permission'));
  });

  test('a whole question lands nearer the operation that answers it', () => {
    const asked = embedQuery('what meetings do i have', index as NonNullable<typeof index>);
    expect(asked).toBeDefined();

    const answer = nearness(asked as Float32Array, index!.entries.get('agenda.events.list')!);
    const wrong = nearness(asked as Float32Array, index!.entries.get('ledger.List_all_User')!);
    expect(answer).toBeGreaterThan(wrong);
  });
});

describe('the index', () => {
  test('holds a vector for every capability it was given', () => {
    expect(index?.entries.size).toBe(CORPUS.size);
  });

  /**
   * Two vectors rather than one, and the reason is measurable: a provider's
   * keywords are appended to every one of its descriptions identically, so the
   * prose of two of its operations is nearly the same point. The names are not.
   */
  test('the name separates siblings the prose cannot', () => {
    const list = index!.entries.get('postbox.users.messages.list')!;
    const drafts = index!.entries.get('postbox.users.drafts.list')!;

    const byProse = similarity(list.prose as Float32Array, drafts.prose as Float32Array);
    const byName = similarity(list.name as Float32Array, drafts.name as Float32Array);
    expect(byName).toBeLessThan(byProse);
  });
});
