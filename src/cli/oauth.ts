import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { completionPage } from './callback-page.ts';
import { OAuthError } from './oauth-error.ts';
import { directExchange, type ExchangeCode, type OAuthTokens } from './oauth-exchange.ts';

/**
 * The OAuth authorization-code exchange, run entirely from the CLI.
 *
 * **The server never participates in this** — ADR-005. The CLI opens a
 * temporary listener on loopback, receives the code there, exchanges it, and
 * writes the refresh token to whichever credential store the config names. That
 * works identically whether the instance is local or on Cloud Run, and it means
 * the deployment needs no public callback URL, no domain verification, and no
 * inbound path at all.
 *
 * PKCE is used even though a Desktop-app client also sends a client secret.
 * Google only recommends it, but a "secret" shipped to an installed app is not
 * meaningfully secret, and PKCE is what actually stops an intercepted
 * authorization code from being redeemed by someone else.
 */

export interface OAuthFlowOptions {
  readonly authorizeUrl: string;
  /** Where a client this machine holds redeems the code. Unused with `exchange`. */
  readonly tokenUrl?: string;
  readonly clientId: string;
  /** Unused with `exchange` — a brokered flow has no secret to hold. */
  readonly clientSecret?: string;
  readonly scopes: readonly string[];
  /**
   * How the code becomes a token. Defaults to posting to `tokenUrl` with the
   * client above; a brokered provider supplies one that posts to its broker.
   *
   * Everything before this point is identical either way, which is the whole
   * reason it is a parameter rather than a branch: the listener, PKCE, the
   * state check, and the browser cannot drift apart between the two paths.
   */
  readonly exchange?: ExchangeCode;
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /** What the completion page names as connected. A provider's display name. */
  readonly connectionLabel?: string;
  /** How long to wait for the operator to finish in the browser. */
  readonly timeoutMs?: number;
  readonly openBrowser?: (url: string) => void;
  readonly onPrompt?: (url: string) => void;
  readonly fetch?: typeof globalThis.fetch;
}

// Re-exported so the flow stays one import for its callers even though the
// exchange half now lives next door.
export { OAuthError };
export type { ExchangeCode, OAuthTokens };

const base64url = (input: Buffer): string => input.toString('base64url');

/** RFC 7636: 43–128 characters of unreserved charset. 32 random bytes gives 43. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Compare the returned state in constant time — it is a CSRF defence. */
function stateMatches(expected: string, received: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(received).digest();
  return timingSafeEqual(a, b);
}

export function defaultOpenBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];

  try {
    // An argument array, never a shell string: the URL contains query
    // parameters and must not be word-split or interpreted.
    // unref: the parent must not wait on a browser that outlives the command.
    Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' }).unref();
  } catch {
    // Headless or no handler — the caller prints the URL either way.
  }
}

/**
 * What the browser is left looking at, in the two shapes it comes in.
 *
 * The label is what the caller knows and this file cannot: which provider the
 * grant was for. Given one, the page names it under "Connected" the way the
 * invite page names the workspace; without one it says only that the flow
 * finished, which is what every path said before.
 */
const connectedPage = (label?: string): Response =>
  completionPage({
    ...(label ? { label: 'Connected', heading: label } : { heading: 'Connected' }),
    detail: 'You can close this tab and return to the terminal.',
    ok: true,
  });

const failedPage = (detail: string): Response =>
  completionPage({ heading: 'Authorization failed', detail, ok: false });

/**
 * Run the flow and return the tokens.
 *
 * The listener binds to 127.0.0.1 on a port the OS picks, serves exactly one
 * callback, and shuts down before this resolves — it exists for the duration of
 * one consent and no longer.
 */
export async function runOAuthFlow(options: OAuthFlowOptions): Promise<OAuthTokens> {
  const { verifier, challenge } = createPkcePair();
  const state = base64url(randomBytes(24));
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // let the OS choose; Google's Desktop client type accepts any loopback port
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 });

      const error = url.searchParams.get('error');
      if (error) {
        rejectCode(
          new OAuthError(
            error === 'access_denied'
              ? 'Authorization was declined in the browser.'
              : `Authorization failed: ${error}`,
          ),
        );
        return failedPage('You can close this tab.');
      }

      const returnedState = url.searchParams.get('state');
      if (!returnedState || !stateMatches(state, returnedState)) {
        // A mismatched state means this callback did not come from the request
        // we started. Refuse it rather than redeeming whatever code it carries.
        rejectCode(new OAuthError('State mismatch — ignoring an unexpected callback.'));
        return failedPage('Unexpected callback.');
      }

      const code = url.searchParams.get('code');
      if (!code) {
        rejectCode(new OAuthError('The callback carried no authorization code.'));
        return failedPage('No code returned.');
      }

      resolveCode(code);
      return connectedPage(options.connectionLabel);
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/callback`;

  try {
    const authorizeUrl = new URL(options.authorizeUrl);
    authorizeUrl.searchParams.set('client_id', options.clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', options.scopes.join(' '));
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    for (const [key, value] of Object.entries(options.authorizeParams ?? {})) {
      authorizeUrl.searchParams.set(key, value);
    }

    options.onPrompt?.(authorizeUrl.href);
    (options.openBrowser ?? defaultOpenBrowser)(authorizeUrl.href);

    const code = await withTimeout(
      codePromise,
      timeoutMs,
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser.`,
    );

    const exchange = options.exchange ?? defaultExchange(options);
    return await exchange({
      code,
      redirectUri,
      codeVerifier: verifier,
      scopes: options.scopes,
    });
  } finally {
    await shutdown(server);
  }
}

