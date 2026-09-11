import { challenge, type AuthOutcome, type Authenticator, type ChallengeError } from '#auth';
import type { Logger } from '#connectivity';
import { RateLimiter } from '#policy';

/**
 * A ceiling on failed authentication.
 *
 * Every credential that does not match the cached one costs a re-read of the
 * credential store — a decrypt locally, a network call on a deployed instance.
 * That re-read is what makes a rotated-in token work on its first call, and it
 * is also a way to make the endpoint do expensive work on behalf of a caller
 * holding no credential at all. This bounds it.
 *
 * Not a security boundary, and `#policy`'s own note says so: 256 bits behind
 * `llk_` is what makes guessing hopeless. This is about cost, and about giving
 * a sustained probe a shape in the log rather than an unbroken run of 401s.
 */
export const FAILED_AUTH_PER_MINUTE = 30;

/**
 * A ceiling on the surface that answers *before* authentication.
 *
 * The limit above sits behind the bearer gate, and for a long time that was the
 * whole of it — which left the four things that answer in front of the gate with
 * no ceiling at all. On a `public` deployment every one of them costs the owner
 * something, and none of them needs a credential to reach:
 *
 *   - `/health` presented with a credential re-reads the credential store, which
 *     on a deployed target is a Secret Manager call — two, when the value the
 *     process cached does not match, because a mismatch against a cached value
 *     forces the re-read that makes a rotation take effect.
 *   - `/register` writes an object to the workspace bucket, then lists two
 *     namespaces to decide whether anything needs evicting.
 *   - `/authorize` compares against the endpoint token, which is another read of
 *     the credential store.
 *   - `/token` reads and writes bucket objects.
 *   - `/state` and `/audit` verify the pairing token, which on a deployed
 *     workspace is a Secret Manager call and has no cache behind it at all.
 *
 * `/health` presented with *no* credential is deliberately free: it reads
 * nothing, and it is what a platform probe and `lanes link outputs` send.
 * Metering it would put a ceiling on the one request that costs nothing to
 * answer.
 *
 * The read surface is **not** given that exemption, and the asymmetry is the
 * point: nothing legitimate calls `/state` without a credential — no probe, no
 * CLI command — so there is no free request to protect. Metering it
 * unconditionally also means the ceiling does not depend on `readRoutes`
 * continuing to parse the header before it asks the store anything. That
 * short-circuit is an optimisation; this is the guarantee.
 */
export const UNAUTHENTICATED_PER_MINUTE = 30;

/**
 * The same ceiling for the endpoint as a whole, keyed on nothing.
 *
 * **This is the one that actually holds.** The per-caller key below is the first
 * `X-Forwarded-For` hop, which anyone talking to the endpoint directly can write
 * as they please — so a per-caller limit alone bounds only a caller who is not
 * trying, and rotating the header walks straight through it.
 *
 * A shared bucket has the opposite problem: whoever is spending it locks
 * everyone else out, which is why `index.ts` refuses to key the *failed-auth*
 * limit that way. Here the trade is different, because what is behind these
 * paths is not the owner's ability to use their endpoint — a client that has
 * already authorised holds a token and never comes back through them — it is a
 * discovery document, a registration, and a consent screen. Losing those for a
 * minute is an authorization that has to be retried. Not losing them costs a
 * stranger's arbitrary spend against the credential store.
 *
 * Two hundred a minute is far above what an authorization flow uses: a connector
 * being added is a handful of requests, once.
 */
export const UNAUTHENTICATED_TOTAL_PER_MINUTE = 200;

/** The key the endpoint-wide bucket is held under. Constant on purpose. */
const EVERYONE = 'endpoint';

/**
 * Who an attempt is counted against.
 *
 * `x-forwarded-for`'s first hop is the client as the platform's front door saw
 * it, which is the only address that means anything on Cloud Run — the socket
 * peer there is Google's frontend, identical for every caller. It is trivially
 * spoofable by anyone talking to the endpoint directly, which is why the
 * fallback is a single shared bucket rather than something that looks
 * per-caller and is not: a loopback endpoint has one caller, and an attacker
 * who can already reach it can read the config file holding the token anyway.
 */
