import { readdir, readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { isToolResult } from '#connectivity';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import {
  createBlobVaultStore,
  createFileVaultStore,
  createMemoryVaultStore,
} from '#secrets';
import { createVaultProvider } from './provider.ts';
import { harnessFor, textOf } from '../harness.ts';

/**
 * The vault.
 *
 * Three properties, each a decision in ADR-012 §3, and each asserted here
 * because each is the kind of thing that is quietly undone by a later
 * convenience:
 *
 *   1. Per-item policy through the capability name, so the policy engine never
 *      learns about arguments.
 *   2. A separate store under a separate key — never `SecretStore`.
 *   3. Tools only, and no listing: the policy-filtered tool list is the listing.
 */

function vaultWith(items: Record<string, string>, connectionId = 'owner') {
  const store = createMemoryVaultStore();
  const seed = Object.entries(items).map(([id]) => ({ id }));

  return {
    store,
    async build() {
      for (const [id, value] of Object.entries(items)) await store.put(connectionId, { id, value });
      return harnessFor(createVaultProvider({ store, items: seed }), connectionId);
    },
  };
}

describe('per-item policy lives in the capability name', () => {
  test('each stored item gets its own read capability', () => {
    const provider = createVaultProvider({
      store: createMemoryVaultStore(),
      items: [{ id: 'github_token' }, { id: 'bank_api_key' }],
    });

    const names = provider.capabilities.map((capability) => capability.name).sort();

    expect(names).toEqual(['get.bank_api_key', 'get.github_token', 'put', 'remove']);
  });

  test('the resulting ids are patterns policy can already express', () => {
    // `vault.get.github_token` matches literally, and `vault.get.*` narrows —
    // both already handled by `capabilityMatches`, with no policy-engine change
    // and no argument-aware matching, which schema.ts warns against by name.
    const capabilityPattern =
      /^(?:\*|[a-z][a-z0-9_]*\.(?:\*|[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*(?:\.\*)?))$/;

    expect(capabilityPattern.test('vault.get.github_token')).toBe(true);
    expect(capabilityPattern.test('vault.get.*')).toBe(true);
  });

  test('an id the capability grammar could not carry is refused at the door', async () => {
    const { build } = vaultWith({});
    const harness = await build();

    await expect(harness.invoke('put', { id: 'Not-Valid', value: 'x' })).rejects.toThrow(
      /must be lowercase/,
    );
  });

  test('two connections holding the same id contribute one capability', () => {
    const provider = createVaultProvider({
      store: createMemoryVaultStore(),
      items: [{ id: 'token' }, { id: 'token' }],
    });

    expect(provider.capabilities.filter((c) => c.name === 'get.token')).toHaveLength(1);
  });
});

describe('reading an item', () => {
  test('returns the stored value', async () => {
    const harness = await vaultWith({ github_token: 'ghp_secret_value' }).build();

    expect(textOf(await harness.invoke('get.github_token'))).toBe('ghp_secret_value');
  });

  test('a missing item is an error rather than an empty string', async () => {
    const store = createMemoryVaultStore();
    const harness = harnessFor(createVaultProvider({ store, items: [{ id: 'absent' }] }));

    const result = await harness.invoke('get.absent');
    expect(isToolResult(result) && result.isError).toBe(true);
  });

  test('the read takes no arguments at all, so none can be logged', () => {
    const provider = createVaultProvider({
      store: createMemoryVaultStore(),
      items: [{ id: 'token' }],
    });

    const read = provider.capabilities.find((capability) => capability.name === 'get.token')!;
    expect(read.kind).toBe('tool');
    // The item is named by the capability, which the audit event records as
    // `capability` — so there is nothing to redact and nothing to leak.
    expect(read.redact).toBeUndefined();
  });
});

describe('a write cannot hand itself a read', () => {
  test('a newly put item has no read capability until the next start', async () => {
    const store = createMemoryVaultStore();
    const harness = harnessFor(createVaultProvider({ store, items: [] }));

    await harness.invoke('put', { id: 'fresh', value: 'v' });

    // Stored...
    expect((await store.get('owner', 'fresh'))?.value).toBe('v');
    // ...but not readable through this process.
    await expect(harness.invoke('get.fresh')).rejects.toThrow(/not a capability/);

    // The next runtime reads the store and registers it, which is the point at
    // which an operator decides whether policy grants it.
    const restarted = harnessFor(createVaultProvider({ store, items: await store.ids() }));
    expect(textOf(await restarted.invoke('get.fresh'))).toBe('v');
  });

  test('the message says so, rather than leaving it to be discovered', async () => {
    const harness = harnessFor(
      createVaultProvider({ store: createMemoryVaultStore(), items: [] }),
    );

    const text = textOf(await harness.invoke('put', { id: 'fresh', value: 'v' }));

    expect(text).toContain('not readable yet');
    expect(text).toContain('vault.get.fresh');
  });
});

describe('there is no way to enumerate the vault', () => {
  test('no capability lists items', () => {
    const provider = createVaultProvider({
      store: createMemoryVaultStore(),
      items: [{ id: 'a' }, { id: 'b' }],
    });

    const names = provider.capabilities.map((capability) => capability.name);

    expect(names).not.toContain('list');
    expect(names.filter((name) => /list|search|find|keys/.test(name))).toEqual([]);
  });

  test('and no capability is a resource, which would be listable and cacheable', () => {
    const provider = createVaultProvider({
      store: createMemoryVaultStore(),
      items: [{ id: 'a' }],
    });

    expect(provider.capabilities.every((capability) => capability.kind === 'tool')).toBe(true);
  });
});

describe('what reaches the audit log', () => {
  test('a stored value is withheld entirely — not even its length', async () => {
    const provider = createVaultProvider({ store: createMemoryVaultStore(), items: [] });
    const put = provider.capabilities.find((capability) => capability.name === 'put')!;

    const redacted = put.redact!({ id: 'github_token', value: 'ghp_the_actual_secret' });

    expect(redacted['id']).toBe('github_token');
    // `keepKeys` would have produced `<string:21>`. A secret's length is a real
    // disclosure, which is why `redaction({ withhold })` exists.
    expect(redacted['value']).toBe('<withheld>');
    expect(JSON.stringify(redacted)).not.toContain('ghp_');
    expect(JSON.stringify(redacted)).not.toContain('21');
  });

  test('a read annotates the item and its size, never its value', async () => {
    const harness = await vaultWith({ token: 'abcdef' }).build();
    await harness.invoke('get.token');

    expect(harness.annotations()).toEqual({ item: 'token', bytes: 6 });
  });
});

describe('the vault is not the credential store — the boundary asserted in M1', () => {
  test('this provider never names the system credential store', async () => {
    // Asserted by reading the source, because the mistake this prevents is an
    // import someone adds for convenience. `docs/detailed/security.md`: collapsing the
    // two would be the most damaging single mistake available here.
    //
    // The check names the *system* store rather than the whole `#secrets`
    // component, because the two now share one. That is not a weakening: the
    // vault provider needs `VaultStore`, and reaching for `SecretStore` or
    // either of its constructors is what must never happen. Sharing the code
    // that seals a document is the opposite of sharing the key that opens it.
    const forbidden = ['SecretStore', 'createFileSecretStore', 'createBlobSecretStore'];
    const directory = new URL('.', import.meta.url).pathname;
    const files = (await readdir(directory)).filter((name) => name.endsWith('.ts'));

    for (const file of files) {
      const source = await readFile(join(directory, file), 'utf8');
      const imports = source.split('\n').filter((line) => /^\s*import\s/.test(line));

      for (const name of forbidden) {
        expect(imports.join('\n')).not.toContain(name);
      }
    }
  });

  test('the provider declares no credential refs, so its allowlist is empty', async () => {
    const provider = createVaultProvider({ store: createMemoryVaultStore(), items: [] });
    expect(provider.credentialRefs).toBeUndefined();

    const harness = harnessFor(provider);
    // The harness seeds a Gmail refresh token and the profile token. Neither is
    // reachable: a provider gets an allowlist computed by core, not a store.
    await expect(harness.context.credentials.get('acme/main')).rejects.toThrow(/not in scope/);
    await expect(harness.context.credentials.get('profile/token')).rejects.toThrow(/not in scope/);
  });

  test('its file and its key are separate from the credential store’s', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-vault-'));
    const store = createFileVaultStore({ path: join(root, 'personal.vault.enc'), env: {} });

    await store.put('owner', { id: 'token', value: 'the-secret' });

    const written = (await readdir(root)).sort();
    expect(written).toEqual(['personal.vault.enc', 'personal.vault.enc.key']);

    // Encrypted whole-document, so item names are hidden alongside values.
    const contents = await readFile(join(root, 'personal.vault.enc'), 'utf8');
    expect(contents).not.toContain('the-secret');
    expect(contents).not.toContain('token');
    expect(contents).toContain('lanes-link-vault');
  });

  test('a credential store file is refused by name rather than failing obscurely', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-vault-'));
    const path = join(root, 'wrong.enc');
    await Bun.write(
      path,
      JSON.stringify({ magic: 'lanes-link-credentials', version: 1, iv: '', tag: '', ciphertext: '' }),
    );

    const store = createFileVaultStore({ path, env: {} });
    await expect(store.get('owner', 'x')).rejects.toThrow(/not a lanes-link-vault document \(found "lanes-link-credentials"\)/);
  });
});

