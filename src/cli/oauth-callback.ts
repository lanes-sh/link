import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { completionPage } from './callback-page.ts';
import { OAuthError } from './oauth-error.ts';

/**
 * The loopback listener both OAuth paths come back to.
 *
 * Two callers want the same door and want it differently. `runOAuthFlow` drives
 * the whole protocol and reads the code itself; `captureOAuthCallback` hands the
 * protocol to the MCP SDK and supplies only somewhere for the browser to land.
 * What they share is everything about the listener — that it binds loopback,
 * serves exactly one callback, compares `state` in constant time, leaves a page
 * a person can read, and drains before it closes — and holding that in one file
 * is what stops the two drifting into disagreeing about it.
 *
 * Split out of `oauth.ts` when that file passed the size budget, along the seam
 * the budget exists to find: the flow, and the door it knocks on.
 */

const base64url = (input: Buffer): string => input.toString('base64url');

/** Compare the returned state in constant time — it is a CSRF defence. */
export function stateMatches(expected: string, received: string): boolean {
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(received).digest();
  return timingSafeEqual(a, b);
}

/**
 * What the browser is left looking at, in the two shapes it comes in.
 *
 * The label is what the caller knows and this file cannot: which provider the
 * grant was for. Given one, the page names it under "Connected" the way the
 * invite page names the workspace; without one it says only that the flow
 * finished, which is what every path said before.
 */
export const connectedPage = (label?: string): Response =>
  completionPage({
    ...(label ? { label: 'Connected', heading: label } : { heading: 'Connected' }),
    detail: 'You can close this tab and return to the terminal.',
    ok: true,
  });

export const failedPage = (detail: string): Response =>
  completionPage({ heading: 'Authorization failed', detail, ok: false });

/**
 * Close the listener without cutting off the response in flight.
 *
 * Forcing the socket shut the instant the code is read leaves the operator
 * looking at a connection error on a flow that in fact succeeded. So: stop
 * gracefully, wait for the in-flight callback to drain, and force only if
 * graceful genuinely did not finish — a keep-alive connection must not be able
 * to hold the CLI open forever either.
 */
export async function shutdown(server: { stop(force?: boolean): Promise<void> }): Promise<void> {
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
export async function withTimeout<T>(promise: Promise<T>, ms: number, message?: string): Promise<T> {
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

export function captureOAuthCallback(
  options: { label?: string; port?: number | undefined } = {},
): CallbackCapture {
  const state = base64url(randomBytes(24));
  let resolveCode: (value: { code: string; iss?: string }) => void;
  let rejectCode: (error: Error) => void;

  const received = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const listener = {
    hostname: '127.0.0.1',
    fetch(request: Request) {
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
  };

  // The port a previous run registered with, where the caller knows one.
  //
  // Asking the OS for any free port is what broke every second connect to a
  // vendor that matches `redirect_uri` literally. The first connect binds
  // whatever it is handed and registers a client declaring *that* URL; the
  // registration is then kept deliberately, because re-registering orphans the
  // grant the operator has just approved. So the second connect arrives on a
  // different port carrying the first one's client and is refused —
  // `redirect_uri not allowed`, before the consent page even renders.
  //
  // Supabase does this. Notion does not, because RFC 8252 §7.3 says a loopback
  // redirect is matched without its port and Notion follows it — which is the
  // only reason this survived as long as it did.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ ...listener, port: options.port ?? 0 });
  } catch {
    // Taken: another connect in flight, or something else holding it. Falling
    // back beats failing — a fresh port still works against every server that
    // follows §7.3, and the one that does not is no worse off than before.
    server = Bun.serve({ ...listener, port: 0 });
  }

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
