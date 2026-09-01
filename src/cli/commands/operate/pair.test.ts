import { describe, expect, test } from 'bun:test';
import { isValidSecretRef } from '#secrets';
import { pairingLink, PAIR_CERT_REF, PAIR_KEY_REF, PAIR_TOKEN_REF } from './pair.ts';

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

/**
 * The link the browser opens, which nothing used to assert on.
 *
 * A loopback link carried no address for as long as loopback looked derivable.
 * It is not: the read listener sits one port above `instance.port`, so an
 * endpoint on any port but the default printed a link the dashboard then read at
 * 7338, reported unreachable, and gave no way to correct — a silent failure in a
 * command that had reported success.
 *
 * These read the fragment rather than the whole string, because the origin comes
 * from `LANES_WEB_URL` and is a local dashboard as often as it is lanes.sh.
 */

function fragment(url: string): URLSearchParams {
  return new URLSearchParams(new URL(url).hash.replace(/^#/, ''));
}

describe('the pairing link', () => {
  test('carries the address, so a non-default port survives the trip', () => {
    const parsed = fragment(pairingLink('llp_token', 'https://127.0.0.1:7401'));
    expect(parsed.get('at')).toBe('https://127.0.0.1:7401');
  });

  test('carries a deployed address the same way', () => {
    const parsed = fragment(pairingLink('llp_token', 'https://link.example.test'));
    expect(parsed.get('at')).toBe('https://link.example.test');
  });

  test('puts both in the fragment, never in the query', () => {
    // The fragment is never sent to a server, which is the whole reason a
    // credential for a surface Lanes cannot see may travel in a URL at all. An
    // address in the query would put a workspace's public address in an access
    // log for the same trip.
    const url = new URL(pairingLink('llp_token', 'https://127.0.0.1:7338'));
    expect(url.search).toBe('');
    expect(url.pathname).toBe('/dashboard/link');
    expect(fragment(url.href).get('pair')).toBe('llp_token');
  });

  test('encodes the address, so its own separators do not end the parameter', () => {
    const raw = new URL(pairingLink('llp_token', 'https://127.0.0.1:7401')).hash;
    expect(raw).toContain('at=https%3A%2F%2F127.0.0.1%3A7401');
  });
});
