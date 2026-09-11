import {
  API_KEY_KIND,
  CLOCK_SKEW_MS,
  JwksVerifier,
  claimedLifetimeMs,
  credentialKind,
  subjectFromClaims,
  type JwksVerifierOptions,
  type SignedSubject,
} from './signed.ts';

/**
 * An API key the dashboard minted and `api.lanes.sh` signed.
 *
 * The credential for a caller with no browser — a CI job, a cron, a container —
 * and the replacement for the static token this CLI used to mint itself. Both
 * halves of that change matter:
 *
 * **It is verified, not compared.** The old token was a random string the
 * workspace held a copy of, so the endpoint's answer to "is this the right
 * credential" was a constant-time comparison against its own credential store.
 * A signed key is checked against a published key, so nothing on this side holds
 * a secret, nothing has to be copied to a deployed target before a key works,
 * and a key issued a minute ago is accepted by an endpoint that has never heard
 * of it.
 *
 * **It names a person, and that was already the rule.** The subject is a
 * `lanes:<uid>`, resolved through `members:` on every request exactly as an OAuth
 * token's is (ADR-068). The key decides nothing about reach; a profile listing
 * that uid does.
 *
 * What this costs, stated plainly: verifying a key needs a key set fetched from
 * the API, where the old comparison needed no network at all. The cache in
 * `JwksVerifier` is an hour and survives an API outage, so the exposure is a
 * cold endpoint during an outage — but a self-hoster pointing `LANES_API_URL`
 * somewhere else must publish a JWKS there.
 *
 * **Revocation is `members:`, and it is the only revocation this shape has.**
 * Reach is resolved per request, so `lanes link profile members remove` stops a
 * key within the member cache's window — seconds. What it cannot do is revoke
 * *one* key while leaving that person's others working: nothing here holds a
 * list of issued keys to strike one from. That belongs to whoever mints them.
 */

/** Who an API key names, once it has been believed. */
export type ApiKeySubject = SignedSubject;

export type ApiKeyVerifierOptions = JwksVerifierOptions;

/**
 * The longest life this endpoint will honour, whatever the key claims.
 *
 * A key is *meant* to be long-lived, so this is not the tight ceiling an
 * assertion carries — it is a backstop against one mistake: a key minted with an
 * `exp` decades out is indistinguishable from a correct one until somebody reads
 * the claims, and by then it has been in a CI secret for a year. Four hundred
 * days is a year with slack, and is the same reasoning that stopped browsers
 * honouring multi-year certificates.
 *
 * A key missing `exp` or `iat` reports an infinite lifetime and is refused here,
 * which is the answer we want: an API key with no expiry is not a thing this
 * endpoint accepts.
 */
const MAX_LIFETIME_MS = 400 * 24 * 60 * 60_000;

export class ApiKeyVerifier {
  readonly #keys: JwksVerifier;

  constructor(options: ApiKeyVerifierOptions) {
    this.#keys = new JwksVerifier(options);
  }

  /**
   * The person this key names, or null.
   *
   * Null rather than a reason, for the reason every verifier here gives: the
   * holder of a rejected credential cannot act on *which* check failed, and an
   * attacker can.
   */
  async verify(token: string, expected: { audience: string }): Promise<ApiKeySubject | null> {
    const payload = await this.#keys.payload(token);
    if (payload === null) return null;

    // **Required, not merely "not an assertion".** This is the asymmetry with
    // `./assertion.ts`, and it is deliberate: that verifier *rejects* a key and
    // tolerates a token with no `kind` at all, because assertions minted before
    // this claim existed must go on working and breaking sign-in is not an
    // acceptable cost. Nothing has ever issued an API key, so this side can
    // demand the claim from its first day — and demanding it is what makes an
    // assertion unusable here, since an assertion does not carry one.
    if (credentialKind(payload) !== API_KEY_KIND) return null;

    if (claimedLifetimeMs(payload) > MAX_LIFETIME_MS + CLOCK_SKEW_MS) return null;

    return subjectFromClaims(payload, {
      issuer: this.#keys.issuer,
      audience: expected.audience,
      now: this.#keys.now(),
    });
  }
}
