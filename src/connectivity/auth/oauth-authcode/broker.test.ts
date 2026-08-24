import { describe, expect, test } from 'bun:test';
import {
  BrokerError,
  brokerConfig,
  brokerExchange,
  brokerOriginOverride,
  brokerRefresh,
} from './broker.ts';

const URL_ = 'https://api.example.com/v1/auth/link/vendor';

/** A fetch that answers once and records what it was asked. */
function answering(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: typeof globalThis.fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('brokerConfig', () => {
  test('reads the client and what it covers out of the envelope', async () => {
    const { fetch, calls } = answering(200, {
      success: true,
      data: {
        client_id: 'shared-client',
        scopes_supported: ['a', 'b'],
        identity_scopes: ['openid', 'email'],
        status: 'open',
        capacity: { accounts: 12, cap: 95 },
        docs_url: 'https://example.com/docs',
      },
    });

    const config = await brokerConfig(URL_, fetch);

    expect(calls[0]!.url).toBe(`${URL_}/config`);
    expect(config.clientId).toBe('shared-client');
    expect(config.scopesSupported).toEqual(['a', 'b']);
    expect(config.identityScopes).toEqual(['openid', 'email']);
    expect(config.open).toBe(true);
    expect(config.capacity).toEqual({ accounts: 12, cap: 95 });
  });

  test('a closed broker carries the reason it is closed', async () => {
    // The wording is the broker's, so a spent cap, a suspension, and a
    // maintenance window can read differently without shipping a new CLI.
    const { fetch } = answering(200, {
      success: true,
      data: { client_id: 'c', status: 'closed', notice: 'At capacity.' },
    });

    const config = await brokerConfig(URL_, fetch);

    expect(config.open).toBe(false);
    expect(config.notice).toBe('At capacity.');
  });

  test('missing optional fields are absent rather than invented', async () => {
    const { fetch } = answering(200, { success: true, data: { client_id: 'c' } });

    const config = await brokerConfig(URL_, fetch);

    expect(config.scopesSupported).toEqual([]);
    expect(config.notice).toBeUndefined();
    expect(config.capacity).toBeUndefined();
    expect(config.open).toBe(true);
  });

  test('a response with no client id is a refusal, not a config with a blank one', async () => {
    const { fetch } = answering(200, { success: true, data: {} });

    await expect(brokerConfig(URL_, fetch)).rejects.toThrow(/did not return a client id/);
  });

  test('an unreachable broker names the cause instead of a bare TypeError', async () => {
    const fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;

    const error = (await brokerConfig(URL_, fetch).catch((e) => e)) as BrokerError;

    expect(error).toBeInstanceOf(BrokerError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('ECONNREFUSED');
  });

  test('an HTML error page does not surface as a JSON parse error', async () => {
    // A captive portal or a proxy is a real failure mode here, and
    // "Unexpected token <" says nothing about what went wrong.
    const { fetch } = answering(502, '<html>Bad Gateway</html>');

    const error = (await brokerConfig(URL_, fetch).catch((e) => e)) as BrokerError;

    expect(error).toBeInstanceOf(BrokerError);
    expect(error.status).toBe(502);
    expect(error.message).not.toContain('JSON');
  });
});

describe('brokerExchange', () => {
  test('sends the code, the verifier, and the redirect it was issued for', async () => {
    const { fetch, calls } = answering(200, {
      success: true,
      data: { access_token: 'at', refresh_token: 'rt', id_token: 'idt', expires_in: 3599 },
    });

    const tokens = await brokerExchange(
      URL_,
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1234/callback' },
      fetch,
    );

    expect(calls[0]!.url).toBe(`${URL_}/exchange`);
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'http://127.0.0.1:1234/callback',
    });
    expect(tokens.refresh_token).toBe('rt');
    expect(tokens.id_token).toBe('idt');
  });

  test('a refusal that your own client would solve says so', async () => {
    const { fetch } = answering(403, {
      success: false,
      error: 'The hosted client is full.',
      own_client: true,
      docs_url: 'https://example.com/docs',
    });

    const error = (await brokerExchange(
      URL_,
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetch,
    ).catch((e) => e)) as BrokerError;

    expect(error.ownClient).toBe(true);
    expect(error.docsUrl).toBe('https://example.com/docs');
    expect(error.message).toBe('The hosted client is full.');
  });

  test('a replayed code is not dressed up as something a console visit fixes', async () => {
    const { fetch } = answering(400, { success: false, error: 'invalid_grant' });

    const error = (await brokerExchange(
      URL_,
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetch,
    ).catch((e) => e)) as BrokerError;

    expect(error.ownClient).toBe(false);
  });

  test('a rate limit carries how long to wait', async () => {
    const { fetch } = answering(429, { success: false, error: 'slow down' }, { 'retry-after': '42' });

    const error = (await brokerExchange(
      URL_,
      { code: 'c', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback' },
      fetch,
    ).catch((e) => e)) as BrokerError;

    expect(error.retryAfterSeconds).toBe(42);
  });
});

describe('brokerRefresh', () => {
  test('presents the identity assertion as a bearer header', async () => {
    const { fetch, calls } = answering(200, {
      success: true,
      data: { access_token: 'fresh', id_token: 'newer' },
    });

    const tokens = await brokerRefresh(URL_, { refreshToken: 'rt', idToken: 'idt' }, fetch);

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(calls[0]!.url).toBe(`${URL_}/refresh`);
    expect(headers['authorization']).toBe('Bearer idt');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ refresh_token: 'rt' });
    expect(tokens.access_token).toBe('fresh');
    expect(tokens.id_token).toBe('newer');
  });

  test('omits the header when there is no assertion to present', async () => {
    // A credential stored before brokering existed carries no id_token, and
    // sending `Bearer undefined` would turn that into a 401 rather than the
    // fallback the broker has for exactly this case.
    const { fetch, calls } = answering(200, { success: true, data: { access_token: 'fresh' } });

    await brokerRefresh(URL_, { refreshToken: 'rt' }, fetch);

    expect((calls[0]!.init!.headers as Record<string, string>)['authorization']).toBeUndefined();
  });
});

