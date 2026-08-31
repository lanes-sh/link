import { timingSafeEqual } from 'node:crypto';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import { readState, type ConnectionRow } from './state.ts';

/**
 * The one surface a browser on `lanes.sh` may read (ADR-063).
 *
 * Its own listener, on its own port, over TLS, with its own credential, and no
 * route in common with the endpoint. Each of those is answering a specific
 * sentence in ADR-039, which refuses cross-origin access on loopback and says
 * so in terms that anticipated this decision. **The rule that refusal protects
 * is not being relaxed** — `/mcp` gains no CORS, no new route and no change to
 * the rebinding guard. This is a different surface, not a hole in that one.
 *
 * Five properties, and dropping any one of them makes the others decorative:
 *
 *  - **One origin, named, never `*`.** Echoed with `Vary: Origin`. A deployed
 *    endpoint may wildcard because it is already publicly reachable; loopback is
 *    not, so a page reaching it is stealing reachability nothing else has.
 *  - **A credential that cannot call a tool.** The pairing token, minted by
 *    `lanes link pair`, stored under its own ref, rotatable on its own. It is
 *    not the MCP bearer and not an OAuth token.
 *  - **Never ambient.** An `Authorization` header the page must already hold,
 *    obtained by the owner running a command. No cookie, no session, so
 *    `credentials: 'include'` buys an attacker nothing.
 *  - **Reads only, ever.** No mutation is reachable from here at all. Editing a
 *    profile from a browser would put control-plane mutation behind a CORS
 *    grant, and ADR-007 does not move for a convenience.
 *  - **TLS.** Not for confidentiality on a loopback socket, but because Safari
 *    will not let an HTTPS page fetch `http://127.0.0.1` and offers no flag that
 *    changes it. Without this the surface does not exist for a Safari user.
 */

/** Where the dashboard lives, and where it lives while somebody is building it. */
export const READ_ORIGINS: readonly string[] = ['https://lanes.sh', 'http://localhost:3000'];

/**
 * The half of the audit log this reads, declared rather than imported.
 *
 * `server` may not depend on `#audit`, and widening that table for one `tail`
 * would be the wrong direction to resolve it: this listener does not know how
 * the log is chained, stored, or verified, and nothing here should be able to
 * find out. What it needs is the last N entries, so that is what it asks for.
 */
export interface AuditTail {
  tail(options?: { limit?: number }): Promise<
    readonly {
      readonly id: string;
      readonly timestamp: Date;
      readonly profile: string;
      readonly principal: string;
      readonly clientLabel?: string | undefined;
      readonly provider: string;
      readonly connection?: string | undefined;
      readonly capability: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly authorization: string;
    }[]
  >;
}

export interface ReadListenerOptions {
  readonly host: string;
  readonly port: number;
  readonly workspace: string;
  /** The current generation's profiles, read through a thunk so a reload lands. */
  readonly profiles: () => ReadonlyMap<string, ProfileRuntime>;
  readonly audit: AuditTail;
  /**
   * The workspace's connection rows, read per request.
   *
   * A thunk rather than a value because a connection added while the endpoint
   * runs should appear without a restart — the same reason `profiles` is one.
   * Read from `connections.yaml` rather than derived from the grants, because
   * a label and an account live on the connection and a grant carries neither.
   */
  readonly connections: () => Promise<readonly ConnectionRow[]>;
  /** The pairing token, compared in constant time. */
  readonly token: string;
  readonly tls: { readonly cert: string; readonly key: string };
  readonly allowedOrigins?: readonly string[] | undefined;
}

export interface RunningReadListener {
  readonly url: string;
  stop(): Promise<void>;
}

export function serveRead(options: ReadListenerOptions): RunningReadListener {
  const origins = options.allowedOrigins ?? READ_ORIGINS;

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    tls: { cert: options.tls.cert, key: options.tls.key },
    fetch: (request) => handle(request, options, origins),
  });

  return {
    // The port the kernel assigned, not the one that was asked for. They differ
    // whenever `port: 0` is passed, and a URL naming 0 is one nothing can reach.
    url: `https://${options.host}:${server.port}`,
    stop: () => server.stop(true),
  };
}

async function handle(
  request: Request,
  options: ReadListenerOptions,
  origins: readonly string[],
): Promise<Response> {
  const origin = request.headers.get('origin');
  const allowed = origin !== null && origins.includes(origin);

  // Answered before the credential is checked, because a preflight carries no
  // credential — that is what it is for. It carries no data either, so
  // answering one reveals only that something is listening, which the TCP
  // connection already revealed.
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: allowed ? 204 : 403, headers: cors(origin, allowed) });
  }

  // Not `405`. A surface that answered "method not allowed" would be confirming
  // to any page on the machine that a Lanes read listener is here; a page that
  // is not the dashboard learns nothing it did not send.
  if (request.method !== 'GET') {
    return json({ error: 'not_found' }, 404, cors(origin, allowed));
  }

  if (origin !== null && !allowed) {
    return json({ error: 'origin_not_allowed' }, 403, cors(origin, false));
  }

  if (!authorised(request, options.token)) {
    return json(
      {
        error: 'unpaired',
        // The page shows this verbatim. Every local failure looks the same from
        // a browser — an expired certificate, a rotated token, a listener that
        // is not running — so the answer is always the command that fixes all
        // of them rather than a diagnosis the page cannot make.
        run: 'lanes link pair',
      },
      401,
      cors(origin, allowed),
    );
  }

  const url = new URL(request.url);

  if (url.pathname === '/state') {
    const rows = await options.connections().catch(() => []);
    return json(
      readState(options.workspace, options.profiles(), rows),
      200,
      cors(origin, allowed),
    );
  }

  if (url.pathname === '/audit') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
    const profile = url.searchParams.get('profile');

    const events = await options.audit.tail({ limit });
    const shown = profile ? events.filter((event) => event.profile === profile) : events;

    return json(
      {
        events: shown.map((event) => ({
          id: event.id,
          timestamp: event.timestamp.toISOString(),
          profile: event.profile,
          principal: event.principal,
          clientLabel: event.clientLabel ?? null,
          provider: event.provider,
          connection: event.connection ?? null,
          capability: event.capability,
          // Already redacted where it was written. This does not redact again,
          // and must not start to: a second rule here would be a second answer
          // to what is sensitive, and the log's own would stop being the truth.
          arguments: event.arguments,
          authorization: event.authorization,
        })),
      },
      200,
      cors(origin, allowed),
    );
  }

  return json({ error: 'not_found' }, 404, cors(origin, allowed));
}

function authorised(request: Request, expected: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return false;

  const presented = Buffer.from(header.slice(7).trim());
  const known = Buffer.from(expected);

  // Length is compared first and separately, because `timingSafeEqual` throws
  // on a mismatch rather than returning false. The length of a token is not the
  // secret; its contents are.
  return presented.length === known.length && timingSafeEqual(presented, known);
}

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  // `Vary: Origin` unconditionally, including on a refusal. Without it a cache
  // between here and the page can serve one origin's answer to another, which
  // is the whole grant leaking through an intermediary.
  const headers: Record<string, string> = { vary: 'Origin' };
  if (!allowed || origin === null) return headers;

  headers['access-control-allow-origin'] = origin;
  headers['access-control-allow-headers'] = 'authorization';
  headers['access-control-allow-methods'] = 'GET, OPTIONS';
  headers['access-control-max-age'] = '600';
  // Deliberately absent: `access-control-allow-credentials`. The token is sent
  // explicitly by the page, so allowing cookies would add an ambient credential
  // to a surface whose safety rests on there not being one.
  return headers;
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
