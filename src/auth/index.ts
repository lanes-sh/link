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
  readonly kind: 'owner' | 'member' | 'machine';
  /**
   * Every profile this caller may reach, or `undefined` for "all of them".
   *
   * `undefined` is the stdio pipe and nothing else now (ADR-068). The pipe is
   * its own proof — a process that can write to it already has the operator's
   * shell — so there is no credential to carry a subject and no member list to
   * match. Every token, static or issued, carries a list: a `member`'s because
   * the list *is* the delegation (ADR-060), and a `machine`'s because a bearer
   * token names the person it was issued to rather than opening everything.
   */
  readonly profiles?: readonly string[] | undefined;
}

export function ownerPrincipal(profile: string): Principal {
  return { id: `${profile}:owner`, profile, kind: 'owner' };
}

/**
 * A person, and the profiles whose `members:` name them.
 *
 * `profile` carries the one this call is acting within, which is what the audit
 * log records and what policy is evaluated against. `profiles` is the whole set
 * they may choose from, and `mayReach` is the check — kept here rather than in
 * the dispatcher so discovery and enforcement cannot answer it differently,
 * which is the same rule `allowedConnections` follows on the capability axis.
 */
export function memberPrincipal(
  subject: string,
  profile: string,
  profiles: readonly string[],
): Principal {
  return { id: subject, profile, kind: 'member', profiles };
}

/**
 * A static token's holder, and the profiles whose `members:` name them.
 *
 * The same shape as `memberPrincipal` and deliberately so — `kind` is the only
 * difference, and it exists for the audit log rather than for policy. ADR-060
 * described this principal and nothing minted one: the static token resolved to
 * `ownerPrincipal`, reaching every profile in the workspace, which made it the
 * one credential here that never had to say who was holding it. A row in
 * `tokens:` names a subject (ADR-068), so this resolves the same way an OAuth
 * token does and `mayReach` gets no special case.
 */
export function machinePrincipal(
  subject: string,
  profile: string,
  profiles: readonly string[],
): Principal {
  return { id: subject, profile, kind: 'machine', profiles };
}

/**
 * The same caller, acting within a different profile.
 *
 * An endpoint serves several profiles and a principal is built once, from the
 * primary — so the profile on it is where the *connection* was opened, not
 * where this call is going. Every dispatch has to say which, because
 * `principal.profile` is what the audit event records and what `mayReach` is
 * checked against; without this the log attributes a member's call to a profile
 * they may never have been able to reach.
 *
 * It does not widen anything. `profiles` carries over untouched, so a name this
 * caller may not reach is still refused — one step later, by the check below.
 */
export function forProfile(principal: Principal, profile: string): Principal {
  return principal.profile === profile ? principal : { ...principal, profile };
}

