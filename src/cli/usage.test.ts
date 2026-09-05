import { describe, expect, test } from 'bun:test';
import { visibleWidth } from './typeset.ts';
import { PROGRAM, usage } from './usage.ts';
import { SECTIONS } from './usage-data.ts';

/**
 * The help text, now that it is rendered rather than typed.
 *
 * What is worth asserting changed with it. Nothing here checks wording — that
 * is what the data file is for, and a test repeating it would be a second copy
 * to keep in step. What these hold is that the layout survives a terminal of any
 * width, and that a description cannot come adrift from its command again.
 */

describe('the help fits the terminal it is asked on', () => {
  test.each([40, 60, 80, 100, 120])('at width %i', (measure) => {
    const overflowing = usage(measure)
      .split('\n')
      // A single unbreakable token is allowed past the edge, the same exception
      // the wrapper makes: `memory/tasks/assets/skills/vault/entities` is
      // forty-one characters and breaking it would invent a word.
      .filter((line) => visibleWidth(line) > measure && line.trim().split(/\s+/).length > 1);

    expect(overflowing).toEqual([]);
  });

  test('a wider terminal is actually used', () => {
    // The old text was one fixed string, so eighty columns of a hundred-and-
    // twenty-column terminal went to waste and a seventy-column one shredded it.
    const narrow = usage(60).split('\n').length;
    const wide = usage(120).split('\n').length;

    expect(wide).toBeLessThan(narrow);
  });
});

describe('what the two parsing tests depend on', () => {
  // `argv.test.ts` and `instructions.test.ts` read this string to find every
  // command the CLI documents. Both rules are now the renderer's to keep rather
  // than something a person maintains by counting spaces, so they are asserted
  // here as well as relied on there.
  const lines = usage(80).split('\n');

  test('a command sits at exactly two spaces, and nothing else does', () => {
    const entries = lines.filter((line) => /^ {2}\w/.test(line));

    expect(entries.length).toBeGreaterThan(20);
    for (const line of entries) expect(line.trimStart()).toStartWith(PROGRAM);
  });

  test('no description line can be mistaken for a command', () => {
    for (const line of lines) {
      if (line.trim() === '') continue;
      const indent = line.length - line.trimStart().length;

      // Three shapes, and only three: a section title at column zero, an entry
      // at two, or anything belonging to an entry indented past it. Two is the
      // load-bearing one — an entry there is either a command, which must be
      // spelled with PROGRAM, or a flag, which begins with a dash and is
      // therefore not matched by the `^ {2}\w` both parsing tests use.
      if (indent === 0 || indent >= 4) continue;

      expect(indent).toBe(2);
      expect(line.trimStart().startsWith(PROGRAM) || line.trimStart().startsWith('-')).toBe(true);
    }
  });
});

describe('a description stays with its command', () => {
  test('--non-interactive describes itself, not the entry four rows below it', () => {
    // The defect the restructure exists to make impossible. These two lines were
    // indented to column 40 and sat under `connect custom`, because that entry
    // was inserted between them and the flag they belong to. They read as part
    // of its description for as long as the text was hand-aligned.
    const entry = SECTIONS.flatMap((section) => section.entries).find((candidate) =>
      candidate.command.includes('--non-interactive'),
    );

    expect(entry?.description).toContain('answer nothing from a terminal');

    const custom = SECTIONS.flatMap((section) => section.entries).find((candidate) =>
      candidate.command.startsWith('connect custom'),
    );

    expect(custom?.description).not.toContain('answer nothing from a terminal');
  });

  test('every entry carries its own command, and none is empty', () => {
    for (const section of SECTIONS) {
      expect(section.entries.length).toBeGreaterThan(0);
      for (const entry of section.entries) expect(entry.command.trim()).not.toBe('');
    }
  });
});

describe('the layout the review found', () => {
  test('a description is never set against a wrapped command\'s last fragment', () => {
    // `  lanes link deploy --workspace <name>` / `    [--dry-run]  set up, build…`
    // read as the description of `[--dry-run]` rather than of the entry.
    for (const measure of [40, 60, 80, 90]) {
      const lines = usage(measure).split('\n');

      for (const [index, line] of lines.entries()) {
        // A continuation of a wrapped command: indented past an entry, and
        // still part of the invocation rather than prose.
        if (!/^ {4}[[<-]/.test(line)) continue;
        const previous = lines[index - 1] ?? '';
        if (!previous.startsWith('  lanes link')) continue;

        // No run of two or more spaces inside the content: that gap is what a
        // description set beside it would look like.
        const body = line.trimEnd().replace(/^ +/, '');
        expect(body).toBe(body.split(/ {2,}/)[0] ?? '');
      }
    }
  });

  test('a narrow terminal stacks instead of wasting half of itself', () => {
    // At sixty the column landed at thirty and left thirty for the text, so
    // most entries printed a paragraph in a half-width gutter.
    const narrow = usage(60).split('\n').filter((line) => line.startsWith('    '));

    expect(narrow.length).toBeGreaterThan(20);
    for (const line of narrow) expect(line.startsWith('     ')).toBe(false);
  });

  test('the owner surfaces are grouped, not one run of forty', () => {
    const lines = usage(80).split('\n');
    const at = lines.findIndex((line) => line.startsWith('  lanes link tasks list'));

    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe('');
  });

  test('deploy --access carries a description rather than swallowing it', () => {
    const entry = SECTIONS.flatMap((section) => section.entries).find((candidate) =>
      candidate.command.startsWith('deploy --access'),
    );

    expect(entry?.command).toBe('deploy --access iam|public');
    expect(entry?.description).toContain('who gets past');
  });
});
