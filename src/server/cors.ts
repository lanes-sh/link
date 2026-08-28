import { isAuthorizationPath } from './oauth.ts';

/**
 * Cross-origin access, for a routable deployment and nothing else.
 *
 * A preflight carries no credentials, by construction rather than by omission:
 * the CORS specification strips them, so `OPTIONS` arrives with no
 * `Authorization` header and no cookie. Answering it from behind the bearer gate
 * therefore refuses every browser-origin client *before* it has any opportunity
 * to present one — which is what this endpoint did until this file existed, and
 * it is a category error rather than a policy.
 *
 * **Never on loopback.** `./rebinding.ts` already answers that question, and
 * answers it no: a cross-origin `Origin` on a request to `127.0.0.1` is refused
 * outright, because a page the owner happens to be visiting can otherwise reach
 * everything that answers before authentication — including the `/authorize`
 * form that asks them for their token. A CORS grant and an `Origin` refusal on
 * the same request are two answers to one question. So `serve` builds a policy
 * only for a host that is not loopback, and nothing in this file decides that:
 * it is decided by whether a policy exists at all.
 */

/**
 * Two halves, because what is already public and what carries the credential
 * differ in what a grant costs.
 *
 * The public half is the authorization surface: readable without a credential by
 * design, so a wildcard adds no reach a `curl` did not already have. It includes
 * `/authorize`, which needs no grant at all — a top-level navigation, not a
 * fetch — because `isAuthorizationPath` is one predicate that already exists and
 * a second list of five paths would be a second thing to drift.
 *
 * `/health` and `/reload` are in neither half. No browser client needs them, and
 * where the answer is not obvious default deny is the cheaper mistake.
 */
export type CorsSurface = 'public' | 'credentialed';

export interface CorsPolicy {
  /**
   * Origins that may call the credentialed surface. `['*']` is the default.
   *
   * A wildcard, and not because narrowing was too much work — because on a
   * deployment there is nothing left for it to defend. Three things have to be
   * true together, and here they are:
   *
   * 1. **The endpoint is already reachable by anyone.** `access: public` is what
   *    a connector needs, so any server on the internet can post to `/mcp` and
   *    read the refusal today. CORS never gated *sending*; it gates whether a
   *    *page* may read the reply. An attacker with a server needs no page.
   * 2. **The credential is never ambient.** It is an `Authorization` header a
   *    page must already possess, never a cookie a browser attaches on its own.
   *    So the request a hostile page gains is an unauthenticated one, and what
   *    it gains from reading the answer is a `401` it could have had from
   *    anywhere.
   * 3. **`Access-Control-Allow-Credentials` is never sent** — and with `*` it
   *    cannot be: the specification refuses the combination outright. The one
   *    header that would make a wildcard dangerous is unreachable from here.
   *
   * What an allowlist bought, then, was a required setup step per user in
   * exchange for narrowing a surface that was not exposed. Naming origins is
   * still possible and still narrows — an enterprise deployment may want it —
   * but absent means `*`, because a default nobody can skip is a default that
   * is wrong.
   *
   * None of this holds on loopback, which is why loopback has no policy at all.
   * There the endpoint is *not* publicly reachable, and that is precisely what
   * a page reaching `127.0.0.1` would be stealing.
   */
  readonly allowedOrigins: readonly string[];
}

/** The default, and what an absent `auth.allowed_origins` resolves to. */
export const ANY_ORIGIN = '*';

/**
 * What a browser is allowed to send.
 *
 * The list is fixed rather than reflected from `Access-Control-Request-Headers`,
 * because reflecting it grants whatever was asked for and the answer to "which
 * headers does this endpoint read" is knowable here. These are they: the
 * credential, the 2026-07-28 envelope's method and target, the client label the
 * audit log records, and the session and resumption headers the MCP SDK sends.
 */
const ALLOW_HEADERS = [
  'authorization',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
  'x-mcp-client',
  'last-event-id',
].join(', ');

/**
 * What a browser is allowed to read back.
 *
 * `WWW-Authenticate` is the load-bearing one: it carries `resource_metadata`,
 * which is the whole discovery handshake (ADR-036). Without it a browser client
 * receives the `401` and cannot see the pointer that tells it what to do next,
 * which looks exactly like an endpoint that refuses for no reason.
 *
 * `Retry-After` for the same reason on the other refusal — `edge.ts` sends one
 * with a `429` and a caller that cannot read it can only guess when to retry.
 */
const EXPOSE_HEADERS = ['WWW-Authenticate', 'Mcp-Session-Id', 'Retry-After'].join(', ');

/**
 * Which half a path belongs to, or neither.
 *
 * The authorization surface answers without a credential by design, so a
 * wildcard there hands a page what `curl` already has. Everything else is either
 * named by the caller as credentialed or gets nothing at all.
 */
