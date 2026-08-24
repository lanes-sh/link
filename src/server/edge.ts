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

/** Refused for rate rather than for credential — deliberately a different status. */
export function tooManyAttempts(retryAfterMs: number): Response {
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
      },
    },
  );
}

/** One bucket set per endpoint. Idle callers are dropped so keys do not accumulate. */
export function failedAuthLimiter(): RateLimiter {
  return new RateLimiter();
}