/**
 * Close the listener without cutting off the response in flight.
 *
 * Forcing the socket shut the instant the code is read leaves the operator
 * looking at a connection error on a flow that in fact succeeded. So: stop
 * gracefully, wait for the in-flight callback to drain, and force only if
 * graceful genuinely did not finish — a keep-alive connection must not be able
 * to hold the CLI open forever either.
 */
async function shutdown(server: { stop(force?: boolean): Promise<void> }): Promise<void> {
  let drained = false;
  const graceful = server.stop().then(() => {
    drained = true;
  });

  await withTimeout(graceful, 2_000).catch(() => {});
  if (!drained) await server.stop(true);
}

/**
 * Race a promise against a deadline, and **clear the timer either way**.
 *
 * A bare `Promise.race` with `setTimeout` leaks: when the real promise wins,
 * the timer is still pending, and a pending timer keeps the event loop alive
 * for its full duration. With a five-minute OAuth deadline that turns a
 * finished `connect` into a terminal that prints "Next: lanes link start" and
 * then sits there for five minutes — which is exactly what it did.
 *
 * Rejects with `OAuthError(message)` if given one, otherwise resolves to
 * undefined at the deadline, which is what the shutdown path wants.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve, reject) => {
        timer = setTimeout(
          () => (message ? reject(new OAuthError(message)) : resolve(undefined as T)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultExchange(options: OAuthFlowOptions): ExchangeCode {
  if (!options.tokenUrl || !options.clientSecret) {
    throw new OAuthError(
      'runOAuthFlow needs either a tokenUrl and clientSecret to redeem the code with, or an exchange to redeem it through.',
    );
  }
  return directExchange({
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}


/**
 * Capture exactly one OAuth callback on loopback.
 *
 * Split out from `runOAuthFlow` so the SDK can drive the protocol — discovery,
 * registration, PKCE, exchange — while we supply only the redirect target. The
 * listener exists for the duration of one consent and no longer.
 */
export interface CallbackCapture {
  readonly redirectUri: string;
  /**
   * The `state` this listener will accept, for the provider to put on the
   * authorization URL. The SDK asks its provider for one and sends whatever it
   * gets; nothing generates it for us.
   */
  readonly state: string;
  wait(timeoutMs?: number): Promise<{ code: string; iss?: string }>;
  close(): Promise<void>;
}

export function captureOAuthCallback(options: { label?: string } = {}): CallbackCapture {
  const state = base64url(randomBytes(24));
  let resolveCode: (value: { code: string; iss?: string }) => void;
  let rejectCode: (error: Error) => void;

  const received = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/callback') return new Response('Not found', { status: 404 });

      const error = url.searchParams.get('error');
      if (error) {
        rejectCode(
          new OAuthError(
            error === 'access_denied'
              ? 'Authorization was declined in the browser.'
              : `Authorization failed: ${error}`,
          ),
        );
        return failedPage('You can close this tab.');
      }

      const code = url.searchParams.get('code');
      if (!code) {
        rejectCode(new OAuthError('The callback carried no authorization code.'));
        return failedPage('No code returned.');
      }

      // Checked here because nothing else checks it. The SDK's own docs say it
      // does not validate `state`, and it only sends one if the provider hands
      // it over — so this listener mints the value, `CredentialOAuthProvider`
      // returns it from `state()`, and the two are compared on the way back.
      //
      // Without it this resolves on the first `/callback?code=` to reach the
      // port, whoever sent it: any local process, or a page the operator has
      // open, can sweep loopback during the five-minute window. PKCE usually
      // turns that into a failed exchange, but a manifest is free to name an
      // authorization server that does not enforce it, and there the code
      // would be redeemed and the connection bound to someone else's account.
      const returnedState = url.searchParams.get('state');
      if (!returnedState || !stateMatches(state, returnedState)) {
        rejectCode(new OAuthError('State mismatch — ignoring an unexpected callback.'));
        return failedPage('Unexpected callback.');
      }

      const iss = url.searchParams.get('iss');
      resolveCode({ code, ...(iss ? { iss } : {}) });
      return connectedPage(options.label);
    },
  });

  return {
    redirectUri: `http://127.0.0.1:${server.port}/callback`,
    state,

    async wait(timeoutMs = 5 * 60_000) {
      return withTimeout(
        received,
        timeoutMs,
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser.`,
      );
    },

    close: () => shutdown(server),
  };
}
