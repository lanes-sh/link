import { createHash, randomBytes } from 'node:crypto';
import { isFresh, readSession, writeSession, type LanesSession } from './session.ts';

/**
 * Signing in to Lanes, from a terminal.
 *
 * The same flow the desktop app runs, and deliberately not a second one: a
 * loopback listener on a port the kernel picks, PKCE, Google's consent screen,
 * and the exchange brokered by the Lanes API so no client holds the client
 * secret. `core/src/auth/store.ts` is the reference implementation; this is it
 * without a webview.
 *
 * **Nothing about the identity provider is hardcoded here.** The client id, the
 * Firebase project and its web API key all come from `/v1/auth/google/config`.
 * That is partly hygiene — this repository is public and a real Google Cloud
 * project id must never be committed to it — and partly that a client which
 * discovers its configuration cannot drift from the service that issues it.
 *
 * There are two tokens and they are not interchangeable. Google's `id_token`
 * proves who signed in *to Google*; exchanging it at Firebase produces the Lanes
 * session, whose `sub` is what a profile's `members:` names (ADR-060). Storing
 * the first would be storing a token no part of Lanes accepts.
 */

/** Where the API is, unless told otherwise. */
export const DEFAULT_API_URL = 'https://api.lanes.sh';

/** The half of `fetch` this module uses. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LoginOptions {
  readonly apiUrl?: string | undefined;
  /**
   * Injected for tests, and for nothing else.
   *
   * Typed as what is called rather than as `typeof fetch`: Bun's carries a
   * `preconnect` property, and requiring a double to grow one is requiring it
   * to stop standing for the thing it replaces.
   */
  readonly fetch?: FetchLike | undefined;
  /** Opens the consent screen. Injected so a test never launches a browser. */
  readonly open?: ((url: string) => Promise<void>) | undefined;
  /** Called with the URL, so a headless run can be told where to go. */
  readonly onUrl?: ((url: string) => void) | undefined;
  /**
   * Where the session is written. Injected for tests, and only for tests.
   *
   * It exists because the alternative was found the hard way: without it, the
   * test suite signs the developer's own machine in as a fixture. A function
   * that writes to `$HOME` and takes no way to say otherwise is one every test
   * of it has to either skip or damage something to run.
   */
  readonly home?: string | undefined;
}

interface BrokerConfig {
  readonly clientId: string;
  readonly firebaseApiKey: string;
  readonly firebaseProjectId: string;
}

/** RFC 7636 S256. The verifier never leaves this process until the exchange. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function brokerConfig(
  apiUrl: string,
  call: FetchLike,
): Promise<BrokerConfig> {
  const response = await call(`${apiUrl}/v1/auth/google/config`);
  if (!response.ok) {
    throw new Error(
      `${apiUrl} would not say how to sign in (${response.status}). ` +
        'If this is a self-hosted API, set LANES_API_URL to reach it.',
    );
  }

  const body = (await response.json()) as { data?: Record<string, unknown> };
  const data = body.data ?? {};

  const clientId = typeof data['client_id'] === 'string' ? data['client_id'] : '';
  const firebaseApiKey =
    typeof data['firebase_api_key'] === 'string' ? data['firebase_api_key'] : '';
  const firebaseProjectId =
    typeof data['firebase_project_id'] === 'string' ? data['firebase_project_id'] : '';

  if (!clientId || !firebaseApiKey) {
    throw new Error(
      `${apiUrl} is not configured for sign-in. It answered without a client id or a ` +
        'Firebase key, which means the deployment is missing GOOGLE_OAUTH_CLIENT_ID or ' +
        'FIREBASE_API_KEY.',
    );
  }

  return { clientId, firebaseApiKey, firebaseProjectId };
}

/**
 * Serve exactly one callback, then stop.
 *
 * Bound to `127.0.0.1` on a port the kernel picks, which is RFC 8252's loopback
 * redirect. Google matches loopback by host and ignores the port, so nothing
 * has to be registered per machine — the property `link_auth.py`'s
 * `_is_loopback_redirect` relies on at the other end.
 */
async function awaitCallback(
  state: string,
  onListening: (redirectUri: string) => Promise<void>,
): Promise<{ code: string; redirectUri: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 });

      const error = url.searchParams.get('error');
      if (error) {
        reject(new Error(`Google refused the sign-in: ${error}`));
        return closingPage('That did not work. You can close this tab.');
      }

      // Checked before the code is read. `state` is the only thing standing
      // between this listener and a page on the machine feeding it a code from
      // somebody else's authorization.
      if (url.searchParams.get('state') !== state) {
        reject(new Error('The sign-in came back with the wrong state, so it was discarded.'));
        return closingPage('That did not work. You can close this tab.');
      }

      const code = url.searchParams.get('code');
      if (!code) {
        reject(new Error('The sign-in came back without a code.'));
        return closingPage('That did not work. You can close this tab.');
      }

      resolve(code);
      return closingPage('Signed in. You can close this tab.');
    },
  });

  const timeout = setTimeout(
    () => reject(new Error('Timed out waiting for the browser. Nothing was changed.')),
    300_000,
  );

  // The redirect URI is returned rather than stashed. Google checks that the
  // exchange sends back the *same* one, and a module-level variable holding it
  // would be shared by two logins running at once — which is not hypothetical
  // on a machine where somebody re-runs a command that seemed to hang.
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  try {
    await onListening(redirectUri);
    return { code: await promise, redirectUri };
  } finally {
    clearTimeout(timeout);
    await server.stop(true);
  }
}

