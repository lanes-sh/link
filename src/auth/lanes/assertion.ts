import type { FetchLike } from './login.ts';

/**
 * Verifying that lanes.sh vouched for the person at the browser.
 *
 * This is what replaces the pasted endpoint token on the consent screen
 * (ADR-062). The endpoint no longer asks "do you hold the owner's credential" —
 * it asks lanes.sh "who is this", and gets back a signed statement it can check
 * without trusting the browser that carried it.
 *
 * Four checks, and each of them is load-bearing:
 *
 *  - **Signature**, against the API's published JWKS. Without it the assertion
 *    is a string the browser handed us and anyone could write one.
 *  - **Audience**, which must be *this endpoint's own resource URL*. An
 *    assertion minted for somebody else's endpoint is a valid assertion; using
 *    it here is the confused-deputy case the MCP authorization spec calls out,
 *    and this is the only thing that stops it.
 *  - **Nonce**, single-use, minted by this endpoint when the flow began. It
 *    binds the assertion to *this* authorization request, so one captured on a
 *    different endpoint of ours cannot be replayed into this one.
 *  - **Expiry**, tight. The assertion crosses one redirect, so a minute is
 *    generous and anything longer is a bearer credential in a browser history.
 *
 * Verification is intentionally a public-key check and not a call back to the
 * API. The endpoint may be behind somebody's firewall; it must be able to
 * verify while only ever having *fetched* a key, and a cached JWKS makes the
 * whole flow work with the API unreachable for the length of the cache.
 *
 * No JWT library. RS256 over a JWK is `crypto.subtle.importKey` plus
 * `crypto.subtle.verify`, which is 30 lines and no supply chain — the same
 * reasoning that has `connectivity/auth/oauth-jwt/key.ts` signing with subtle
 * rather than pulling one in.
 */

/** What an assertion says once it has been believed. */
export interface Assertion {
  /** `lanes:<uid>`, the same string `lanes auth login` stores and `members:` names. */
  readonly subject: string;
  readonly email: string | null;
}

export interface AssertionVerifierOptions {
  /** Where the signing keys are published. */
  readonly jwksUrl: string;
  /** Who is allowed to have signed. Checked against `iss`. */
  readonly issuer: string;
  readonly fetch?: FetchLike | undefined;
  readonly now?: (() => number) | undefined;
  /** How long a fetched key set is reused. */
  readonly cacheTtlMs?: number | undefined;
}

/**
 * One published key, as it arrives.
 *
 * Loose on purpose: `importKey` is the thing that decides whether a JWK is
 * usable, and re-deciding that here with a stricter type would mean a key the
 * platform accepts being dropped by our own schema.
 */
type Jwk = Record<string, unknown> & { kid?: unknown; kty?: unknown; alg?: unknown };

/** An hour. A key rotation is noticed within it, and a miss refetches anyway. */
const DEFAULT_CACHE_TTL_MS = 60 * 60_000;

/**
 * The shortest interval between two refetches provoked by an unknown key id.
 *
 * Without it, a token naming a key that does not exist costs a round trip to
 * the API — and since anyone can send one unauthenticated, every endpoint
 * becomes an amplifier pointed at us. A minute bounds that at one request per
 * endpoint per minute while still letting a genuine rotation land promptly.
 */
const MISS_REFETCH_MS = 60_000;

/** Assertions cross one redirect; more than this is a credential left lying about. */
const MAX_LIFETIME_MS = 120_000;

/** Clocks differ. Small enough that it does not extend the window meaningfully. */
const CLOCK_SKEW_MS = 30_000;

/** What `importKey('jwk', …)` takes, without depending on a lib.dom global. */
type JsonWebKeyLike = Parameters<typeof crypto.subtle.importKey>[1] extends infer T
  ? Extract<T, { kty?: string | undefined }>
  : never;

export class AssertionVerifier {
  readonly #options: AssertionVerifierOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #keys: { at: number; byKid: Map<string, CryptoKey> } | null = null;
  #missedAt = Number.NEGATIVE_INFINITY;

