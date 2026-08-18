import { hashToken } from './oauth/store.ts';

/**
 * Verifying a token an issuer you already run handed out.
 *
 * The alternative to this endpoint issuing its own. Named for the protocol and
 * not for any vendor, on the same reasoning that makes the database adapter
 * `s3` and not `supabase` (ADR-013): the issuer is a URL, so pointing this
 * at a different provider is an edit to a config file rather than a branch in
 * the code.
 *
 * Three checks, and dropping any of them makes the other two decorative:
 *
 *  - **Audience.** The token must name this application. Without it, a token the
 *    same issuer minted for any *other* application it serves would open this
 *    endpoint — the confused-deputy case the MCP authorization spec calls out.
 *    Every large issuer serves many applications, so this is the check that
 *    matters most and the one most easily left out, because everything works
 *    without it.
 *  - **Expiry**, so a token that has been revoked by lapsing actually stops.
 *  - **Subject**, against an allowlist. The issuer will happily vouch for every
 *    account it has; which of them is *you* is not something it knows.
 */

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface OidcVerifierOptions {
  readonly issuer: string;
  /** The audience a token must name — this application's client id at the issuer. */
  readonly audience: string;
  readonly allowedSubjects: readonly string[];
  /**
   * Where to ask about a token, when the issuer's metadata does not say.
   *
   * Access tokens are frequently opaque, so validating one means asking the
   * issuer. RFC 7662 standardised that as `introspection_endpoint` in the
   * discovery document — and several large issuers ship an equivalent without
   * advertising one, so this is the escape hatch for those. A URL in config, not
   * a case in a switch.
   */
  readonly introspectionEndpoint?: string | undefined;
  /**
   * Narrower than `typeof fetch` on purpose.
   *
   * The runtime's own type carries extensions — `preconnect` among them — that
   * nothing here calls, and requiring them would mean every test stub had to
   * implement them to be assignable.
   */
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  /** How long a positive answer is reused. Zero disables the cache. */
  readonly cacheTtlMs?: number;
}

export interface VerifiedSubject {
  readonly subject: string;
  readonly expiresAt: number;
}

interface Introspection {
  readonly active: boolean;
  readonly audiences: readonly string[];
  readonly subjects: readonly string[];
  readonly expiresAt: number | null;
}

/** A minute. Long enough to spare a round trip per call, short enough to notice. */
const DEFAULT_CACHE_TTL_MS = 60_000;

export class OidcVerifier {
  readonly #options: OidcVerifierOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #cache = new Map<string, VerifiedSubject>();
  #discovered: Promise<Record<string, unknown>> | null = null;

  constructor(options: OidcVerifierOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  /** The subject this token belongs to, or null if it does not open this endpoint. */
  async verify(token: string): Promise<VerifiedSubject | null> {
    const key = hashToken(token);
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached;
    this.#cache.delete(key);

    const introspection = await this.#introspect(token);
    if (!introspection?.active) return null;

    if (!introspection.audiences.includes(this.#options.audience)) return null;
    if (introspection.expiresAt !== null && introspection.expiresAt <= this.#now()) return null;

    const subject = introspection.subjects.find((candidate) =>
      this.#options.allowedSubjects.includes(candidate),
    );
    if (!subject) return null;

    const ttl = this.#options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const verified: VerifiedSubject = {
      subject,
      // Never cached past the token's own expiry, however generous the TTL.
      expiresAt: Math.min(this.#now() + ttl, introspection.expiresAt ?? Infinity),
    };
    if (ttl > 0) this.#cache.set(key, verified);
    return verified;
  }

  async #endpoint(): Promise<string | null> {
    if (this.#options.introspectionEndpoint) return this.#options.introspectionEndpoint;

    this.#discovered ??= this.#fetch(
      `${this.#options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(5_000) },
    )
      .then((response) => (response.ok ? response.json() : {}))
      .catch(() => ({}));

    const metadata = await this.#discovered;
    const endpoint = metadata['introspection_endpoint'];
    return typeof endpoint === 'string' ? endpoint : null;
  }

  /**
   * Two request shapes, because two are in the wild.
   *
   * RFC 7662 is a form POST of `token`. The other common spelling is a GET with
   * the token in the query string, which several issuers ship instead. Trying
   * the standard one first and the other on failure covers both without either
   * being named in a conditional.
   */
  async #introspect(token: string): Promise<Introspection | null> {
    const endpoint = await this.#endpoint();
    if (!endpoint) {
      // Fail closed and say why. Falling back to a check that cannot see the
      // audience would leave the confused-deputy hole open while looking like
      // it verified something.
      throw new Error(
        `The issuer ${this.#options.issuer} publishes no introspection_endpoint. ` +
          'Set auth.authorization.introspection_endpoint to the URL that answers ' +
          'questions about a token, or this endpoint cannot check who a token was issued to.',
      );
    }

    const posted = await this.#ask(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    if (posted) return posted;

    const url = new URL(endpoint);
    url.searchParams.set('access_token', token);
    return this.#ask(url.toString(), { method: 'GET' });
  }

  async #ask(url: string, init: RequestInit): Promise<Introspection | null> {
    try {
      const response = await this.#fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
      if (!response.ok) return null;
      return normalise((await response.json()) as Record<string, unknown>, this.#now());
    } catch {
      return null;
    }
  }
}

/**
 * One shape out of several spellings of the same three facts.
 *
 * `aud` may be a string or an array, and some issuers put the client id in
 * `azp` instead. Expiry arrives as an absolute `exp` in seconds or as a relative
 * `expires_in`. Identity is `sub`, and an issuer that also asserts a *verified*
 * email is asserting something an operator would rather write in an allowlist
 * than a numeric id — so both are offered, and an unverified one never is.
 */
function normalise(body: Record<string, unknown>, now: number): Introspection {
  const strings = (value: unknown): string[] =>
    typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];

  const expiresAt =
    typeof body['exp'] === 'number'
      ? body['exp'] * 1000
      : typeof body['expires_in'] === 'number'
        ? now + body['expires_in'] * 1000
        : typeof body['expires_in'] === 'string' && /^\d+$/.test(body['expires_in'])
          ? now + Number(body['expires_in']) * 1000
          : null;

  const emailVerified = body['email_verified'];
  const verified = emailVerified === true || emailVerified === 'true';

  return {
    // RFC 7662 says `active`. A 200 from an endpoint that does not use the field
    // is itself the answer, so its absence is not treated as inactive.
    active: body['active'] !== false,
    audiences: [...strings(body['aud']), ...strings(body['azp'])],
    subjects: [
      ...strings(body['sub']),
      ...(verified ? strings(body['email']) : []),
    ],
    expiresAt,
  };
}
