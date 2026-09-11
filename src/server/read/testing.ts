import type { Authenticator, Principal } from '#auth';

/**
 * An authenticator that answers for one token.
 *
 * The routes take the endpoint's own `authenticate` so that who is calling is
 * an input rather than something they work out, and a test about filtering
 * wants to state the caller in one line rather than drive an OAuth flow to get
 * one. The real chain is exercised in `src/auth/remote.test.ts` and
 * `src/auth/index.test.ts`; this stands in for it everywhere the subject under
 * test is a route.
 *
 * It returns the principal verbatim, including its `profiles`, because that is
 * the field under test: `mayReach` reads it and the routes filter on the
 * answer.
 */
export function fixedAuthenticator(
  token: string,
  principal: Principal,
): Authenticator['authenticate'] {
  return async (header) =>
    header === `Bearer ${token}`
      ? { ok: true, principal }
      : { ok: false, reason: header ? 'invalid' : 'missing' };
}
