import { base64url, decodeJson } from '#auth/lanes/assertion.ts';

/**
 * The gate on the control plane.
 *
 * `api.lanes.sh` decides three things this service does not: who is calling,
 * which workspace they named, and whether their role permits the act. It says
 * so in a short signed statement, and everything downstream trusts what comes
 * out of here — including which workspace's bytes get opened. A forged or
 * misdirected assertion is not a failed request, it is a read of somebody
 * else's account.
 *
 * ## Why this is not `#auth/lanes/assertion.ts`
 *
 * That verifier answers a different question in a different setting. It checks
 * a statement a *browser* carried to an endpoint that may be behind somebody's
 * firewall, so it has to fetch a key set it has never seen, cache it, and
 * defend the fetch against being used as an amplifier. It also binds to a nonce,
 * because the thing it authorises is one authorization request.
 *
 * Both ends of this one are operated by Lanes and configured together. There is
 * no key to discover, so the key is pinned: no network at boot, no cache to
 * reason about, and no unauthenticated path that provokes an outbound request.
 * There is no nonce because the thing being authorised is one call, bounded by
 * a short expiry instead.
 *
 * What the two share is the fiddly part — base64url and JSON decoding — which
 * is imported rather than written twice.
 *
 * ## Why asymmetric, when a shared secret would be simpler
 *
 * An HMAC would let this service mint the assertions it accepts. It holds every
 * managed workspace's credentials, so a compromise here should not also be the
 * ability to forge authority over any workspace at any role. Verifying with a
 * public key means a compromise here reads what it already had.
 */

/** What an assertion says once it has been believed. */
export interface ControlAssertion {
  /** `lanes:<uid>`, the same string a profile's `members:` names. */
  readonly subject: string;
  /** The Lanes workspace this call acts in. Never taken from a request body. */
  readonly workspace: string;
  readonly role: ControlRole;
  /** What the caller's credential was granted at consent. Absent means none. */
  readonly scopes: readonly string[];
}

/**
 * The two roles the API distinguishes.
 *
 * Deliberately the API's vocabulary rather than a profile's `owner`/`member`.
 * They answer different questions — one is "may you administer this workspace",
 * the other is "may you consume this profile" — and one word covering both is
 * how a check ends up applied to the wrong question.
 */
export const CONTROL_ROLES = ['editor', 'admin'] as const;

export type ControlRole = (typeof CONTROL_ROLES)[number];

export interface ControlAssertionVerifierOptions {
  /** The API's signing key, pinned. Per environment, never shared across them. */
  readonly publicKey: CryptoKey;
  /** Who is allowed to have signed. Carries the environment (ADR-072). */
  readonly issuer: string;
  /** This service's own URL. Carries the environment for the same reason. */
  readonly audience: string;
  readonly now?: (() => number) | undefined;
}

/**
 * How long an assertion may live, however long its issuer said.
 *
 * Two minutes covers a clock skew and a slow hop and nothing else. Checked here
 * as well as trusted from the issuer: an API that widened its own expiry would
 * otherwise turn a per-request statement into a bearer token over every
 * workspace, and this is the party that would live with it.
 */
const MAX_LIFETIME_MS = 120_000;

const CLOCK_SKEW_MS = 30_000;

export class ControlAssertionVerifier {
  readonly #options: ControlAssertionVerifierOptions;
  readonly #now: () => number;

  constructor(options: ControlAssertionVerifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * What this assertion says, or null.
   *
   * Null rather than a reason, for the reason its sibling gives: a caller told
   * *which* check failed learns which of its attempts got closer, and a
   * legitimate caller learns nothing it can act on. The route logs the detail.
   */
  async verify(token: string): Promise<ControlAssertion | null> {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = decodeJson(encodedHeader);
    const payload = decodeJson(encodedPayload);
    if (header === null || payload === null) return null;

    // Pinned, not read. Honouring the token's own `alg` is how `none` and
    // HMAC-with-the-public-key both work.
    if (header['alg'] !== 'RS256') return null;

    const signature = base64url(encodedSignature);
    if (signature === null) return null;

    const valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      this.#options.publicKey,
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!valid) return null;

    return this.#claims(payload);
  }

  /** Everything true of a verified signature but not yet of this statement. */
  #claims(payload: Record<string, unknown>): ControlAssertion | null {
    if (payload['iss'] !== this.#options.issuer) return null;

    // Exact match. A prefix comparison would admit an assertion minted for a
    // different service on the same host, and the environments differ by
    // hostname (ADR-072) — so this is also what stops a stage-minted assertion
    // being replayed at production if the two ever shared a key.
    const audience = payload['aud'];
    const audiences = Array.isArray(audience) ? audience : [audience];
    if (!audiences.includes(this.#options.audience)) return null;

    const now = this.#now();
    const exp = typeof payload['exp'] === 'number' ? payload['exp'] * 1000 : 0;
    const iat = typeof payload['iat'] === 'number' ? payload['iat'] * 1000 : 0;
    if (exp <= now - CLOCK_SKEW_MS) return null;
    if (iat > now + CLOCK_SKEW_MS) return null;
    if (exp - iat > MAX_LIFETIME_MS + CLOCK_SKEW_MS) return null;

    const subject = payload['sub'];
    if (typeof subject !== 'string' || subject.length === 0) return null;

    const workspace = payload['workspace'];
    if (typeof workspace !== 'string' || workspace.length === 0) return null;

    const role = CONTROL_ROLES.find((known) => known === payload['role']);
    if (role === undefined) return null;

    // A missing claim is no scopes, never every scope. This is the default that
    // decides whether an older API version's assertion can widen a policy.
    const declared = payload['scopes'];
    const scopes = Array.isArray(declared)
      ? declared.filter((scope): scope is string => typeof scope === 'string')
      : [];

    return { subject, workspace, role, scopes };
  }
}
