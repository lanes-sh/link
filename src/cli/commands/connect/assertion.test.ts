import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineProvider, type ProviderManifest } from '#connectivity';
import { ASSERTION_GRANT } from '#connectivity/auth/index.ts';
import type { SecretStore } from '#secrets';
import type { Prompter } from '../../prompt.ts';
import { authoriseWithKey } from './assertion.ts';

/**
 * Collecting a key, and the two halves that have different lifetimes.
 *
 * The key is one file covering every provider of a vendor and is asked for once
 * per profile; the account it acts as is per connection. Getting that wrong in
 * either direction is a real cost — seven pastes of the same file one way, and
 * a second connection silently inheriting the first's identity the other.
 */

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

const KEY = JSON.stringify({
  type: 'service_account',
  client_email: 'link@my-project.iam.gserviceaccount.example',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n',
  token_uri: 'https://tokens.example.test/token',
});

function manifest(delegation: 'optional' | 'required' = 'optional'): ProviderManifest {
  return defineProvider({
    id: 'vendor_mail',
    name: 'Vendor Mail',
    connector: { kind: 'http', base_url: 'https://api.test', openapi: './t.json' },
    auth: {
      kind: 'oauth',
      registration: 'manual',
      app: 'vendor',
      scopes: ['https://api.test/auth/read'],
      authorize_url: 'https://accounts.example.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.example.com/token',
      assertion: {
        method: 'service_account',
        label: 'Service account key',
        delegation,
        key_ref: 'vendor/key',
        reach: 'only what is shared with it',
        subject_label: 'Account to act as',
        setup: {
          steps: ['Download the key'],
          prompts: [
            { key: 'key', label: 'Path to the key', secret: true, scope: 'shared', credential_ref: 'vendor/key' },
          ],
        },
      },
    },
    setup: {
      prompts: [{ key: 'client_id', label: 'Id', credential_ref: 'vendor/client_id' }],
    },
  });
}

function assertionOf(m: ProviderManifest) {
  return (m.auth as Extract<ProviderManifest['auth'], { kind: 'oauth' }>).assertion!;
}

function memoryStore(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    store: {
      get: async (ref: string) => map.get(ref) ?? null,
      set: async (ref: string, value: string) => void map.set(ref, value),
      has: async (ref: string) => map.has(ref),
      delete: async (ref: string) => void map.delete(ref),
      list: async () => [...map.keys()],
    } as unknown as SecretStore,
    map,
  };
}

/** Answers a queue of questions, and remembers what it was asked. */
function prompter(...answers: string[]): Prompter & { asked: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const next = (question: string): string => {
    asked.push(question);
    return queue.shift() ?? '';
  };

  return {
    asked,
    interactive: true,
    ask: async (question) => next(question),
    askSecret: async (question) => next(question),
    confirm: async () => true,
  };
}

const silent: Prompter = {
  interactive: false,
  ask: async () => '',
  askSecret: async () => '',
  confirm: async () => false,
};

async function keyFileOnDisk(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'assertion-'));
  directories.push(directory);
  const path = join(directory, 'key.json');
  await writeFile(path, KEY);
  return path;
}

const base = (overrides: Record<string, unknown> = {}) => {
  const m = manifest();
  return {
    manifest: m,
    assertion: assertionOf(m),
    connectionId: 'main',
    changes: [] as string[],
    replace: false,
    ...overrides,
  };
};

