/**
 * The loopback listener a browser comes back to, and nothing else.
 *
 * Split from `login.ts` because the two have one value between them — an
 * authorization code — and everything else they know is disjoint. This file
 * knows about sockets, `state`, and the page somebody is left looking at; it
 * knows nothing about Google, Firebase, or where a session is stored.
 */

/** What the browser should be told, for whoever is rendering it. */
export interface LandingPage {
  readonly ok: boolean;
  /** One line. The reason, when something went wrong. */
  readonly detail: string;
}

/**
 * Serve exactly one callback, then stop.
 *
 * Bound to `127.0.0.1` on a port the kernel picks, which is RFC 8252's loopback
 * redirect. Google matches loopback by host and ignores the port, so nothing
 * has to be registered per machine — the property `link_auth.py`'s
 * `_is_loopback_redirect` relies on at the other end.
 */
export async function awaitCallback(
  state: string,
  onListening: (redirectUri: string) => Promise<void>,
  render: (outcome: LandingPage) => Response,
): Promise<{ code: string; redirectUri: string }> {
  const page = (outcome: LandingPage): Response => closing(render(outcome));
  const { promise, resolve, reject } = Promise.withResolvers<string>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      // Anything else, including the favicon a browser asks for unprompted.
      // It closes its connection too, so a stray request cannot keep the server
      // alive past the redirect it is waiting for.
      if (url.pathname !== '/callback') {
        return closing(new Response('Not found', { status: 404 }));
      }

      const error = url.searchParams.get('error');
      if (error) {
        reject(new Error(`Google refused the sign-in: ${error}`));
        return page({ ok: false, detail: `Google refused the sign-in: ${error}` });
      }

      // Checked before the code is read. `state` is the only thing standing
      // between this listener and a page on the machine feeding it a code from
      // somebody else's authorization.
      if (url.searchParams.get('state') !== state) {
        reject(new Error('The sign-in came back with the wrong state, so it was discarded.'));
        return page({
          ok: false,
          detail: 'That sign-in came back with the wrong state, so it was discarded.',
        });
      }

      const code = url.searchParams.get('code');
      if (!code) {
        reject(new Error('The sign-in came back without a code.'));
        return page({ ok: false, detail: 'That sign-in came back without a code.' });
      }

      resolve(code);
      return page({ ok: true, detail: 'You can close this tab and go back to your terminal.' });
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

    // Graceful, and this is the whole of the fix for a login that worked and
    // looked like it had not. `stop(true)` closes active connections
    // immediately, and the active connection is the one carrying the page the
    // person is waiting to see: `resolve` runs inside the handler, before Bun
    // has written the response, so forcing here raced the browser and won every
    // time. What they got was a connection error on a sign-in that had already
    // succeeded, which is the worst possible way for this to fail.
    //
    // Nothing can hold a graceful stop open, because every response closes its
    // own connection — see `closing`. That is what makes this safe to await
    // rather than force.
    await server.stop();
  }
}

/**
 * `Connection: close` on whatever was rendered.
 *
 * Applied here rather than asked of the renderer, because it is a property of
 * *this* listener rather than of the page. The server is torn down the moment
 * the code arrives, and a keep-alive connection would either hold the graceful
 * stop open or be severed mid-response — the second is what used to happen.
 * Telling the browser not to reuse the socket makes "respond, then stop" a
 * sequence rather than a race.
 */
function closing(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('connection', 'close');
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The page when nobody supplied one.
 *
 * Deliberately plain, and deliberately not what a person sees: `lanes auth
 * login` passes the branded card. This is for tests, and for a caller that has
 * no opinion about presentation.
 */
export function plainPage(outcome: LandingPage): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Lanes</title>` +
      `<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0">` +
      `<p>${outcome.ok ? 'Signed in.' : 'That did not work.'} ${outcome.detail}</p></body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
