import { describe, expect, test } from 'bun:test';
import { pushDecision } from './secrets.ts';

/**
 * What `secrets push` copies.
 *
 * The rule that matters is that a reference already present in the destination
 * is left alone unless the operator asks otherwise: the destination's copy may
 * be newer — a token rotated against the cloud target, say — and quietly
 * overwriting it with a stale local value would break the deployed instance
 * with no error anywhere.
 */

const refs = ['gmail/main', 'gmail/side', 'profile/token'];

describe('pushDecision', () => {
  test('copies everything into an empty destination', () => {
    expect(pushDecision({ refs, existing: new Set(), overwrite: false })).toEqual({
      copy: refs,
      skip: [],
    });
  });

  test('skips what the destination already holds', () => {
    expect(
      pushDecision({ refs, existing: new Set(['profile/token']), overwrite: false }),
    ).toEqual({ copy: ['gmail/main', 'gmail/side'], skip: ['profile/token'] });
  });

  test('--overwrite replaces them', () => {
    expect(pushDecision({ refs, existing: new Set(refs), overwrite: true })).toEqual({
      copy: refs,
      skip: [],
    });
  });

  test('a destination holding everything is a no-op rather than an error', () => {
    // Re-running a push is how an operator confirms a migration landed.
    expect(pushDecision({ refs, existing: new Set(refs), overwrite: false })).toEqual({
      copy: [],
      skip: refs,
    });
  });

  test('an empty source copies nothing', () => {
    expect(pushDecision({ refs: [], existing: new Set(refs), overwrite: false })).toEqual({
      copy: [],
      skip: [],
    });
  });

  test('the decision is a partition — every reference lands in exactly one list', () => {
    const { copy, skip } = pushDecision({
      refs,
      existing: new Set(['gmail/side']),
      overwrite: false,
    });
    expect([...copy, ...skip].sort()).toEqual([...refs].sort());
  });
});
