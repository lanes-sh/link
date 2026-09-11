import type { FetchLike } from './login.ts';

/**
 * Believing something `api.lanes.sh` signed, without deciding what it means.
 *
 * Split out of `./assertion.ts` when a second credential arrived that this
 * endpoint must verify the same way and judge differently. The signature, the
 * published keys and the claims *every* Lanes-signed token has to satisfy are
 * here; what makes one a redirect assertion and another a long-lived API key is
 * in the two files that build on this.
 *
 * The split is not tidying. Both credentials are RS256 over the same JWKS from
 * the same issuer, so a second copy of the key cache would mean two caches with
 * two rotation windows, and a second copy of the audience check would mean two
 * chances to get the confused-deputy comparison wrong. There is one of each, and
 * the differences are stated as rules on top rather than reimplemented beneath.
 *
 * No JWT library, for the reason `./assertion.ts` has always given: RS256 over a
 * JWK is `crypto.subtle.importKey` plus `crypto.subtle.verify`, which is thirty
 * lines and no supply chain.
 */

/** What a verified token says that both credentials say the same way. */
export interface SignedSubject {
  /** `lanes:<uid>`, the same string `lanes auth login` stores and `members:` names. */
  readonly subject: string;
  readonly email: string | null;
}

export interface JwksVerifierOptions {
  /** Where the signing keys are published. */
  readonly jwksUrl: string;
  /** Who is allowed to have signed. Checked against `iss` by `subjectFromClaims`. */
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

/** Clocks differ. Small enough that it does not extend any window meaningfully. */
export const CLOCK_SKEW_MS = 30_000;

/** What `importKey('jwk', …)` takes, without depending on a lib.dom global. */
type JsonWebKeyLike = Parameters<typeof crypto.subtle.importKey>[1] extends infer T
  ? Extract<T, { kty?: string | undefined }>
  : never;

/**
 * The issuer's keys, and whether this token was signed with one of them.
 *
 * Signature only. It answers "did `api.lanes.sh` write this", which is the same
 * question for every Lanes-signed credential, and nothing about what the token
 * is for — so a caller that forgets to check the claims gets a payload rather
 * than a principal, and `subjectFromClaims` is the only way to turn one into the
 * other.
 *
 * Verification is intentionally a public-key check and not a call back to the
 * API. The endpoint may be behind somebody's firewall; it must be able to verify
 * while only ever having *fetched* a key, and a cached JWKS makes the whole flow
 * work with the API unreachable for the length of the cache.
 */
export class JwksVerifier {
  readonly #options: JwksVerifierOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #keys: { at: number; byKid: Map<string, CryptoKey> } | null = null;
  #missedAt = Number.NEGATIVE_INFINITY;

  constructor(options: JwksVerifierOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? Date.now;
  }

  get issuer(): string {
    return this.#options.issuer;
  }

  now(): number {
    return this.#now();
  }

  /**
   * The payload of a token this issuer signed, or null.
   *
   * Null rather than a reason, the same way `AssertionVerifier.verify` has always
   * answered: "the signature did not verify" versus "the key id was unknown"
   * tells an attacker which of their attempts got closer while telling a
   * legitimate caller nothing they can act on.
   */
  async payload(token: string): Promise<Record<string, unknown> | null> {
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

    const signature = base64url(encodedSignature);
    if (signature === null) return null;

    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );

    return valid ? payload : null;
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

/**
 * The claims every Lanes-signed credential must satisfy, whatever it is for.
 *
 * Three of them, and each is load-bearing:
 *
 *  - **Issuer**, against the API this endpoint was told to trust. Without it a
 *    signature from any key we happen to have cached would do.
 *  - **Audience**, which must be *this endpoint's own resource URL*, matched
 *    exactly per RFC 8707. A token minted for somebody else's endpoint is a
 *    valid token; using it here is the confused-deputy case the MCP
 *    authorization spec calls out, and this is the only thing that stops it. A
 *    prefix or suffix comparison would admit a token minted for a different
 *    endpoint on the same host.
 *  - **Expiry and issuance**, with a small skew. How *long* a credential may
 *    live is not decided here — that is the one rule that genuinely differs
 *    between a token crossing a single redirect and a key living in a CI
 *    secret — so each caller checks its own ceiling.
 */
export function subjectFromClaims(
  payload: Record<string, unknown>,
  expected: { readonly issuer: string; readonly audience: string; readonly now: number },
): SignedSubject | null {
  if (payload['iss'] !== expected.issuer) return null;

  const audience = payload['aud'];
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes(expected.audience)) return null;

  const exp = typeof payload['exp'] === 'number' ? payload['exp'] * 1000 : 0;
  const iat = typeof payload['iat'] === 'number' ? payload['iat'] * 1000 : 0;

  if (exp <= expected.now - CLOCK_SKEW_MS) return null;
  if (iat > expected.now + CLOCK_SKEW_MS) return null;

  const subject = payload['sub'];
  if (typeof subject !== 'string' || subject.length === 0) return null;

  return {
    // The API signs the raw uid; the prefix is added at exactly one place in the
    // client, so nothing here and in `login.ts` can disagree about what a
    // subject looks like.
    subject: subject.startsWith('lanes:') ? subject : `lanes:${subject}`,
    email: typeof payload['email'] === 'string' ? payload['email'] : null,
  };
}

/**
 * How long a token claims to be good for, in milliseconds.
 *
 * Returned rather than checked, because the ceiling is what distinguishes the
 * two credentials and each states its own. A token missing either claim reports
 * `Infinity`, so a caller comparing against a ceiling refuses it — which is the
 * right answer for both of them and is why this does not return null.
 */
export function claimedLifetimeMs(payload: Record<string, unknown>): number {
  const exp = typeof payload['exp'] === 'number' ? payload['exp'] * 1000 : null;
  const iat = typeof payload['iat'] === 'number' ? payload['iat'] * 1000 : null;
  return exp === null || iat === null ? Number.POSITIVE_INFINITY : exp - iat;
}

/**
 * Which Lanes-signed credential this is, as the payload declares it.
 *
 * A claim rather than the JOSE `typ` header, because the header almost certainly
 * already says `JWT` and overloading it would mean asking the API to change
 * something a client may be reading. Unknown and absent are the same answer —
 * null — and the two callers treat that differently on purpose: see
 * `./api-key.ts`.
 */
export function credentialKind(payload: Record<string, unknown>): string | null {
  const kind = payload['kind'];
  return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

/** What a long-lived API key declares itself to be. */
export const API_KEY_KIND = 'api_key';

export function base64url(value: string): ArrayBuffer | null {
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
