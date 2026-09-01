import type { Logger } from '#connectivity';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import type { PairingCredential } from './credential.ts';
import { readState, type ConnectionRow, type ReadEndpoint } from './state.ts';

/**
 * The two routes a browser origin may read, and everything that guards them.
 *
 * One implementation, two binds. On loopback `./listener.ts` gives them a port
 * of their own over TLS; on a deployed workspace `./deployed.ts` hands them to
 * the endpoint's own router, because Cloud Run routes exactly one port. The
 * split is deliberate and the sharing is the point: four of ADR-063's five
 * properties are decided in this file, so the two surfaces cannot drift into
 * two answers about what a pairing token may reach.
 *
 * Four properties, and dropping any one makes the others decorative:
 *
 *  - **One origin, named, never `*`.** Echoed with `Vary: Origin`. A deployment
 *    may wildcard `/mcp` because it is already publicly reachable and a `curl`
 *    has that reach already — but this returns every connection, every profile
 *    and the whole audit log, and `cors.ts`'s wildcard was buying the absence of
 *    a required setup step that does not exist here. So it is named.
 *  - **A credential that cannot call a tool.** The pairing token, minted by
 *    `lanes link pair`, under its own ref, rotatable on its own. It is not the
 *    MCP bearer and not an OAuth token, and it never passes through the
 *    endpoint's authenticator — one shared check would make each able to do the
 *    other's job.
 *  - **Never ambient.** An `Authorization` header the page must already hold.
 *    No cookie, no session, so `credentials: 'include'` buys an attacker
 *    nothing.
 *  - **Reads only, ever.** No mutation is reachable from here at all. Editing a
 *    profile from a browser would put control-plane mutation behind a CORS
 *    grant, and ADR-007 does not move for a convenience.
 *
 * The fifth — TLS — belongs to the bind rather than to the routes, and
 * `./listener.ts` carries it.
 */

/** Where the dashboard lives, and where it lives while somebody is building it. */
export const READ_ORIGINS: readonly string[] = ['https://lanes.sh', 'http://localhost:3000'];

export const STATE_PATH = '/state';
export const AUDIT_PATH = '/audit';

/**
 * Whether the router should hand this path over.
 *
 * A predicate rather than an exported array, so the router owns no literal of
 * its own and cannot come to disagree with the handler about which paths these
 * are. `isAuthorizationPath` is the same shape for the same reason.
 */
export function isReadPath(pathname: string): boolean {
  return pathname === STATE_PATH || pathname === AUDIT_PATH;
}

/** The most entries `/audit` will return, however many are asked for. */
const AUDIT_CEILING = 500;
const AUDIT_DEFAULT = 100;

/**
 * The half of the audit log this reads, declared rather than imported.
 *
 * `server` may not depend on `#audit`, and widening that table for one `tail`
 * would be the wrong direction to resolve it: these routes do not know how the
 * log is chained, stored, or verified, and nothing here should be able to find
 * out. What they need is the last N entries, so that is what they ask for.
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
      readonly status: string;
      readonly durationMs: number;
      readonly error?: { readonly kind: string; readonly message: string } | undefined;
    }[]
  >;
}

export interface ReadDeps {
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
  readonly credential: PairingCredential;
  /** What this endpoint says about itself. Fixed for the life of the bind. */
  readonly endpoint: ReadEndpoint;
  readonly allowedOrigins?: readonly string[] | undefined;
  readonly log?: Logger | undefined;
}

/**
 * Answer a read request, whatever it turns out to be.
 *
 * This answers **every** request handed to it, including its own `404` for an
 * unknown path — which is what lets `serveRead` pass a whole port through it.
 * The router must therefore hand over only what `isReadPath` matched: given an
 * unmatched path this would swallow `/mcp`.
 */
export async function readRoutes(request: Request, deps: ReadDeps): Promise<Response> {
  const origins = deps.allowedOrigins ?? READ_ORIGINS;
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
  // to any page that a Lanes read surface is here; a page that is not the
  // dashboard learns nothing it did not send.
  if (request.method !== 'GET') {
    return json({ error: 'not_found' }, 404, cors(origin, allowed));
  }

  if (origin !== null && !allowed) {
    return json({ error: 'origin_not_allowed' }, 403, cors(origin, false));
  }

  // The header is parsed before the store is asked anything. A request carrying
  // no bearer cannot be the dashboard, and on a deployed workspace a store read
  // is a network call — so answering it from the request alone is the
  // difference between a stranger costing nothing and a stranger costing a
  // Secret Manager round trip. `BearerAuthenticator` orders itself the same way
  // for the same reason.
  const presented = bearer(request);

  if (presented === null || !(await deps.credential.verify(presented))) {
    return json(
      {
        error: 'unpaired',
        // The page shows this verbatim. Every failure looks the same from a
        // browser — an expired certificate, a rotated token, a listener that is
        // not running — so the answer is always the command that fixes all of
        // them rather than a diagnosis the page cannot make.
        run: 'lanes link pair',
      },
      401,
      cors(origin, allowed),
    );
  }

  const url = new URL(request.url);

  if (url.pathname === STATE_PATH) {
    const rows = await deps.connections().catch(() => []);
    return json(
      readState(deps.workspace, deps.profiles(), rows, deps.endpoint),
      200,
      cors(origin, allowed),
    );
  }

  if (url.pathname === AUDIT_PATH) {
    const limit = Math.min(
      Number(url.searchParams.get('limit') ?? AUDIT_DEFAULT) || AUDIT_DEFAULT,
      AUDIT_CEILING,
    );
    const profile = url.searchParams.get('profile');

    const events = await deps.audit.tail({ limit });
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
          // Authorised and then failed is a state the four fields above cannot
          // express, and it is the one worth seeing: a call the policy allowed
          // and the provider refused reads as a successful call without these.
          status: event.status,
          durationMs: event.durationMs,
          error: event.error ?? null,
        })),
      },
      200,
      cors(origin, allowed),
    );
  }

  return json({ error: 'not_found' }, 404, cors(origin, allowed));
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;

  const presented = header.slice(7).trim();
  return presented === '' ? null : presented;
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
