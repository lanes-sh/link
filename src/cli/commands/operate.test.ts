import { describe, expect, test } from 'bun:test';
import { tokenInvocation } from './operate/outputs.ts';
import { markdownCell } from './operate.ts';

/**
 * `audit tail --format md` renders the log; it does not store it (ADR-013).
 *
 * A rendering still has to be safe, because the thing being rendered is not
 * trusted. Redaction reduces most argument values to a type marker, but a
 * provider's `redact` map opts specific keys back in verbatim — a message id, a
 * URI — and those came from the caller. A pipe or a newline in one is the
 * difference between a table and a forged row.
 */

describe('audit markdown cells', () => {
  test('escapes a pipe rather than letting it end the cell', () => {
    const cell = markdownCell('{"q":"a|b"}');

    expect(cell).toBe('`{"q":"a\\|b"}`');
    // One cell means one unescaped pipe count of zero: every `|` is preceded by
    // a backslash, so the row cannot gain a column.
    expect(cell.replaceAll('\\|', '')).not.toContain('|');
  });

  test('flattens newlines, which would otherwise end the row', () => {
    expect(markdownCell('line one\nline two')).toBe('`line one line two`');
    expect(markdownCell('a\r\n\r\nb')).toBe('`a b`');
  });

  test('escapes a backslash before it can escape the escaping', () => {
    // Without this, `\` followed by `|` renders as a literal backslash and a
    // live pipe — the escape cancels itself and the row splits anyway.
    expect(markdownCell('a\\|b')).toBe('`a\\\\\\|b`');
  });

  test('leaves an ordinary value alone', () => {
    expect(markdownCell('{"id":"msg_1"}')).toBe('`{"id":"msg_1"}`');
  });
});

/**
 * The token command `outputs` hands over, and the two flags it must carry.
 *
 * A token is per-target. Printing a bare `token show --raw` beside a deployed
 * URL hands over the *local* token — a credential that looks like an answer and
 * fails as a wrong password, which is the failure mode this whole helper was
 * written to avoid and reintroduced one flag lower down.
 */
describe('the token command outputs prints', () => {
  test('names both the profile and the target, on either path', async () => {
    // Whichever branch is taken — a `lanes` on PATH that matches, or the
    // checkout-relative fallback — the selection has to survive into the line
    // somebody pastes.
    const invocation = await tokenInvocation('a-token-no-endpoint-will-match', 'work', 'cloud');

    expect(invocation.command).toContain('--profile work');
    expect(invocation.command).toContain('--target cloud');
    expect(invocation.command).toContain('token show --raw');
  });
});
