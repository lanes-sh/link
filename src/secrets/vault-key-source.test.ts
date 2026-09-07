import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { createMemoryCredentials } from '#stores/state/testing.ts';
import { createBlobVaultStore, createSecretVaultStore } from './vault.ts';

/**
 * Where a deployed vault's key comes from, when one process serves more than
 * one workspace.
 *
 * `LANES_LINK_VAULT_KEY` is process-global, which is exactly right for a
 * self-hosted deploy: one process, one workspace, one key, delivered by
 * `--set-secrets`. A Lanes-hosted runtime serves many workspaces from one
 * process, and a process-global key there means one key opens every tenant's
 * vault — so a single leak is total, and rotating one workspace's key is not
 * expressible at all.
 *
 * `encryptionKey` already accepts a resolved key, and is the wrong shape for
 * this: a host would have to fetch every workspace's key before building a
 * store that may never touch the vault, turning an unused surface into a
 * Secret Manager round trip on every request and a failure mode for requests
 * that had nothing to do with the vault. A `KeySource` is resolved on first use
 * and cached, which is what these first two tests pin.
 */

const keyOf = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const counting = (fill: number) => {
  let calls = 0;
  return {
    calls: () => calls,
    source: async (): Promise<Uint8Array> => {
      calls += 1;
      return keyOf(fill);
    },
  };
};

describe('a vault key source', () => {
  test('is not consulted until the vault is actually touched', async () => {
    const key = counting(1);

    createBlobVaultStore({
      store: createMemoryBlobStore(),
      env: {},
      keySource: key.source,
    });

    expect(key.calls()).toBe(0);
  });

  test('is resolved once, however many operations follow', async () => {
    const key = counting(1);
    const vault = createBlobVaultStore({
      store: createMemoryBlobStore(),
      env: {},
      keySource: key.source,
    });

    await vault.put('main', { id: 'stripe', value: 'sk_test_x' });
    await vault.get('main', 'stripe');
    await vault.ids();

    expect(key.calls()).toBe(1);
  });

  test('one workspace does not open another workspace vault', async () => {
    // One backend on purpose. Separate roots already keep two workspaces apart;
    // this is the property that still holds when something else has failed and
    // one tenant is looking at another tenant's bytes.
    const blobs = createMemoryBlobStore();

    const first = createBlobVaultStore({ store: blobs, env: {}, keySource: async () => keyOf(1) });
    await first.put('main', { id: 'stripe', value: 'sk_live_first' });

    const second = createBlobVaultStore({ store: blobs, env: {}, keySource: async () => keyOf(2) });
    await expect(second.get('main', 'stripe')).rejects.toThrow();
  });

  test('is preferred over the environment, which a host must not depend on', async () => {
    // A multi-tenant host sets no LANES_LINK_VAULT_KEY. If one were present —
    // left over, or set for something else — a store given its own source must
    // still use that source, or one workspace silently seals under a key
    // another workspace can open.
    const env = { LANES_LINK_VAULT_KEY: Buffer.from(keyOf(9)).toString('base64') };
    const blobs = createMemoryBlobStore();

    const scoped = createBlobVaultStore({ store: blobs, env, keySource: async () => keyOf(1) });
    await scoped.put('main', { id: 'stripe', value: 'sk_live_x' });

    const ambient = createBlobVaultStore({ store: blobs, env });
    await expect(ambient.get('main', 'stripe')).rejects.toThrow();
  });

  test('reaches the secret-backed adapter too', async () => {
    // `secret` is the adapter a deployment actually uses, so a key source that
    // only reached `blob` would leave the deployed path process-global.
    const credentials = createMemoryCredentials();

    const first = createSecretVaultStore({
      store: credentials,
      env: {},
      keySource: async () => keyOf(1),
    });
    await first.put('main', { id: 'stripe', value: 'sk_live_first' });

    const second = createSecretVaultStore({
      store: credentials,
      env: {},
      keySource: async () => keyOf(2),
    });
    await expect(second.get('main', 'stripe')).rejects.toThrow();
  });
});
