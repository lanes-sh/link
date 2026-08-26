import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import type { SecretRef, SecretStore } from '#secrets';
import type { Prompter } from '../../prompt.ts';
import { authorisePastedToken } from './pasted-token.ts';

/**
 * The credential the operator already holds, for a provider that does OAuth.
 *
 * It exists because the browser flow can be refused by somebody who is not in
 * the room: a Slack workspace on Enterprise Grid needs an admin to approve an
 * app before it can authenticate anyone. What these pin is that the paste ends
 * up indistinguishable from a browser grant everywhere downstream — same ref,
 * same shape — because anything else would mean a second path through the
 * dispatcher, and that is the cost this deliberately does not pay.
 */
const manifest = defineProvider({
  id: 'vendor_chat',
  name: 'Vendor Chat',
  connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/mcp' },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: 'vendor',
    scopes: ['chat.read', 'chat.write'],
    authorize_url: 'https://accounts.example.com/authorize',
    token_url: 'https://accounts.example.com/token',
    client_id: 'shipped.1',
    refresh_token: 'optional',
  },
  setup: {
    prompts: [{ key: 'token', label: 'User token', secret: true, scope: 'connection' as const }],
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

describe('a pasted token for an OAuth provider', () => {
  test('lands at the ref the browser flow writes, in the shape it writes', async () => {
    const credentials = memoryStore();

    await authorisePastedToken({
      manifest,
      connectionId: 'pending',
      credentials,
      prompter: answering('xoxp-the-token'),
    });

    const stored = JSON.parse(credentials.seen.get('vendor_chat/pending')!) as Record<
      string,
      unknown
    >;
    expect(stored['access_token']).toBe('xoxp-the-token');
    expect(stored['token_type']).toBe('Bearer');
    expect(stored['authorized_via']).toBe('pasted');
  });

  test('carries neither a refresh token nor an expiry, because it has neither', async () => {
    // This is what makes it free downstream: with no refresh token
    // `upstreamAccessToken` hands the stored value straight back, and with no
    // `expires_at` nothing reports a healthy long-lived token as stale.
    const credentials = memoryStore();

    await authorisePastedToken({
      manifest,
      connectionId: 'pending',
      credentials,
      prompter: answering('xoxp-the-token'),
    });

    const stored = JSON.parse(credentials.seen.get('vendor_chat/pending')!) as Record<
      string,
      unknown
    >;
    expect('refresh_token' in stored).toBe(false);
    expect('expires_at' in stored).toBe(false);
  });

  test('records what was asked for, since what was granted cannot be read back', async () => {
    // The scope gate has nothing to show on this path: what the token can do
    // was decided wherever it was minted. Recorded as a weaker guarantee rather
    // than papered over with a set nobody verified.
    const credentials = memoryStore();

    await authorisePastedToken({
      manifest,
      connectionId: 'pending',
      credentials,
      prompter: answering('xoxp-the-token'),
    });

    const stored = JSON.parse(credentials.seen.get('vendor_chat/pending')!) as Record<
      string,
      unknown
    >;
    expect(stored['scope']).toBe('chat.read chat.write');
  });

  test('refuses where the manifest describes no token to ask for', async () => {
    const noPrompts = defineProvider({
      id: 'vendor_other',
      name: 'Vendor Other',
      connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/mcp' },
      auth: { kind: 'oauth', registration: 'dynamic', scopes: [] },
    });

    await expect(
      authorisePastedToken({
        manifest: noPrompts,
        connectionId: 'pending',
        credentials: memoryStore(),
        prompter: answering('anything'),
      }),
    ).rejects.toThrow(/no pasted-credential path/);
  });
});
