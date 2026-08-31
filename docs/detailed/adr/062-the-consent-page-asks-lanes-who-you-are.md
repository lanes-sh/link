# ADR-062: The consent page asks Lanes who you are, and the pasted token is for CI

**Status:** accepted · **Amends** [ADR-018](018-the-gate-is-in-the-application.md),
[ADR-036](036-a-client-is-told-this-endpoint-keeps-it-signed-in.md),
[ADR-054](054-the-surface-in-front-of-the-gate.md) · **Retires**
[ADR-003](003-auth-model.md)'s "the token is the identity" · **Requires**
[ADR-060](060-a-caller-is-a-person.md)

## Context

ADR-018 made this endpoint its own authorization server, and the machinery is complete: dynamic
client registration, mandatory PKCE, a consent screen, codes, access tokens, refresh families, and
the reuse grace ADR-035 added. One step in it is not what it appears to be.

The consent screen asks the owner to **paste their endpoint bearer token**. `approve(request,
token)` compares it and mints a code. That is a proof of possession of a shared secret, and it is
the only proof anywhere in the flow — the whole OAuth apparatus resolves to "whoever can read the
credential store is the owner".

Three things follow, and the third is why this is being changed now.

**It cannot answer the question ADR-060 asks.** A pasted secret says *the holder has the secret*.
It cannot say which person is at the browser, so a member list has nothing to match against and
delegation is not expressible.

**Locally, the flow is skipped entirely.** `lanes link mcp add` writes
`--header "Authorization: Bearer $(lanes link token show --raw …)"`, so every local registration
bypasses consent, PKCE and expiry, and ends with the endpoint's long-lived credential sitting in a
harness config file in plaintext. ADR-003 records that limitation; ADR-060 makes it the ordinary
case rather than an edge.

**The form is the most valuable thing on the endpoint.** ADR-039 names it directly when explaining
why a loopback endpoint refuses every cross-origin request: what such a page reaches is
"`/health`, the discovery documents, `/register`, and the `/authorize` consent form **that asks the
owner for their token**".

## Decision

**`/authorize` asks Lanes who the person is, instead of asking them for a secret.**

1. `/authorize` validates the client and redirect as it does today, mints a single-use nonce into
   `OAuthStore`, and redirects the browser to `https://lanes.sh/link/authorize` carrying the
   resource, the nonce, and the endpoint's return address.
2. That page signs the person in with their existing Lanes session, shows what is being granted —
   the client's name, the redirect host, the endpoint, and the profiles the subject is a member of
   — and asks the Lanes API for an assertion.
3. It redirects back to `/authorize/callback?assertion=<jwt>`.
4. The endpoint verifies the assertion against the API's published keys: RS256, `aud` equal to its
   own resource URL, the nonce single-use from `OAuthStore`, sixty seconds of validity. It resolves
   `sub` to the profiles whose `members:` list it, and mints the code.

**Every endpoint runs this, loopback included.** `auth.authorization` stops being optional and a
new profile is written with `{ mode: self }`. The discovery documents are already served ahead of
the auth gate on loopback, so a client pointed at `http://127.0.0.1:7337/mcp` discovers the
authorization server and completes the flow with nothing configured.

**`lanes link mcp add` stops writing a header.** It registers the bare URL. The client discovers
`/.well-known/oauth-protected-resource` from the `401` and runs the flow, which is what ADR-036
built the challenge for and what every remote client already does.

**The static token becomes CI's credential and nothing else.** `token show` and `token rotate`
survive, their help says what they are for, and `kind: 'machine'` is the principal they resolve to
(ADR-060). A headless runner has no browser and needs a way in; a person has a browser and no
longer needs a secret.

**`mode: oidc` is untouched**, and it is now the documented answer for anyone who does not want
Lanes in their authorization path. An issuer of your own, `allowed_subjects`, no change.

## What this costs, stated plainly

**A browser authorization now depends on lanes.sh being reachable.** A self-hosted endpoint's
sign-in leg runs through infrastructure the operator does not control. Bounded three ways, and
worth being precise: an *existing* session refreshes against the endpoint's own `/token` and does
not touch Lanes; only a first authorization or a lapsed refresh family does; and `mode: oidc`
removes the dependency entirely for anyone who wants it gone.

**A local endpoint is no longer usable with no account at all.** That is ADR-060's cost, arriving
here as the mechanism.

**The assertion is a new trust relationship.** The endpoint believes what the Lanes API signs about
a subject. The API can therefore mint an assertion for any subject, for any endpoint that trusts
it — which is what "identity provider" means, and is stated rather than left to be discovered. The
`aud` binding is what stops an assertion minted for one endpoint opening another; the nonce is what
stops one being replayed into a second authorization.

**One thing gets safer, and it is the thing ADR-039 was most worried about.** There is no longer a
form on the endpoint that asks the owner for their token, so the highest-value target on a loopback
bind no longer exists.

## Consequences

**The CSP fix from the 0.7.2 consent-page regression carries over with a different destination.**
`formActionFor` derives `form-action` from the redirect the page's own approval produces; that
redirect is now to lanes.sh rather than to the client, and `oauth.test.ts` asserts the served
policy admits it. The mechanism is unchanged and the regression it prevents is the same one.

**The return leg is a top-level navigation**, so it carries no `Origin` header and no
mixed-content rule applies to it — which is what lets an HTTPS page hand control back to
`http://127.0.0.1`. `server/rebinding.ts` validates `Origin` as well as `Host` and must admit an
absent one on that path; the API's Slack broker already performs this exact bounce against a
loopback listener, so the shape is proven rather than assumed.

**`approve()` loses its token parameter** and gains an assertion. The form, its hidden fields and
the round trip through them go with it — the request is carried in the redirect to Lanes and back,
and is re-validated against the registration before anything is minted, exactly as before.

## What this does not do

It does not make Lanes the authorization server. This endpoint still issues every token a client
holds, still owns expiry and revocation, and still answers `/token`; Lanes answers one question,
once, at the start. It does not change what a token may reach — that is the profile's grants and
its member list. And it does not give the API any way to call this endpoint: the trust is one
signature, verified offline, in one direction.
