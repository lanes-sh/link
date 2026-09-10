import type { Logger } from '#connectivity';
import { mayReach, type Authenticator, type Principal } from '#auth';
import type { ProfileRuntime } from '../mcp/visibility.ts';
import { bearer, cors, json } from './http.ts';
import { dataRoutes, isDataPath, DATA_HEADERS, DATA_METHODS } from './data.ts';
import type { DataSurface } from '#cli/owner-data/surface.ts';
import {
  readState,
  type ConnectionRow,
  type ProviderNames,
  type ReadEndpoint,
} from './state.ts';

/**
 * The two routes a browser origin may read, and everything that guards them.
 *
 * One implementation, two binds. On loopback `./listener.ts` gives them a port
 * of their own over TLS; on a deployed workspace `./deployed.ts` hands them to
 * the endpoint's own router, because Cloud Run routes exactly one port. The
 * split is deliberate and the sharing is the point: four of ADR-063's five
 * properties are decided in this file, so the two surfaces cannot drift into
 * two answers about what a caller may reach.
 *
 * Four properties, and dropping any one makes the others decorative:
 *
 *  - **One origin, named, never `*`.** Echoed with `Vary: Origin`. A deployment
 *    may wildcard `/mcp` because it is already publicly reachable and a `curl`
 *    has that reach already — but this returns every connection, every profile
 *    and the whole audit log, and `cors.ts`'s wildcard was buying the absence of
 *    a required setup step that does not exist here. So it is named.
 *  - **The same credential `/mcp` takes, through the same authenticator.** An
 *    OAuth bearer the browser got by signing in with Lanes, or a static API
 *    key: both name a uid, and both carry the profiles that uid's `members:`
 *    rows resolved to. This surface used to have a credential of its own — the
 *    pairing token — and that is the whole of ADR-079: it answered *does this
 *    browser hold the workspace's secret*, never *who is holding it*, so there
 *    was no principal to filter on and nothing filtered. A second credential
 *    shape was also a second set of rules to keep in step, which is why the
 *    fix is to delete one rather than to add a check to it.
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

/**
 * Everything this surface serves, which is what the router hands over.
 *
 * A second predicate rather than widening `isReadPath`, because that one still
 * has a job: it names the two paths that are reads and nothing else, and a
 * predicate called "read" gating a `DELETE` would be the kind of quiet
 * disagreement between a name and a behaviour this file exists to prevent.
 *
 * It was `isPairedPath` while a pairing token was what reached these. Nothing
 * is paired any more — a caller signs in — and a predicate still saying so
 * would be the same disagreement one level up.
 */