export function callerKey(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'direct';
}

/**
 * Refused for rate rather than for credential — deliberately a different status.
 *
 * **It still carries the challenge when it is standing in for a 401.** The whole
 * point of the `WWW-Authenticate` header is that a client whose access token has
 * lapsed reads it and refreshes; the ceiling below turns some of those 401s into
 * 429s, and a 429 without the header is one the client cannot act on. A
 * connector with several sessions retrying an expired token spends the budget in
 * seconds, and then recovers a minute later on its own — which reads as an
 * endpoint that is intermittently unavailable rather than one asking to be
 * re-authorised.
 *
 * Absent for the pre-auth ceilings, which meter `.well-known` and `/register`
 * and have no credential to challenge for.
 */
export function tooManyAttempts(retryAfterMs: number, metadataUrl?: string | null): Response {
  return new Response(
    JSON.stringify({
      error: 'too_many_requests',
      hint: 'Too many failed authentication attempts. Wait, then retry.',
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
        ...(metadataUrl === undefined
          ? {}
          : { 'www-authenticate': challenge(metadataUrl, CHALLENGE.invalid) }),
      },
    },
  );
}

/**
 * One bucket set per endpoint.
 *
 * The map is bounded by `RateLimiter` itself rather than by a caller
 * remembering to prune it. This comment used to say idle callers were dropped
 * "so keys do not accumulate", and nothing anywhere called `prune` — so on a
 * public URL the map grew one entry per distinct `X-Forwarded-For` for as long
 * as the process lived, which is a header a stranger writes.
 */
export function failedAuthLimiter(): RateLimiter {
  return new RateLimiter();
}

/** The same, for the pre-authentication surface. Separate so one cannot spend the other. */
export function unauthenticatedLimiter(): RateLimiter {
  return new RateLimiter();
}

/**
 * The refusal for a pre-authentication request over budget, or `undefined` to
 * let it through.
 *
 * One function rather than a branch in the router, for the reason `./cors.ts`
 * and `./oauth.ts` are their own files: `index.ts` gains a delegation instead of
 * the whole of this behaviour, and it stays inside the size budget that would
 * otherwise be the rule relaxed to fit this in.
 *
 * `isAuthorizationPath` is passed rather than imported so this file does not
 * reach back into the router's path constants — `corsAware` takes the same shape
 * for the same reason.
 *
 * Two buckets are taken rather than one short-circuiting the other, so a caller
 * that has exhausted its own budget still counts against the endpoint's: the
 * alternative lets a flood of distinct forwarded-for values leave the shared
 * bucket untouched, which is precisely the case the shared bucket exists for.
 */
export function unauthenticatedRefusal(input: {
  readonly request: Request;
  readonly pathname: string;
  readonly limiter: RateLimiter;
  readonly healthPath: string;
  readonly isAuthorizationPath: (pathname: string) => boolean;
  readonly authorizationEnabled: boolean;
  /** Passed rather than imported, for the reason `isAuthorizationPath` is. */
  readonly isDashboardPath: (pathname: string) => boolean;
  readonly readEnabled: boolean;
}): Response | undefined {
  // A `/health` carrying no credential reads nothing and is deliberately free —
  // it is what a platform probe and `lanes link outputs` send, and a ceiling on
  // the one request that costs nothing to answer is an outage waiting for an
  // attack that did not have to cause one.
  const costly =
    input.pathname === input.healthPath
      ? input.request.headers.get('authorization') !== null
      : (input.readEnabled && input.isDashboardPath(input.pathname)) ||
        (input.authorizationEnabled && input.isAuthorizationPath(input.pathname));

  if (!costly) return undefined;

  const caller = callerKey(input.request);
  const mine = input.limiter.take(`caller:${caller}`, UNAUTHENTICATED_PER_MINUTE);
  const everyone = input.limiter.take(EVERYONE, UNAUTHENTICATED_TOTAL_PER_MINUTE);
  if (mine.allowed && everyone.allowed) return undefined;

  return tooManyAttempts(Math.max(mine.retryAfterMs, everyone.retryAfterMs));
}

