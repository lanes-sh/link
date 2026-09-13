import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryCredentials } from '#stores/state/testing.ts';
import { VAULT_KEY_REF, createSecretVaultStore } from './vault.ts';

/**
 * The vault as one entry in the secret store.
 *
 * The interesting assertions are not that it round-trips — every adapter does
 * — but that putting it in the credential store's backend did not merge the
 * two stores. What keeps them apart is the key, and these check that the key
 * is doing that work.
 */

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const env = { LANES_LINK_VAULT_KEY: KEY };

function open(store: ReturnType<typeof createMemoryCredentials>, ref?: string) {
  return createSecretVaultStore({ store, env, ...(ref ? { ref } : {}) });
}

describe('the vault in a secret store', () => {
  let credentials: ReturnType<typeof createMemoryCredentials>;

  beforeEach(() => {
    credentials = createMemoryCredentials();
  });

  test('an item round-trips through one secret', async () => {
    const vault = open(credentials);
    await vault.put('main', { id: 'stripe', value: 'sk_live_x', description: 'Billing' });

    const read = await open(credentials).get('main', 'stripe');
    expect(read?.value).toBe('sk_live_x');
    expect(read?.description).toBe('Billing');

    // One document, one ref — not one secret per item.
    expect(await credentials.list()).toEqual(['vault/document']);
  });

  test('the ref is configurable', async () => {
    const vault = open(credentials, 'vault/personal');
    await vault.put('main', { id: 'stripe', value: 'sk_live_x' });
    expect(await credentials.list()).toEqual(['vault/personal']);
  });

  test('what lands in the secret store is ciphertext, not the value', async () => {
    // This is the whole argument for the adapter being acceptable. If the
    // stored document contained the value, putting the vault in the credential
    // store's backend really would have collapsed the two.
    const vault = open(credentials);
    await vault.put('main', { id: 'stripe', value: 'sk_live_SUPERSECRET', description: 'Billing' });

    const stored = (await credentials.get('vault/document'))!;
    expect(stored).not.toContain('sk_live_SUPERSECRET');
    expect(stored).not.toContain('Billing');
    // And the item's *name* is inside the sealed document too, which is why
    // this is one secret rather than one per item.
    expect(stored).not.toContain('stripe');
  });

  test('a different key cannot read it', async () => {
    await open(credentials).put('main', { id: 'stripe', value: 'sk_live_x' });

    const other = createSecretVaultStore({
      store: credentials,
      env: { LANES_LINK_VAULT_KEY: Buffer.from(new Uint8Array(32).fill(9)).toString('base64') },
    });

    await expect(other.get('main', 'stripe')).rejects.toThrow();
  });

  test('without LANES_LINK_VAULT_KEY it refuses rather than minting one', async () => {
    // A file vault may mint a key beside the document. This one must not:
    // there is nowhere to put it that is not the store it is protecting.
    const vault = createSecretVaultStore({ store: credentials, env: {} });
    await expect(vault.put('main', { id: 'x', value: 'y' })).rejects.toThrow(
      /LANES_LINK_VAULT_KEY/,
    );
  });

  test('ids lists names without reading values', async () => {
    const vault = open(credentials);
    await vault.put('main', { id: 'stripe', value: 'a' });
    await vault.put('main', { id: 'openai', value: 'b' });

    expect((await vault.ids()).map((item) => item.id).sort()).toEqual(['openai', 'stripe']);
  });

  test('delete reports whether anything went', async () => {
    const vault = open(credentials);
    await vault.put('main', { id: 'stripe', value: 'a' });

    expect(await vault.delete('main', 'stripe')).toBe(true);
    expect(await vault.delete('main', 'stripe')).toBe(false);
    expect(await vault.get('main', 'stripe')).toBeNull();
  });

  test('an oversized document is refused with the limit, not a REST error', async () => {
    const vault = createSecretVaultStore({ store: credentials, env });
    await expect(
      vault.put('main', { id: 'huge', value: 'x'.repeat(70 * 1024) }),
    ).rejects.toThrow(/over the 65536-byte limit/);
  });

  test('a missing document reads as an empty vault', async () => {
    expect(await open(credentials).get('main', 'nothing')).toBeNull();
    expect(await open(credentials).ids()).toEqual([]);
  });
});

