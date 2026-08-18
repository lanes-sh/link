import { ownerPrincipal, parseBearer, type AuthOutcome, type Authenticator } from './index.ts';
import type { OAuthStore } from './oauth/store.ts';
import type { OidcVerifier } from './oidc.ts';

/**
 * The two ways a remote client's token becomes a principal.
 *
 * Both resolve to the **owner** principal, and that is a deliberate limit rather
 * than an omission. There is one person behind this endpoint; what a caller may
 * do is decided by the profile's policy per capability per call, not by which
 * credential opened the door. Delegated principals are additive later — the
 * dispatch path already takes a principal rather than assuming the owner — and
 * inventing a second kind now would mean inventing the policy axis to go with
 * it before anything needed one.
 *
 * Neither of these ever reports `missing` for a credential it simply does not
 * recognise. That is what the chain's ranking is for: a token this link cannot
 * place is `invalid` from its point of view and `missing` only if no link saw
 * anything at all.
 */

/** A token this endpoint issued through its own authorization flow. */
export class IssuedTokenAuthenticator implements Authenticator {
  readonly #store: OAuthStore;
  readonly #profile: string;

  constructor(store: OAuthStore, profile: string) {
    this.#store = store;
    this.#profile = profile;
  }

  async authenticate(header: string | null | undefined): Promise<AuthOutcome> {
    const presented = parseBearer(header);
    if (presented === null) return { ok: false, reason: header ? 'malformed' : 'missing' };

    const record = await this.#store.token(presented);
    // `kind` matters: a refresh token is a credential for the token endpoint and
    // must not open the resource. They are indistinguishable as strings, so the
    // check is the only thing separating them.
    if (!record || record.kind !== 'access') return { ok: false, reason: 'invalid' };

    return { ok: true, principal: ownerPrincipal(this.#profile) };
  }
}

/** A token an external issuer minted, verified against that issuer. */
export class OidcAuthenticator implements Authenticator {
  readonly #verifier: OidcVerifier;
  readonly #profile: string;

  constructor(verifier: OidcVerifier, profile: string) {
    this.#verifier = verifier;
    this.#profile = profile;
  }

  async authenticate(header: string | null | undefined): Promise<AuthOutcome> {
    const presented = parseBearer(header);
    if (presented === null) return { ok: false, reason: header ? 'malformed' : 'missing' };

    try {
      const verified = await this.#verifier.verify(presented);
      return verified
        ? { ok: true, principal: ownerPrincipal(this.#profile) }
        : { ok: false, reason: 'invalid' };
    } catch {
      // The issuer being unreachable, or misconfigured, is not an authorisation.
      // Failing closed here means an outage at the identity provider closes the
      // endpoint rather than opening it.
      return { ok: false, reason: 'invalid' };
    }
  }
}