type RefusalReason = Extract<AuthOutcome, { ok: false }>['reason'];

/**
 * What a caller should do about each refusal.
 *
 * `invalid` is the only one a client can act on by itself: it presented a
 * credential and this endpoint did not accept it, which is what a refresh is
 * for. RFC 6750 §3.1 has a name for that and clients branch on it; the others
 * mean there is nothing to refresh, and §3 says to stay quiet rather than send
 * a client after a token it does not hold. `malformed` says nothing either —
 * `invalid_request` carries a SHOULD of a 400 status, and changing that path's
 * status is a larger question than this answers.
 */
const CHALLENGE: Partial<Record<RefusalReason, ChallengeError>> = {
  invalid: {
    code: 'invalid_token',
    description: 'The credential is expired, revoked, or not one this endpoint issued.',
  },
};

/** The same four, for whoever is reading the body rather than the header. */
const HINTS: Record<RefusalReason, string> = {
  missing: 'Present the profile token as: Authorization: Bearer <token>',
  malformed: 'Present the profile token as: Authorization: Bearer <token>',
  invalid: 'Refresh the credential. Authorize again only if the refresh is refused too.',
  not_configured: 'This profile has no token yet. Run: lanes link token rotate',
};

/**
 * The `401`, with whatever the caller can act on.
 *
 * Here rather than in the router because it is the same subject as the two
 * ceilings above — what this endpoint does about a caller who has not
 * authenticated — and because the router was over its size budget carrying both.
 * The vocabulary is RFC 6750's on the header and plain English in the body, so
 * whoever is reading a terminal and whoever is writing a client each get the
 * version they can use.
 */
function unauthorized(reason: RefusalReason, metadataUrl: string | null): Response {
  return new Response(
    JSON.stringify({ error: 'unauthorized', reason, hint: HINTS[reason] }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': challenge(metadataUrl, CHALLENGE[reason]),
      },
    },
  );
}

/**
 * What a caller who failed authentication gets: the `401`, or the `429` once
 * they have failed too often.
 *
 * The ceiling is spent **after** the attempt rather than before it. Keyed on the
 * caller alone, anyone able to reach the endpoint could spend the owner's budget
 * and lock them out, which trades a cost problem for a worse availability one.
 * Only a failure consumes a token, so a valid credential is never refused by
 * this.
 *
 * `metadataUrl` is the whole handshake for a remote client: it reads the named
 * document, finds the authorization server, and starts a flow. Without it the
 * client has to guess the document's location, and a client that guesses wrong
 * reports the endpoint as unreachable.
 */
export function authRefusal(input: {
  readonly request: Request;
  readonly reason: RefusalReason;
  readonly limiter: RateLimiter;
  readonly metadataUrl: string | null;
}): Response {
  const budget = input.limiter.take(callerKey(input.request), FAILED_AUTH_PER_MINUTE);
  return budget.allowed
    ? unauthorized(input.reason, input.metadataUrl)
    : tooManyAttempts(budget.retryAfterMs, input.metadataUrl);
}

/** What a request says it is calling, and on what. */
export interface NamedTarget {
  readonly method: string | null;
  readonly name: string | null;
  /**
   * The capability id, when the tool being called is `lanes_tools_call`.
   *
   * The gateway's own name is always advertised, so the tool name says nothing
   * about whether this instance knows what is being asked for. One level down
   * it does. Absent for every other tool, and for a body that does not carry it.
   */
  readonly capability: string | null;
  /**
   * The keywords, when the tool being called is `lanes_tools_search`.
   *
   * The same problem as `capability` and not the same shape: a search names no
   * capability to look up, so what "this instance knows about it" means is
   * whether anything it holds matches. Absent for every other tool.
   */
  readonly query: string | null;
}

