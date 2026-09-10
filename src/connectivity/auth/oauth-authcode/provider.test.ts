import { beforeEach, describe, expect, test } from 'bun:test';
import type { CredentialOAuthProvider } from './provider.ts';
import { clearUpstreamTokens, distrustUpstreamToken, upstreamAccessToken } from './provider.ts';

/**
 * Which access token goes out, and who gets to say it is dead.
 *
 * The stored `expires_at` is a claim about the future, not a fact. A token can
 * be rejected while our clock still calls it valid — a rotated refresh token, a
 * revoked grant, a superseded token — and until the vendor's answer could be
 * fed back in, every call kept sending the same dead token until the clock
 * caught up. On an hour-long token that is an hour of 401s.
 */

const KEY = 'gmail.main';
const HOUR = 3_600_000;

/** A provider whose stored blob is a plain object, so saves are observable. */
function stubProvider(initial: Record<string, unknown>) {
  let blob = { ...initial };
  return {
    connectionId: 'main',
    tokens: async () => blob,
    saveTokens: async (next: Record<string, unknown>) => void (blob = { ...next }),
  } as unknown as CredentialOAuthProvider;
}

const live = () => ({
  access_token: 'stored-token',
  refresh_token: 'refresh-token',
  expires_at: Date.now() + HOUR,
});

beforeEach(() => {
  clearUpstreamTokens();
});

describe('a token the clock still calls valid', () => {
  test('is reused, and nothing is refreshed', async () => {
    let refreshes = 0;
    const token = await upstreamAccessToken({
      connectionKey: KEY,
      provider: stubProvider(live()),
      refresh: async () => {
        refreshes += 1;
        return { access_token: 'fresh-token', expires_in: 3600 };
      },
    });

    expect(token).toBe('stored-token');
    expect(refreshes).toBe(0);
  });
});

describe('a token the vendor has rejected', () => {
  test('is refreshed on the next call, whatever the stored clock says', async () => {
    // The whole fix. Before this, the stored `expires_at` was the only opinion
    // that counted, so a 401 changed nothing and the next call sent the same
    // dead token.
    const provider = stubProvider(live());
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
      return { access_token: 'fresh-token', expires_in: 3600 };
    };

    expect(await upstreamAccessToken({ connectionKey: KEY, provider, refresh })).toBe(
      'stored-token',
    );

    distrustUpstreamToken(KEY);

    expect(await upstreamAccessToken({ connectionKey: KEY, provider, refresh })).toBe(
      'fresh-token',
    );
    expect(refreshes).toBe(1);
  });

  test('distrust is spent once, so the refreshed token is then trusted', async () => {
    const provider = stubProvider(live());
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
      return { access_token: `fresh-${refreshes}`, expires_in: 3600 };
    };

    distrustUpstreamToken(KEY);
    await upstreamAccessToken({ connectionKey: KEY, provider, refresh });
    await upstreamAccessToken({ connectionKey: KEY, provider, refresh });

    // A flag that stuck would refresh on every call for the rest of the process.
    expect(refreshes).toBe(1);
  });

  test('one connection being rejected does not disturb another', async () => {
    const refresh = async () => ({ access_token: 'fresh-token', expires_in: 3600 });
    const other = stubProvider(live());

    await upstreamAccessToken({ connectionKey: 'gmail.other', provider: other, refresh });
    distrustUpstreamToken(KEY);

    expect(
      await upstreamAccessToken({ connectionKey: 'gmail.other', provider: other, refresh }),
    ).toBe('stored-token');
  });

  test('with nothing to refresh with, the stored token is still handed back', async () => {
    // Not every server issues a refresh token. Distrust cannot conjure one, and
    // the honest outcome is the 401 surfacing as "re-authorise".
    const provider = stubProvider({ access_token: 'stored-token', expires_at: Date.now() + HOUR });

    distrustUpstreamToken(KEY);

    expect(
      await upstreamAccessToken({ connectionKey: KEY, provider, refresh: async () => undefined }),
    ).toBe('stored-token');
  });
});
