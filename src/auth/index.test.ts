import { describe, expect, test } from 'bun:test';
import type { SecretStore } from '#secrets';
import {
  BearerAuthenticator,
  generateProfileToken,
  ownerPrincipal,
  parseBearer,
  tokensMatch,
} from './index.ts';

function storeWith(entries: Record<string, string>): SecretStore {
  const map = new Map(Object.entries(entries));
  return {
    async get(ref) {
      return map.get(ref) ?? null;
    },
    async set(ref, value) {
      map.set(ref, value);
    },
    async has(ref) {
      return map.has(ref);
    },
    async delete(ref) {
      map.delete(ref);
    },
    async list() {
      return [...map.keys()];
    },
  };
}

describe('bearer parsing', () => {
  test('accepts the standard form, case-insensitively', () => {
    expect(parseBearer('Bearer abc123')).toBe('abc123');
    expect(parseBearer('bearer abc123')).toBe('abc123');
    expect(parseBearer('  Bearer   abc123  ')).toBe('abc123');
  });

  test('rejects anything that is not a bearer credential', () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer('')).toBeNull();
    expect(parseBearer('Basic abc123')).toBeNull();
    expect(parseBearer('Bearer')).toBeNull();
    expect(parseBearer('Bearer ')).toBeNull();
  });
});

describe('token comparison', () => {
  test('matches identical tokens and rejects different ones', () => {
    expect(tokensMatch('llk_abc', 'llk_abc')).toBe(true);
    expect(tokensMatch('llk_abc', 'llk_abd')).toBe(false);
  });

  test('handles differing lengths without throwing', () => {
    // timingSafeEqual throws on length mismatch, which would both crash the
    // request and leak length. Hashing first is what avoids that.
    expect(tokensMatch('short', 'a-much-longer-token-value')).toBe(false);
    expect(tokensMatch('', 'x')).toBe(false);
  });
});

describe('generated tokens', () => {
  test('are prefixed, long, and distinct', () => {
    const a = generateProfileToken();
    const b = generateProfileToken();

    expect(a.startsWith('llk_')).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });
});

describe('authentication', () => {
  const options = {
    profile: 'personal',
    tokenRef: 'profile/token',
    credentials: storeWith({ 'profile/token': 'llk_correct' }),
  };

  test('accepts the profile token and resolves the owner principal', async () => {
    const auth = new BearerAuthenticator(options);
    const outcome = await auth.authenticate('Bearer llk_correct');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.principal).toEqual(ownerPrincipal('personal'));
  });

  test('rejects a wrong token, a missing header, and a malformed one distinctly', async () => {
    const auth = new BearerAuthenticator(options);

    expect(await auth.authenticate('Bearer llk_wrong')).toEqual({ ok: false, reason: 'invalid' });
    expect(await auth.authenticate(null)).toEqual({ ok: false, reason: 'missing' });
    expect(await auth.authenticate('Basic xyz')).toEqual({ ok: false, reason: 'malformed' });
  });

  test('fails closed when the profile has no token configured', async () => {
    const auth = new BearerAuthenticator({ ...options, credentials: storeWith({}) });
    expect(await auth.authenticate('Bearer anything')).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  test("a token from one profile does not authenticate another profile's endpoint", async () => {
    const personal = new BearerAuthenticator({
      profile: 'personal',
      tokenRef: 'profile/token',
      credentials: storeWith({ 'profile/token': 'llk_personal' }),
    });
    const work = new BearerAuthenticator({
      profile: 'work',
      tokenRef: 'profile/token',
      credentials: storeWith({ 'profile/token': 'llk_work' }),
    });

    expect((await personal.authenticate('Bearer llk_work')).ok).toBe(false);
    expect((await work.authenticate('Bearer llk_personal')).ok).toBe(false);
    expect((await work.authenticate('Bearer llk_work')).ok).toBe(true);
  });

  test('rotation is picked up once the cache is invalidated', async () => {
    const credentials = storeWith({ 'profile/token': 'llk_old' });
    const auth = new BearerAuthenticator({ ...options, credentials });

    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true);

    await credentials.set('profile/token', 'llk_new');
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true); // still cached

    auth.invalidateCache();
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(false);
    expect((await auth.authenticate('Bearer llk_new')).ok).toBe(true);
  });
});
