# ADR-047: A pasted token may carry its own auth scheme, and a write surface may hand back a credential

**Status:** accepted · **Follows** [ADR-033](033-a-pasted-token-for-an-mcp-server.md) ·
**Builds on** [ADR-045](045-a-redirect-the-vendor-matches-exactly.md) · **Constrained by**
[ADR-017](017-attachments-by-reference.md)

## Context

Discord was added to post announcements to servers the operator owns, and to read channels so an
agent can triage them. Two things about it do not fit the shapes already here, and both are worth
recording because the cheap answer to each is a rule this repository otherwise holds.

**There is no user-account path at all.** Discord publishes no API for acting as yourself.
Automating a user token is self-botting, which their terms forbid and which gets accounts
terminated, and the OAuth2 user scopes cover neither posting to a channel nor reading its history.
Everything an integration can legitimately do, it does as an *application* — and an application's
messages carry an `APP` badge that cannot be removed. So "post as myself" is not available and
never will be. What is available is the *name and avatar* on each message, set per message through
a webhook, which is close enough to be worth building and not close enough to describe as the
thing that was asked for.

That also settles why this is not OAuth — and note it is *not* ADR-033's reason, which ADR-045 has
since withdrawn. A vendor matching its callback URL exactly against a kernel-chosen port is now
answerable with `auth.redirect_uri`, so it is no longer an argument for a pasted token anywhere.
What holds here is narrower and not fixable on our side. A Discord OAuth2 flow with the
`bot` scope installs an application into a server, but the credential that then calls the API is
the application's bot token — a property of the app, not something the exchange returns. So a
browser flow would end with the operator copying a token out of the developer portal anyway. The
`webhook.incoming` scope *does* return a usable credential, and it is write-only to one channel: it
cannot read, so it cannot serve the half of this that is triage.

**Discord's scheme word is `Bot`, not `Bearer`.** `Authorization: Bot MTIz…`. Nothing in this
codebase could emit that: `attachBearer` assembles `Bearer ${token}` and there is no field to say
otherwise.

## Decision

**A token credential may carry its own scheme inside the stored value, rather than the manifest
gaining a field to name one.** Discord declares `auth: { kind: 'header', header: 'Authorization' }`,
which writes the stored value into the header verbatim, and the operator pastes `Bot MTIz…`.

The alternative was one optional `scheme` field on `authTokenSchema`, defaulting to `Bearer`, read
in `bearer/index.ts`, `credential.ts`, `resolve.ts` and `cli/identity.ts`. It is a small, additive
change and it is the better *design*. It was not taken because it widens the shared auth surface
for one provider, and `header` already expresses exactly this — a credential whose whole value goes
in a named header. The provider stays inside its own folder.

Two costs follow, and neither is hypothetical:

- **A token pasted without the prefix fails as an opaque 401.** Mitigated where it happens rather
  than in a comment: the prompt label is `Discord bot token, prefixed — Bot <token>`, and
  `setup.troubleshooting` names the missing prefix as the first thing to check. `discord.test.ts`
  asserts both, so the mitigation cannot quietly disappear.
- **The connection cannot name itself.** `resolveAccount` sends `Authorization: Bearer <stored
  value>`, which here is `Bearer Bot MTIz…` — a 401 and a null. So the provider declares **no
  `identity` block at all**, rather than one that always fails after a network round trip. The
  operator types a label. Re-running `connect` with the same label repairs the existing connection
  instead of adding a second, because `settleIdentity` matches on it; a scripted run passes
  `--display-name`. If a `scheme` field is ever added for another vendor, this provider should take
  it and grow an identity block.

**The webhook operations are vendored, accepting that two of them return a credential to the
caller.** `create_webhook` and `list_channel_webhooks` include the webhook's token in their
response, and a webhook token is standalone: anybody holding it can post to that channel with no
other authentication. It therefore reaches the model.

This is a real weakening and it is recorded as one — `provider.response-may-carry-a-credential`,
NOT-GUARANTEED, in [`security.md`](../security.md). It is accepted because the alternative is not
"the same thing, safely" but "no posting under the operator's own name", which was the point.
Bounded three ways: the token only posts to the one channel it was made for, `redact` withholds
`webhook_token` from the audit log so it is not also written down in clear, and
`docs/detailed/setup/discord.md` says plainly that a webhook is a credential and how to revoke one.

**No capability is authored.** An authored `announce` capability could find-or-create the webhook
and post through it without ever returning the token, which would close the exposure above. It is
not built: ADR-017 sets the bar at "the vendor's API can do something its *document* cannot
express", and three documented calls express this fine. Recorded as the obvious follow-up if the
exposure proves to matter more than the ~80 lines.

**The vendored operation list is the security boundary, and it is pinned by a test.** `connect`
writes one policy rule, `discord.*`, and policy has no pattern between `provider.*` and an exact
name — so every operation in the spec is an operation an agent may call. Twenty are vendored out of
242. `bulk_delete_messages` is excluded although it sits beside `delete_message`; so is every
moderation, role, and guild-settings endpoint. `discord.test.ts` asserts the list is exactly those
twenty, so a refresh that picks up a new operation fails and gets read rather than merging quietly.

## Consequences

Adding Discord needed no change to any shared component. What it did change is the vendoring
pipeline, which moved from `providers/google/specs/vendor.ts` into
`providers/shared/vendor-spec.ts`, `vendor-operations.ts` and `vendor-schemas.ts` so a second
provider could use it — verified by re-running `bun run vendor:google` and requiring all seven
committed specs to come back byte-identical.

Three repairs were added there, each opt-in per provider, and each of them is a bug that would
otherwise have shipped silently:

- `hoistPathParameters` — Discord declares path parameters on the path item, which is legal and
  which `mcp-from-openapi`'s validator does not read. Without it the document fails validation
  outright and generates **zero** tools.
- `rewriteRequestBody` — `execute_webhook`'s body is a top-level `anyOf`, so the generator emits one
  argument literally named `body` and the connector sends `{"body":{…}}` where Discord expects
  `{…}`. Every test in the repository passes; only a live call fails.
- `requestContentTypes` — the `multipart/form-data` branches name fields `files[0]`, which is not a
  legal tool property name, and one illegal name rejects the entire tools list for *every* provider
  on the endpoint. Nothing but the generator's own content-type preference was keeping it out.
  ADR-045 taught the transport to form-encode as well as JSON-encode, which narrows this but does
  not close it: multipart is still unsendable, so the branch describes a request that cannot be
  made whichever encoding the generator selects.

A fourth is not a flag but a guard: the generator answers an unresolvable `$ref` by logging to the
console and omitting that one tool, so `vendorSpec` now refuses a run where the generated tool
count disagrees with the operation count. Pruning `components.securitySchemes` — which looks like
11.5 KB of dead weight — silently drops three tools, including `get_my_user`, the one call an
operator would use to check the connection.

Attachments are unavailable as a result of the content-type narrowing. That is the honest state
rather than a regression: ADR-017's machinery is the route to them, not a multipart branch nothing
sends.
