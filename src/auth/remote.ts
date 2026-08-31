import {
  memberPrincipal,
  ownerPrincipal,
  parseBearer,
  type AuthOutcome,
  type Authenticator,
} from './index.ts';
import type { OAuthStore } from './oauth/store.ts';
import type { OidcVerifier } from './oidc.ts';

/**
 * The two ways a remote client's token becomes a principal.
 *
 * A token this endpoint issued now carries *who completed the flow* and which
 * profiles named them, so it resolves to a member principal (ADR-060). Both were
 * the owner until 0.8.0, on the reading that there is one person behind an
 * endpoint — which stopped being true the moment a profile could declare
 * somebody else may consume it.
 *
 * **A token without a subject is still the owner**, and that is not a fallback
 * to be tidied away: it is what a token minted before this release is, and
 * every one of them keeps working until it expires rather than logging its
 * holder out on upgrade.
 *
 * `OidcAuthenticator` still resolves to the owner, deliberately. A self-hoster
 * pointing at their own issuer has an allowlist of subjects and no `members:`
 * to map them onto — the delegation model is the Lanes one, and pretending
 * otherwise would mean inventing a mapping nobody configured.
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

    if (record.subject === undefined) return { ok: true, principal: ownerPrincipal(this.#profile) };

    // The list resolved when the code was minted, not now. Re-reading it here
    // would mean a profile edit silently ending a live session, which ADR-060
    // deliberately does not do — `lanes link token rotate` is the way to close
    // that window, and `profile members remove` says so out loud.
    return {
      ok: true,
      principal: memberPrincipal(record.subject, this.#profile, record.profiles ?? []),
    };
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
