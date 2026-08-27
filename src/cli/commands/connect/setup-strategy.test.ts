import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import type { SecretRef, SecretStore } from '#secrets';
import type { Prompter } from '../../prompt.ts';
import { ensureStaticCredential } from './setup.ts';

/**
 * The prompt a strategy provider needs, which it did not get.
 *
 * `ensureStaticCredential` returned early for `auth.kind === 'strategy'`, from
 * when the kind was unreachable and the exclusion cost nothing. The first
 * provider to use it made the exclusion exactly backwards: bunq's API key is a
 * pasted value like any other — more so, since the handshake runs *on* it — so
 * an interactive `lanes link connect bunq` stored nothing and then failed
 * inside the handshake, complaining that no key had been stored.
 *
 * Worth its own file because nothing else here covers the shape: the provider
 * that reaches this function without being `bearer`, `api_key`, or `basic`.
 */
const manifest = defineProvider({
  id: 'acme',
  name: 'Acme',
  connector: { kind: 'http', base_url: 'https://api.acme.test/v1', openapi: './acme.json' },
  auth: { kind: 'strategy', strategy: 'handshake' },
  setup: {
    prompts: [{ key: 'api_key', label: 'Acme API key', secret: true, scope: 'connection' as const }],
  },
});

function memoryStore(): SecretStore & { seen: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    seen: map,
    get: async (ref) => map.get(ref) ?? null,
    set: async (ref, value) => void map.set(ref, value),
    has: async (ref) => map.has(ref),
    delete: async (ref) => void map.delete(ref),
    list: async (prefix) =>
      [...map.keys()].filter((k) => !prefix || k.startsWith(prefix)) as SecretRef[],
  };
}

const answering = (value: string): Prompter => ({
  interactive: true,
  ask: async () => value,
  askSecret: async () => value,
  confirm: async () => true,
});

describe('a strategy provider on the interactive path', () => {
  test('is asked for its credential, and it lands at the derived ref', async () => {
    const credentials = memoryStore();

    await ensureStaticCredential({
      manifest,
      connectionId: 'pending',
      credentials,
      replace: false,
      provisional: true,
      prompter: answering('pasted-api-key'),
    });

    // Derived, not declared — bunq issues one key per account, so a
    // `credential_ref` on the manifest would make every connection share one.
    expect(credentials.seen.get('acme/pending')).toBe('pasted-api-key');
  });

  test('is not asked again when the handshake already replaced it', async () => {
    // The re-connect case: what is stored is no longer the pasted key but the
    // whole installed context. Asking again without `--replace` would be a
    // question the operator has already answered.
    const credentials = memoryStore();
    await credentials.set('acme/main', '{"api_key":"k","private_key":"p"}');

    await ensureStaticCredential({
      manifest,
      connectionId: 'main',
      credentials,
      replace: false,
      provisional: false,
      prompter: answering('should-not-be-asked'),
    });

    expect(credentials.seen.get('acme/main')).toBe('{"api_key":"k","private_key":"p"}');
  });

  test('--replace asks again, which is how a rotated key gets in', async () => {
    const credentials = memoryStore();
    await credentials.set('acme/main', 'the-old-key');

    await ensureStaticCredential({
      manifest,
      connectionId: 'main',
      credentials,
      replace: true,
      provisional: false,
      prompter: answering('the-new-key'),
    });

    expect(credentials.seen.get('acme/main')).toBe('the-new-key');
  });
});