function closingPage(message: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Lanes</title>` +
      `<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">` +
      `<p>${message}</p></body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function login(options: LoginOptions = {}): Promise<LanesSession> {
  const apiUrl = options.apiUrl ?? process.env['LANES_API_URL'] ?? DEFAULT_API_URL;
  const call = options.fetch ?? globalThis.fetch;

  const config = await brokerConfig(apiUrl, call);
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString('base64url');

  const { code, redirectUri } = await awaitCallback(state, async (redirectUri) => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'email profile openid');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    // Google issues a refresh token only when asked, and only on a consent
    // screen it has actually shown. Without both, a second sign-in on the same
    // machine returns no refresh token and the session lasts an hour.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    options.onUrl?.(url.toString());
    await options.open?.(url.toString());
  });

  const google = await exchangeWithBroker(apiUrl, call, {
    code,
    codeVerifier: verifier,
    redirectUri,
  });

  const session = await firebaseSession(config, call, google.idToken, apiUrl);
  await writeSession(session, options.home);
  return session;
}

async function exchangeWithBroker(
  apiUrl: string,
  call: FetchLike,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<{ idToken: string }> {
  const response = await call(`${apiUrl}/v1/auth/google/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    data?: { id_token?: unknown };
    error?: unknown;
  };

  if (!response.ok || typeof body.data?.id_token !== 'string') {
    throw new Error(
      `The sign-in could not be completed: ${String(body.error ?? response.status)}`,
    );
  }

  return { idToken: body.data.id_token };
}

/**
 * Google's id token, exchanged for the Lanes one.
 *
 * Firebase's `signInWithIdp` over REST, because there is no browser here to run
 * the web SDK in. The API key is a public identifier rather than a secret —
 * it is in the web bundle — which is why it can be served to a CLI at all.
 */
async function firebaseSession(
  config: BrokerConfig,
  call: FetchLike,
  googleIdToken: string,
  apiUrl: string,
): Promise<LanesSession> {
  const response = await call(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${config.firebaseApiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postBody: `id_token=${googleIdToken}&providerId=google.com`,
        requestUri: 'http://127.0.0.1',
        returnSecureToken: true,
        returnIdpCredential: true,
      }),
    },
  );

  const body = (await response.json().catch(() => ({}))) as {
    localId?: unknown;
    email?: unknown;
    idToken?: unknown;
    refreshToken?: unknown;
    expiresIn?: unknown;
    error?: { message?: unknown };
  };

  if (
    !response.ok ||
    typeof body.localId !== 'string' ||
    typeof body.idToken !== 'string' ||
    typeof body.refreshToken !== 'string'
  ) {
    throw new Error(
      `Lanes would not accept the Google sign-in: ${String(body.error?.message ?? response.status)}`,
    );
  }

  const seconds = Number(body.expiresIn ?? 3600);

  return {
    // The prefix is what keeps a subject out of `secret-detection.ts`'s
    // high-entropy rule and says which provider vouched for it — see
    // `profile/primitives.ts`, where both halves are one decision.
    subject: `lanes:${body.localId}`,
    email: typeof body.email === 'string' ? body.email : null,
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
    apiUrl,
  };
}

/**
 * A token this machine can present, refreshing it if it has lapsed.
 *
 * The refresh is against Google's secure-token endpoint rather than the Lanes
 * API, which is what the Firebase SDK does in the desktop app and web — the API
 * verifies tokens and does not mint them.
 */
export async function currentIdToken(
  options: { fetch?: FetchLike; apiUrl?: string } = {},
): Promise<string | null> {
  const session = await readSession();
  if (session === null) return null;
  if (isFresh(session)) return session.idToken;

  const call = options.fetch ?? globalThis.fetch;
  const config = await brokerConfig(session.apiUrl, call).catch(() => null);
  if (config === null) return null;

  const response = await call(
    `https://securetoken.googleapis.com/v1/token?key=${config.firebaseApiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
    },
  );

  const body = (await response.json().catch(() => ({}))) as {
    id_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };

  if (!response.ok || typeof body.id_token !== 'string') return null;

  const refreshed: LanesSession = {
    ...session,
    idToken: body.id_token,
    refreshToken:
      typeof body.refresh_token === 'string' ? body.refresh_token : session.refreshToken,
    expiresAt: new Date(Date.now() + Number(body.expires_in ?? 3600) * 1000).toISOString(),
  };

  await writeSession(refreshed);
  return refreshed.idToken;
}