function surfaceOf(pathname: string, credentialed: readonly string[]): CorsSurface | undefined {
  if (isAuthorizationPath(pathname)) return 'public';
  return credentialed.includes(pathname) ? 'credentialed' : undefined;
}

/** POST for calls, GET for the SSE stream, DELETE to end a session. */
const ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';

/** A day. A preflight per call is the cost of getting this wrong. */
const MAX_AGE = '86400';

/**
 * The value for `Access-Control-Allow-Origin`, or `null` to grant nothing.
 *
 * A listed origin is echoed rather than answered with `*`, because a list is a
 * narrowing and `*` would discard it. That is also why the wildcard and the echo
 * cannot share a branch: they differ in whether the answer varies by caller, and
 * `Vary` has to follow.
 */
function grantFor(request: Request, surface: CorsSurface, policy: CorsPolicy): string | null {
  if (surface === 'public') return ANY_ORIGIN;
  if (policy.allowedOrigins.includes(ANY_ORIGIN)) return ANY_ORIGIN;

  const origin = request.headers.get('origin');
  return origin && policy.allowedOrigins.includes(origin) ? origin : null;
}

/**
 * The headers to add to a response, or `undefined` for nothing to add.
 *
 * Nothing is added when the request carries no `Origin`, which is every
 * non-browser client: there is no origin to grant, and a header naming one
 * would be an invention. That is also what keeps `curl` output identical to what
 * it was.
 */
function corsHeaders(
  request: Request,
  surface: CorsSurface,
  policy: CorsPolicy,
): Record<string, string> | undefined {
  const origin = request.headers.get('origin');
  if (!origin) return undefined;

  const allowed = grantFor(request, surface, policy);
  if (!allowed) return undefined;

  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': ALLOW_METHODS,
    'access-control-allow-headers': ALLOW_HEADERS,
    'access-control-expose-headers': EXPOSE_HEADERS,
    'access-control-max-age': MAX_AGE,
    // Only meaningful where the value varies, and harmful to omit there: a
    // shared cache would otherwise hand one origin's grant to another.
    ...(allowed === ANY_ORIGIN ? {} : { vary: 'Origin' }),
  };
}

/**
 * The answer to a preflight: `204`, with the grant or without it.
 *
 * Without it for an origin that is not allowed, rather than a `403` — the
 * browser refuses the call on the absence of the header, which is the mechanism
 * CORS actually uses, and a distinct status would tell a probing page which
 * paths exist. Never a `401`: see the note at the top of this file.
 *
 * `Access-Control-Allow-Credentials` is absent from both, deliberately and
 * everywhere. The credential here is a header a page cannot obtain, never a
 * cookie a browser would attach on its own, so the wildcard above grants
 * nothing without it — and sending it is what would turn that wildcard into a
 * hole.
 */
function preflightResponse(headers: Record<string, string> | undefined): Response {
  return new Response(null, { status: 204, headers: headers ?? {} });
}

/**
 * The same response, carrying the grant.
 *
 * Rebuilt rather than mutated: a `Response` the MCP SDK returns may carry an
 * immutable header guard, and `body` is a stream that survives being passed
 * through. A `204` or `304` has a null body already, so this is safe for those
 * too.
 */
function withCors(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

/**
 * The same handler, with cross-origin requests answered.
 *
 * A wrapper rather than six branches in the router, for the reason `./oauth.ts`
 * is its own file: `index.ts` gains a delegation instead of the whole of this
 * behaviour, and it stays inside the size budget that would otherwise be the
 * rule relaxed to fit this in.
 *
 * Wrapped at `serve()` rather than inside the router, which is also where the
 * policy is decided: cross-origin access is a property of the address this is
 * bound to, exactly as `allowedHostnames` is, and putting both in one function
 * is what makes the loopback exclusion legible instead of an invariant spread
 * across two files.
 *
 * It is what makes the ordering safe, too. A preflight answered here never
 * reaches the rebinding guard inside `inner` — and does not need to, because a
 * policy exists only off loopback, where that guard is inert. Both facts are
 * three lines apart in `serve()`, derived from the same `loopback`.
 *
 * The credentialed paths are passed rather than imported because the router owns
 * its own path constants, and reaching back for `MCP_PATH` would make this file
 * and that one import each other.
 */
export function corsAware(
  inner: (request: Request) => Promise<Response>,
  credentialed: readonly string[],
  policy: CorsPolicy,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const surface = surfaceOf(new URL(request.url).pathname, credentialed);
    if (!surface) return await inner(request);

    const headers = corsHeaders(request, surface, policy);

    // Answered here, ahead of the auth gate, because a preflight carries no
    // credential and never will — the note at the top of this file says why that
    // is a fact about CORS rather than a choice about this endpoint.
    if (request.method === 'OPTIONS') return preflightResponse(headers);

    const response = await inner(request);
    return headers ? withCors(response, headers) : response;
  };
}
