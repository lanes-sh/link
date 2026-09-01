import { readRoutes, type ReadDeps } from './routes.ts';

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
 */

export { READ_ORIGINS, type AuditTail, type ReadDeps } from './routes.ts';

export interface ReadListenerOptions extends ReadDeps {
  readonly host: string;
  readonly port: number;
  readonly tls: { readonly cert: string; readonly key: string };
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
    // side passes only what `isReadPath` matched — handing an unmatched path to
    // `readRoutes` there would swallow `/mcp`.
    fetch: (request) => readRoutes(request, options),
  });

  return {
    // The port the kernel assigned, not the one that was asked for. They differ
    // whenever `port: 0` is passed, and a URL naming 0 is one nothing can reach.
    url: `https://${options.host}:${server.port}`,
    stop: () => server.stop(true),
  };
}
