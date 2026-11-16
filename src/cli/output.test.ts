import { afterEach, describe, expect, test } from 'bun:test';
import { divider, heading, printable, prose, steps, waiting } from './output.ts';
import { stripAnsi, visibleWidth } from './typeset.ts';

/**
 * The wait indicator, minus the part you have to look at.
 *
 * What it draws needs a terminal and an eye. What it must not do is testable and
 * is the half that breaks things: a wait sits between the command and its next
 * prompt, so anything it swallows or leaks running is a hang with no output to
 * explain it. A test run has no TTY, which exercises the plain branch — the
 * animated one differs only in what reaches stderr.
 */

describe('waiting', () => {
  test('returns what the work returned', async () => {
    expect(await waiting('checking', async () => 'answer')).toBe('answer');
  });

  test('propagates a failure instead of swallowing it into a hang', async () => {
    // The `finally` that stops the animation must not become a `catch`.
    await expect(waiting('checking', async () => Promise.reject(new Error('gcloud died')))).rejects.toThrow(
      'gcloud died',
    );
  });

  test('does not outlive the work it describes', async () => {
    // The interval is unref'd, but a leaked *reference* is still a redraw
    // scribbling over whatever the command printed next. Settling before the
    // next write is the property that matters.
    const before = Date.now();
    await waiting('checking', async () => Bun.sleep(30));

    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
  });
});


/**
 * The block renderers, asserted on structure rather than on wording.
 *
 * A snapshot of a heading and seven steps would be rewritten by every copy edit
 * to a provider manifest, and would then be re-approved without being read —
 * which is a test that costs maintenance and catches nothing. What is worth
 * holding is that a line fits, that a rule reaches the edge, and that a
 * continuation lands under the text.
 */
describe('blocks', () => {
  const COLUMNS = process.env['COLUMNS'];

  afterEach(() => {
    if (COLUMNS === undefined) delete process.env['COLUMNS'];
    else process.env['COLUMNS'] = COLUMNS;
  });

  /** What a renderer wrote, with the colour taken back off. */
  function captured(render: (to: (line?: string) => void) => void): string[] {
    const lines: string[] = [];
    render((line = '') => lines.push(stripAnsi(line)));
    return lines;
  }

  test('a heading is a blank line, the title, and a rule out to the width', () => {
    process.env['COLUMNS'] = '41';
    const [blank, titled] = captured((to) => heading('Endpoint', to));

    expect(blank).toBe('');
    expect(titled).toStartWith('Endpoint ─');
    expect(visibleWidth(titled!)).toBe(40);
  });

  test('a heading with no room for a rule is still a heading', () => {
    process.env['COLUMNS'] = '41';
    const [, titled] = captured((to) => heading('x'.repeat(60), to));

    expect(titled).toBe('x'.repeat(60));
  });

  test('a divider reaches the width and nothing more', () => {
    process.env['COLUMNS'] = '51';
    const [line] = captured((to) => divider(to));

    expect(visibleWidth(line!)).toBe(50);
  });

  test('prose wraps to the terminal; print would not have', () => {
    process.env['COLUMNS'] = '41';
    const long = 'There is no OAuth app to register, and one of your own would need a fixed port.';
    const lines = captured((to) => prose(long, { to }));

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    expect(lines.join(' ')).toBe(long);
  });

  test('steps put continuations under the text, not under the number', () => {
    process.env['COLUMNS'] = '41';
    const lines = captured((to) =>
      steps(['short', 'a step long enough that it has to be broken across two lines'], to),
    );

    expect(lines[0]).toStartWith('  1  ');
    expect(lines.at(-1)).toStartWith('     ');
  });
});

/**
 * Text from outside, on a terminal an operator is reading to make a decision.
 *
 * An OAuth `client_name` arrives through unauthenticated registration, and
 * `session list` prints it next to the subject somebody is deciding whether to
 * cut off. These are the sequences that move the cursor rather than colour it.
 */
describe('printable', () => {
  test('cursor movement cannot erase or redraw the rows around it', () => {
    // `2J` clears the screen and `A` walks up it. Either turns a listing into a
    // place to hide a row, which is worse than having no listing.
    expect(printable('Desktop\u001b[2J\u001b[A\u001b[AEvil')).toBe('Desktop?[2J?[A?[AEvil');
  });

  test('a carriage return cannot overwrite the line it is on', () => {
    // The cheapest version of the same trick, and the one `stripAnsi` would
    // leave untouched: it removes colour, which is not what moves a cursor.
    expect(printable('real\r        fake')).toBe('real?        fake');
  });

  test('the bell and a null are flattened too', () => {
    expect(printable('a\u0007b\u0000c')).toBe('a?b?c');
  });

  test('replaced rather than dropped, so an all-escape name reads as odd', () => {
    // Dropping would render it blank, and a blank row beside a live session is
    // indistinguishable from a tidy one.
    expect(printable('\u001b\u001b\u001b')).toBe('???');
  });

  test('a name long enough to scroll the others away is capped', () => {
    const capped = printable('x'.repeat(500));

    expect(capped).toHaveLength(64);
    expect(capped.endsWith('…')).toBe(true);
  });

  test('ordinary text is left exactly as it is', () => {
    expect(printable('Claude Desktop')).toBe('Claude Desktop');
    expect(printable('lanes:adalovelace')).toBe('lanes:adalovelace');
  });
});
