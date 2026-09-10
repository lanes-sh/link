import { describe, expect, test } from 'bun:test';
import { IssuedTokenAuthenticator } from './remote.ts';
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
  test('is the owner, so one minted before this release keeps working', async () => {
    // Not a fallback to be tidied away. Every token issued by 0.7 has no
    // subject, and reading that as "no profiles" would log every connector out
    // on upgrade.
    const { store, auth } = authenticator();
    await store.putToken('lla_old', {
      clientId: 'llc_x',
      kind: 'access',
      scope: 'mcp',
      family: 'llf_x',
      expiresAt: HOUR,
    });

    const outcome = await auth.authenticate('Bearer lla_old');

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.principal.kind).toBe('owner');
    expect(outcome.ok && outcome.principal.profiles).toBeUndefined();
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
    // The direction this has to fail in. `profiles: undefined` means "the whole
    // workspace" — so a row that lost its list must not read as one that never
    // had one.
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