describe('the file store round-trips', () => {
  test('values survive a reopen, and deletion is durable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-vault-'));
    const path = join(root, 'v.enc');

    const first = createFileVaultStore({ path, env: {} });
    await first.put('owner', { id: 'a', value: 'one', description: 'first' });
    await first.put('work', { id: 'a', value: 'two' });

    const second = createFileVaultStore({ path, env: {} });
    expect((await second.get('owner', 'a'))?.value).toBe('one');
    // Connections do not share an item namespace even under the same id.
    expect((await second.get('work', 'a'))?.value).toBe('two');
    expect(await second.ids()).toEqual([
      { connectionId: 'owner', id: 'a', description: 'first' },
      { connectionId: 'work', id: 'a' },
    ]);

    expect(await second.delete('owner', 'a')).toBe(true);
    expect(await second.delete('owner', 'a')).toBe(false);
    expect(await createFileVaultStore({ path, env: {} }).get('owner', 'a')).toBeNull();
  });

  test('the wrong key is a refusal, never a partial read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-vault-'));
    const path = join(root, 'v.enc');

    await createFileVaultStore({ path, key: new Uint8Array(32).fill(1), env: {} }).put('owner', {
      id: 'a',
      value: 'x',
    });

    const wrong = createFileVaultStore({ path, key: new Uint8Array(32).fill(2), env: {} });
    await expect(wrong.get('owner', 'a')).rejects.toThrow(/could not decrypt/);
  });
});

