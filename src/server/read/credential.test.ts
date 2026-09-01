import { describe, expect, test } from 'bun:test';
import { cachedPairingCredential, directPairingCredential } from './credential.ts';

/**
 * Verifying the pairing token, and what each bind pays for the answer.
 *
 * The clock is injected rather than slept through, so raising the window fails
 * a test instead of passing more slowly.
 */

const TOKEN = 'llp_a-pairing-token';
const NEXT = 'llp_the-rotated-one';

describe('on loopback, every presentation reads', () => {
  test('a rotation lands at once, which is what `pair --rotate` promises', async () => {
    let current = TOKEN;
    const credential = directPairingCredential({ read: async () => current });

    expect(await credential.verify(TOKEN)).toBe(true);

    current = NEXT;
    expect(await credential.verify(TOKEN)).toBe(false);
    expect(await credential.verify(NEXT)).toBe(true);
  });

  test('a store with no version is unpaired rather than open', async () => {
    const credential = directPairingCredential({ read: async () => null });
    expect(await credential.verify(TOKEN)).toBe(false);
  });

  test('an empty value is unpaired too — that is the shape a deploy creates', async () => {
    const credential = directPairingCredential({ read: async () => '' });
    expect(await credential.verify('')).toBe(false);
  });

  test('a throwing store refuses rather than propagating', async () => {
    const reasons: string[] = [];
    const credential = directPairingCredential({
      read: async () => {
        throw new Error('permission denied');
      },
      onError: (reason) => reasons.push(reason),
    });

    expect(await credential.verify(TOKEN)).toBe(false);
    expect(reasons).toEqual(['permission denied']);
  });
});

describe('on a deployed endpoint, one read is cached', () => {
  function fixture(initial: string | null) {
    let current = initial;
    let reads = 0;
    let clock = 1_000;

    const credential = cachedPairingCredential({
      read: async () => {
        reads += 1;
        return current;
      },
      ttlMs: 5_000,
      now: () => clock,
    });

    return {
      credential,
      reads: () => reads,
      advance: (ms: number) => {
        clock += ms;
      },
      rotate: (next: string | null) => {
        current = next;
      },
    };
  }

  test('a valid token inside the window costs nothing after the first read', async () => {
    const it = fixture(TOKEN);

    expect(await it.credential.verify(TOKEN)).toBe(true);
    expect(await it.credential.verify(TOKEN)).toBe(true);
    expect(await it.credential.verify(TOKEN)).toBe(true);

    // The whole reason this exists: `GcpSecretManagerStore` has no cache, so
    // without this a dashboard polling `/state` is one network round trip per
    // poll for as long as the page is open.
    expect(it.reads()).toBe(1);
  });

  test('a token rotated in works on its first presentation', async () => {
    const it = fixture(TOKEN);

    await it.credential.verify(TOKEN);
    it.rotate(NEXT);

    // A mismatch against a cached value is ambiguous — wrong, or just rotated —
    // and exactly one re-read separates them.
    expect(await it.credential.verify(NEXT)).toBe(true);
  });

  test('a wrong token buys exactly one extra read, not one per attempt', async () => {
    const it = fixture(TOKEN);

    await it.credential.verify(TOKEN);
    expect(it.reads()).toBe(1);

    expect(await it.credential.verify('llp_wrong')).toBe(false);
    expect(it.reads()).toBe(2);

    // The re-read refreshed the cache, so the next wrong guess is answered
    // from it: a caller presenting garbage cannot spend a store read per
    // request.
    expect(await it.credential.verify('llp_wrong')).toBe(false);
    expect(it.reads()).toBe(2);
  });

  test('a token rotated away stops working within the window', async () => {
    const it = fixture(TOKEN);

    await it.credential.verify(TOKEN);
    it.rotate(NEXT);

    // The honest cost, stated as a test: still accepted until the window ends.
    expect(await it.credential.verify(TOKEN)).toBe(true);

    it.advance(5_000);
    expect(await it.credential.verify(TOKEN)).toBe(false);
  });
});