export function isDashboardPath(pathname: string): boolean {
  return isReadPath(pathname) || isDataPath(pathname);
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
  /**
   * Who is calling, resolved exactly as `/mcp` resolves it.
   *
   * The endpoint's own authenticator, passed in rather than rebuilt — the chain
   * of the workspace's static API keys and, where a profile declares one, its
   * OAuth or OIDC gate (`server/authorization.ts`). So a bearer works on both
   * surfaces or on neither, and `mayReach` is asked the same question about the
   * same principal in both places.
   *
   * Every principal it can produce names a uid and carries a resolved profile
   * list. `ownerPrincipal` — the one that reaches everything — is reachable
   * only from the stdio pipe and the CLI, and `src/architecture.test.ts` holds
   * that, so there is no credential arriving here that can widen past a member
   * list.
   */
  readonly authenticate: Authenticator['authenticate'];
  /**
   * What each provider is called, for the row nobody has labelled.
   *
   * Optional so a harness can omit it: absent, an unlabelled row reports a null
   * label and its reader falls back to the id, which is what every reader did
   * before. Both real binds pass their runtime's registry.
   */
  readonly providerName?: ProviderNames | undefined;
  /** What this endpoint says about itself. Fixed for the life of the bind. */
  readonly endpoint: ReadEndpoint;
  /**
   * The owner's own data, when this endpoint opened runtimes that can reach it.
   *
   * Narrow on purpose, and satisfied under `cli` — the only component allowed
   * to touch both a store and the log. `server` may import neither, so this is
   * the same seam `AuditTail` above keeps, for the same reason (ADR-069).
   *
   * Optional because a harness may omit it. Absent, `/data` is a `404` and
   * every other path behaves exactly as it did before this surface existed.
   */
  readonly data?: DataSurface | undefined;
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
  const url = new URL(request.url);

  // Whether this request is for the surface that may write (ADR-069), decided
  // once. `deps.data` absent means no data surface at all — an endpoint whose
  // runtimes were never wired answers these paths exactly as it answers an
  // unknown one, so a bind without a data surface needs no second code path.
  const writable = deps.data !== undefined && isDataPath(url.pathname);
  const methods = writable ? DATA_METHODS : 'GET, OPTIONS';
  const permitted = (headers = 'authorization'): Record<string, string> =>
    cors(origin, allowed, methods, headers);

  // Answered before the caller is resolved, because a preflight carries no
  // credential — that is what it is for. It carries no data either, so
  // answering one reveals only that something is listening, which the TCP
  // connection already revealed.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: allowed ? 204 : 403,
      headers: permitted(writable ? DATA_HEADERS : undefined),
    });
  }

  // Not `405`. A surface that answered "method not allowed" would be confirming
  // to any page that a Lanes read surface is here; a page that is not the
  // dashboard learns nothing it did not send. `/state` and `/audit` are still
  // reads only: the widening below is scoped to the paths `isDataPath` matched.
  if (request.method !== 'GET' && !(writable && DATA_METHODS.includes(request.method))) {
    return json({ error: 'not_found' }, 404, permitted());
  }

  if (origin !== null && !allowed) {
    return json({ error: 'origin_not_allowed' }, 403, cors(origin, false, methods));
  }

  // The header is parsed before the store is asked anything. A request carrying
  // no bearer cannot be the dashboard, and on a deployed workspace a store read
  // is a network call — so answering it from the request alone is the
  // difference between a stranger costing nothing and a stranger costing a
  // Secret Manager round trip. `BearerAuthenticator` orders itself the same way
  // for the same reason.
  const presented = bearer(request);

  // The page shows this verbatim, and it is the one answer for every way a
  // credential can fail to name somebody — expired, revoked, never signed in.
  // `signIn` rather than a command, because the fix is in the browser now: the
  // page starts an authorization against this endpoint and the person signs in
  // with Lanes, which is the same thing an MCP client does.
  const unauthorized = (): Response =>
    json({ error: 'unauthorized', signIn: true }, 401, permitted());

  if (presented === null) return unauthorized();

  // **Failing closed is the point of the `catch`.** Resolving a bearer reads
  // the credential store, which on a deployed workspace is a network call to
  // Secret Manager — and it answers a missing IAM binding with 403 rather than
  // 404, so the adapter *throws* rather than returning null. Uncaught on a
  // public URL that is a 500, and a 500 on a misconfigured binding is
  // indistinguishable from a 500 on a bug. `authenticateRequest` wraps the
  // `/mcp` path the same way, for the same reason.
  const outcome = await deps
    .authenticate(request.headers.get('authorization'))
    .catch((reason: unknown) => {
      deps.log?.warn('could not resolve the caller', {
        reason: reason instanceof Error ? reason.message : String(reason),
      });
      return { ok: false, reason: 'invalid' } as const;
    });

  if (!outcome.ok) return unauthorized();
  const caller: Principal = outcome.principal;

  // Below the authentication, so one place decides who is calling and the two
  // surfaces cannot come to disagree about what they may reach.
  if (writable && deps.data) {
    return dataRoutes(request, url, deps.data, permitted(DATA_HEADERS), caller);
  }

  if (url.pathname === STATE_PATH) {
    const rows = await deps.connections().catch(() => []);
    return json(
      readState(deps.workspace, deps.profiles(), rows, deps.endpoint, caller, deps.providerName),
      200,
      permitted(),
    );
  }

  if (url.pathname === AUDIT_PATH) {
    const limit = Math.min(
      Number(url.searchParams.get('limit') ?? AUDIT_DEFAULT) || AUDIT_DEFAULT,
      AUDIT_CEILING,
    );
    const profile = url.searchParams.get('profile');

    const events = await deps.audit.tail({ limit });
    // Filtered by what the caller reaches before the `profile` argument narrows
    // it further. The log is the workspace's (ADR-063), but an entry names the
    // profile it happened in, so an unfiltered tail would report the existence
    // of every profile and every capability called in it to somebody no member
    // list names.
    const mine = events.filter((event) => mayReach(caller, event.profile));
    const shown = profile ? mine.filter((event) => event.profile === profile) : mine;

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
      permitted(),
    );
  }

  return json({ error: 'not_found' }, 404, permitted());
}
