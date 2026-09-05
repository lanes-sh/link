import { afterEach, describe, expect, test } from 'bun:test';
import { numbered, rule, stripAnsi, truncate, visibleWidth, wrap } from './typeset.ts';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';

const before = new Map(
  (['NO_COLOR', 'FORCE_COLOR'] as const).map((key) => [key, process.env[key]] as const),
);

afterEach(() => {
  for (const [key, value] of before) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const indentOf = (line: string): number => line.match(/^ */)![0].length;

/** Where a numbered line's text starts, past its gutter and its own lead. */
function textColumn(head: string): number {
  const gutter = head.match(/^\s*\d+\s\s/)![0];
  const lead = head.slice(gutter.length).match(/^ */)![0];

  return gutter.length + lead.length;
}

/** The words of a laid-out block, in order, with the colour taken back off. */
const wordsOf = (lines: readonly string[]): string[] =>
  lines
    .flatMap((line) => stripAnsi(line).split(/\s+/))
    .filter((word) => word.length > 0);

describe('measuring', () => {
  test('colour costs nothing, because it occupies nothing', () => {
    expect(visibleWidth('[2mabc[0m')).toBe(3);
  });

  test('a wide character costs two, which String.length gets wrong', () => {
    // `table()` measured with `.length` before this existed, so a CJK label
    // pushed every column after it one place left.
    expect('日本'.length).toBe(2);
    expect(visibleWidth('日本')).toBe(4);
  });

  test('a combining mark costs nothing, because it hangs off its neighbour', () => {
    expect(visibleWidth('é')).toBe(1);
  });

  test('a rule with no room is empty rather than a thrown RangeError', () => {
    expect(rule(0)).toBe('');
    expect(rule(-5)).toBe('');
    expect(rule(3)).toBe('───');
  });
});

describe('wrapping', () => {
  const paragraph =
    'GitHub issues a fine-grained personal access token for this. There is no ' +
    'OAuth app to register, and an app of your own would need a fixed callback port.';

  test('no line is wider than it was told to be', () => {
    for (const width of [40, 60, 80]) {
      for (const line of wrap(paragraph, width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test('nothing is lost and nothing is invented', () => {
    // The property that catches most wrapper bugs on its own.
    expect(wordsOf(wrap(paragraph, 37)).join(' ')).toBe(paragraph);
  });

  test('an embedded newline is a hard break, not a space', () => {
    const lines = wrap('one\ntwo', 80);
    expect(lines).toEqual(['one', 'two']);
  });

  test("a line's own indent carries onto its continuations", () => {
    // Google's steps indent their sub-headings by two. A continuation that
    // returned to column zero would read as a new bullet.
    const lines = wrap('  BRANDING must be filled in before anything else is offered', 30);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith('  ')).toBe(true);
  });

  test('a hanging indent is added on top of that', () => {
    const lines = wrap('alpha beta gamma delta epsilon', 20, { hanging: '>>' });
    expect(lines[0]!.startsWith('>>')).toBe(false);
    for (const line of lines.slice(1)) expect(line.startsWith('>>')).toBe(true);
  });

  test('a word longer than the width is never broken', () => {
    // A broken URL cannot be clicked, and terminals linkify by contiguity.
    const url = 'https://github.com/settings/personal-access-tokens';
    const lines = wrap(`Open ${url} and choose a name`, 20);
    expect(lines.some((line) => stripAnsi(line).includes(url))).toBe(true);
  });

  test('degenerate widths do not throw or loop', () => {
    expect(wrap('', 40)).toEqual(['']);
    expect(() => wrap('a b c', 1)).not.toThrow();
    expect(() => wrap('a b c', 0)).not.toThrow();
    expect(() => wrap('a b c', -10)).not.toThrow();
  });
});

describe('picking things out of prose', () => {
  test('a quoted phrase split across two lines is painted on both halves', () => {
    // The reason colour is decided per word. Wrapping a string that already
    // carries escape codes is how a sequence gets split and leaks onward.
    process.env['NO_COLOR'] = '1';
    const plain = wrap('Choose "Generate a brand new token" now', 24, { highlight: true });
    expect(wordsOf(plain).join(' ')).toBe('Choose "Generate a brand new token" now');
  });

  test('highlighting never changes the words, only their colour', () => {
    const text = 'Run lanes link connect github --replace and open https://example.com now';
    process.env['NO_COLOR'] = '1';
    expect(wrap(text, 30, { highlight: true }).map(stripAnsi).join(' ').split(/\s+/)).toEqual(
      text.split(' '),
    );
  });

  test('a span is painted once, not once per word', () => {
    // Per-word escapes render identically and treble the bytes. A reset
    // between every word is also what makes a piped log unreadable.
    delete process.env['NO_COLOR'];
    process.env['FORCE_COLOR'] = '1';

    const [line] = wrap('Choose "Generate a new token" now', 80, { highlight: true });
    expect([...line!.matchAll(/\u001b\[0m/g)]).toHaveLength(1);
  });

  test('the program name used as a noun is not painted as a command', () => {
    // The tail is greedy over lowercase words, because a command is mostly
    // lowercase words. `A remote lanes link workspace binds to one of these…`
    // came out with seven words of English in link cyan, so position decides:
    // a command is given at the start of a line or after a colon.
    process.env['FORCE_COLOR'] = '1';
    delete process.env['NO_COLOR'];

    const [prose] = wrap('A remote lanes link workspace binds to one of these', 90, {
      highlight: true,
    });

    expect(prose).not.toContain('\u001b');
  });

  test('the same words after a colon, or at the start of a line, are painted', () => {
    process.env['FORCE_COLOR'] = '1';
    delete process.env['NO_COLOR'];

    expect(wrap('run: lanes link connect github --replace', 90, { highlight: true })[0]).toContain(
      '\u001b',
    );
    expect(wrap('  lanes link token issue --me', 90, { highlight: true })[0]).toContain('\u001b');
  });

  test('a span that starts inside a word still paints it', () => {
    // `(https://example.com)` is one word whose first character carries no
    // mark, and keying on index zero left the URL in it unpainted.
    process.env['FORCE_COLOR'] = '1';
    delete process.env['NO_COLOR'];

    expect(wrap('See (https://example.com) now', 90, { highlight: true })[0]).toContain('\u001b');
  });

  test('a value is not prose, so nothing in it is picked out', () => {
    process.env['NO_COLOR'] = '1';
    const [line] = wrap('github/pending', 40);
    expect(line).toBe('github/pending');
  });
});

describe('a numbered walkthrough', () => {
  const steps = [
    'Open the console and choose Generate.',
    'Name it, and set an expiry you are willing to renew, because the name is how ' +
      'you revoke this one later without touching your other tokens.',
  ];

  test('continuations align under the text rather than under the number', () => {
    const lines = numbered(steps, 50).map(stripAnsi);
    const wrapped = lines.filter((line) => !/^\s*\d/.test(line));

    expect(wrapped.length).toBeGreaterThan(0);
    for (const line of wrapped) expect(line.startsWith('     ')).toBe(true);
  });

  test('the gutter grows with the largest number, so a list lines up with itself', () => {
    const many = Array.from({ length: 12 }, (_, index) => `step ${index + 1}`);
    const lines = numbered(many, 60).map(stripAnsi);

    expect(lines[0]).toStartWith('   1  ');
    expect(lines[11]).toStartWith('  12  ');
  });

  test("an embedded line is re-indented under its step, not under column zero", () => {
    // Google's steps indent continuations by seven spaces, a depth chosen for
    // the old fixed four-character gutter. Added to a computed gutter it landed
    // thirteen columns in and read as unrelated to the step above it.
    const [head, ...tail] = numbered(['Enable the APIs:\n       gcloud services enable x'], 60).map(
      stripAnsi,
    );

    // Two columns in from where the step's own text begins, whatever the
    // gutter happens to be — asserting the relationship rather than a column
    // keeps this honest when a list grows past nine entries.
    expect(indentOf(tail[0]!)).toBe(textColumn(head!) + 2);
  });

  test('a sub-item nests below its own lead, not level with its continuations', () => {
    // `  AUDIENCE — …` already sits one level in. Flattening its embedded lines
    // to a fixed two columns would put them level with its wrapped text, which
    // is the difference between a nested paragraph and a wrapped one.
    const [head, ...tail] = numbered(
      ['  AUDIENCE — pick a type\n    INTERNAL, if it is a Workspace'],
      60,
    ).map(stripAnsi);

    expect(tail.at(-1)).toStartWith(' '.repeat(textColumn(head!) + 2) + 'INTERNAL');
  });

  test('no line overflows the width it was given', () => {
    for (const line of numbered(steps, 44)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(44);
    }
  });
});

/**
 * The strongest check here, and the cheapest.
 *
 * Every setup step this repository ships, at every width the renderer can be
 * asked for. It fails the moment somebody adds a provider whose steps the
 * layout cannot handle, which no fixture can promise — and it needs no fixture
 * of its own, because the data is already in the tree.
 */
describe('every step of every provider fits', () => {
  const withSteps = PROVIDER_MANIFESTS.filter((manifest) => (manifest.setup?.steps ?? []).length > 0);

  test('there are some, or the sweep below passed on an empty list', () => {
    expect(withSteps.length).toBeGreaterThan(5);
  });

  test.each([40, 60, 80, 90])('at width %i', (width) => {
    const overflowing: string[] = [];

    for (const manifest of withSteps) {
      for (const line of numbered(manifest.setup!.steps, width)) {
        // A single unbreakable token — a URL, a scope, a service account
        // address — is allowed past the edge. Anything else is a layout bug.
        const words = stripAnsi(line).trim().split(/\s+/);
        if (visibleWidth(line) > width && words.length > 1) {
          overflowing.push(`${manifest.id}: ${stripAnsi(line)}`);
        }
      }
    }

    expect(overflowing).toEqual([]);
  });
});

describe('cutting to a width', () => {
  test('counts columns, not UTF-16 units', () => {
    // `slice` cut a CJK label at the wrong column and could split a surrogate
    // pair, handing the terminal half a character.
    expect(truncate('日本語です', 4)).toBe('日本');
    expect(visibleWidth(truncate('日本語です', 5))).toBeLessThanOrEqual(5);
  });

  test('leaves a string that already fits, and copes with no room', () => {
    expect(truncate('short', 40)).toBe('short');
    expect(truncate('short', 0)).toBe('');
  });
});