/**
 * The method and target of a request, whichever revision it speaks.
 *
 * The 2026-07-28 envelope requires both in headers and rejects a request whose
 * headers and body disagree, so for an envelope client this is exact and free.
 *
 * **A 2025-era request carries neither**, and those are most of the clients this
 * endpoint is actually advertised to — the hosted connectors reach it by URL and
 * speak the older revision. Reading the header alone therefore short-circuited
 * for exactly the callers the refusal audit and the stale-config probe were
 * written for: a call naming a tool the protocol layer rejects left no trace,
 * and an instance holding config older than the account being named never
 * re-read it. Both are documented in `index.ts` as the second exception to
 * `audit.every-invocation`, and the fix named there is this one — clone and
 * parse the body when the header is absent, which is what `stdio.ts` already
 * does for want of headers.
 *
 * The clone is what makes it safe: the handler still gets an unconsumed body.
 * The cost is bounded by the same rule that bounds everything else on this path
 * — attachments are named rather than carried (ADR-017), so an MCP request body
 * is small.
 */
export async function namedTarget(request: Request): Promise<NamedTarget> {
  // The envelope mirrors the method and the target name into headers, but not
  // a tool's arguments — so the stable-name pair's own arguments are only ever
  // in the body, and reading them is the one thing an envelope client does not
  // save us.
  const header = request.headers.get('mcp-method');

  try {
    const body = (await request.clone().json()) as {
      method?: unknown;
      params?: { name?: unknown; arguments?: { capability?: unknown; query?: unknown } };
    };
    const { capability, query } = body.params?.arguments ?? {};

    return {
      method: header ?? (typeof body.method === 'string' ? body.method : null),
      name:
        request.headers.get('mcp-name') ??
        (typeof body.params?.name === 'string' ? body.params.name : null),
      capability: typeof capability === 'string' ? capability : null,
      query: typeof query === 'string' ? query : null,
    };
  } catch {
    // A body that is not JSON is one the handler refuses on its own, and a
    // refusal that cannot be named is not worth failing the request over. The
    // headers still stand where an envelope client sent them.
    return { method: header, name: request.headers.get('mcp-name'), capability: null, query: null };
  }
}

/**
 * Authenticate, and turn a store outage into an answer rather than a stack.
 *
 * `authenticate` is not a pure check: both authenticators in the chain read the
 * credential store, and on a deployed instance that is a network call — a GCS
 * GET for the hashed token object, and a Secret Manager read behind the bearer
 * path. Neither was guarded, and there is no `catch` anywhere in the router, so
 * a 429 or a 503 from either store escaped the fetch handler entirely: the
 * client got a bare 500, nothing was logged, and "the connector is unavailable"
 * is how every client renders that.
 *
 * **503, not 401.** The credential presented may well be perfectly good; what
 * failed is this endpoint's ability to check it. Answering 401 would tell a
 * client to refresh a token that is not the problem, and a client that cannot
 * refresh then asks the person to authorise again — user-visible churn caused by
 * a transient bucket error. `Retry-After` says the useful thing instead.
 *
 * This is deliberately not the same choice `OidcAuthenticator` makes internally.
 * There, an unreachable issuer means the claim cannot be established at all and
 * failing closed is the safe reading. Here the failure is ours and is transient,
 * and both readings are closed — so the one that does not misattribute the fault
 * wins.
 */
export async function authenticateRequest(
  authenticator: Authenticator,
  request: Request,
  log: Logger,
): Promise<AuthOutcome | Response> {
  try {
    return await authenticator.authenticate(request.headers.get('authorization'));
  } catch (error) {
    log.error('could not authenticate', {
      message: error instanceof Error ? error.message : String(error),
    });

    return new Response(
      JSON.stringify({
        error: 'unavailable',
        hint: 'This endpoint could not reach its credential store. The credential was not rejected.',
      }),
      { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '2' } },
    );
  }
}
