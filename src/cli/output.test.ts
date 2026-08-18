import { describe, expect, test } from 'bun:test';
import { waiting } from './output.ts';

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
