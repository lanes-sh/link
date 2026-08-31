import { describe, expect, test } from 'bun:test';
import { isValidSecretRef } from '#secrets';
import { PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF } from './pair.ts';

/**
 * The three references `lanes link pair` writes.
 *
 * A constant that is never validated until somebody runs the command is a
 * constant that is wrong until somebody runs the command. These were
 * `workspace/pair.cert` and friends, which `isValidSecretRef` refuses — a
 * secret reference is `[a-z0-9_-]` between slashes, because these names become
 * Secret Manager entries on a deployed workspace and Google allows no dots
 * either. The command failed on its first real invocation, having passed every
 * test in the suite.
 */

describe('the pairing credential references', () => {
  test.each([
    ['token', PAIR_TOKEN_REF],
    ['certificate', PAIR_CERT_REF],
    ['key', PAIR_KEY_REF],
  ])('the %s reference is one a store will accept', (_name, ref) => {
    expect(isValidSecretRef(ref)).toBe(true);
  });

  test('all three are distinct, so none overwrites another', () => {
    expect(new Set([PAIR_TOKEN_REF, PAIR_CERT_REF, PAIR_KEY_REF]).size).toBe(3);
  });

  test('they share a namespace that says what owns them', () => {
    // `workspace/` rather than `profile/`: pairing is a property of the machine
    // and its workspace, not of any one profile, and the read surface it opens
    // lists every profile there.
    for (const ref of [PAIR_TOKEN_REF, PAIR_CERT_REF, PAIR_KEY_REF]) {
      expect(ref.startsWith('workspace/')).toBe(true);
    }
  });
});
