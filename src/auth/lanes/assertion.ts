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
 * Verifying that lanes.sh vouched for the person at the browser.
 *
 * This is what replaces the pasted endpoint token on the consent screen
 * (ADR-062). The endpoint no longer asks "do you hold the owner's credential" —
 * it asks lanes.sh "who is this", and gets back a signed statement it can check
 * without trusting the browser that carried it.
 *
 * The signature, the published keys, the issuer and the audience are
 * `./signed.ts`, because a second Lanes-signed credential now goes through the
 * same checks. What is left here is what makes this one an *assertion* rather
 * than an API key, and there are three of them:
 *
 *  - **Nonce**, single-use, minted by this endpoint when the flow began. It
 *    binds the assertion to *this* authorization request, so one captured on a
 *    different endpoint of ours cannot be replayed into this one.
 *  - **Expiry, tight.** The assertion crosses one redirect, so a minute is
 *    generous and anything longer is a bearer credential in a browser history.
 *  - **Not an API key.** A key is signed by the same issuer and may name the
 *    same audience, so without this a ninety-day credential could be presented
 *    where a two-minute one belongs — and the lifetime ceiling below would not
 *    catch it, because a key's `exp` and `iat` are consistent with each other.
 *    See `./api-key.ts` for the other half of the pair.
 */

/** What an assertion says once it has been believed. */
export type Assertion = SignedSubject;

export type AssertionVerifierOptions = JwksVerifierOptions;

/** Assertions cross one redirect; more than this is a credential left lying about. */
const MAX_LIFETIME_MS = 120_000;

export class AssertionVerifier {
  readonly #keys: JwksVerifier;

  constructor(options: AssertionVerifierOptions) {
    this.#keys = new JwksVerifier(options);
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
  async verify(
    token: string,
    expected: { audience: string; nonce: string },
  ): Promise<Assertion | null> {
    const payload = await this.#keys.payload(token);
    if (payload === null) return null;

    // **Before anything else that could pass.** A credential minted for the
    // other purpose is refused on what it says it is, not on whether its other
    // claims happen to fit.
    if (credentialKind(payload) === API_KEY_KIND) return null;

    if (payload['nonce'] !== expected.nonce) return null;

    // Checked here as well as trusted from the issuer. A deployment that
    // widened its own expiry would silently turn a redirect-scoped assertion
    // into a long-lived bearer token, and this endpoint is the party that has
    // to live with that.
    if (claimedLifetimeMs(payload) > MAX_LIFETIME_MS + CLOCK_SKEW_MS) return null;

    return subjectFromClaims(payload, {
      issuer: this.#keys.issuer,
      audience: expected.audience,
      now: this.#keys.now(),
    });
  }
}