/**
 * Where the key comes from when the caller is not the revision.
 *
 * A deployment has `LANES_LINK_VAULT_KEY` mounted from `vault/key` and never
 * reaches past the environment. The CLI has no such mount and, until this, no
 * way to resolve one — while holding the very store `vault/key` is in. These
 * pin the order, the laziness, and the two failures that must not be confused.
 */
describe('a key the target keeps', () => {
  const STORED = Buffer.from(new Uint8Array(32).fill(11)).toString('base64');
  let credentials: ReturnType<typeof createMemoryCredentials>;

  function stored(get?: (ref: string) => Promise<string | null>) {
    return {
      ref: VAULT_KEY_REF,
      get: get ?? ((ref: string) => credentials.get(ref)),
      describeStore: "this target's credential store",
    };
  }

  beforeEach(async () => {
    credentials = createMemoryCredentials();
    await credentials.set(VAULT_KEY_REF, STORED);
  });

  test('opens a vault the deployment minted, with nothing in the environment', async () => {
    const vault = createSecretVaultStore({ store: credentials, env: {}, stored: stored() });
    await vault.put('main', { id: 'stripe', value: 'sk_live_x' });

    const read = await createSecretVaultStore({
      store: credentials,
      env: {},
      stored: stored(),
    }).get('main', 'stripe');
    expect(read?.value).toBe('sk_live_x');
  });

  test('the environment still wins, so a revision resolves as it always did', async () => {
    // Sealed under the mounted key while the store holds a different one. The
    // reader below has only the stored key, so a successful read would mean the
    // environment had been skipped.
    await createSecretVaultStore({ store: credentials, env, stored: stored() }).put('main', {
      id: 'stripe',
      value: 'sk_live_x',
    });

    await expect(
      createSecretVaultStore({ store: credentials, env: {}, stored: stored() }).get(
        'main',
        'stripe',
      ),
    ).rejects.toThrow();
  });

  test('the store is not asked until a document actually needs opening', async () => {
    // The cost that would otherwise land on every request a deployment serves,
    // including the ones with no interest in a vault.
    let reads = 0;
    const counted = stored(async (ref) => {
      reads += 1;
      return credentials.get(ref);
    });

    const empty = createSecretVaultStore({ store: credentials, env: {}, stored: counted });
    expect(await empty.ids()).toEqual([]);
    expect(reads).toBe(0);

    const vault = createSecretVaultStore({ store: credentials, env: {}, stored: counted });
    await vault.put('main', { id: 'stripe', value: 'a' });
    await vault.get('main', 'stripe');
    await vault.ids();
    // Resolved once and cached, not once per operation.
    expect(reads).toBe(1);
  });

  test('a key that cannot be read is not reported as a key that is not there', async () => {
    // Secret Manager answers a missing binding with 403 rather than 404, so an
    // identity cannot enumerate secrets by their error codes. The two have
    // different fixes and must not arrive as one sentence.
    const denied = stored(async () => {
      throw new Error('403 permission denied');
    });

    await expect(
      createSecretVaultStore({ store: credentials, env: {}, stored: denied }).put('main', {
        id: 'x',
        value: 'y',
      }),
    ).rejects.toThrow(/could not be read.*granted/s);
  });

  test('with no key anywhere the refusal names where it looked', async () => {
    const bare = createMemoryCredentials();
    const vault = createSecretVaultStore({
      store: bare,
      env: {},
      stored: { ref: VAULT_KEY_REF, get: (ref) => bare.get(ref), describeStore: 'the store' },
      remedy: 'lanes link deploy --workspace cloud',
    });

    await expect(vault.put('main', { id: 'x', value: 'y' })).rejects.toThrow(
      /"vault\/key" in the store holds no key either.*lanes link deploy --workspace cloud/s,
    );
  });

  test('a stored key of the wrong length says so, naming the ref', async () => {
    const short = createMemoryCredentials();
    await short.set(VAULT_KEY_REF, Buffer.from(new Uint8Array(16)).toString('base64'));

    await expect(
      createSecretVaultStore({
        store: short,
        env: {},
        stored: { ref: VAULT_KEY_REF, get: (ref) => short.get(ref), describeStore: 'the store' },
      }).put('main', { id: 'x', value: 'y' }),
    ).rejects.toThrow(/vault\/key must decode to 32 bytes, got 16/);
  });
});