  constructor(options: AssertionVerifierOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  /**
   * The person this assertion names, or null.
   *
   * Null rather than a reason. The caller renders an error page to whoever is
   * at the browser, and "the signature did not verify" versus "the audience was
   * wrong" tells an attacker which of their attempts got closer while telling a
   * legitimate user nothing they can act on. What *is* actionable — expiry — is
   * the one case the caller can infer by retrying.
   */
  async verify(token: string, expected: { audience: string; nonce: string }): Promise<Assertion | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (header === null || payload === null) return null;

    // Pinned, not read. `alg` arrives inside the token, so honouring it is how
    // the `none` algorithm and the HMAC-with-the-public-key confusions work.
    if (header['alg'] !== 'RS256') return null;

    const kid = typeof header['kid'] === 'string' ? header['kid'] : null;
    if (kid === null) return null;

    const key = await this.#key(kid);
    if (key === null) return null;

    const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
    const signature = base64url(encodedSignature);
    if (signature === null) return null;

    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signature,
      signed,
    );
    if (!valid) return null;

    return this.#claims(payload, expected);
  }

  /** Everything that is true of a verified signature but not yet of this token. */
  #claims(payload: Record<string, unknown>, expected: { audience: string; nonce: string }): Assertion | null {
    if (payload['iss'] !== this.#options.issuer) return null;

    // Exact match, per RFC 8707. A prefix or suffix comparison here would admit
    // an assertion minted for a different endpoint on the same host.
    const audience = payload['aud'];
    const audiences = Array.isArray(audience) ? audience : [audience];
    if (!audiences.includes(expected.audience)) return null;

    if (payload['nonce'] !== expected.nonce) return null;

    const now = this.#now();
    const exp = typeof payload['exp'] === 'number' ? payload['exp'] * 1000 : 0;
    const iat = typeof payload['iat'] === 'number' ? payload['iat'] * 1000 : 0;

    if (exp <= now - CLOCK_SKEW_MS) return null;
    if (iat > now + CLOCK_SKEW_MS) return null;

    // Checked here as well as trusted from the issuer. A deployment that
    // widened its own expiry would silently turn a redirect-scoped assertion
    // into a long-lived bearer token, and this endpoint is the party that has
    // to live with that.
    if (exp - iat > MAX_LIFETIME_MS + CLOCK_SKEW_MS) return null;

    const subject = payload['sub'];
    if (typeof subject !== 'string' || subject.length === 0) return null;

    return {
      // The API signs the raw uid; the prefix is added at exactly one place in
      // the client, here and in `login.ts`, so the two cannot disagree about
      // what a subject looks like.
      subject: subject.startsWith('lanes:') ? subject : `lanes:${subject}`,
      email: typeof payload['email'] === 'string' ? payload['email'] : null,
    };
  }

  /**
   * The signing key with that id.
   *
   * A miss against a warm cache refetches, because that is what a key rotation
   * looks like from here and the alternative is every endpoint refusing until
   * its cache lapses. It refetches at most once a minute, because the *other*
   * thing a miss looks like is an invented key id, and those arrive
   * unauthenticated and as fast as anyone cares to send them.
   */
  async #key(kid: string): Promise<CryptoKey | null> {
    const ttl = this.#options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const now = this.#now();
    const fresh = this.#keys !== null && now - this.#keys.at < ttl;

    if (fresh) {
      const hit = this.#keys?.byKid.get(kid);
      if (hit) return hit;
      if (now - this.#missedAt < MISS_REFETCH_MS) return null;
      this.#missedAt = now;
    }

    const loaded = await this.#load();
    return loaded.get(kid) ?? null;
  }

  async #load(): Promise<Map<string, CryptoKey>> {
    const byKid = new Map<string, CryptoKey>();

    const response = await this.#fetch(this.#options.jwksUrl).catch(() => null);
    if (response === null || !response.ok) {
      // Left uncached, so the next attempt tries again rather than treating an
      // outage as "there are no keys" for an hour. Whatever was already known
      // still answers, which is what keeps a verified endpoint working while
      // the API is down.
      return this.#keys?.byKid ?? byKid;
    }

    const body = (await response.json().catch(() => ({}))) as { keys?: Jwk[] };

    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256')) continue;
      if (typeof jwk.kid !== 'string') continue;

      const key = await crypto.subtle
        .importKey('jwk', jwk as JsonWebKeyLike, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, [
          'verify',
        ])
        .catch(() => null);

      if (key !== null) byKid.set(jwk.kid, key);
    }

    this.#keys = { at: this.#now(), byKid };
    return byKid;
  }
}

function base64url(value: string): ArrayBuffer | null {
  try {
    const bytes = Buffer.from(value, 'base64url');
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

function decodeJson(value: string): Record<string, unknown> | null {
  const bytes = base64url(value);
  if (bytes === null) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
