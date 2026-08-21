import { describe, expect, test } from 'bun:test';
import { BrokerError } from '#connectivity/auth/index.ts';
import { brokerExchangeVia, directExchange } from './oauth-exchange.ts';
import { OAuthError } from './oauth-error.ts';

const INPUT = {
  code: 'the-code',
  redirectUri: 'http://127.0.0.1:53412/callback',
  codeVerifier: 'the-verifier',
  scopes: ['scope.a', 'scope.b'],
};

function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('directExchange', () => {
  test('posts the client and the verifier to the vendor', async () => {
    const { fetch, calls } = answering(200, {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 1200,
      scope: 'granted.a',
    });

    const tokens = await directExchange({
      tokenUrl: 'https://oauth2.example.com/token',
      clientId: 'cid',
      clientSecret: 'secret',
      fetch,
    })(INPUT);

    const sent = new URLSearchParams(String(calls[0]!.init!.body));
    expect(calls[0]!.url).toBe('https://oauth2.example.com/token');
    expect(sent.get('client_secret')).toBe('secret');
    expect(sent.get('code_verifier')).toBe('the-verifier');
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(tokens).toEqual({
      refreshToken: 'rt',
      accessToken: 'at',
      expiresIn: 1200,
      scope: 'granted.a',
    });
  });

  test('falls back to what was asked for when the vendor omits the granted scope', async () => {
    const { fetch } = answering(200, { access_token: 'at', refresh_token: 'rt' });

    const tokens = await directExchange({
      tokenUrl: 'https://oauth2.example.com/token',
      clientId: 'cid',
      clientSecret: 'secret',
      fetch,
    })(INPUT);

    expect(tokens.scope).toBe('scope.a scope.b');
    expect(tokens.expiresIn).toBe(3600);
  });

  test('surfaces an id_token when one comes back, and omits the field when not', async () => {
    const withId = answering(200, { access_token: 'at', refresh_token: 'rt', id_token: 'idt' });
    const without = answering(200, { access_token: 'at', refresh_token: 'rt' });
    const make = (fetch: typeof globalThis.fetch) =>
      directExchange({
        tokenUrl: 'https://oauth2.example.com/token',
        clientId: 'cid',
        clientSecret: 'secret',
        fetch,
      })(INPUT);

    expect((await make(withId.fetch)).idToken).toBe('idt');
    expect('idToken' in (await make(without.fetch))).toBe(false);
  });
});

describe('brokerExchangeVia', () => {
  test('redeems the code through the broker and never touches a token url', async () => {
    const { fetch, calls } = answering(200, {
      success: true,
      data: { access_token: 'at', refresh_token: 'rt', id_token: 'idt', expires_in: 900 },
    });

    const tokens = await brokerExchangeVia({ url: 'https://api.example.com/b', fetch })(INPUT);

    expect(calls[0]!.url).toBe('https://api.example.com/b/exchange');
    expect(tokens.idToken).toBe('idt');
    expect(tokens.expiresIn).toBe(900);
  });

  test('a broker refusal reaches the caller whole, not flattened to a string', async () => {
    // The notice and the "your own client would fix this" flag are what the
    // connect command renders. Wrapping this in an OAuthError would drop both.
    const { fetch } = answering(403, {
      success: false,
      error: 'The hosted client is full.',
      own_client: true,
      notice: 'At capacity.',
    });

    const error = (await brokerExchangeVia({ url: 'https://api.example.com/b', fetch })(
      INPUT,
    ).catch((e) => e)) as BrokerError;

    expect(error).toBeInstanceOf(BrokerError);
    expect(error.ownClient).toBe(true);
    expect(error.notice).toBe('At capacity.');
  });

  test('a broker that returns no refresh token fails now rather than in an hour', async () => {
    const { fetch } = answering(200, { success: true, data: { access_token: 'at' } });

    await expect(
      brokerExchangeVia({ url: 'https://api.example.com/b', fetch })(INPUT),
    ).rejects.toBeInstanceOf(OAuthError);
  });
});
