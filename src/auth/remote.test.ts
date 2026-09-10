import { describe, expect, test } from 'bun:test';
import { IssuedTokenAuthenticator, OidcAuthenticator } from './remote.ts';
import { EVERY_PROFILE, mayReach } from './principal.ts';
import type { OidcVerifier } from './oidc.ts';
import { OAuthStore } from './oauth/store.ts';
import type { KeyValueStore } from '#stores/state';

/**
 * A key-value store in a Map.
 *
 * The real one is built over a blob store, and standing one of those up here
 * would make this a test of the storage adapter. What is under test is the four
 * lines that turn a row into a principal.
 */
function memoryStore(): KeyValueStore {
  const rows = new Map<string, string>();
  const at = (namespace: string, key: string): string => `${namespace}\u0000${key}`;

  return {
    get: async (namespace, key) => rows.get(at(namespace, key)) ?? null,
    set: async (namespace, key, value) => void rows.set(at(namespace, key), value),
    delete: async (namespace, key) => void rows.delete(at(namespace, key)),
    keys: async (namespace) =>
      [...rows.keys()]
        .filter((row) => row.startsWith(`${namespace}\u0000`))
        .map((row) => row.slice(namespace.length + 1)),
    clearNamespace: async (namespace) => {
      for (const row of [...rows.keys()]) {
        if (row.startsWith(`${namespace}\u0000`)) rows.delete(row);
      }
    },
  };
}

/**
 * What a token this endpoint issued turns into.
 *
 * The crux of delegation, and the one step where a stored row becomes a
 * principal the dispatcher will act on. Three cases, and the middle one is the
 * whole release: a token that names a person reaches the profiles that named
 * them back, and nothing else.
 */

function authenticator(): { store: OAuthStore; auth: IssuedTokenAuthenticator } {
  const store = new OAuthStore(memoryStore());
  return { store, auth: new IssuedTokenAuthenticator(store, 'personal') };
}

const HOUR = Date.now() + 3_600_000;

describe('a token that names nobody', () => {
  test('is refused, because a credential that cannot say who it is opens nothing', async () => {
    // This used to resolve to the owner, so that a token issued by 0.7 kept
    // working until it expired rather than logging its connector out on
    // upgrade. The owner principal reaches every profile in the workspace, so
    // the kindness was a standing bypass of `members:` on the one credential
    // that could not name a person. Refused instead: the holder re-authorises,
    // which is one browser round trip. ADR-078.
    const { store, auth } = authenticator();
    await store.putToken('lla_old', {
      clientId: 'llc_x',
      kind: 'access',
      scope: 'mcp',
      family: 'llf_x',
      expiresAt: HOUR,
    });

    const outcome = await auth.authenticate('Bearer lla_old');

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('invalid');
  });

  test('is refused the same way an unknown token is, so neither is distinguishable', async () => {
    // A distinct reason would tell a caller "this token exists but is too old",
    // which is a fact about the workspace they have not authenticated to learn.
    const { auth } = authenticator();

    const unknown = await auth.authenticate('Bearer lla_never_issued');

    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.reason).toBe('invalid');
  });
});

describe('a token that names a person', () => {
  test('carries the profiles resolved when it was minted', async () => {
    const { store, auth } = authenticator();
    await store.putToken('lla_hers', {
      clientId: 'llc_x',
      kind: 'access',
      scope: 'mcp',
      family: 'llf_x',
      subject: 'lanes:HER',
      profiles: ['personal', 'shared'],
      expiresAt: HOUR,
    });

    const outcome = await auth.authenticate('Bearer lla_hers');

    expect(outcome.ok && outcome.principal.kind).toBe('member');
    expect(outcome.ok && outcome.principal.id).toBe('lanes:HER');
    expect(outcome.ok && outcome.principal.profiles).toEqual(['personal', 'shared']);
  });

  test('a subject with no profiles reaches nothing, rather than everything', async () => {
    // The direction this has to fail in. A stored row's list is optional, and a
    // row that lost its list must not read as one that may open everything —
    // `?? []` at the call site is what decides that, and this pins it.
    const { store, auth } = authenticator();
    await store.putToken('lla_nobody', {
      clientId: 'llc_x',
      kind: 'access',
      scope: 'mcp',
      family: 'llf_x',
      subject: 'lanes:NOBODY',
      profiles: [],
      expiresAt: HOUR,
    });

    const outcome = await auth.authenticate('Bearer lla_nobody');

    expect(outcome.ok && outcome.principal.profiles).toEqual([]);
  });
});

describe('a credential that is not an access token', () => {
  test('a refresh token does not open the resource', async () => {
    // They are indistinguishable as strings, so the `kind` check is the only
    // thing separating a credential for the token endpoint from one for this.
    const { store, auth } = authenticator();
    await store.putToken('llr_refresh', {
      clientId: 'llc_x',
      kind: 'refresh',
      scope: 'mcp',
      family: 'llf_x',
      subject: 'lanes:HER',
      profiles: ['personal'],
      expiresAt: HOUR,
    });

    expect(await auth.authenticate('Bearer llr_refresh')).toEqual({ ok: false, reason: 'invalid' });
  });

  test('nothing at all is missing, not invalid, so the chain can rank it', async () => {
    const { auth } = authenticator();

    expect(await auth.authenticate(null)).toEqual({ ok: false, reason: 'missing' });
  });
});

