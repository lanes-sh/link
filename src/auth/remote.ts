import {
  memberPrincipal,
  parseBearer,
  type AuthContext,
  type AuthOutcome,
  type Authenticator,
} from './index.ts';
import type { ApiKeyVerifier } from './lanes/api-key.ts';
import type { OAuthStore } from './oauth/store.ts';
import type { OidcVerifier } from './oidc.ts';

/**
 * The three ways a remote client's token becomes a principal.
 *
 * A token this endpoint issued carries *who completed the flow*, and the
 * profiles that name them are resolved per request from the declared config, so
 * it resolves to a member principal (ADR-060, amended by ADR-083). Both were the
 * owner until 0.8.0, on the reading that there is one person behind an endpoint
 * — which stopped being true the moment a profile could declare somebody else
 * may consume it.
 *
 * **All four resolve membership the same way now**, which is what ADR-060's own
 * revocation paragraph already claimed and only one of them did. A static token
 * had no mint to be resolved at, so it always read the files; an issued token
 * had one and read it once. The asymmetry was not a design, it was an accident
 * of which credential arrived first.
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
  readonly #profilesFor: (subject: string) => Promise<readonly string[]>;

  constructor(
    store: OAuthStore,
    profile: string,
    profilesFor: (subject: string) => Promise<readonly string[]>,
  ) {
    this.#store = store;
    this.#profile = profile;
    this.#profilesFor = profilesFor;
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

    // **Resolved now, not at the mint** — which reverses what this comment used
    // to defend (ADR-083 amends ADR-060). The stored `record.profiles` is still
    // written and is no longer read: a browser session's reach was frozen when
    // its code was minted and rode unchanged through thirty days of refresh, so
    // a profile added after a client signed in could not be reached by it at
    // all, and a member removed kept their reach for the full
    // `access_token_ttl_minutes` — twelve hours by default, with no command
    // anywhere in the CLI able to shorten it.
    //
    // The old argument was that re-reading here would let a profile edit
    // silently end a live session. That is now the point rather than the
    // objection: a revocation that lands later than a grant is the security
    // property failing, and this was the slowest path in the system.
    let profiles: readonly string[];
    try {
      profiles = await this.#profilesFor(record.subject);
    } catch {
      // Fail closed, and kept structurally separate from the empty case below.
      // `workspaceMembers` only throws when it has no last-known-good answer at
      // all, so this is a boot against a workspace this process cannot reach —
      // not a member list that came back empty.
      return { ok: false, reason: 'invalid' };
    }

    // **Empty ends the session, and only here.** For the other three
    // credentials an empty list has always been an ordinary non-error — a
    // subject no profile names reaches nothing and is told so by a refusal
    // (ADR-082) — and `remote.test.ts`, `index.test.ts`, `delegation.test.ts`
    // and `visibility.test.ts` all pin that. An *issued* token is the one case
    // where empty carries a second fact: `OAuthServer.callback` refuses to mint
    // one for a member of nothing, so a token resolving to empty must have had
    // its membership removed since. That is a revocation, and 401 is what tells
    // the client to re-authorise and meet the mint's own explanation of why it
    // cannot. A browser session is also the only one of the four that is a
    // session at all; the others are long-lived machine credentials with nothing
    // to end.
    if (profiles.length === 0) return { ok: false, reason: 'invalid' };

    return { ok: true, principal: memberPrincipal(record.subject, this.#profile, profiles) };
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

/**
 * An API key `api.lanes.sh` signed, verified against its published keys.
 *
 * The third shape, and the one that replaces a credential this CLI used to mint
 * itself. It resolves the same way the other two do — a subject, then the
 * profiles whose `members:` name them — so `mayReach` gets no special case and
 * nothing here decides reach.
 *
 * **It is the only link that needs to know which endpoint was addressed.** An
 * issued token is bound to this endpoint by living in its store; an OIDC token
 * by an audience the operator configured. A key is signed by an issuer that
 * serves every Lanes endpoint, so the audience is the *only* thing standing
 * between a key minted for one deployment and every other deployment. Absent, it
 * refuses: an unchecked audience here would make a key a skeleton key across
 * every endpoint the issuer signs for, which is precisely the failure ADR-079
 * spent its argument on one level up.
 */
export class LanesKeyAuthenticator implements Authenticator {
  readonly #verifier: ApiKeyVerifier;
  readonly #profile: string;
  readonly #profilesFor: (subject: string) => Promise<readonly string[]>;

  constructor(
    verifier: ApiKeyVerifier,
    profile: string,
    profilesFor: (subject: string) => Promise<readonly string[]>,
  ) {
    this.#verifier = verifier;
    this.#profile = profile;
    this.#profilesFor = profilesFor;
  }

  async authenticate(
    header: string | null | undefined,
    context?: AuthContext,
  ): Promise<AuthOutcome> {
    const presented = parseBearer(header);
    if (presented === null) return { ok: false, reason: header ? 'malformed' : 'missing' };

    // Fail closed on a caller that did not say who was addressed. `invalid`
    // rather than `not_configured`: the credential was not examined, and the
    // chain's ranking treats `invalid` as the more specific answer — which is
    // right, because something reached this link with a bearer it could not
    // judge, and that is worth surfacing over "nobody has set this up".
    if (context === undefined) return { ok: false, reason: 'invalid' };

    try {
      const verified = await this.#verifier.verify(presented, { audience: context.resource });
      if (!verified) return { ok: false, reason: 'invalid' };

      // Resolved per request, never cached with the credential. This is what
      // makes `profile members remove` the revocation for a key, and it is the
      // only one a signed credential has — see `./lanes/api-key.ts`.
      const profiles = await this.#profilesFor(verified.subject);
      return { ok: true, principal: memberPrincipal(verified.subject, this.#profile, profiles) };
    } catch {
      // A JWKS fetch that throws, or a resolver that does. Closed, for the
      // reason `OidcAuthenticator` gives: an outage at the identity provider
      // must close the endpoint rather than open it.
      return { ok: false, reason: 'invalid' };
    }
  }
}
