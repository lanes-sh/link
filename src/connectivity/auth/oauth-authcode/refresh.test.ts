import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import type { SecretRef, SecretStore } from '#secrets';
import { refreshDirectly } from './refresh.ts';
import type { CredentialOAuthProvider } from './provider.ts';

/**
 * Where a refresh is sent, which is a property of the token and not the config.
 *
 * A refresh token minted by one OAuth client is refused by another. So an
 * operator who registers a client of their own six months after connecting must
 * not have their existing connections quietly pointed at it — they would all
 * answer `invalid_grant`, and the config change would look unrelated.
 */

const BROKER = { url: 'https://api.example.com/v1/auth/link/vendor', operator: 'Someone' };

const manifest = (broker: object | null = BROKER) =>
  defineProvider({
    id: 'vendor_mail',
    name: 'Vendor Mail',
    connector: { kind: 'http', base_url: 'https://api.test', openapi: './t.json' },
    auth: {
      kind: 'oauth',
      registration: 'manual',
      app: 'vendor',
      scopes: ['a'],
      authorize_url: 'https://accounts.example.com/o/oauth2/v2/auth',
      token_url: 'https://oauth2.example.com/token',
      ...(broker ? { broker } : {}),
    },
    ...(broker
      ? {}
      : {
          setup: {
            prompts: [{ key: 'client_id', label: 'Client id', credential_ref: 'vendor/client_id' }],
          },
        }),
  });

/** A provider whose stored blob is a plain object, so saves are observable. */
function stubProvider(initial: Record<string, unknown>) {
  let blob = { ...initial };
  return {
    provider: {
      tokens: async () => blob,
      saveTokens: async (next: Record<string, unknown>) => void (blob = { ...next }),
    } as unknown as CredentialOAuthProvider,
    current: () => blob,
  };
}

const store = (seed: Record<string, string> = {}): SecretStore => {
  const map = new Map(Object.entries(seed));
  return {
    get: async (ref) => map.get(ref) ?? null,
    set: async (ref, value) => void map.set(ref, value),
    has: async (ref) => map.has(ref),
    delete: async (ref) => void map.delete(ref),
    list: async () => [...map.keys()] as SecretRef[],
  };
};

function recording(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('refreshDirectly', () => {
  test('a token stamped as brokered refreshes through the broker', async () => {
    const { fetch, calls } = recording(200, { success: true, data: { access_token: 'fresh' } });
    const { provider } = stubProvider({
      refresh_token: 'rt',
      id_token: 'idt',
      authorized_via: 'broker',
    });

    await refreshDirectly(manifest(), provider, 'https://oauth2.example.com/token', store(), fetch);

    expect(calls[0]!.url).toBe(`${BROKER.url}/refresh`);
    expect((calls[0]!.init!.headers as Record<string, string>)['authorization']).toBe('Bearer idt');
  });

  test('an unstamped token on a brokered provider still uses the stored client', async () => {
    // The one that matters: a connection made before this feature existed, on a
    // profile that has since stopped declaring its own client. It was minted by
    // the operator's client, so it must keep going there.
    const { fetch, calls } = recording(200, { access_token: 'fresh' });
    const { provider } = stubProvider({ refresh_token: 'rt' });

    await refreshDirectly(
      manifest(),
      provider,
      'https://oauth2.example.com/token',
      store({ 'vendor/client_id': 'id', 'vendor/client_secret': 'secret' }),
      fetch,
    );

    expect(calls[0]!.url).toBe('https://oauth2.example.com/token');
    expect(new URLSearchParams(String(calls[0]!.init!.body)).get('client_secret')).toBe('secret');
  });

  test('a provider with no broker is untouched', async () => {
    const { fetch, calls } = recording(200, { access_token: 'fresh' });
    const { provider } = stubProvider({ refresh_token: 'rt', authorized_via: 'broker' });

    await refreshDirectly(
      manifest(null),
      provider,
      'https://oauth2.example.com/token',
      store({ 'vendor/client_id': 'id', 'vendor/client_secret': 'secret' }),
      fetch,
    );

    expect(calls[0]!.url).toBe('https://oauth2.example.com/token');
  });

  test('the stamp, the assertion, and the refresh token all survive a refresh', async () => {
    // Neither the vendor nor the broker echoes these unless there is a new one.
    // Dropping any of the three leaves the *next* refresh with no token, no
    // attribution, or pointed at the wrong client.
    const { fetch } = recording(200, { success: true, data: { access_token: 'fresh' } });
    const { provider, current } = stubProvider({
      refresh_token: 'rt',
      id_token: 'idt',
      authorized_via: 'broker',
    });

    await refreshDirectly(manifest(), provider, 'https://oauth2.example.com/token', store(), fetch);

    expect(current()).toMatchObject({
      refresh_token: 'rt',
      id_token: 'idt',
      authorized_via: 'broker',
      access_token: 'fresh',
    });
  });

  test('a fresher assertion from the broker replaces the stored one', async () => {
    const { fetch } = recording(200, {
      success: true,
      data: { access_token: 'fresh', id_token: 'newer' },
    });
    const { provider, current } = stubProvider({
      refresh_token: 'rt',
      id_token: 'stale',
      authorized_via: 'broker',
    });

    await refreshDirectly(manifest(), provider, 'https://oauth2.example.com/token', store(), fetch);

    expect(current()['id_token']).toBe('newer');
  });

  test('a broker refusal names the command the owner runs, not the agent', async () => {
    // This reaches an agent mid-request. It must not read as something the
    // agent could do next.
    const { fetch } = recording(403, { success: false, error: 'withdrawn', notice: 'Revoked.' });
    const { provider } = stubProvider({ refresh_token: 'rt', authorized_via: 'broker' });

    const error = (await refreshDirectly(
      manifest(),
      provider,
      'https://oauth2.example.com/token',
      store(),
      fetch,
    ).catch((e) => e)) as Error;

    expect(error.message).toContain('lanes link connect vendor_mail');
    expect(error.message).toContain('Revoked.');
  });

  test('no refresh token at all is said plainly rather than sent anywhere', async () => {
    const { fetch, calls } = recording(200, {});
    const { provider } = stubProvider({ authorized_via: 'broker' });

    await expect(
      refreshDirectly(manifest(), provider, 'https://oauth2.example.com/token', store(), fetch),
    ).rejects.toThrow(/No refresh token stored/);
    expect(calls).toEqual([]);
  });
});
