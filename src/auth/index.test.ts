import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSecretStore, generateCredentialKey, type SecretStore } from '#secrets';
import {
  AuthenticatorChain,
  BearerAuthenticator,
  generateProfileToken,
  machinePrincipal,
  mayReach,
  parseBearer,
  tokensMatch,
  type AuthContext,
  type Authenticator,
  type AuthOutcome,
} from './index.ts';

/**
 * A store where the named refs throw instead of answering.
 *
 * What a missing Secret Manager binding actually looks like: the adapter
 * answers null for a 404 and *throws* for a 403, because a missing binding is
 * denied rather than absent. A bare `Error` with the status only in its
 * message, because that is what the adapter constructs.
 */
function storeRefusing(entries: Record<string, string>, denied: readonly string[]): SecretStore {
  const base = storeWith(entries);
  return {
    ...base,
    async get(ref) {
      if (denied.includes(ref)) {
        throw new Error(
          `Secret Manager could not read ${ref} (HTTP 403). PERMISSION_DENIED: ` +
            'Permission "secretmanager.versions.access" denied',
        );
      }
      return base.get(ref);
    },
  };
}

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
      credentials?: SecretStore;
      profilesFor?: (subject: string) => Promise<readonly string[]>;
      now?: () => number;
      rows?: readonly { id: string; subject: string; ref: string }[];
      report?: (message: string) => void;
    } = {},
  ) => ({
    profile: 'personal',
    tokens: async () =>
      overrides.rows ?? [{ id: 'tok1', subject: SUBJECT, ref: 'tokens/tok1' }],
    credentials: overrides.credentials ?? storeWith({ 'tokens/tok1': 'llk_correct' }),
    profilesFor: overrides.profilesFor ?? (async () => ['personal']),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.report ? { report: overrides.report } : {}),
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

/**
 * How often the store is asked, which is the whole cost of this class.
 *
 * The re-read on a cached miss is deliberate and stays: it is what makes a
 * token rotated in a moment ago work on its first call rather than after the
 * window. What was not deliberate is that on a healthy deployed endpoint the
 * condition guarding it was *always* true.
 *
 * A hosted connector presents an OAuth token, which the next link in the chain
 * handles. It can never match a row here. But it reached the same comparison,
 * missed as any non-row would, and triggered the re-read — a bucket read, a
 * YAML parse and a schema validation of the whole connections file, per
 * request, to re-confirm a list that was already known to be empty.
 */
describe('how often the credential store is read', () => {
  const SUBJECT = 'lanes:abc123';

  function counting(rows: readonly { id: string; subject: string; ref: string }[]) {
    let reads = 0;
    return {
      reads: () => reads,
      options: {
        profile: 'personal',
        tokens: async () => {
          reads++;
          return rows;
        },
        credentials: storeWith({ 'tokens/tok1': 'llk_correct' }),
        profilesFor: async () => ['personal'],
      },
    };
  }

  test('a token that cannot be one of ours is not looked up twice', async () => {
    const { reads, options } = counting([{ id: 'tok1', subject: SUBJECT, ref: 'tokens/tok1' }]);
    const auth = new BearerAuthenticator(options);

    // Warms the cache, and legitimately reads once.
    await auth.authenticate('Bearer llk_correct');
    const warm = reads();

    // An OAuth-shaped credential, of the kind every hosted connector presents.
    await auth.authenticate('Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.x.y');
    await auth.authenticate('Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.x.y');

    expect(reads()).toBe(warm);
  });

  /**
   * And the behaviour that condition exists for is untouched: a token that
   * *could* be one of ours and is not in the cached set still costs the one
   * re-read, because it might have been issued since.
   */
  test('a token that could be ours is still re-read for once', async () => {
    const { reads, options } = counting([{ id: 'tok1', subject: SUBJECT, ref: 'tokens/tok1' }]);
    const auth = new BearerAuthenticator(options);

    await auth.authenticate('Bearer llk_correct');
    const warm = reads();

    await auth.authenticate('Bearer llk_rotated_in_a_moment_ago');

    expect(reads()).toBe(warm + 1);
  });
});

/**
 * What the chain does with the context, which is the contract the key link needs.
 *
 * `LanesKeyAuthenticator` refuses when it is not told which endpoint was
 * addressed, so a chain that accepted a context and forwarded nothing would turn
 * every API key into a refusal — and it would do it silently, because a refused
 * key is indistinguishable from a wrong one from outside. Hence a test of the
 * forwarding itself rather than only of the links.
 */
describe('the chain and the context', () => {
  /** A link that records what it was asked and answers from a fixed verdict. */
  function recording(outcome: AuthOutcome): {
    link: Authenticator;
    seen: { context?: AuthContext | undefined; calls: number };
  } {
    const seen: { context?: AuthContext | undefined; calls: number } = { calls: 0 };
    return {
      seen,
      link: {
        authenticate: async (_header, context) => {
          seen.calls += 1;
          seen.context = context;
          return outcome;
        },
      },
    };
  }

  const ADDRESSED: AuthContext = { resource: 'https://link.example.com/mcp' };

  test('every link is told which endpoint was addressed', async () => {
    const first = recording({ ok: false, reason: 'invalid' });
    const second = recording({ ok: false, reason: 'invalid' });

    await new AuthenticatorChain([first.link, second.link]).authenticate('Bearer x', ADDRESSED);

    expect(first.seen.context).toEqual(ADDRESSED);
    expect(second.seen.context).toEqual(ADDRESSED);
  });

  test('a caller that names no endpoint forwards that, rather than inventing one', async () => {
    const only = recording({ ok: false, reason: 'invalid' });

    await new AuthenticatorChain([only.link]).authenticate('Bearer x');

    expect(only.seen.context).toBeUndefined();
  });

  test('the first link to recognise the credential still wins, and later ones are not asked', async () => {
    const yes = recording({
      ok: true,
      principal: { id: 'lanes:EXAMPLE', profile: 'personal', kind: 'machine', profiles: ['personal'] },
    });
    const never = recording({ ok: false, reason: 'invalid' });

    const outcome = await new AuthenticatorChain([yes.link, never.link]).authenticate(
      'Bearer x',
      ADDRESSED,
    );

    expect(outcome.ok).toBe(true);
    expect(never.seen.calls).toBe(0);
  });
});

describe('a credential that cannot be read', () => {
  /**
   * The endpoint went down for everyone because one row was unreadable.
   *
   * Issuing a token against a deployed target created the secret container but
   * not the resource-level grant that lets the runtime identity read it. Secret
   * Manager answers a missing binding with 403 rather than 404 — so that an
   * identity cannot enumerate secrets by their error codes — and the adapter
   * returns null for the 404 and throws for the 403. The throw left `#reload`,
   * left `authenticate`, left the chain, and every caller was refused,
   * including the token that had been working.
   *
   * The rule these hold is `openReconciled`'s, one layer down: what cannot be
   * read is skipped and said out loud, not allowed to answer for everyone else.
   */
  const SUBJECT = 'lanes:abc123';
  const TWO_ROWS = [
    { id: 'tok1', subject: SUBJECT, ref: 'tokens/tok1' },
    { id: 'tok2', subject: SUBJECT, ref: 'tokens/tok2' },
  ];

  const withRefusal = (overrides: { report?: (message: string) => void } = {}) => ({
    profile: 'personal',
    tokens: async () => TWO_ROWS,
    credentials: storeRefusing({ 'tokens/tok2': 'llk_good' }, ['tokens/tok1']),
    profilesFor: async () => ['personal'],
    ...(overrides.report ? { report: overrides.report } : {}),
  });

  test('the row beside it still authenticates', async () => {
    const auth = new BearerAuthenticator(withRefusal());

    const outcome = await auth.authenticate('Bearer llk_good');

    expect(outcome.ok).toBe(true);
  });

  test('a wrong token is still refused, rather than excused by the unreadable row', async () => {
    const auth = new BearerAuthenticator(withRefusal());

    expect(await auth.authenticate('Bearer llk_wrong')).toEqual({ ok: false, reason: 'invalid' });
  });

  test('every row unreadable refuses, rather than throwing', async () => {
    const auth = new BearerAuthenticator({
      profile: 'personal',
      tokens: async () => TWO_ROWS,
      credentials: storeRefusing({}, ['tokens/tok1', 'tokens/tok2']),
      profilesFor: async () => ['personal'],
    });

    // `not_configured` rather than a fourth reason: from here it is
    // indistinguishable from a workspace that has issued nothing, and the
    // report below is what carries the difference to whoever can act on it.
    expect(await auth.authenticate('Bearer llk_good')).toEqual({
      ok: false,
      reason: 'not_configured',
    });
  });

  test('the unreadable row is named, with what the store said', async () => {
    const said: string[] = [];
    const auth = new BearerAuthenticator(withRefusal({ report: (m) => said.push(m) }));

    await auth.authenticate('Bearer llk_good');

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('tok1');
    expect(said[0]).toContain('PERMISSION_DENIED');
    // The row that reads fine is not named, or the line stops being a list of
    // what is wrong.
    expect(said[0]).not.toContain('tok2');
  });

  test('a standing fault is said once, not on every reload', async () => {
    let clock = 0;
    const said: string[] = [];
    const auth = new BearerAuthenticator({
      ...withRefusal({ report: (m) => said.push(m) }),
      now: () => clock,
    });

    await auth.authenticate('Bearer llk_good');
    clock += 10_000; // past the cache window, so the next call re-reads
    await auth.authenticate('Bearer llk_good');
    clock += 10_000;
    await auth.authenticate('Bearer llk_good');

    // Three reads, one line. A grant nobody has fixed yet is a read every five
    // seconds, and a line each time would bury the one that mattered.
    expect(said).toHaveLength(1);
  });

  test('a row that becomes readable is not reported again', async () => {
    let clock = 0;
    let denied = ['tokens/tok1'];
    const said: string[] = [];
    const auth = new BearerAuthenticator({
      profile: 'personal',
      tokens: async () => TWO_ROWS,
      credentials: {
        ...storeWith({ 'tokens/tok1': 'llk_first', 'tokens/tok2': 'llk_good' }),
        async get(ref) {
          if (denied.includes(ref)) throw new Error(`denied ${ref}`);
          return ref === 'tokens/tok1' ? 'llk_first' : 'llk_good';
        },
      },
      profilesFor: async () => ['personal'],
      report: (m) => said.push(m),
      now: () => clock,
    });

    await auth.authenticate('Bearer llk_good');
    expect(said).toHaveLength(1);

    denied = [];
    clock += 10_000;

    // The grant landed: the row it was refusing now opens the endpoint, and
    // nothing new is said about it.
    expect((await auth.authenticate('Bearer llk_first')).ok).toBe(true);
    expect(said).toHaveLength(1);
  });

  test('a later link in the chain is still reached', async () => {
    // The amplification, and the reason this was worth fixing on its own
    // merits. This link runs first and is unconditional, so before the skip a
    // single unreadable static row refused the OAuth tokens and the
    // Lanes-signed keys behind it — credentials that have nothing to do with
    // the store that failed, and that never got asked.
    const signed: Authenticator = {
      authenticate: async () => ({
        ok: true,
        principal: {
          id: 'lanes:signed',
          profile: 'personal',
          kind: 'machine',
          profiles: ['personal'],
        },
      }),
    };

    const chain = new AuthenticatorChain([
      new BearerAuthenticator({
        profile: 'personal',
        tokens: async () => TWO_ROWS,
        credentials: storeRefusing({}, ['tokens/tok1', 'tokens/tok2']),
        profilesFor: async () => ['personal'],
      }),
      signed,
    ]);

    const outcome = await chain.authenticate('Bearer a.signed.jwt');

    expect(outcome.ok).toBe(true);
  });
});
