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
  refreshToken: { required: true, vendor: 'Vendor', revokeUrl: 'https://example.com/permissions' },
  ...overrides,
});

/**
 * Act as the browser coming back *through the relay*.
 *
 * The relay has only `state` to work from, so this reads the port out of it the
 * same way the broker's callback route does — which is what makes this a test
 * of the contract rather than of a value threaded through in the clear.
 */
function relayed(mutate?: (params: URLSearchParams) => void) {
  return (url: string) => {
    const authorize = new URL(url);
    const state = authorize.searchParams.get('state')!;
    const port = state.split('.').pop();

    const back = new URL(`http://127.0.0.1:${port}/callback`);
    back.searchParams.set('code', 'auth-code-1');
    back.searchParams.set('state', state);
    mutate?.(back.searchParams);
    void fetch(back.href);
  };
}

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
    // The vendor and the revoke page come from the manifest now. This assertion
    // used to name Google, which was true only while Google was the only
    // provider that redeemed a code here.
    expect(error.message).toMatch(/Vendor returned no refresh token/);
    expect(error.message).toMatch(/https:\/\/example\.com\/permissions/);
  });

  test('a vendor the manifest says issues none succeeds, and stores no expiry', async () => {
    // Slack's shape: a long-lived user token, no refresh token, no stated
    // lifetime. Demanding one here refused every connection that worked.
    const mock = mockTokenEndpoint({ access_token: 'xoxp-access', scope: 'chat:write' });

    const tokens = await runOAuthFlow(
      options({
        fetch: mock.fetch,
        openBrowser: browserThatApproves(),
        refreshToken: { required: false, vendor: 'Vendor' },
      }) as never,
    );

    expect(tokens.accessToken).toBe('xoxp-access');
    expect(tokens.refreshToken).toBeUndefined();
    expect(tokens.expiresIn).toBeUndefined();
  });
});

/**
 * A vendor that will not accept a loopback redirect at all.
 *
 * Slack refuses to register a non-HTTPS Redirect URL, and a CLI on loopback
 * cannot be HTTPS. So the broker's own origin is named instead, the browser
 * lands there, and it bounces straight back down to the listener opened here.
 * The listener does not change; only the address the vendor is told.
 */
