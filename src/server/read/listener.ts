import { READ_ORIGINS, readRoutes, type ReadDeps } from './routes.ts';
import { handleAuthorization, isAuthorizationPath, type AuthorizationSurface } from '../oauth.ts';
import { corsAware } from '../cors.ts';

/**
 * The read surface on loopback: its own port, over TLS (ADR-063).
 *
 * The routes themselves live in `./routes.ts`, shared with the deployed bind,
 * so the four properties they enforce cannot come to differ between the two.
 * What is decided *here* is the fifth, and it is the one that is genuinely
 * about this bind rather than about the routes:
 *
 * **TLS.** Not for confidentiality on a loopback socket, but because Safari
 * will not let an HTTPS page fetch `http://127.0.0.1` and offers no header,
 * flag or opt-in that changes it. Without this the surface does not exist for a
 * Safari user. It is also the whole reason for a second port: the MCP listener
 * must keep answering `http://127.0.0.1:7337` for every registration that
 * already exists.
 *
 * A deployed workspace needs none of this — Cloud Run terminates TLS with a
 * certificate a browser already trusts, and routes exactly one port — so it
 * takes the routes through the endpoint's own router instead. See
 * `./deployed.ts`.
 *
 * **It also serves the authorization paths**, for the same Safari reason turned
 * around: the surface now takes the bearer `/mcp` takes (ADR-079), and a page
 * on `https://lanes.sh` cannot reach the MCP listener's `http://127.0.0.1:7337`
 * to get one. So `/register`, `/authorize` and `/token` answer here too,
 * through the same `handleAuthorization` the endpoint's router calls. One
 * `OAuthStore` sits behind both, so which port minted a token does not matter
 * to what the token opens — and the MCP listener keeps answering its own copy
 * of these paths for every client already registered against it.
 *
 * **Their CORS is `corsAware`'s, not this file's.** `surfaceOf` has always
 * called the authorization paths `public` and answered them with a wildcard,
 * for a reason `cors.ts` states: they answer without a credential by design, so
 * a wildcard hands a page what `curl` already has. Wrapping the handler is
 * therefore the whole of it — the alternative, a second grant written here, was
 * tried and is redundant on any bind where `corsAware` runs, which is every
 * bind but this one. Everything `corsAware` does not classify falls through
 * untouched, and `readRoutes` answers those with its own *named* grant, because
 * what they return is the workspace rather than a public document.
 */

export { READ_ORIGINS, type AuditTail, type ReadDeps } from './routes.ts';

export interface ReadListenerOptions extends ReadDeps {
  readonly host: string;
  readonly port: number;
  readonly tls: { readonly cert: string; readonly key: string };
  /**
   * The endpoint's authorization server, when the primary profile declares one.
   *
   * Absent for a profile with no `auth.authorization`, and then there is no way
   * to sign in to this surface at all — which is why `doctor --fix` repairs a
   * profile missing it.
   */
  readonly authorization?: AuthorizationSurface | undefined;
}

export interface RunningReadListener {
  readonly url: string;
  stop(): Promise<void>;
}

export function serveRead(options: ReadListenerOptions): RunningReadListener {
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    tls: { cert: options.tls.cert, key: options.tls.key },
    // Everything, because this owns a whole port. The router on the deployed
    // side passes only what `isDashboardPath` matched — handing an unmatched
    // path to `readRoutes` there would swallow `/mcp`.
    //
    // The authorization paths come first and are deliberately not behind the
    // read surface's own checks: a client's first request is the one that
    // discovers how to authenticate, so requiring a credential to reach the
    // document that says where credentials come from would close the loop it
    // exists to open. `server/index.ts` orders them the same way.
    fetch: corsAware(
      async (request) => {
        const url = new URL(request.url);
        if (options.authorization && isAuthorizationPath(url.pathname)) {
          return await handleAuthorization(request, options.authorization);
        }
        return await readRoutes(request, options);
      },
      // No credentialed paths: `readRoutes` grants its own, by name. This is
      // here only so the authorization paths get the `public` treatment they
      // get everywhere else.
      [],
      { allowedOrigins: READ_ORIGINS },
    ),
  });

  return {
    // The port the kernel assigned, not the one that was asked for. They differ
    // whenever `port: 0` is passed, and a URL naming 0 is one nothing can reach.
    url: `https://${options.host}:${server.port}`,
    stop: () => server.stop(true),
  };
}