/**
 * The blob store — what a deployment uses (ADR-014).
 *
 * Before it existed, `openRuntime` built a file store unconditionally, so a
 * Cloud Run instance wrote its vault to a container filesystem and the next
 * revision discarded every item in it without an error to say so.
 */
describe('the blob store keeps the same document, somewhere else', () => {
  const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

  test('round-trips through a blob, under one key', async () => {
    const blobs = createMemoryBlobStore();
    const env = { LANES_LINK_VAULT_KEY: KEY };

    const first = createBlobVaultStore({ store: blobs, env });
    await first.put('owner', { id: 'a', value: 'one', description: 'first' });
    await first.put('work', { id: 'a', value: 'two' });

    const second = createBlobVaultStore({ store: blobs, env });
    expect((await second.get('owner', 'a'))?.value).toBe('one');
    expect((await second.get('work', 'a'))?.value).toBe('two');
    expect(await second.ids()).toEqual([
      { connectionId: 'owner', id: 'a', description: 'first' },
      { connectionId: 'work', id: 'a' },
    ]);

    // One document, so one object — the same envelope the file store writes.
    expect((await blobs.list()).map((blob) => blob.key)).toEqual(['vault.enc']);

    expect(await second.delete('owner', 'a')).toBe(true);
    expect(await createBlobVaultStore({ store: blobs, env }).get('owner', 'a')).toBeNull();
  });

  test('item names are encrypted alongside values, as in a file', async () => {
    // This is why there is no secret-per-item adapter: a secret manager keyed by
    // item id would publish the names into a cloud IAM console.
    const blobs = createMemoryBlobStore();
    await createBlobVaultStore({ store: blobs, env: { LANES_LINK_VAULT_KEY: KEY } }).put('owner', {
      id: 'bank_password',
      value: 'the-secret',
    });

    const written = new TextDecoder().decode((await blobs.get('vault.enc'))!);
    expect(written).not.toContain('the-secret');
    expect(written).not.toContain('bank_password');
    expect(written).toContain('lanes-link-vault');
  });

  test('a document written to a file is readable from a blob under the same key', async () => {
    // The format does not depend on where it landed, which is the property that
    // makes `lanes link secrets push`-shaped migration between targets possible
    // at all.
    const root = await mkdtemp(join(tmpdir(), 'lanes-link-vault-'));
    const path = join(root, 'v.enc');
    const env = { LANES_LINK_VAULT_KEY: KEY };

    await createFileVaultStore({ path, env }).put('owner', { id: 'a', value: 'carried' });

    const blobs = createMemoryBlobStore();
    await blobs.put('vault.enc', new Uint8Array(await readFile(path)));

    expect((await createBlobVaultStore({ store: blobs, env }).get('owner', 'a'))?.value).toBe(
      'carried',
    );
  });

  test('no key refuses to write, naming the fix', async () => {
    // The file store may mint a key because it has a sibling file to keep it in.
    // A deployment does not: a generated key would be lost with the process and
    // take every previously stored item with it, so this refuses instead.
    const store = createBlobVaultStore({ store: createMemoryBlobStore(), env: {} });

    await expect(store.put('owner', { id: 'a', value: 'x' })).rejects.toThrow(
      /LANES_LINK_VAULT_KEY is required.*lanes link vault key generate/s,
    );
  });

  test('no key refuses to read a vault that exists, rather than reporting it empty', async () => {
    // The dangerous case: a deployment that loses its key must not look like a
    // deployment whose vault is simply empty. An unwritten vault does read as
    // empty, and needs no key to say so — there is nothing yet to decrypt.
    const blobs = createMemoryBlobStore();
    await createBlobVaultStore({ store: blobs, env: { LANES_LINK_VAULT_KEY: KEY } }).put('owner', {
      id: 'a',
      value: 'x',
    });

    const keyless = createBlobVaultStore({ store: blobs, env: {} });
    await expect(keyless.get('owner', 'a')).rejects.toThrow(/LANES_LINK_VAULT_KEY is required/);
    await expect(keyless.ids()).rejects.toThrow(/LANES_LINK_VAULT_KEY is required/);

    expect(await createBlobVaultStore({ store: createMemoryBlobStore(), env: {} }).ids()).toEqual(
      [],
    );
  });
});
