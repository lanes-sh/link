import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { normalize, pieces, split } from './wordpiece.ts';
import { readTable } from './table.ts';

/**
 * The tokenizer agrees with the one the table was built with.
 *
 * This is the assertion the whole vendored table rests on. A static embedding
 * is a lookup keyed by token, so a tokenizer that cuts a word differently
 * returns a real vector for the wrong row — no error, no warning, and a ranking
 * that is quietly worse than it should be. Nothing else in the system would
 * notice.
 *
 * The fixture is the reference implementation's own output, produced by
 * `bench/vendor-vectors.ts --fixture` with Hugging Face's `tokenizers` and
 * committed. Pinned rather than depended upon: the dependency is a native
 * module with a model loader attached, and what it is needed for is thirty
 * lines of expected output that do not change.
 */

const fixture = JSON.parse(
  readFileSync(new URL('./wordpiece-fixture.json', import.meta.url), 'utf8'),
) as { text: string; tokens: string[] }[];

const table = readTable(new URL('./table.lvec', import.meta.url).pathname);
const byRow = new Map([...table.vocabulary].map(([token, row]) => [row, token]));

describe('wordpiece', () => {
  test('the fixture covers the shapes that reach it', () => {
    expect(fixture.length).toBeGreaterThan(20);
  });

  test.each(fixture.map((row, at) => [`${at}: ${row.text.slice(0, 48).replace(/\n/g, ' ')}`, row] as const))(
    '%s',
    (_name, row) => {
      const got = pieces(row.text, table.vocabulary).map((index) => byRow.get(index));
      expect(got).toEqual(row.tokens);
    },
  );

  /**
   * An identifier is where this differs from a tokenizer meant for prose, and
   * where it matters most: the text being searched is mostly identifiers.
   */
  test('punctuation separates rather than disappearing', () => {
    expect(split('users.messages.list')).toEqual(['users', '.', 'messages', '.', 'list']);
    expect(split('me.todo.lists.ListTasks')).toEqual(['me', '.', 'todo', '.', 'lists', '.', 'listtasks']);
  });

  test('accents come off and case goes down, as the checkpoint expects', () => {
    expect(normalize('Café RÉSUMÉ')).toBe('cafe resume');
  });

  test('tabs and newlines are whitespace, not lost characters', () => {
    expect(split('send an\temail\nnow')).toEqual(['send', 'an', 'email', 'now']);
  });

  /**
   * A blob is one word the vocabulary has no cut for. The reference gives up
   * rather than emit a letter per character, and so does this — otherwise a
   * base64 attachment in a description would contribute thirty tokens of noise
   * to that capability's vector.
   */
  test('a word too long to cut contributes nothing', () => {
    expect(pieces('x'.repeat(200), table.vocabulary)).toEqual([]);
  });

  test('an empty query addresses no rows', () => {
    expect(pieces('   ', table.vocabulary)).toEqual([]);
  });
});
