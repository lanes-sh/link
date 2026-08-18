import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSecretStore, generateCredentialKey } from './system.ts';

const roots: string[] = [];

async function storePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-cred-'));
  roots.push(root);
  return join(root, 'personal.credentials.enc');
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const KEY = new Uint8Array(Buffer.from(generateCredentialKey(), 'base64'));

describe('round trip', () => {
  test('stores, reads, lists, and deletes', async () => {
    const path = await storePath();
    const store = createFileSecretStore({ path, key: KEY });

    expect(await store.get('gmail/main')).toBeNull();
    expect(await store.has('gmail/main')).toBe(false);

    await store.set('gmail/main', 'refresh-token-main');
    await store.set('gmail/side', 'refresh-token-side');
    await store.set('profile/token', 'llk_abc');

    expect(await store.get('gmail/main')).toBe('refresh-token-main');
    expect(await store.has('gmail/main')).toBe(true);
    expect(await store.list()).toEqual(['gmail/main', 'gmail/side', 'profile/token']);
    expect(await store.list('gmail/')).toEqual(['gmail/main', 'gmail/side']);

    await store.delete('gmail/side');
    expect(await store.get('gmail/side')).toBeNull();
    expect(await store.list()).toEqual(['gmail/main', 'profile/token']);
  });

  test('survives a reopen with the same key', async () => {
    const path = await storePath();
    await createFileSecretStore({ path, key: KEY }).set('gmail/main', 'refresh-token');

    const reopened = createFileSecretStore({ path, key: KEY });
    expect(await reopened.get('gmail/main')).toBe('refresh-token');
  });

  test('rejects a malformed reference rather than storing it', async () => {
    const store = createFileSecretStore({ path: await storePath(), key: KEY });
    await expect(store.set('nonamespace', 'x')).rejects.toThrow(/Malformed secret reference/);
    await expect(store.get('../escape/x')).rejects.toThrow(/Malformed secret reference/);
  });
});

describe('what actually lands on disk', () => {
  test('neither values nor credential names appear in plaintext', async () => {
    const path = await storePath();
    const store = createFileSecretStore({ path, key: KEY });
    await store.set('gmail/main', 'super-secret-refresh-token');

    const onDisk = await readFile(path, 'utf8');

    expect(onDisk).not.toContain('super-secret-refresh-token');
    // Names are encrypted too: which accounts exist is itself information.
    expect(onDisk).not.toContain('gmail/main');
    expect(onDisk).toContain('lanes-link-credentials');
  });

  test('is written 0600', async () => {
    const path = await storePath();
    await createFileSecretStore({ path, key: KEY }).set('gmail/main', 'x');

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test('uses a fresh IV per write, so identical content does not repeat ciphertext', async () => {
    const path = await storePath();
    const store = createFileSecretStore({ path, key: KEY });

    await store.set('gmail/main', 'same-value');
    const first = JSON.parse(await readFile(path, 'utf8')) as { iv: string; ciphertext: string };

    await store.set('gmail/main', 'same-value');
    const second = JSON.parse(await readFile(path, 'utf8')) as { iv: string; ciphertext: string };

    // IV reuse under GCM is catastrophic, so this is worth asserting directly.
    expect(second.iv).not.toBe(first.iv);
    expect(second.ciphertext).not.toBe(first.ciphertext);
  });
});

describe('key handling', () => {
  test('generates a 0600 key file when no key is supplied', async () => {
    const path = await storePath();
    const store = createFileSecretStore({ path, env: {} });
    await store.set('gmail/main', 'x');

    expect((await stat(`${path}.key`)).mode & 0o777).toBe(0o600);
    expect(await createFileSecretStore({ path, env: {} }).get('gmail/main')).toBe('x');
  });

  test('reads a base64 key from the environment', async () => {
    const path = await storePath();
    const encoded = generateCredentialKey();
    const env = { LANES_LINK_CREDENTIAL_KEY: encoded };

    await createFileSecretStore({ path, env }).set('gmail/main', 'x');
    expect(await createFileSecretStore({ path, env }).get('gmail/main')).toBe('x');
  });

  test('rejects a key of the wrong length rather than padding it', async () => {
    const store = createFileSecretStore({
      path: await storePath(),
      env: { LANES_LINK_CREDENTIAL_KEY: Buffer.from('too-short').toString('base64') },
    });
    await expect(store.set('gmail/main', 'x')).rejects.toThrow(/must decode to 32 bytes/);
  });

  test('the wrong key refuses to decrypt rather than returning garbage', async () => {
    const path = await storePath();
    await createFileSecretStore({ path, key: KEY }).set('gmail/main', 'x');

    const wrongKey = new Uint8Array(Buffer.from(generateCredentialKey(), 'base64'));
    await expect(createFileSecretStore({ path, key: wrongKey }).get('gmail/main')).rejects.toThrow(
      /could not decrypt/,
    );
  });
});

describe('tamper detection', () => {
  test('a modified ciphertext fails authentication instead of being read', async () => {
    const path = await storePath();
    await createFileSecretStore({ path, key: KEY }).set('gmail/main', 'x');

    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
    const bytes = Buffer.from(document['ciphertext']!, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    document['ciphertext'] = bytes.toString('base64');
    await writeFile(path, JSON.stringify(document));

    // GCM is authenticated encryption; this is the property that makes a
    // partial or altered read impossible rather than merely unlikely.
    await expect(createFileSecretStore({ path, key: KEY }).get('gmail/main')).rejects.toThrow(
      /could not decrypt/,
    );
  });

  test('a foreign file is rejected by its magic rather than misparsed', async () => {
    const path = await storePath();
    await writeFile(path, JSON.stringify({ magic: 'something-else', version: 1 }));

    await expect(createFileSecretStore({ path, key: KEY }).get('gmail/main')).rejects.toThrow(
      /not a lanes-link-credentials document/,
    );
  });

  test('an unknown format version is refused rather than guessed at', async () => {
    const path = await storePath();
    await writeFile(
      path,
      JSON.stringify({ magic: 'lanes-link-credentials', version: 99, iv: '', tag: '', ciphertext: '' }),
    );

    await expect(createFileSecretStore({ path, key: KEY }).get('gmail/main')).rejects.toThrow(
      /format version 99/,
    );
  });
});

describe('durability', () => {
  test('leaves no temporary file behind', async () => {
    const path = await storePath();
    const store = createFileSecretStore({ path, key: KEY });
    await store.set('gmail/main', 'x');
    await store.set('gmail/side', 'y');

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(path, '..'));
    expect(entries.filter((name) => name.includes('.tmp'))).toEqual([]);
  });
});
