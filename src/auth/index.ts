/**
 * Client identity.
 *
 * M1: one bearer token per profile, resolved from the credential store. The
 * token is the identity — holding it makes you the profile's owner principal.
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
import type { SecretRef, SecretStore } from '#secrets';

/**
 * Who is acting. M1 resolves exactly one per profile, but the dispatch path
 * takes a principal rather than assuming the owner, so delegated access is
 * additive later instead of a rewrite.
 */
export interface Principal {
  readonly id: string;
  readonly profile: string;
  readonly kind: 'owner';
}

export function ownerPrincipal(profile: string): Principal {
  return { id: `${profile}:owner`, profile, kind: 'owner' };
}

export type AuthOutcome =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly reason: 'missing' | 'malformed' | 'invalid' | 'not_configured' };

/**
 * Anything that can turn an `Authorization` header into a principal.
 *
 * Extracted so the endpoint can accept more than one kind of proof without the
 * request path learning what kinds exist. There are two: a static token the
 * operator holds, and a token this endpoint or an issuer handed to a client
 * that completed an authorization flow. Both arrive in the same header, and the
 * server does not care which answered.
 */
export interface Authenticator {
  authenticate(authorizationHeader: string | null | undefined): Promise<AuthOutcome>;
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

  async authenticate(authorizationHeader: string | null | undefined): Promise<AuthOutcome> {
    const rank = { invalid: 3, not_configured: 2, malformed: 1, missing: 0 } as const;
    let worst: Extract<AuthOutcome, { ok: false }> = { ok: false, reason: 'missing' };

    for (const link of this.#links) {
      const outcome = await link.authenticate(authorizationHeader);
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

export interface AuthenticatorOptions {
  readonly profile: string;
  readonly tokenRef: SecretRef;
  readonly credentials: SecretStore;
}

export class BearerAuthenticator implements Authenticator {
  readonly #options: AuthenticatorOptions;
  #cached: string | null = null;

  constructor(options: AuthenticatorOptions) {
    this.#options = options;
  }

  async authenticate(authorizationHeader: string | null | undefined): Promise<AuthOutcome> {
    const { profile, tokenRef, credentials } = this.#options;

    const presented = parseBearer(authorizationHeader);
    if (presented === null) {
      return { ok: false, reason: authorizationHeader ? 'malformed' : 'missing' };
    }

    const expected = (this.#cached ??= await credentials.get(tokenRef));
    if (expected === null) {
      // The profile has no token yet. Fail closed and let `lanes link doctor` explain.
      return { ok: false, reason: 'not_configured' };
    }

    return tokensMatch(presented, expected)
      ? { ok: true, principal: ownerPrincipal(profile) }
      : { ok: false, reason: 'invalid' };
  }

  /** Called after `lanes link token rotate` so a running instance picks up the change. */
  invalidateCache(): void {
    this.#cached = null;
  }
}

/**
 * Mint a profile token: 32 random bytes, base64url, prefixed so it is
 * recognisable in a config file and greppable in a leak.
 */
export function generateProfileToken(): string {
  return `llk_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
}

export {
  authorizationServerMetadata,
  challenge,
  protectedResourceMetadata,
  MCP_SCOPE,
  type ResourceIdentity,
} from './oauth/metadata.ts';
export { OAuthServer, matchesRegistered, pkceChallengeFor, type AuthorizeRequest, type OAuthResult } from './oauth/server.ts';
export { OAuthStore, hashToken, randomToken } from './oauth/store.ts';
export { OidcVerifier, type OidcVerifierOptions, type VerifiedSubject } from './oidc.ts';
export { IssuedTokenAuthenticator, OidcAuthenticator } from './remote.ts';