describe('the key', () => {
  test('is read from the path the console downloaded it to, and stored by value', async () => {
    const { store, map } = memoryStore();
    const path = await keyFileOnDisk();

    await authoriseWithKey({ ...base(), credentials: store, prompter: prompter(path, '') });

    // The contents, never the path: this credential outlives the machine, and a
    // deployed revision has no such file to read.
    expect(map.get('vendor/key')).toBe(KEY);
  });

  test('is taken verbatim when it was pasted instead', async () => {
    const { store, map } = memoryStore();

    await authoriseWithKey({ ...base(), credentials: store, prompter: prompter(KEY, '') });

    expect(map.get('vendor/key')).toBe(KEY);
  });

  test('is rejected before anything is written when the path is wrong', async () => {
    const { store, map } = memoryStore();

    await expect(
      authoriseWithKey({
        ...base(),
        credentials: store,
        prompter: prompter('/no/such/key.json', ''),
      }),
    ).rejects.toThrow(/No file at/);

    expect(map.size).toBe(0);
  });

  test('is rejected before anything is written when it is the wrong file', async () => {
    const { store, map } = memoryStore();
    const wrong = JSON.stringify({ installed: { client_id: 'x' } });

    await expect(
      authoriseWithKey({ ...base(), credentials: store, prompter: prompter(wrong, '') }),
    ).rejects.toThrow(/client.*file, not an account key/i);

    expect(map.size).toBe(0);
  });

  test('is asked for once, and found already there by the next provider', async () => {
    const { store } = memoryStore({ 'vendor/key': KEY });
    const terminal = prompter('');

    await authoriseWithKey({
      ...base(),
      credentials: store,
      prompter: terminal,
    });

    // Only the subject. Seven providers share one file, and asking again per
    // provider would be seven pastes of the same key.
    expect(terminal.asked).toHaveLength(1);
    expect(terminal.asked[0]).toContain('Account to act as');
  });

  test('is asked for again when the operator says so', async () => {
    const { store, map } = memoryStore({ 'vendor/key': 'stale' });

    await authoriseWithKey({
      ...base({ replace: true }),
      credentials: store,
      prompter: prompter(KEY, ''),
    });

    expect(map.get('vendor/key')).toBe(KEY);
  });

  test('is not asked for again on a first connect, because the key is not per connection', async () => {
    // The bug this pins: `provisional` means "an earlier connect stored
    // something no server accepted", which is true of a per-connection
    // credential and false of a key shared by the whole profile. Testing it
    // here made a stored key unusable — the preflight reported everything
    // present, and the run that followed immediately asked for it.
    const { store } = memoryStore({ 'vendor/key': KEY });
    const terminal = prompter('');

    await authoriseWithKey({ ...base(), credentials: store, prompter: terminal });

    expect(terminal.asked).toHaveLength(1);
    expect(terminal.asked[0]).toContain('Account to act as');
  });
});

describe('the pointer a connection stores', () => {
  test('names the key rather than copying it, so there is one thing to rotate', async () => {
    const { store, map } = memoryStore();

    await authoriseWithKey({ ...base(), credentials: store, prompter: prompter(KEY, '') });

    expect(JSON.parse(map.get('vendor_mail/main')!)).toEqual({
      grant: ASSERTION_GRANT,
      key_ref: 'vendor/key',
    });
  });

  test('carries the account to act as when one was given', async () => {
    const { store, map } = memoryStore({ 'vendor/key': KEY });

    await authoriseWithKey({
      ...base(),
      credentials: store,
      prompter: prompter('someone@example.com'),
    });

    expect(JSON.parse(map.get('vendor_mail/main')!).subject).toBe('someone@example.com');
  });

  test('omits it entirely when the key stands for itself', async () => {
    const { store, map } = memoryStore({ 'vendor/key': KEY });

    await authoriseWithKey({ ...base(), credentials: store, prompter: prompter('') });

    expect('subject' in JSON.parse(map.get('vendor_mail/main')!)).toBe(false);
  });
});

describe('an account this can only reach by acting as someone', () => {
  const required = () => {
    const m = manifest('required');
    return { manifest: m, assertion: assertionOf(m) };
  };

  test('refuses a blank answer, because the alternative reads as empty rather than as an error', async () => {
    const { store } = memoryStore({ 'vendor/key': KEY });
    const { manifest: m, assertion } = required();

    await expect(
      authoriseWithKey({
        manifest: m,
        assertion,
        connectionId: 'main',
        credentials: store,
        changes: [],
        replace: false,
        prompter: prompter(''),
      }),
    ).rejects.toThrow(/would authenticate and then find every mailbox, list and calendar empty/);
  });

  test('refuses a run with nobody to ask, rather than acting as nobody', async () => {
    const { store } = memoryStore({ 'vendor/key': KEY });
    const { manifest: m, assertion } = required();

    await expect(
      authoriseWithKey({
        manifest: m,
        assertion,
        connectionId: 'main',
        credentials: store,
        changes: [],
        replace: false,
        prompter: silent,
      }),
    ).rejects.toThrow(/non-interactive/);
  });
});
