import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import type { SecretRef, SecretStore } from '#secrets';
import { CredentialOAuthProvider } from './provider.ts';

/**
 * Which grant this asks for, when the SDK asks.
 *
 * `prepareTokenRequest` is optional in the SDK's interface and was
 * unnecessary until the 2.0.0 client: `auth()` exchanged a stored refresh
 * token itself. It now routes every token request through it, so a provider
 * without one can only complete the flow the SDK still has a default for — the
 * authorization code.
 *
 * The consequence was silent and total. Every `mcp` connector using OAuth
 * worked until its first access token expired and then failed permanently,
 * with a message that mentions neither refresh nor expiry: "Either
 * provider.prepareTokenRequest() or authorizationCode is required". Three
 * separate providers were reported unreachable before the shape of it was
 * clear.
 *
 * Half of what follows asserts that this stays quiet, because a token request
 * is not a place to be helpful by default.
 */

const manifest = defineProvider({
  id: 'vendor_notes',
  name: 'Vendor Notes',
  connector: { kind: 'mcp', endpoint: 'https://mcp.example.com/mcp' },
  auth: { kind: 'oauth', registration: 'dynamic' },
});

/** A credential store over a Map, so what is stored is what was written. */
function storeWith(rows: Record<string, unknown>): SecretStore {
  const map = new Map(Object.entries(rows).map(([ref, value]) => [ref, JSON.stringify(value)]));
  return {
    get: async (ref: SecretRef) => map.get(ref) ?? null,
    set: async (ref: SecretRef, value: string) => void map.set(ref, value),
    delete: async (ref: SecretRef) => void map.delete(ref),
    list: async () => [...map.keys()] as SecretRef[],
  } as unknown as SecretStore;
}

function provider(rows: Record<string, unknown>): CredentialOAuthProvider {
  return new CredentialOAuthProvider({
    manifest,
    connectionId: 'con1',
    credentials: storeWith(rows),
  });
}

/** Where `saveTokens` and `tokens` keep their blob for this connection. */
const TOKENS = 'vendor_notes/con1';

describe('what grant a token request asks for', () => {
  test('a stored refresh token becomes a refresh grant', async () => {
    const params = await provider({ [TOKENS]: { refresh_token: 'r1', access_token: 'a1' } })
      .prepareTokenRequest();

    expect(params?.get('grant_type')).toBe('refresh_token');
    expect(params?.get('refresh_token')).toBe('r1');
  });

  /**
   * An omitted scope on a refresh means "the same as before". Naming a narrower
   * one would quietly downgrade the grant, so it is only sent when asked for.
   */
  test('a scope is passed on only when one was given', async () => {
    const stored = { [TOKENS]: { refresh_token: 'r1' } };

    expect((await provider(stored).prepareTokenRequest())?.has('scope')).toBe(false);
    expect((await provider(stored).prepareTokenRequest(''))?.has('scope')).toBe(false);
    expect((await provider(stored).prepareTokenRequest('read'))?.get('scope')).toBe('read');
  });

  /**
   * The one that would be a bug rather than a nuisance.
   *
   * The SDK consults this *before* it looks at the authorization code, so
   * answering with a refresh grant during a genuine re-authorization would
   * spend a refresh token where the caller had just consented in a browser —
   * and the consent would be thrown away. `#codeVerifier` is set for exactly
   * the length of one exchange, which makes it the signal that one is running.
   */
  test('an authorization code in flight is left alone', async () => {
    const during = provider({ [TOKENS]: { refresh_token: 'r1' } });
    during.saveCodeVerifier('pkce-verifier');

    expect(await during.prepareTokenRequest()).toBeUndefined();
  });

  /**
   * And once that exchange is over the verifier is dropped, so the next
   * refresh is prepared normally rather than being shadowed by a flow that has
   * finished.
   */
  test('and is prepared again once that exchange has finished', async () => {
    const after = provider({ [TOKENS]: { refresh_token: 'r1' } });
    after.saveCodeVerifier('pkce-verifier');
    await after.invalidateCredentials('verifier');

    expect((await after.prepareTokenRequest())?.get('grant_type')).toBe('refresh_token');
  });

  /**
   * Nothing stored is a connection that genuinely needs re-consent. Falling
   * through leaves the SDK to start an authorization, which
   * `redirectToAuthorization` turns into `ReauthRequired` naming the command
   * that fixes it — a better answer than a token request that cannot succeed.
   */
  test('no refresh token falls through rather than guessing', async () => {
    expect(await provider({}).prepareTokenRequest()).toBeUndefined();
    expect(await provider({ [TOKENS]: { access_token: 'a1' } }).prepareTokenRequest()).toBeUndefined();
    expect(await provider({ [TOKENS]: { refresh_token: '' } }).prepareTokenRequest()).toBeUndefined();
  });
});
