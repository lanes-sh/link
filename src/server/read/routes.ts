import type { Logger } from '#connectivity';
import { mayReach, memberPrincipal, type Principal } from '#auth';
import type { Federation } from '#auth';

/**
 * Only the half of `Federation` this surface needs.
 *
 * `profilesFor` is deliberately not taken: this file answers that from the
 * runtimes it is already holding. Asking for less is what keeps the two
 * sources of "which profiles name this person" from becoming two answers.
 */
export type AssertionCheck = Pick<Federation, 'verify' | 'consentUrl'>;
import type { ProfileRuntime } from '../mcp/visibility.ts';
import type { PairingCredential } from './credential.ts';
import { reaches, type PairedCaller, type PairingSessions } from './session.ts';
import { bearer, cors, json } from './http.ts';
import { isPairingPath, pairingRoutes, SESSION_PATH } from './pairing.ts';
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

/**
 * Everything a pairing token may reach, which is what the router hands over.
 *
 * A second predicate rather than widening `isReadPath`, because that one still
 * has a job: it names the two paths that are reads and nothing else, and a
 * predicate called "read" gating a `DELETE` would be the kind of quiet
 * disagreement between a name and a behaviour this file exists to prevent.
 */
export function isPairedPath(pathname: string): boolean {
  return isReadPath(pathname) || isDataPath(pathname) || isPairingPath(pathname);
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
  /**
   * Where a pairing token becomes a person, and where a session is resolved.
   *
   * Optional so a harness may omit it. Absent, the exchange is a `404` and
   * every gated path answers `401` — which is the honest state for an endpoint
   * that cannot tell one caller from another, and is what an old build looks
   * like to a dashboard that has learned to ask.
   */
  readonly sessions?: PairingSessions | undefined;
  /**
   * Who lanes.sh says is at the browser, and which profiles name them.
   *
   * The same `Federation` the endpoint's own OAuth consent flow is handed
   * (`auth/lanes/federation.ts`), passed in rather than rebuilt, so the two
   * surfaces cannot come to disagree about who signed an assertion.
   *
   * Narrowed to the half that answers *who*. Which profiles that subject
   * reaches is read from `profiles()` below instead — the live generation,
   * which is the same set the endpoint serves and is already reload-aware, so
   * there is no second cache to go stale against a `profile members remove`.
   */
  readonly federation?: AssertionCheck | undefined;
  /**
   * What an assertion must name as its audience.
   *
   * This surface's own base URL, never the MCP one: a statement minted to open
   * the dashboard must not be replayable into an authorization at `/mcp`, and
   * the audience is the field that decides it.
   *
   * Optional because only one bind can know it up front. A loopback listener
   * chooses its own address and pins it here. A deployed one is reached at
   * whatever the platform assigned, which is not known when the deps are built,
   * so it falls back to the origin of the request being served — the address
   * the browser actually used, which is the one it asked lanes.sh to mint for.
   */
  readonly resource?: string | undefined;
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
  // unknown one, which is the same shape as an unpaired workspace and needs no
  // second code path.
  const writable = deps.data !== undefined && isDataPath(url.pathname);
  // The exchange takes a POST and nothing else does. Named here rather than
  // folded into `writable`, because the two are different grants: one is the
  // owner's own data, the other is the step that decides whose data it is.
  const pairing = isPairingPath(url.pathname);
  const methods = pairing ? 'GET, POST, OPTIONS' : writable ? DATA_METHODS : 'GET, OPTIONS';
  const permitted = (headers = 'authorization'): Record<string, string> =>
    cors(origin, allowed, methods, headers);

  // Answered before the credential is checked, because a preflight carries no
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
  const posting = pairing && request.method === 'POST' && url.pathname === SESSION_PATH;
  if (
    request.method !== 'GET' &&
    !posting &&
    !(writable && DATA_METHODS.includes(request.method))
  ) {
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

  // The page shows this verbatim. Every failure looks the same from a browser —
  // an expired certificate, a rotated token, a listener that is not running —
  // so the answer is always the command that fixes all of them rather than a
  // diagnosis the page cannot make.
  const unpaired = (): Response =>
    json({ error: 'unpaired', run: 'lanes link pair' }, 401, permitted());

  if (presented === null) return unpaired();

  // **The pairing token opens the exchange and nothing else.** It names a
  // workspace, not a person, so everything below it is gated on the session the
  // exchange hands back instead. That is the whole of ADR-079: this credential
  // used to answer `/state`, `/audit` and `/data` directly, which made it a
  // key to every profile in the workspace for whoever held it.
  if (pairing) {
    if (!(await deps.credential.verify(presented))) return unpaired();
    return pairingRoutes(request, url, deps, permitted());
  }

  const caller = (await deps.sessions?.resolve(presented)) ?? null;
  if (caller === null) return unpaired();

  // Below the session check, so one place decides who is calling and the two
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
    const mine = events.filter((event) => reaches(caller, event.profile));
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
