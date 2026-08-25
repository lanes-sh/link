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
  /** Injectable for tests. Only the cache window reads it. */
  readonly now?: () => number;
}

/**
 * How long a cached token may answer before the store is consulted again.
 *
 * The cache is here so the common case — a valid token, on every request — is a
 * comparison rather than a file read or a Secret Manager call. What it must not
 * do is outlive a rotation. `lanes link token rotate` is the only revocation
 * this system has, and an unbounded cache meant a revoked token kept opening the
 * endpoint until the process restarted, while the replacement was refused.
 *
 * Five seconds makes rotation effectively immediate and still collapses a burst
 * of calls onto one read.
 */
const CACHE_TTL_MS = 5_000;

export class BearerAuthenticator implements Authenticator {
  readonly #options: AuthenticatorOptions;
  readonly #now: () => number;
  #cached: string | null = null;
  #readAt = 0;

  constructor(options: AuthenticatorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async authenticate(authorizationHeader: string | null | undefined): Promise<AuthOutcome> {
    const { profile } = this.#options;

    const presented = parseBearer(authorizationHeader);
    if (presented === null) {
      return { ok: false, reason: authorizationHeader ? 'malformed' : 'missing' };
    }

    const fresh = this.#cached !== null && this.#now() - this.#readAt < CACHE_TTL_MS;
    let expected = fresh ? this.#cached : await this.#reload();

    // A mismatch against a *cached* value is ambiguous: either the credential is
    // wrong, or it is the right one and this process has not seen the rotation
    // that produced it. One re-read separates the two, and it is what makes a
    // rotated-in token work on its first call rather than after the window.
    // Only a cached comparison can be wrong this way, so a fresh read never
    // pays for a second one — which is what keeps a wrong token from costing a
    // store read per attempt.
    if (fresh && (expected === null || !tokensMatch(presented, expected))) {
      expected = await this.#reload();
    }

    if (expected === null) {
      // The profile has no token yet. Fail closed and let `lanes link doctor` explain.
      return { ok: false, reason: 'not_configured' };
    }

    return tokensMatch(presented, expected)
      ? { ok: true, principal: ownerPrincipal(profile) }
      : { ok: false, reason: 'invalid' };
  }

  async #reload(): Promise<string | null> {
    // Both caches, or neither: the store holds its own decrypted copy, so
    // re-reading without dropping that first re-reads the same stale value.
    this.#options.credentials.refresh?.();
    this.#cached = await this.#options.credentials.get(this.#options.tokenRef);
    this.#readAt = this.#now();
    return this.#cached;
  }

  /**
   * Drop the cached value immediately.
   *
   * The window above already bounds how long a rotation goes unnoticed, so this
   * is an optimisation rather than the mechanism — nothing's correctness may
   * depend on it being called, because for a long time nothing called it.
   */
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
  type ChallengeError,
  type ResourceIdentity,
} from './oauth/metadata.ts';
export { OAuthServer, pkceChallengeFor, type AuthorizeRequest, type OAuthResult } from './oauth/server.ts';
export { matchesRegistered } from './oauth/redirects.ts';
export { OAuthStore, hashToken, randomToken } from './oauth/store.ts';
export { OidcVerifier, type OidcVerifierOptions, type VerifiedSubject } from './oidc.ts';
export { IssuedTokenAuthenticator, OidcAuthenticator } from './remote.ts';
