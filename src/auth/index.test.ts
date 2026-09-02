import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSecretStore, generateCredentialKey, type SecretStore } from '#secrets';
import {
  BearerAuthenticator,
  generateProfileToken,
  machinePrincipal,
  mayReach,
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
  const SUBJECT = 'lanes:abc123';

  /** One issued row, and the profiles its subject is a member of. */
  const issued = (
    overrides: {
      credentials?: ReturnType<typeof storeWith>;
      profilesFor?: (subject: string) => Promise<readonly string[]>;
      now?: () => number;
      rows?: readonly { id: string; subject: string; ref: string }[];
    } = {},
  ) => ({
    profile: 'personal',
    tokens: async () =>
      overrides.rows ?? [{ id: 'tok1', subject: SUBJECT, ref: 'tokens/tok1' }],
    credentials: overrides.credentials ?? storeWith({ 'tokens/tok1': 'llk_correct' }),
    profilesFor: overrides.profilesFor ?? (async () => ['personal']),
    ...(overrides.now ? { now: overrides.now } : {}),
  });

  const options = issued();

  test('accepts an issued token and resolves the subject it names', async () => {
    const auth = new BearerAuthenticator(options);
    const outcome = await auth.authenticate('Bearer llk_correct');

    expect(outcome.ok).toBe(true);
    // The whole of ADR-068: a static token is a person, with the profiles their
    // membership gives them — not an owner with `profiles: undefined`, which is
    // what it used to be and reached everything.
    if (outcome.ok) {
      expect(outcome.principal).toEqual(machinePrincipal(SUBJECT, 'personal', ['personal']));
    }
  });

  test('reaches only the profiles its subject is a member of', async () => {
    const auth = new BearerAuthenticator(
      issued({ profilesFor: async () => ['personal', 'shared'] }),
    );
    const outcome = await auth.authenticate('Bearer llk_correct');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.principal.profiles).toEqual(['personal', 'shared']);
      // Not "all of them". `mayReach` reads `undefined` as unrestricted, so a
      // machine principal that carried it would restore what this removed.
      expect(outcome.principal.profiles).not.toBeUndefined();
      expect(mayReach(outcome.principal, 'work')).toBe(false);
    }
  });

  test('a subject no profile lists reaches nothing, rather than everything', async () => {
    const auth = new BearerAuthenticator(issued({ profilesFor: async () => [] }));
    const outcome = await auth.authenticate('Bearer llk_correct');

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.principal.profiles).toEqual([]);
      expect(mayReach(outcome.principal, 'personal')).toBe(false);
    }
  });

  test('a resolver that throws fails closed', async () => {
    // Falling back to "every profile" here would restore the old behaviour at
    // exactly the moment something is already wrong.
    const auth = new BearerAuthenticator(
      issued({
        profilesFor: async () => {
          throw new Error('members unreadable');
        },
      }),
    );
    expect(await auth.authenticate('Bearer llk_correct')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  test('several rows each authenticate as their own subject', async () => {
    const auth = new BearerAuthenticator(
      issued({
        rows: [
          { id: 'tok1', subject: 'lanes:aaaaaa', ref: 'tokens/tok1' },
          { id: 'tok2', subject: 'lanes:bbbbbb', ref: 'tokens/tok2' },
        ],
        credentials: storeWith({ 'tokens/tok1': 'llk_one', 'tokens/tok2': 'llk_two' }),
        profilesFor: async (subject) => (subject === 'lanes:aaaaaa' ? ['personal'] : ['work']),
      }),
    );

    const one = await auth.authenticate('Bearer llk_one');
    const two = await auth.authenticate('Bearer llk_two');

    expect(one.ok && one.principal.id).toBe('lanes:aaaaaa');
    expect(one.ok && one.principal.profiles).toEqual(['personal']);
    expect(two.ok && two.principal.id).toBe('lanes:bbbbbb');
    expect(two.ok && two.principal.profiles).toEqual(['work']);
  });

  test('a row whose credential is missing matches nothing', async () => {
    // What a half-finished `secrets push` leaves: the row travels with
    // connections.yaml and the value does not.
    const auth = new BearerAuthenticator(
      issued({ credentials: storeWith({ 'tokens/tok2': 'llk_other' }) }),
    );
    expect(await auth.authenticate('Bearer llk_other')).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  test('rejects a wrong token, a missing header, and a malformed one distinctly', async () => {
    const auth = new BearerAuthenticator(options);

    expect(await auth.authenticate('Bearer llk_wrong')).toEqual({ ok: false, reason: 'invalid' });
    expect(await auth.authenticate(null)).toEqual({ ok: false, reason: 'missing' });
    expect(await auth.authenticate('Basic xyz')).toEqual({ ok: false, reason: 'malformed' });
  });

  test('fails closed when nothing has been issued', async () => {
    const auth = new BearerAuthenticator(issued({ rows: [] }));
    expect(await auth.authenticate('Bearer anything')).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  test("a token from one workspace does not open another's endpoint", async () => {
    const personal = new BearerAuthenticator(
      issued({ credentials: storeWith({ 'tokens/tok1': 'llk_personal' }) }),
    );
    const work = new BearerAuthenticator(
      issued({ credentials: storeWith({ 'tokens/tok1': 'llk_work' }) }),
    );

    expect((await personal.authenticate('Bearer llk_work')).ok).toBe(false);
    expect((await work.authenticate('Bearer llk_personal')).ok).toBe(false);
    expect((await work.authenticate('Bearer llk_work')).ok).toBe(true);
  });

  test('rotation is picked up once the cache is invalidated', async () => {
    const credentials = storeWith({ 'tokens/tok1': 'llk_old' });
    const auth = new BearerAuthenticator(issued({ credentials }));

    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true);

    await credentials.set('tokens/tok1', 'llk_new');
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true); // still cached

    auth.invalidateCache();
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(false);
    expect((await auth.authenticate('Bearer llk_new')).ok).toBe(true);
  });

  test('a rotated-in token is accepted without an explicit invalidation', async () => {
    // Nothing in production calls invalidateCache(), so a token the cache has
    // never seen has to be able to prove itself. The mismatch is the signal.
    const credentials = storeWith({ 'tokens/tok1': 'llk_old' });
    const auth = new BearerAuthenticator(issued({ credentials }));

    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true);

    await credentials.set('tokens/tok1', 'llk_new');
    expect((await auth.authenticate('Bearer llk_new')).ok).toBe(true);
  });

  test('a revoked token stops working once the cache window passes', async () => {
    // Re-reading on mismatch cannot catch this on its own: the revoked token
    // still equals the cached value, so it matches and never reaches the store.
    // An attacker holding a leaked token is precisely the caller who never
    // produces a mismatch, so the cache also has to age out.
    let clock = 1_000;
    const credentials = storeWith({ 'tokens/tok1': 'llk_old' });
    const auth = new BearerAuthenticator(issued({ credentials, now: () => clock }));

    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true);

    await credentials.set('tokens/tok1', 'llk_new');
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true); // inside the window

    clock += 10_000;
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(false);
    expect((await auth.authenticate('Bearer llk_new')).ok).toBe(true);
  });
});

describe('rotation by another process', () => {
  test('a token rotated through a second store instance is accepted', async () => {
    // The in-memory store above cannot show this. The real credential store
    // keeps the decrypted document in memory too, so an authenticator that
    // re-read was still handed a stale copy — and `lanes link token rotate` is
    // always a second process writing the same file.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-auth-'));
    const path = join(root, 'personal.credentials.enc');
    const key = new Uint8Array(Buffer.from(generateCredentialKey(), 'base64'));

    const serving = createFileSecretStore({ path, key });
    await serving.set('tokens/tok1', 'llk_old');

    const auth = new BearerAuthenticator({
      profile: 'personal',
      tokens: async () => [{ id: 'tok1', subject: 'lanes:abc123', ref: 'tokens/tok1' }],
      credentials: serving,
      profilesFor: async () => ['personal'],
    });
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(true);

    // The CLI, in its own process, over the same file.
    await createFileSecretStore({ path, key }).set('tokens/tok1', 'llk_new');

    expect((await auth.authenticate('Bearer llk_new')).ok).toBe(true);
    expect((await auth.authenticate('Bearer llk_old')).ok).toBe(false);

    await rm(root, { recursive: true, force: true });
  });
});
