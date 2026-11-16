import { describe, expect, test } from 'bun:test';
import { IssuedTokenAuthenticator, LanesKeyAuthenticator, OidcAuthenticator } from './remote.ts';
import { EVERY_PROFILE, mayReach } from './principal.ts';
import type { ApiKeyVerifier } from './lanes/api-key.ts';
import type { OidcVerifier } from './oidc.ts';
import { OAuthStore, SEEN_TTL_MS } from './oauth/store.ts';
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

function authenticator(
  // Resolved per request now (ADR-083), so the harness has to supply the answer
  // the endpoint's `workspaceMembers` would. Defaults to the one profile these
  // cases are about; a test drives revocation by passing `[]`.
  profilesFor: (subject: string) => Promise<readonly string[]> = async () => ['personal'],
): { store: OAuthStore; auth: IssuedTokenAuthenticator } {
  const store = new OAuthStore(memoryStore());
  return { store, auth: new IssuedTokenAuthenticator(store, 'personal', profilesFor) };
}

const HOUR = Date.now() + 3_600_000;

describe('a token that names nobody', () => {
  test('is refused, because a credential that cannot say who it is opens nothing', async () => {
    // This used to resolve to the owner, so that a token issued by 0.7 kept
    // working until it expired rather than logging its connector out on
    // upgrade. The owner principal reaches every profile in the workspace, so
    // the kindness was a standing bypass of `members:` on the one credential
    // that could not name a person. Refused instead: the holder re-authorises,
    // which is one browser round trip. ADR-079.
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
  /** A stored access-token row for `lanes:HER`, with whatever list it was minted with. */
  const hers = (profiles: readonly string[]) =>
    ({
      clientId: 'llc_x',
      kind: 'access',
      scope: 'mcp',
      family: 'llf_x',
      subject: 'lanes:HER',
      profiles,
      expiresAt: HOUR,
    }) as never;

  test('reaches what the member list says now, not what the mint recorded', async () => {
    // The release this is. A browser session's reach was resolved once, when
    // its code was minted, and rode unchanged through thirty days of refresh —
    // so a profile added after a client signed in could not be reached by it at
    // all, whatever the schema said. The stored list is still *written*, for the
    // rollback reason `oauth/store.ts` gives, and deliberately no longer read:
    // here it says one thing and the resolver says another, and the resolver
    // wins (ADR-083 amends ADR-060).
    const { store, auth } = authenticator(async () => ['personal', 'added-since']);
    await store.putToken('lla_hers', hers(['personal', 'shared']));

    const outcome = await auth.authenticate('Bearer lla_hers');

    expect(outcome.ok && outcome.principal.kind).toBe('member');
    expect(outcome.ok && outcome.principal.id).toBe('lanes:HER');
    expect(outcome.ok && outcome.principal.profiles).toEqual(['personal', 'added-since']);
  });

  test('a member removed since the mint is refused, which ends the session', async () => {
    // Renamed from "a subject with no profiles reaches nothing", because that is
    // no longer what happens and the old name would keep passing while meaning
    // the opposite. An empty list is not a principal reaching nothing any more;
    // it is a refusal. `OAuthServer.callback` will not mint a token for a member
    // of nothing, so an issued token resolving to empty can only mean membership
    // was removed since — a revocation, and 401 is what tells the client to
    // re-authorise and meet the mint's own explanation of why it cannot.
    //
    // **This is scoped to this credential**, and the two describes below pin
    // that: for an OIDC token and a signed key an empty list has always been an
    // ordinary non-error, because neither has a mint gate and empty may always
    // have meant "never had any reach".
    const { store, auth } = authenticator(async () => []);
    await store.putToken('lla_removed', hers([]));

    expect(await auth.authenticate('Bearer lla_removed')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  test('a resolver that throws fails closed, and says nothing more than the rest', async () => {
    // A different branch in the code from the empty case above, and the same
    // answer on the wire. `AuthOutcome`'s reasons are a closed set and both of
    // these have to be a 401; a sixth value would leak "you exist but reach
    // nothing" into a header, which is the disclosure property ADR-082 rests on.
    // `workspaceMembers` only throws once it has no last-known-good answer at
    // all, so in practice this is a boot against an unreachable workspace.
    const { store, auth } = authenticator(async () => {
      throw new Error('the workspace is unreachable');
    });
    await store.putToken('lla_hers', hers(['personal']));

    expect(await auth.authenticate('Bearer lla_hers')).toEqual({ ok: false, reason: 'invalid' });
  });

  test('one token answers differently as the member list moves, with no re-mint', async () => {
    // The whole claim, in one test: three answers from one credential, with no
    // reconnect and no new code minted. Driven off a mutable set rather than
    // three authenticators, so what changes is the workspace rather than the
    // thing under test — and the last step is the direction that matters, since
    // a revocation landing later than a grant is the security property failing.
    const reach = new Set(['personal']);
    const { store, auth } = authenticator(async () => [...reach]);
    await store.putToken('lla_hers', hers(['personal']));

    const first = await auth.authenticate('Bearer lla_hers');
    expect(first.ok && first.principal.profiles).toEqual(['personal']);

    reach.add('work');
    const widened = await auth.authenticate('Bearer lla_hers');
    expect(widened.ok && widened.principal.profiles).toEqual(['personal', 'work']);

    reach.clear();
    expect(await auth.authenticate('Bearer lla_hers')).toEqual({ ok: false, reason: 'invalid' });
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
  function counting(now?: () => number): {
    store: OAuthStore;
    /** A second instance over the same rows — what another warm instance is. */
    elsewhere: OAuthStore;
    reads: () => number;
  } {
    const inner = memoryStore();
    let reads = 0;
    const counted: KeyValueStore = {
      ...inner,
      get: async (namespace, key) => {
        reads++;
        return inner.get(namespace, key);
      },
    };
    return {
      store: new OAuthStore(counted, now),
      elsewhere: new OAuthStore(counted, now),
      reads: () => reads,
    };
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

  /**
   * The assumption the window exists for, and the one the record's own expiry
   * could never have covered.
   *
   * `revokeToken` clears this map in whichever process runs it. A revocation
   * from the CLI writes the shared workspace store and cannot reach a running
   * endpoint's copy; the store is built once and ADR-029 does not rebuild the
   * authorization gate on a reload. So before the window, a cached record
   * survived every reload for its full `access_token_ttl_minutes` — twelve
   * hours by default — and nothing could end a session on a warm instance.
   */
  test('a revocation from another instance lands within the window', async () => {
    let clock = 1_000_000;
    const { store, elsewhere } = counting(() => clock);
    // Twelve hours, the default TTL: the point is that the record is nowhere
    // near its own expiry, so expiry cannot be what stops it resolving.
    await store.putToken('tok', record(clock + 12 * 3_600_000));
    expect(await store.token('tok')).not.toBeNull();

    await elsewhere.revokeToken('tok');

    // Still answered from memory, and that is the honest cost rather than a
    // defect: the window is a real staleness, bounded instead of unbounded.
    expect(await store.token('tok')).not.toBeNull();

    // **Ten seconds, not `SEEN_TTL_MS`.** Advancing by the constant makes the
    // test pass for the wrong reason: widen the window and the same jump also
    // clears the record's own twelve hours, so the expiry path returns null and
    // nothing is proven. This number has to sit above the window and far below
    // the expiry, and the guard keeps it there if the constant moves.
    expect(SEEN_TTL_MS).toBeLessThan(10_000);
    clock += 10_000;

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

/**
 * What an API key the dashboard minted turns into.
 *
 * The resolution is the same shape as the two above and is not what these tests
 * are for. What is different, and what the first two cases hold, is that this is
 * the only link whose credential was signed by an issuer serving every Lanes
 * endpoint — so the audience is the only thing making a key mean *this* endpoint,
 * and a caller that does not say which endpoint was addressed must be refused
 * rather than trusted.
 */

/** A verifier that answers from a table, and records the audience it was given. */
function stubKeyVerifier(
  answers: Record<string, string>,
  seen?: { audience?: string },
): ApiKeyVerifier {
  return {
    verify: async (token: string, expected: { audience: string }) => {
      if (seen) seen.audience = expected.audience;
      const subject = answers[token];
      return subject ? { subject, email: null } : null;
    },
  } as unknown as ApiKeyVerifier;
}

describe('an API key the API signed', () => {
  const SUBJECT = 'lanes:EXAMPLEUID00000000000000000';
  const ADDRESSED = { resource: 'https://link.example.com/mcp' };

  test('reaches only the profiles whose members: name its subject', async () => {
    const auth = new LanesKeyAuthenticator(
      stubKeyVerifier({ theirs: SUBJECT }),
      'personal',
      async (subject) => (subject === SUBJECT ? ['personal'] : []),
    );

    const outcome = await auth.authenticate('Bearer theirs', ADDRESSED);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.principal.id).toBe(SUBJECT);
    expect(outcome.principal.kind).toBe('member');
    expect(outcome.principal.profiles).toEqual(['personal']);
    expect(mayReach(outcome.principal, 'personal')).toBe(true);
    expect(mayReach(outcome.principal, 'work')).toBe(false);
  });

  test('is refused when the caller did not say which endpoint was addressed', async () => {
    // Fail closed. Verifying without an audience would accept a key minted for
    // any endpoint the same issuer signs for, which is the whole reason the
    // audience is checked at all.
    const auth = new LanesKeyAuthenticator(
      stubKeyVerifier({ theirs: SUBJECT }),
      'personal',
      async () => ['personal'],
    );

    const outcome = await auth.authenticate('Bearer theirs');

    expect(outcome).toEqual({ ok: false, reason: 'invalid' });
  });

  test('checks the key against the endpoint the request named', async () => {
    const seen: { audience?: string } = {};
    const auth = new LanesKeyAuthenticator(
      stubKeyVerifier({ theirs: SUBJECT }, seen),
      'personal',
      async () => ['personal'],
    );

    await auth.authenticate('Bearer theirs', ADDRESSED);

    expect(seen.audience).toBe('https://link.example.com/mcp');
  });

  test('a subject no profile names reaches nothing, and that is not an error', async () => {
    const auth = new LanesKeyAuthenticator(
      stubKeyVerifier({ theirs: SUBJECT }),
      'personal',
      async () => [],
    );

    const outcome = await auth.authenticate('Bearer theirs', ADDRESSED);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.principal.profiles).toEqual([]);
    expect(outcome.principal.profiles).not.toBe(EVERY_PROFILE);
    expect(mayReach(outcome.principal, 'personal')).toBe(false);
  });

  test('a key the verifier does not believe is invalid, not missing', async () => {
    const auth = new LanesKeyAuthenticator(stubKeyVerifier({}), 'personal', async () => ['personal']);

    expect(await auth.authenticate('Bearer nope', ADDRESSED)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  test('a member lookup that throws fails closed', async () => {
    // The alternative is a bucket outage widening what a key reaches, which is
    // the direction nothing here is allowed to fail in.
    const auth = new LanesKeyAuthenticator(
      stubKeyVerifier({ theirs: SUBJECT }),
      'personal',
      async () => {
        throw new Error('the store is unreachable');
      },
    );

    expect(await auth.authenticate('Bearer theirs', ADDRESSED)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  test('no credential is missing, and a malformed one says so', async () => {
    const auth = new LanesKeyAuthenticator(stubKeyVerifier({}), 'personal', async () => []);

    expect(await auth.authenticate(null, ADDRESSED)).toEqual({ ok: false, reason: 'missing' });
    expect(await auth.authenticate('Basic abc', ADDRESSED)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
