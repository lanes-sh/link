import { describe, expect, test } from 'bun:test';

import { refuseUnknownFlags } from './unknown-flags.ts';

/**
 * The refusal, tested where it now lives rather than through one of its callers.
 *
 * `selection.test.ts` exercises it thoroughly through `assertKnownFlags`, but
 * only ever with an allowlist derived from the `link` tables. The point of the
 * extraction is that a second area supplies its own, so the cases that matter
 * here are the ones about the *message*: what a caller's own allowlist puts in
 * front of the operator.
 */
describe('refusing a flag a command does not read', () => {
  const allowed = new Set(['help', 'json', 'api-url']);

  test('an accepted flag passes', () => {
    expect(() => refuseUnknownFlags('lanes auth login', allowed, { json: true })).not.toThrow();
    expect(() =>
      refuseUnknownFlags('lanes auth login', allowed, { 'api-url': 'https://example.invalid' }),
    ).not.toThrow();
  });

  test('an unknown flag is refused, and the message names the command', () => {
    expect(() => refuseUnknownFlags('lanes auth login', allowed, { nope: true })).toThrow(
      'Unknown flag "--nope" for "lanes auth login"',
    );
  });

  test('a near miss is guessed', () => {
    // The case this whole change is for. `--api_url` is one edit from
    // `--api-url`, and the old behaviour was to drop it in silence.
    expect(() =>
      refuseUnknownFlags('lanes auth login', allowed, { api_url: 'https://example.invalid' }),
    ).toThrow('Did you mean --api-url?');
  });

  test('the message lists what is accepted, sorted', () => {
    try {
      refuseUnknownFlags('lanes auth', allowed, { wat: true });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('Accepts: --api-url --help --json');
    }
  });

  test('the first unknown flag is the one reported', () => {
    // Reporting one is deliberate: an operator fixes one flag and runs again,
    // and a list of three refusals reads as three separate problems.
    expect(() => refuseUnknownFlags('lanes auth', allowed, { aaa: true, zzz: true })).toThrow(
      '--aaa',
    );
  });
});
