# ADR-080: An API key is signed, not stored

**Status:** accepted · **Completes** [ADR-068](068-a-credential-names-a-person.md) ·
**Amends** [ADR-062](062-the-consent-page-asks-lanes-who-you-are.md),
[ADR-018](018-the-gate-is-in-the-application.md)

## Context

There is no difference between "the API key" and "the `lanes link token`". They are
one object under two names, and the code says so — `server/read/routes.ts` calls
the `llk_` rows "the workspace's static API keys" while the command that mints
them is `token issue`. Asked what the token family was *for*, the honest answer
was: it is the API key, and the CLI is the thing that mints it.

That second half is the problem, and it is not the naming.

A `llk_` token is a random string the workspace keeps a copy of. So:

- **The endpoint's answer is a comparison, not a verification.** `BearerAuthenticator`
  reads every `tokens:` row's value out of the credential store and compares in
  constant time. The credential and its verifier are the same secret.
- **A key has to be transported before it works.** Minted locally, it lives in the
  local store; a deployed revision reads a different store, so a key is useful
  there only after `secrets push` and a Secret Manager version exists. Nothing
  says so at mint time.
- **The mint is in the wrong place.** A credential is issued by whoever can
  authenticate the person it names. The CLI cannot: it holds a session and takes
  `--subject <id>` on trust, so `token issue --subject lanes:<someone-else>`
  mints a working credential for a person who was never asked.

ADR-068 fixed what a token *means* — a row names a person, and reach follows from
`members:`. It did not change who mints one or how it is checked, because at the
time there was nowhere else to mint it. ADR-062 built that somewhere: the consent
page asks `api.lanes.sh` who you are and the endpoint verifies a signed assertion
against published keys, holding no secret of its own.

So the endpoint already verifies one Lanes-signed credential. The static token is
the part of the surface that did not get the same treatment.

## Decision

**An API key is signed by `api.lanes.sh` and verified against its published keys.
Nothing on this side holds a copy.**

A key is an RS256 JWT: `iss` the API, `sub` a `lanes:<uid>`, `aud` this endpoint's
own resource URL, `kind: api_key`, and an `exp`. The dashboard mints it, because
the dashboard is where the person is already authenticated.

The endpoint verifies it with the machinery ADR-062 already put there — the same
JWKS cache, the same RS256-over-`crypto.subtle` check, the same exact-match
audience comparison. `lanes/signed.ts` is that machinery, extracted; `assertion.ts`
and `api-key.ts` are the two sets of rules on top of it. One key cache, one
rotation window, one audience comparison.

Reach is unchanged and is the point: the subject resolves through `members:` on
every request, exactly as an issued token's does. A key decides nothing about
what it opens.

### The two credentials must not be interchangeable, and the asymmetry is deliberate

An assertion and a key are signed by the same issuer, may name the same audience,
and name the same person. Only the `kind` claim separates a credential that
crosses one redirect from one that lives in a CI secret for ninety days.

- **`api-key.ts` requires `kind: api_key`.** Nothing has ever issued a key, so
  this side can demand the claim from its first day — and demanding it is what
  makes an assertion unusable here, since an assertion carries none.
- **`assertion.ts` rejects `kind: api_key` and tolerates its absence.** It cannot
  require `kind: assertion`: assertions minted before this claim existed must go
  on working, and breaking sign-in is not an acceptable price for symmetry.

Both directions are closed by that pair, and neither depends on the lifetime
ceiling. Relying on the ceiling alone would be wrong: a key minted with a short
`exp` has an `iat` consistent with it and would pass.

### The audience is the only thing that makes a key mean *this* endpoint

An issued token is bound to this endpoint by living in its store. An OIDC token is
bound by an audience the operator configured. A Lanes-signed key is bound by
nothing except `aud`, because its issuer signs for every Lanes endpoint there is.

So `Authenticator.authenticate` gains an optional `AuthContext` carrying the
resource identifier the caller addressed — the same string
`protectedResourceMetadata` publishes, derived from `Host` and
`X-Forwarded-Proto` because this endpoint does not know its own public URL from
config.

**Optional in the type, mandatory in effect.** `LanesKeyAuthenticator` refuses
when it is absent rather than skipping the check. That is ADR-079's lesson stated
one layer down: an unset field must not resolve to the widest answer. It is
optional only so the three links that ignore it, and the test doubles that predate
it, need not mention it.

The loopback read listener supplies the *MCP server's* URL rather than its own.
It binds one port above the endpoint, so a resource built from its own `Host`
would name an address no key was ever minted for.

A workspace-scoped audience was considered and rejected. `lanes_workspace` is the
only Lanes-side identifier a target carries, it is optional and hand-written, and
it exists as a convenience check for `profile members add`. Making it the thing a
credential is verified against would turn a field most targets do not set into a
gate, and a roster check into an authorization decision — which is exactly what
the access model says it must never be.

### Revocation is `members:`, and what that cannot do is stated

Reach is resolved per request, so `lanes link profile members remove` stops a key
within the member cache's window — seconds, and the same lever that already
revokes every other shape.

What it cannot do is revoke *one* key while leaving that person's others working.
Nothing here holds a list of issued keys to strike one from, and nothing should:
that list belongs to whoever mints them. Per-key revocation is the dashboard's,
and until it exists the honest statement is that a key is revoked by removing the
person, not the key.

### What this costs

**Verification stops being offline.** A `llk_` comparison needed no network. A
signed key needs a key set fetched from the API. The cache is an hour and a fetch
failure leaves previously-known keys answering, so the exposure is a cold endpoint
during an API outage — but a self-hoster pointing `LANES_API_URL` elsewhere must
publish a JWKS there. This is the same dependency ADR-062 already took on for
sign-in; it now covers the headless path too.

## Consequences

`BearerAuthenticator`, `generateProfileToken`, the `llk_` prefix, the `tokens:`
block and the `lanes link token` family all become removable — but **not in this
change**, and the ordering is not incidental. The four CLI commands that call
their own endpoint (`outputs`, `tools`, the reload notification, and
`mcp add --headless`) get their credential from `anyIssuedToken`, and
`mcp add --headless` requires one rather than degrading. Until the API can hand
the CLI a short-lived endpoint-audienced token, deleting the mint would leave
those commands with nothing.

So both links sit in the chain at once. Static rows first, because that is still a
constant-time comparison against a cached value; the declared gate next, because
an issued token is a lookup in this endpoint's own state; the signed key last,
because it is the only link that may have to fetch a key set. A credential that is
not a JWT fails that link on its first `split`, so the ordering costs the other
two nothing.

The key link is **unconditional**, unlike the OAuth gate. It is the headless path,
and making it depend on `auth.authorization` would mean a profile declaring no
remote-client model could not be reached by a machine at all — which is the case
the static token existed for.

Removing the static family needs a contract bump and a migration that drops
`tokens:` rows and their `tokens/*` values. That is a breaking change to a
published package: every headless registration in the wild presents a `llk_`.
ADR-066 records what a rename cost a client that had already fetched the old list.
