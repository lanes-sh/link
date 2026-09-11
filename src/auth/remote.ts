import {
  memberPrincipal,
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
 * **A token without a subject is refused** (ADR-079). It used to resolve to the
 * owner, so that a token minted before 0.8.0 kept working until it expired
 * rather than logging its holder out on upgrade. That was a kindness on a
 * single-operator endpoint and a skeleton key on a shared one: `ownerPrincipal`
 * reaches every profile in the workspace, so the one credential that could not
 * say who was holding it was also the one that opened everything. The upgrade
 * cost is a re-authorisation; the alternative was a standing bypass of
 * `members:` that no member list could close.
 *
 * **`OidcAuthenticator` resolves through `members:` too**, for the same reason.
 * It used to return the owner on the grounds that a self-hoster pointing at
 * their own issuer has an allowlist of subjects and no `members:` to map them
 * onto. But `allowed_subjects` answers *may this token in*, not *what may it
 * open*, and treating the first as the second meant every subject the issuer
 * vouched for reached every profile. The subject the verifier already returns
 * is matched against the member lists exactly as an issued token's is, so a
 * self-hoster adds their subject with `lanes link profile members add` and gets
 * the same deny-by-default everybody else has.
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

    // A token minted before ADR-060 named nobody, and there is no way to ask it
    // who it belongs to now. Refused rather than promoted to the owner: the
    // holder re-authorises, which costs one browser round trip, and nothing in
    // the workspace is reachable in the meantime by a credential that cannot
    // name a person. ADR-079.
    if (record.subject === undefined) return { ok: false, reason: 'invalid' };

    // The list resolved when the code was minted, not now. Re-reading it here
    // would mean a profile edit silently ending a live session, which ADR-060
    // deliberately does not do — so `profile members remove` stops the next
    // sign-in and lets one already made run its course.
    //
    // **Nothing closes that window**, and this comment used to say
    // `lanes link token rotate` did. It does not: it rotates one API token row,
    // needs an `--id`, and prints that browser clients are unaffected. No
    // command in the CLI reaches `OAuthStore` at all. Until one does, the window
    // is `access_token_ttl_minutes` — twelve hours by default — and the honest
    // thing is to say so rather than to name a command that would report
    // success.
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
  readonly #profilesFor: (subject: string) => Promise<readonly string[]>;

  constructor(
    verifier: OidcVerifier,
    profile: string,
    profilesFor: (subject: string) => Promise<readonly string[]>,
  ) {
    this.#verifier = verifier;
    this.#profile = profile;
    this.#profilesFor = profilesFor;
  }

  async authenticate(header: string | null | undefined): Promise<AuthOutcome> {
    const presented = parseBearer(header);
    if (presented === null) return { ok: false, reason: header ? 'malformed' : 'missing' };

    try {
      const verified = await this.#verifier.verify(presented);
      if (!verified) return { ok: false, reason: 'invalid' };

      // The issuer said who this is; the member lists say what they may open.
      // Two questions, two answers — conflating them is what made every subject
      // an owner. A resolver that throws falls into the catch below and fails
      // closed, which is the same rule the static-token path follows.
      const profiles = await this.#profilesFor(verified.subject);
      return { ok: true, principal: memberPrincipal(verified.subject, this.#profile, profiles) };
    } catch {
      // The issuer being unreachable, or misconfigured, is not an authorisation.
      // Failing closed here means an outage at the identity provider closes the
      // endpoint rather than opening it.
      return { ok: false, reason: 'invalid' };
    }
  }
}
