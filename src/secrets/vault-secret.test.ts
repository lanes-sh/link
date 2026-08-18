import { beforeEach, describe, expect, test } from 'bun:test';
import { createMemoryCredentials } from '#stores/state/testing.ts';
import { createSecretVaultStore } from './vault.ts';

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