describe('a relayed redirect', () => {
  const RELAY = 'https://api.example.com/v1/auth/link/vendor/callback';

  test('names the relay to the vendor, not the loopback port', async () => {
    const mock = mockTokenEndpoint(SUCCESS);
    let authorizeUrl = '';

    await runOAuthFlow(
      options({
        fetch: mock.fetch,
        relayRedirect: RELAY,
        openBrowser: (url: string) => {
          authorizeUrl = url;
          relayed()(url);
        },
      }) as never,
    );

    expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(RELAY);
  });

  test('carries the listening port in state, because the relay has no other way home', async () => {
    const mock = mockTokenEndpoint(SUCCESS);
    let authorizeUrl = '';

    await runOAuthFlow(
      options({
        fetch: mock.fetch,
        relayRedirect: RELAY,
        openBrowser: (url: string) => {
          authorizeUrl = url;
          relayed()(url);
        },
      }) as never,
    );

    const state = new URL(authorizeUrl).searchParams.get('state')!;
    const port = Number(state.split('.').pop());
    expect(state).toMatch(/^[\w-]+\.\d+$/);
    expect(port).toBeGreaterThan(1024);
  });

  test('redeems against the relay, because the vendor requires the two to match', async () => {
    const mock = mockTokenEndpoint(SUCCESS);

    await runOAuthFlow(
      options({ fetch: mock.fetch, relayRedirect: RELAY, openBrowser: relayed() }) as never,
    );

    expect(mock.calls[0]!.body['redirect_uri']).toBe(RELAY);
  });

  test('still refuses a callback whose state does not match', async () => {
    // The port rides along, but the random half is unchanged and is still what
    // binds this callback to this flow.
    const mock = mockTokenEndpoint(SUCCESS);

    const error = await runOAuthFlow(
      options({
        fetch: mock.fetch,
        relayRedirect: RELAY,
        timeoutMs: 1_500,
        openBrowser: relayed((params) => params.set('state', 'someone-elses.54321')),
      }) as never,
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect(error).toBeInstanceOf(OAuthError);
  });

  test('without one, the listener names itself as before', async () => {
    const mock = mockTokenEndpoint(SUCCESS);
    let authorizeUrl = '';

    await runOAuthFlow(
      options({
        fetch: mock.fetch,
        openBrowser: (url: string) => {
          authorizeUrl = url;
          browserThatApproves()(url);
        },
      }) as never,
    );

    const sent = new URL(authorizeUrl).searchParams;
    expect(sent.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // No port appended: there is nobody to tell.
    expect(sent.get('state')).not.toContain('.');
  });
});

describe('the exchange is a seam', () => {
  test('an injected exchange is used, and the token endpoint is never called', async () => {
    // The point of the seam: a brokered provider has no client secret to post,
    // so the flow must be able to redeem the code somewhere else entirely while
    // the listener, PKCE, and the state check stay exactly as they are.
    let redeemed: { code: string; redirectUri: string; codeVerifier: string } | undefined;
    const tokenEndpoint = mockTokenEndpoint({});

    const tokens = await runOAuthFlow({
      authorizeUrl: 'https://accounts.example.com/authorize',
      clientId: 'cid',
      scopes: ['scope.a'],
      refreshToken: { required: true, vendor: 'Vendor' },
      openBrowser: browserThatApproves(),
      fetch: tokenEndpoint.fetch,
      exchange: async (input) => {
        redeemed = {
          code: input.code,
          redirectUri: input.redirectUri,
          codeVerifier: input.codeVerifier,
        };
        return { refreshToken: 'rt', accessToken: 'at', expiresIn: 60, scope: 'scope.a' };
      },
    });

    expect(tokens.accessToken).toBe('at');
    expect(tokenEndpoint.calls).toHaveLength(0);
    expect(redeemed?.code).toBe('auth-code-1');
    expect(redeemed?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // The verifier is the one the flow generated, so PKCE still binds the code
    // to this process rather than to whoever supplied the exchange.
    expect(redeemed?.codeVerifier).toMatch(/^[\w-]{43}$/);
  });

  test('a flow with neither an exchange nor a token url to redeem at refuses', async () => {
    // The secret is deliberately not part of this any more: a public client has
    // none, and requiring one refused the shipped-client path before it sent
    // anything.
    const error = await runOAuthFlow({
      authorizeUrl: 'https://accounts.example.com/authorize',
      clientId: 'cid',
      scopes: ['scope.a'],
      refreshToken: { required: true, vendor: 'Vendor' },
      openBrowser: browserThatApproves(),
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect(error).toBeInstanceOf(OAuthError);
    expect(error?.message).toMatch(/needs a tokenUrl/);
  });

  test('a public client redeems with no secret, sending none rather than an empty one', async () => {
    const mock = mockTokenEndpoint(SUCCESS);

    await runOAuthFlow({
      authorizeUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://oauth2.example.com/token',
      clientId: 'shipped-id',
      scopes: ['scope.a'],
      refreshToken: { required: true, vendor: 'Vendor' },
      openBrowser: browserThatApproves(),
      fetch: mock.fetch,
    });

    const sent = mock.calls[0]!.body;
    expect(sent['client_id']).toBe('shipped-id');
    expect('client_secret' in sent).toBe(false);
    expect(sent['code_verifier']).toMatch(/^[\w-]{43}$/);
  });
});

describe('a redirect the vendor matches exactly', () => {
  /**
   * The third answer to "where does the browser come back to". A kernel-chosen
   * port cannot be registered in a console months in advance, and a vendor that
   * matches `redirect_uri` byte for byte refuses the grant rather than the
   * port — so the failure is `redirect_uri_mismatch` after consent, which reads
   * as a broken client rather than as a port that moved.
   */
  function freePort(): number {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const { port } = probe;
    probe.stop(true);
    if (!port) throw new Error('Bun.serve bound no port');
    return port;
  }

  /**
   * The same problem one flow over, and the one that actually bit.
   *
   * `--auth` aside, a dynamically registered client hits this too. The first
   * connect binds whatever the kernel hands out and registers a client
   * declaring *that* URL; the registration is then kept deliberately, because
   * re-registering orphans the grant the operator just approved. Every later
   * connect asked for a new port and sent a URL that client never declared, so
   * a vendor matching literally refused it before the consent page rendered —
   * `redirect_uri not allowed`, seen against Supabase.
   *
   * Notion hid it: RFC 8252 §7.3 says a loopback redirect is matched without
   * its port, and Notion follows that.
   */
  test('the listener asks for the port a kept registration already declared', async () => {
    const first = captureOAuthCallback();
    const port = Number(new URL(first.redirectUri).port);
    await first.close();

    const again = captureOAuthCallback({ port });

    expect(new URL(again.redirectUri).port).toBe(String(port));
    await again.close();
  });

  test('and takes a free one rather than failing when that port is held', async () => {
    // Another connect in flight, or something else on it. Falling back beats
    // failing: a fresh port still works against every server that follows
    // §7.3, and the one that does not is no worse off than it was.
    const holding = captureOAuthCallback();
    const taken = Number(new URL(holding.redirectUri).port);

    const second = captureOAuthCallback({ port: taken });

    expect(new URL(second.redirectUri).port).not.toBe(String(taken));
    expect(Number(new URL(second.redirectUri).port)).toBeGreaterThan(0);

    await holding.close();
    await second.close();
  });

  test('with no port asked for, it binds any free one as it always did', async () => {
    const capture = captureOAuthCallback();

    expect(Number(new URL(capture.redirectUri).port)).toBeGreaterThan(0);
    await capture.close();
  });

  test('the declared URL is what the vendor is told, verbatim', async () => {
    const port = freePort();
    const fixedRedirect = `http://127.0.0.1:${port}/callback`;
    const { fetch: tokenFetch } = mockTokenEndpoint(SUCCESS);
    let announced: string | undefined;

    await runOAuthFlow(
      options({
        fixedRedirect,
        fetch: tokenFetch,
        openBrowser: (url: string) => {
          announced = new URL(url).searchParams.get('redirect_uri') ?? undefined;
          browserThatApproves()(url);
        },
      }) as never,
    );

    expect(announced).toBe(fixedRedirect);
  });

  test('the listener binds the port the vendor was told about', async () => {
    // The two must agree by construction. If the flow announced the fixed URL
    // but still listened on a kernel-chosen port, the browser would come back
    // to a closed socket and this would time out rather than resolve.
    const port = freePort();
    const { fetch: tokenFetch } = mockTokenEndpoint(SUCCESS);

    const tokens = await runOAuthFlow(
      options({
        fixedRedirect: `http://127.0.0.1:${port}/callback`,
        fetch: tokenFetch,
        openBrowser: browserThatApproves(),
      }) as never,
    );

    expect(tokens.accessToken).toBe('access-1');
  });

  test('a redirect naming no port is refused before the browser opens', async () => {
    await expect(
      runOAuthFlow(
        options({
          fixedRedirect: 'https://example.com/callback',
          openBrowser: () => {},
        }) as never,
      ),
    ).rejects.toThrow(/names no port/);
  });

  test('a port already in use says so, and says why it cannot be moved', async () => {
    const port = freePort();
    const holder = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('') });

    try {
      await expect(
        runOAuthFlow(
          options({
            fixedRedirect: `http://127.0.0.1:${port}/callback`,
            openBrowser: () => {},
          }) as never,
        ),
      ).rejects.toThrow(/already in use/);
    } finally {
      holder.stop(true);
    }
  });
});
