/**
 * Client identity.
 *
 * What every way of proving a credential has in common: the outcome, the
 * interface, the chain that tries them in order, and how a bearer is parsed and
 * compared. Each proof itself is its own file — `bearer.ts` for the rows this
 * workspace stores, `remote.ts` for the three it verifies rather than holds.
 *
 * Target: the OAuth 2.1 resource-server model the MCP spec expects, where this
 * module validates tokens issued by an external authorization server. Client
 * identity, authentication, and authorization are kept behind separate
 * interfaces precisely so that drops in without touching a single provider.
 * Do not invent cryptography here.
 *
 * KNOWN LIMITATION, stated rather than papered over: bearer tokens are bearer
 * authorization. Anyone holding the token is the principal, tokens are not
 * bound to a device, and agent config files typically sit in plaintext on
 * disk — so a token is roughly as protected as that file. Revocation means
 * rotating the token and reconciling.
 */

import { timingSafeEqual } from 'node:crypto';

import type { Principal } from './principal.ts';

/**
 * The principal model lives in `./principal.ts`, and is re-exported here so
 * that `#auth` stays the one import every other component uses.
 */
export {
  EVERY_PROFILE,
  forProfile,
  machinePrincipal,
  mayReach,
  memberPrincipal,
  ownerPrincipal,
  reachWithin,
  type Principal,
  type Reach,
} from './principal.ts';

export type AuthOutcome =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' | 'invalid' | 'not_configured' };

/**
 * What the request says about who is being addressed.
 *
 * Only one field, and only one authenticator reads it: a credential somebody
 * *else* signed has to name this endpoint, or a key minted for one deployment
 * opens every deployment the same issuer serves — the confused-deputy case the
 * MCP authorization spec calls out. A token this endpoint minted needs none of
 * this, because being in this endpoint's store is already the binding.
 *
 * **Optional in the type and mandatory in effect.** A link that needs it refuses
 * when it is absent rather than skipping the check, which is ADR-079's lesson
 * stated one layer down: an absent field must not resolve to the widest answer.
 * It is optional here only so the implementations that ignore it, and the test
 * doubles that predate it, do not have to mention it.
 */
export interface AuthContext {
  /**
   * This endpoint's resource identifier, exactly as the client addressed it.
   *
   * The same string `protectedResourceMetadata` publishes and an assertion's
   * `aud` must match — built from `Host` and `X-Forwarded-Proto`, because this
   * endpoint does not know its own public URL from config. See
   * `server/oauth.ts`.
   */
  readonly resource: string;
}

/**
 * Anything that can turn an `Authorization` header into a principal.
 *
 * Extracted so the endpoint can accept more than one kind of proof without the
 * request path learning what kinds exist. There are three: a static token the
 * operator holds, a token this endpoint or an issuer handed to a client that
 * completed an authorization flow, and an API key `api.lanes.sh` signed. All
 * arrive in the same header, and the server does not care which answered.
 */
export interface Authenticator {
  authenticate(
    authorizationHeader: string | null | undefined,
    context?: AuthContext,
  ): Promise<AuthOutcome>;
  invalidateCache?(): void;
}

/**
 * Try each in order; the first to recognise the credential wins.
 *
 * Order is not arbitrary — the static token first, because it is a local
 * constant-time comparison against a cached value and covers the CLI, `outputs`,
 * and every local registration. Putting a network round trip in front of that
 * would make the common case the slow one.
 *
 * The reported reason is the most specific failure any link produced. A chain
 * that reported `missing` because the last link saw no credential of *its* kind
 * would describe a rejected token as an absent one, which sends whoever is
 * debugging it to entirely the wrong place.
 */
export class AuthenticatorChain implements Authenticator {
  readonly #links: readonly Authenticator[];

  constructor(links: readonly Authenticator[]) {
    this.#links = links;
  }

  async authenticate(
    authorizationHeader: string | null | undefined,
    context?: AuthContext,
  ): Promise<AuthOutcome> {
    const rank = { invalid: 3, not_configured: 2, malformed: 1, missing: 0 } as const;
    let worst: Extract<AuthOutcome, { ok: false }> = { ok: false, reason: 'missing' };

    for (const link of this.#links) {
      const outcome = await link.authenticate(authorizationHeader, context);
      if (outcome.ok) return outcome;
      if (rank[outcome.reason] > rank[worst.reason]) worst = outcome;
    }

    return worst;
  }

  invalidateCache(): void {
    for (const link of this.#links) link.invalidateCache?.();
  }
}

const BEARER_PATTERN = /^Bearer[ ]+(.+)$/i;

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.trim().match(BEARER_PATTERN);
  return match?.[1]?.trim() || null;
}

/**
 * Compare in constant time.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length,
 * so both sides are hashed to a fixed width first. Comparing raw tokens with
 * `===` would leak the shared prefix a byte at a time.
 */
export function tokensMatch(a: string, b: string): boolean {
  const hash = (value: string): Buffer =>
    Buffer.from(new Bun.CryptoHasher('sha256').update(value, 'utf8').digest());
  return timingSafeEqual(hash(a), hash(b));
}

export {
  authorizationServerMetadata,
  challenge,
  protectedResourceMetadata,
  MCP_SCOPE,
  type ChallengeError,
  type ResourceIdentity,
} from './oauth/metadata.ts';
export {
  OAuthServer,
  pkceChallengeFor,
  type EndpointIdentity,
  type Federation,
  type OAuthResult,
} from './oauth/server.ts';
export { AssertionVerifier, type Assertion } from './lanes/assertion.ts';
export { ApiKeyVerifier, type ApiKeySubject } from './lanes/api-key.ts';
export {
  lanesApiKeyVerifier,
  lanesApiUrl,
  lanesFederation,
  DEFAULT_WEB_URL,
  type FederationOptions,
} from './lanes/federation.ts';
export { matchesRegistered } from './oauth/redirects.ts';
export { OAuthStore, hashToken, randomToken } from './oauth/store.ts';
export { OidcVerifier, type OidcVerifierOptions, type VerifiedSubject } from './oidc.ts';
export { IssuedTokenAuthenticator, LanesKeyAuthenticator, OidcAuthenticator } from './remote.ts';
export {
  BearerAuthenticator,
  generateProfileToken,
  type AuthenticatorOptions,
  type IssuedToken,
} from './bearer.ts';