/** Whether this caller may act within the named profile. */
export function mayReach(principal: Principal, profile: string): boolean {
  return principal.profiles === undefined || principal.profiles.includes(profile);
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

/**
 * One issued token, as the authenticator needs it.
 *
 * Structurally what `connections.yaml` holds, declared here rather than
 * imported: `auth` may not reach `#profile` (the architecture test enforces the
 * direction), and the rows arrive as a closure for the same reason
 * `profilesFor` does.
 */
export interface IssuedToken {
  readonly id: string;
  readonly subject: string;
  readonly ref: SecretRef;
}

export interface AuthenticatorOptions {
  /**
   * The primary, which is what `principal.profile` starts as.
   *
   * Not what the token reaches — that is `profilesFor(subject)`. It is where
   * the connection was opened, and every dispatch rewrites it with `forProfile`.
   */
  readonly profile: string;
  /** The workspace's issued tokens. Re-read on every reload, so a revoke lands. */
  readonly tokens: () => Promise<readonly IssuedToken[]>;
  readonly credentials: SecretStore;
  /**
   * Which profiles list this subject as a member.
   *
   * The same resolver the OAuth path is handed (`server/endpoint.ts`), passed in
   * rather than reached for, so discovery and enforcement cannot disagree about
   * a subject's reach.
   */
  readonly profilesFor: (subject: string) => Promise<readonly string[]>;
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

/** An issued row, with its value read out of the store. */
interface LoadedToken {
  readonly subject: string;
  readonly value: string;
}

export class BearerAuthenticator implements Authenticator {
  readonly #options: AuthenticatorOptions;
  readonly #now: () => number;
  #cached: readonly LoadedToken[] | null = null;
  #readAt = 0;

  constructor(options: AuthenticatorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async authenticate(authorizationHeader: string | null | undefined): Promise<AuthOutcome> {
    const presented = parseBearer(authorizationHeader);
    if (presented === null) {
      return { ok: false, reason: authorizationHeader ? 'malformed' : 'missing' };
    }

    const fresh = this.#cached !== null && this.#now() - this.#readAt < CACHE_TTL_MS;
    let rows = fresh ? this.#cached! : await this.#reload();
    let matched = find(presented, rows);

    // A miss against a *cached* set is ambiguous: either the credential is
    // wrong, or it is the right one and this process has not seen the rotation
    // or the issue that produced it. One re-read separates the two, and it is
    // what makes a rotated-in token work on its first call rather than after
    // the window. Only a cached comparison can be wrong this way, so a fresh
    // read never pays for a second one — which is what keeps a wrong token from
    // costing a store read per attempt.
    if (fresh && matched === null) {
      rows = await this.#reload();
      matched = find(presented, rows);
    }

    if (rows.length === 0) {
      // No token has been issued. Fail closed, and distinctly from a wrong one:
      // `lanes link doctor` reads this to say "issue one" rather than "check it".
      return { ok: false, reason: 'not_configured' };
    }

    if (matched === null) return { ok: false, reason: 'invalid' };

    // **Resolved per request, not cached with the value.** Membership is read
    // when a token is minted for an OAuth client (ADR-060) because there is a
    // mint to read it at; a static token has none, so this is the only place
    // the question can be asked. It is what makes `profile members remove`
    // take effect on the next call rather than on the next rotation.
    //
    // A resolver that throws fails closed. The alternative — falling back to
    // "every profile" — would restore exactly the behaviour ADR-068 removes,
    // and would do it precisely when something is already wrong.
    let profiles: readonly string[];
    try {
      profiles = await this.#options.profilesFor(matched.subject);
    } catch {
      return { ok: false, reason: 'invalid' };
    }

    return {
      ok: true,
      principal: machinePrincipal(matched.subject, this.#options.profile, profiles),
    };
  }

  async #reload(): Promise<readonly LoadedToken[]> {
    // Both caches, or neither: the store holds its own decrypted copy, so
    // re-reading without dropping that first re-reads the same stale value.
    this.#options.credentials.refresh?.();

    const rows = await this.#options.tokens();
    const loaded: LoadedToken[] = [];
    for (const row of rows) {
      const value = await this.#options.credentials.get(row.ref);
      // A row whose credential is gone is not an error to report here. It is
      // what a half-finished `secrets push` looks like, and the row simply
      // matches nothing — `doctor` is where that is worth a sentence.
      if (value) loaded.push({ subject: row.subject, value });
    }

    this.#cached = loaded;
    this.#readAt = this.#now();
    return loaded;
  }

  /**
   * Drop the cached set immediately.
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
 * The row a presented token matches, or null.
 *
 * Every row is compared even after one matches. Returning early would make the
 * time taken describe *which* row answered, and the whole point of
 * `tokensMatch` is that a comparison here leaks nothing about the value it is
 * comparing against.
 */
function find(presented: string, rows: readonly LoadedToken[]): LoadedToken | null {
  let found: LoadedToken | null = null;
  for (const row of rows) if (tokensMatch(presented, row.value)) found = row;
  return found;
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
export {
  OAuthServer,
  pkceChallengeFor,
  type EndpointIdentity,
  type Federation,
  type OAuthResult,
} from './oauth/server.ts';
export { AssertionVerifier, type Assertion } from './lanes/assertion.ts';
export { lanesFederation, DEFAULT_WEB_URL, type FederationOptions } from './lanes/federation.ts';
export { matchesRegistered } from './oauth/redirects.ts';
export { OAuthStore, hashToken, randomToken } from './oauth/store.ts';
export { OidcVerifier, type OidcVerifierOptions, type VerifiedSubject } from './oidc.ts';
export { IssuedTokenAuthenticator, OidcAuthenticator } from './remote.ts';
