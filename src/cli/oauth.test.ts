import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { OAuthError, captureOAuthCallback, createPkcePair, runOAuthFlow } from './oauth.ts';

/**
 * The flow is driven end to end against its own loopback listener: the fake
 * "browser" is a fetch to the callback URL the flow just published. Only the
 * token endpoint is mocked.
 */

interface TokenCall {
  body: Record<string, string>;
}

function mockTokenEndpoint(
  response: Record<string, unknown>,
  status = 200,
): { fetch: typeof globalThis.fetch; calls: TokenCall[] } {
  const calls: TokenCall[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    calls.push({ body: Object.fromEntries(new URLSearchParams(init?.body as string)) });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

const SUCCESS = { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 's' };

const options = (overrides: Record<string, unknown> = {}) => ({
  authorizeUrl: 'https://accounts.example.com/authorize',
  tokenUrl: 'https://oauth2.example.com/token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scopes: ['scope.read'],
  timeoutMs: 5_000,
  ...overrides,
});

/** Act as the browser: follow the authorize URL back to the loopback callback. */
function browserThatApproves(mutate?: (params: URLSearchParams) => void) {
  return (url: string) => {
    const authorize = new URL(url);
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!);

    redirect.searchParams.set('code', 'auth-code-1');
    redirect.searchParams.set('state', authorize.searchParams.get('state')!);
    mutate?.(redirect.searchParams);

    void fetch(redirect).catch(() => {});
  };
}

describe('PKCE', () => {
  test('the challenge is the S256 hash of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash('sha256').update(verifier).digest().toString('base64url');

    expect(challenge).toBe(expected);
    expect(challenge).not.toBe(verifier);
  });

  test('the verifier is within the RFC 7636 length range and unpredictable', () => {
    const a = createPkcePair();
    const b = createPkcePair();

    expect(a.verifier.length).toBeGreaterThanOrEqual(43);
    expect(a.verifier.length).toBeLessThanOrEqual(128);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('the happy path', () => {
  test('returns the refresh token and sends the verifier on exchange', async () => {
    const mock = mockTokenEndpoint(SUCCESS);
    let authorizeUrl = '';

    const tokens = await runOAuthFlow(
      options({
        fetch: mock.fetch,
        openBrowser: (url: string) => {
          authorizeUrl = url;
          browserThatApproves()(url);
        },
      }) as never,
    );

    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.accessToken).toBe('access-1');

    const sent = new URL(authorizeUrl).searchParams;
    expect(sent.get('code_challenge_method')).toBe('S256');
    expect(sent.get('response_type')).toBe('code');
    expect(sent.get('scope')).toBe('scope.read');
    expect(sent.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // The verifier is what actually protects an intercepted code, so assert it
    // reaches the token endpoint and matches the challenge that was published.
    const verifier = mock.calls[0]!.body['code_verifier']!;
    expect(createHash('sha256').update(verifier).digest().toString('base64url')).toBe(
      sent.get('code_challenge')!,
    );

    expect(mock.calls[0]!.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      client_id: 'client-id',
      client_secret: 'client-secret',
    });
  });

  test('passes provider-declared authorize parameters through', async () => {
    const mock = mockTokenEndpoint(SUCCESS);
    let authorizeUrl = '';

    await runOAuthFlow(
      options({
        fetch: mock.fetch,
        authorizeParams: { access_type: 'offline', prompt: 'consent' },
        openBrowser: (url: string) => {
          authorizeUrl = url;
          browserThatApproves()(url);
        },
      }) as never,
    );

    const sent = new URL(authorizeUrl).searchParams;
    expect(sent.get('access_type')).toBe('offline');
    expect(sent.get('prompt')).toBe('consent');
  });

  test('binds the listener to loopback only', async () => {
    const mock = mockTokenEndpoint(SUCCESS);
    let redirectUri = '';

    await runOAuthFlow(
      options({
        fetch: mock.fetch,
        openBrowser: (url: string) => {
          redirectUri = new URL(url).searchParams.get('redirect_uri')!;
          browserThatApproves()(url);
        },
      }) as never,
    );

    expect(new URL(redirectUri).hostname).toBe('127.0.0.1');
  });

  test('the browser actually receives the success page', async () => {
    // Forcing the socket closed the instant the code is read would leave the
    // operator looking at a connection error on a flow that succeeded.
    const mock = mockTokenEndpoint(SUCCESS);
    let callback: Promise<{ status: number; contentType: string | null; body: string }> | undefined;

    await runOAuthFlow(
      options({
        fetch: mock.fetch,
        connectionLabel: 'Google Drive',
        openBrowser: (url: string) => {
          const authorize = new URL(url);
          const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
          redirect.searchParams.set('code', 'auth-code-1');
          redirect.searchParams.set('state', authorize.searchParams.get('state')!);

          callback = fetch(redirect).then(async (response) => ({
            status: response.status,
            contentType: response.headers.get('content-type'),
            body: await response.text(),
          }));
        },
      }) as never,
    );

    // Awaited after the flow returns, so this asserts the response survived
    // shutdown rather than merely having been started.
    const delivered = await callback!;
    expect(delivered.status).toBe(200);
    expect(delivered.contentType).toContain('text/html');
    expect(delivered.body).toContain('Connected');
    // The caller names what was connected; the page is where that lands.
    expect(delivered.body).toContain('Google Drive');
  });

  test('the listener does not outlive the flow', async () => {
    const mock = mockTokenEndpoint(SUCCESS);
    let redirectUri = '';

    await runOAuthFlow(
      options({
        fetch: mock.fetch,
        openBrowser: (url: string) => {
          redirectUri = new URL(url).searchParams.get('redirect_uri')!;
          browserThatApproves()(url);
        },
      }) as never,
    );

    // It exists for the duration of one consent and no longer.
    //
    // Asserting "the port refuses connections" would be racy: other tests bind
    // random ports and the OS may hand this one straight back out. So assert
    // the thing that actually matters — our listener is not the one answering.
    const after = await fetch(redirectUri)
      .then((response) => response.text())
      .catch(() => '<connection refused>');

    expect(after).not.toContain('Connected');
  });
});

describe('rejections', () => {
  test('a mismatched state is refused rather than redeemed', async () => {
    const mock = mockTokenEndpoint(SUCCESS);

    // A callback we did not initiate must not have its code exchanged, whatever
    // it carries — that is the whole point of the state parameter.
    await expect(
      runOAuthFlow(
        options({
          fetch: mock.fetch,
          openBrowser: browserThatApproves((params) => params.set('state', 'not-the-state')),
        }) as never,
      ),
    ).rejects.toThrow(/State mismatch/);

    expect(mock.calls).toHaveLength(0);
  });

  test('a declined authorization is reported as such', async () => {
    const mock = mockTokenEndpoint(SUCCESS);

    await expect(
      runOAuthFlow(
        options({
          fetch: mock.fetch,
          openBrowser: (url: string) => {
            const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
            redirect.searchParams.set('error', 'access_denied');
            void fetch(redirect).catch(() => {});
          },
        }) as never,
      ),
    ).rejects.toThrow(/declined in the browser/);
  });

  test('a callback with no code is refused', async () => {
    const mock = mockTokenEndpoint(SUCCESS);

    await expect(
      runOAuthFlow(
        options({
          fetch: mock.fetch,
          openBrowser: (url: string) => {
            const authorize = new URL(url);
            const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
            redirect.searchParams.set('state', authorize.searchParams.get('state')!);
            void fetch(redirect).catch(() => {});
          },
        }) as never,
      ),
    ).rejects.toThrow(/no authorization code/);
  });

  test('times out rather than hanging forever', async () => {
    const mock = mockTokenEndpoint(SUCCESS);

    await expect(
      runOAuthFlow(
        options({ fetch: mock.fetch, timeoutMs: 150, openBrowser: () => {} }) as never,
      ),
    ).rejects.toThrow(/Timed out/);
  });

  test('a token-endpoint failure carries the provider error through', async () => {
    const mock = mockTokenEndpoint(
      { error: 'invalid_client', error_description: 'Unauthorized' },
      401,
    );

    await expect(
      runOAuthFlow(options({ fetch: mock.fetch, openBrowser: browserThatApproves() }) as never),
    ).rejects.toThrow(/invalid_client Unauthorized/);
  });

  test('a response with no refresh token fails now, with the actual cause', async () => {
    // Without it, the connection would work until the access token expires and
    // then quietly stop — a failure that surfaces an hour later and looks like
    // something else entirely.
    const mock = mockTokenEndpoint({ access_token: 'access-only', expires_in: 3600 });

    const error = await runOAuthFlow(
      options({ fetch: mock.fetch, openBrowser: browserThatApproves() }) as never,
    ).then(
      () => new Error('expected the flow to reject'),
      (caught: unknown) => caught as Error,
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(error.message).toMatch(/no refresh token/);
    expect(error.message).toMatch(/myaccount\.google\.com\/permissions/);
  });
});

/**
 * The listener the SDK drives, rather than the flow we drive ourselves.
 *
 * The SDK builds the authorization URL and only puts a `state` on it if its
 * provider hands one over, and it does not check the value when the callback
 * comes back. Both halves therefore live here: the listener mints the state and
 * the listener compares it. These tests are what keeps the pair together.
 */
describe('the SDK-driven callback listener', () => {
  test('publishes a state for the provider to send', () => {
    const first = captureOAuthCallback();
    const second = captureOAuthCallback();

    try {
      expect(first.state).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      // Per listener, not per process: two concurrent connects must not accept
      // each other's callbacks.
      expect(first.state).not.toBe(second.state);
    } finally {
      void first.close();
      void second.close();
    }
  });

  test('refuses a callback that carries no state', async () => {
    const capture = captureOAuthCallback();

    try {
      // The handler goes on before the request, or the rejection lands with
      // nothing attached and Bun reports it as unhandled.
      const refused = capture.wait(5_000).then(() => null, (error: Error) => error);
      await fetch(`${capture.redirectUri}?code=unsolicited`).catch(() => {});

      expect((await refused)?.message).toMatch(/State mismatch/);
    } finally {
      await capture.close();
    }
  });

  test('refuses a code injected by anyone sweeping the loopback port', async () => {
    const capture = captureOAuthCallback();

    try {
      const refused = capture.wait(5_000).then(() => null, (error: Error) => error);
      // What an <img src="http://127.0.0.1:N/callback?code=..."> on any open
      // page amounts to. PKCE would usually fail the exchange afterwards, but
      // the code must not be redeemed at all.
      await fetch(`${capture.redirectUri}?code=attacker&state=guessed`).catch(() => {});

      expect((await refused)?.message).toMatch(/State mismatch/);
    } finally {
      await capture.close();
    }
  });

  test('accepts the callback it actually started', async () => {
    const capture = captureOAuthCallback();

    try {
      const pending = capture.wait(5_000);
      const url = new URL(capture.redirectUri);
      url.searchParams.set('code', 'the-real-code');
      url.searchParams.set('state', capture.state);
      url.searchParams.set('iss', 'https://accounts.example.test');
      await fetch(url).catch(() => {});

      expect(await pending).toEqual({ code: 'the-real-code', iss: 'https://accounts.example.test' });
    } finally {
      await capture.close();
    }
  });
});