describe('brokerOriginOverride', () => {
  test('is absent unless the variable is set to something', () => {
    expect(brokerOriginOverride({})).toBeUndefined();
    expect(brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: '' })).toBeUndefined();
    expect(brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: '   ' })).toBeUndefined();
  });

  test('keeps the origin and discards everything after it', () => {
    // The provider owns the path. Accepting one here would mean two places
    // decide where `/exchange` lives, and they would disagree eventually.
    expect(brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'https://stage.example.com/v9/nope' })).toBe(
      'https://stage.example.com',
    );
    expect(brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'http://127.0.0.1:8080' })).toBe(
      'http://127.0.0.1:8080',
    );
  });

  test('refuses a value it cannot read rather than falling back', () => {
    // Falling back would send a real authorization code to production while
    // the operator believes they are exercising a local broker.
    expect(() => brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'not a url' })).toThrow(
      /is not a URL/,
    );
    expect(() => brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'ftp://example.com' })).toThrow(
      /must be an http or https URL/,
    );
  });

  test('names the scheme it read, because a missing one still parses', () => {
    // `localhost:8080` is a URL whose scheme is "localhost". Without this the
    // refusal reads as nonsense to someone who just forgot `http://`.
    expect(() => brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'localhost:8080' })).toThrow(
      /reads as scheme "localhost"/,
    );
  });

  test('permits http only for a loopback host', () => {
    expect(brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'http://localhost:8080' })).toBe(
      'http://localhost:8080',
    );
    expect(() => brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'http://stage.example.com' })).toThrow(
      /in the clear/,
    );
    expect(brokerOriginOverride({ LANES_LINK_BROKER_ORIGIN: 'https://stage.example.com' })).toBe(
      'https://stage.example.com',
    );
  });
});
