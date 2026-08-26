import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuthError } from './oauth-error.ts';
import {
  captureOAuthCallback,
  connectedPage,
  failedPage,
  shutdown,
  stateMatches,
  withTimeout,
  type CallbackCapture,
} from './oauth-callback.ts';
import {
  directExchange,
  type ExchangeCode,
  type OAuthTokens,
  type RefreshTokenPolicy,
} from './oauth-exchange.ts';

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
  /** What a response carrying no refresh token means for this vendor. */
  readonly refreshToken: RefreshTokenPolicy;
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /**
   * An HTTPS URL to name as the redirect, for a vendor that will take no other.
   *
   * Absent for every vendor that accepts a loopback callback, which is all of
   * them but Slack — there the listener names itself and this is the whole of
   * it. Present where the vendor's redirect must be HTTPS: the browser then
   * lands on that URL, which bounces it down to the listener opened here, and
   * the port it needs to bounce to travels in `state`.
   *
   * The listener is unchanged either way. It still binds loopback on a port the
   * kernel picked, still serves exactly one callback, and still checks `state`
   * on the way back. What changes is only the address the vendor is told.
   */
  readonly relayRedirect?: string;
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
export type { ExchangeCode, OAuthTokens, RefreshTokenPolicy };

// Re-exported so a caller wanting a loopback callback still has one import to
// reach for. Which file it lives in is this module's business, not theirs.
export { captureOAuthCallback };
export type { CallbackCapture };

const base64url = (input: Buffer): string => input.toString('base64url');

/** RFC 7636: 43–128 characters of unreserved charset. 32 random bytes gives 43. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
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
 * Run the flow and return the tokens.
 *
 * The listener binds to 127.0.0.1 on a port the OS picks, serves exactly one
 * callback, and shuts down before this resolves — it exists for the duration of
 * one consent and no longer.
 */
export async function runOAuthFlow(options: OAuthFlowOptions): Promise<OAuthTokens> {
  const { verifier, challenge } = createPkcePair();
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // let the OS choose; nothing outside this machine names this port
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
        // A mismatched state means this callback did not come from the
        // request we started. Refuse it rather than redeeming whatever code
        // it carries.
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

  // Where the vendor is told to send the browser. The relay bounces it back
  // here; without one it comes here directly, which is every other provider.
  const redirectUri = options.relayRedirect ?? `http://127.0.0.1:${server.port}/callback`;

  /**
   * The CSRF binding, and — behind a relay — the only way home.
   *
   * Built after the listener because half of it is the port the kernel just
   * chose. The relay has nowhere else to learn that from: `state` is opaque to
   * the vendor, round-trips untouched, and is already checked on the way back,
   * so carrying the port in it costs no extra parameter and no state held
   * anywhere. Without a relay it stays what it always was.
   *
   * Safe to declare after the handler that reads it: `Bun.serve` returns
   * synchronously and nothing can be served until this frame yields.
   */
  const state = options.relayRedirect
    ? `${base64url(randomBytes(24))}.${server.port}`
    : base64url(randomBytes(24));

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

function defaultExchange(options: OAuthFlowOptions): ExchangeCode {
  // The secret is no longer part of this condition. A public client has none —
  // its id ships in the manifest and PKCE is what protects the exchange — so
  // requiring one here refused the shipped-client path before it sent anything.
  if (!options.tokenUrl) {
    throw new OAuthError(
      'runOAuthFlow needs a tokenUrl to redeem the code at, or an exchange to redeem it through.',
    );
  }
  return directExchange({
    tokenUrl: options.tokenUrl,
    clientId: options.clientId,
    refreshToken: options.refreshToken,
    ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}