/**
 * How often an issued token costs a store read.
 *
 * Every authenticated request resolves one, and every resolution was a read —
 * on a deployed target a bucket round trip before any of the caller's work
 * begins. The record is immutable until it expires: it is written once at mint
 * and nothing rewrites it, which is what makes remembering it safe.
 *
 * The reason to test it is not the saving. It is that a cache in front of an
 * authorization decision is exactly the kind that must not outlive what it
 * caches, so the tests that matter are the ones about forgetting.
 */
describe('resolving the same token twice', () => {
  function counting(): { store: OAuthStore; reads: () => number } {
    const inner = memoryStore();
    let reads = 0;
    const counted: KeyValueStore = {
      ...inner,
      get: async (namespace, key) => {
        reads++;
        return inner.get(namespace, key);
      },
    };
    return { store: new OAuthStore(counted), reads: () => reads };
  }

  const record = (expiresAt: number) =>
    ({ kind: 'access', subject: 'lanes:abc', client: 'c1', family: 'f1', expiresAt }) as never;

  test('the second resolution does not read the store', async () => {
    const { store, reads } = counting();
    await store.putToken('tok', record(Date.now() + 60_000));

    expect(await store.token('tok')).not.toBeNull();
    const after = reads();
    expect(await store.token('tok')).not.toBeNull();

    expect(reads()).toBe(after);
  });

  /**
   * The one that would matter if it were wrong. A revoked token must stop
   * working on the next call, not when something happens to evict it.
   */
  test('a revoked token stops resolving immediately', async () => {
    const { store } = counting();
    await store.putToken('tok', record(Date.now() + 60_000));
    expect(await store.token('tok')).not.toBeNull();

    await store.revokeToken('tok');

    expect(await store.token('tok')).toBeNull();
  });

  /** And a spent refresh token is seen as spent, not as it was before. */
  test('consuming a token is visible to the next resolution', async () => {
    const { store } = counting();
    await store.putToken('tok', record(Date.now() + 60_000));
    expect(await store.token('tok')).not.toBeNull();

    await store.consumeToken('tok');

    expect((await store.token('tok'))?.kind).toBe('consumed');
  });

  /**
   * A cached copy cannot outlive the grant it stands for: expiry is checked
   * against the record's own field before it is served, so a token that ran out
   * while it sat in memory is refused rather than honoured.
   */
  test('a cached token that has expired is not served', async () => {
    const { store } = counting();
    await store.putToken('tok', record(Date.now() + 20));
    expect(await store.token('tok')).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(await store.token('tok')).toBeNull();
  });
});

/**
 * What a token somebody else's issuer minted turns into.
 *
 * There were no tests here at all, which is the other half of why this went
 * unnoticed: the path returned `ownerPrincipal` and nothing asserted what that
 * reached. A verifier that says "yes, this is Ada" was being read as "yes, Ada
 * may open everything", and those are different sentences.
 */

/** A verifier that answers from a table, so the test is about the resolution. */
function stubVerifier(answers: Record<string, string>): OidcVerifier {
  return {
    verify: async (token: string) => {
      const subject = answers[token];
      return subject ? { subject, expiresAt: HOUR } : null;
    },
  } as unknown as OidcVerifier;
}

describe('a token from an external issuer', () => {
  const SUBJECT = 'lanes:3QBmAxJLLrYSMTVUIeCN1SKFbdD3';

  test('reaches only the profiles whose members: name its subject', async () => {
    const auth = new OidcAuthenticator(
      stubVerifier({ theirs: SUBJECT }),
      'personal',
      async (subject) => (subject === SUBJECT ? ['personal'] : []),
    );

    const outcome = await auth.authenticate('Bearer theirs');

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.principal.kind).toBe('member');
    expect(outcome.ok && outcome.principal.id).toBe(SUBJECT);
    expect(outcome.ok && outcome.principal.profiles).toEqual(['personal']);
  });

  test('a verified subject on no profile reaches nothing, rather than everything', async () => {
    // The bug, pinned. `allowed_subjects` decided this token was let in; it
    // never decided what the token may open, and reading the first as the
    // second is what made every subject an owner.
    const auth = new OidcAuthenticator(
      stubVerifier({ theirs: SUBJECT }),
      'personal',
      async () => [],
    );

    const outcome = await auth.authenticate('Bearer theirs');

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.principal.profiles).toEqual([]);
    expect(outcome.ok && mayReach(outcome.principal, 'personal')).toBe(false);
  });

  test('never carries EVERY_PROFILE, whatever the issuer said', async () => {
    const auth = new OidcAuthenticator(stubVerifier({ theirs: SUBJECT }), 'personal', async () => [
      'personal',
      'work',
    ]);

    const outcome = await auth.authenticate('Bearer theirs');

    expect(outcome.ok && outcome.principal.profiles).not.toBe(EVERY_PROFILE);
  });

  test('a resolver that throws fails closed', async () => {
    // An outage in the thing that answers "which profiles name this person"
    // must close the endpoint rather than open it. Falling back to "all of
    // them" at the moment something is already wrong is the worst available
    // direction.
    const auth = new OidcAuthenticator(stubVerifier({ theirs: SUBJECT }), 'personal', async () => {
      throw new Error('members unavailable');
    });

    const outcome = await auth.authenticate('Bearer theirs');

    expect(outcome.ok).toBe(false);
  });

  test('a token the issuer does not vouch for is invalid', async () => {
    const auth = new OidcAuthenticator(stubVerifier({}), 'personal', async () => ['personal']);

    const outcome = await auth.authenticate('Bearer nope');

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.reason).toBe('invalid');
  });
});
