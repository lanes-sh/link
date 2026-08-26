# ADR-040: An MCP connector may use a client somebody else registered

**Status:** accepted · **Amends** [ADR-028](028-a-hosted-oauth-client-is-the-default.md) ·
**Supersedes the Slack half of** [ADR-033](033-a-pasted-token-for-an-mcp-server.md)

## Context

ADR-033 ended with a sentence that has turned out to be wrong: *"Slack costs a console visit and
always will."* The reasoning behind it was sound about Slack and wrong about this repository, which
is the kind of mistake worth recording in full rather than quietly correcting.

Three claims held it up. Two are still true:

- **Slack does not support Dynamic Client Registration.** Confirmed, and it is a decision rather
  than a gap — DCR would let a client authenticate a user without an app existing, and on
  Enterprise Grid an admin approves each app first. Waiting for it is waiting for nothing.
- **A confidential client is needed.** `https://mcp.slack.com/.well-known/oauth-authorization-server`
  advertises `client_secret_post` and no `registration_endpoint`.

The third does not:

- **"A broker cannot be used, because the SDK owns an MCP provider's exchange and there is no seam
  to route it."** There is a seam, and it was already load-bearing. `createMcpConnector` takes
  `accessToken: () => Promise<string | null>` and sets a plain `Authorization: Bearer` header; at
  serve time that token comes from `bearerToken()` through `credentialResolver`, not from the SDK.
  The SDK owns only the *connect-time* exchange — and `authoriseDirect`, written for `http`
  connectors that have no metadata to discover, is a complete authorization-code flow with a broker
  hook already in it. What made an MCP provider different was discovery, and a manifest that names
  its own endpoints has nothing left to discover.

The fourth claim, about redirect URIs, is **correct**, and this ADR spent a while believing it was
not. ADR-033 recorded that Slack requires an HTTPS redirect and that a loopback callback is
therefore impossible. Evidence pointed the other way — Anthropic's Slack app has
`http://localhost:3118/callback` registered and publicly distributed, confirmed by Slack's own team
on `anthropics/claude-code#37714` — so this was built on the assumption that a registered loopback
URL works.

It does not. Tested against a real app: the Redirect URL field rejects a non-HTTPS value outright.
Whatever exception Anthropic's app enjoys is not one available by registering an app today. The
first shape of this change — a fixed loopback port, `auth.redirect`, and a client id shipped in the
manifest so a public client could redeem locally — was built, tested, and then removed, because
every part of it depended on Slack accepting a redirect Slack will not accept.

The lesson is narrow and worth keeping: an observed working configuration is evidence about *that*
configuration, not about what the console will let you create.

## Decision

**An `mcp` connector may declare `auth.broker` or `auth.client_id`, provided it also declares
`authorize_url` and `token_url`.** Naming both endpoints is what takes a provider off the SDK's
flow and onto the direct one, where the exchange is ours to route. Declaring one without the other
is refused at definition: half-declared is the dangerous state, because the SDK would run the flow
and then post to a token endpoint with a client it does not hold.

Notion, Linear, and Google's two MCP servers name neither and are untouched.

**There is no fallback, and there cannot be one here.** A shipped client id was built for the case a
broker cannot cover — being unreachable — and removed with the loopback redirect it depended on. The
broker is not merely where the secret lives; it is the HTTPS origin the redirect requires. A client
with nothing behind it has nowhere for Slack to send the browser.

So Slack's broker is not optional the way Google's is, and `connect slack` fails when it is down.
Softened by Slack issuing no refresh token: an outage stops new connections and cannot interrupt one
already made, which is the opposite of the risk ADR-028 warned a shared client carries.

**Where a vendor refuses a loopback redirect, the broker receives it and bounces it down.** Slack
sends the browser to `https://api.lanes.sh/v1/auth/link/slack/callback`; that route 302s to
`http://127.0.0.1:<port>/callback`, and the port travels in `state` — which is opaque to the vendor,
round-trips untouched, and is already the CSRF binding the CLI checks, so it costs no parameter and
no state held anywhere. `runOAuthFlow` takes `relayRedirect`; the listener is unchanged and still
binds a port the kernel picked.

This does not reopen [ADR-025](025-connecting-an-account-from-a-deployed-endpoint.md). The CLI still
starts the flow, opens the browser, receives the code, redeems it, and writes the credential
locally. No consent moves to a server, nothing is stored between the two legs, and the broker
already receives the authorization code at `/exchange` — seeing it one step earlier grants it
nothing, and the PKCE verifier needed to redeem it never leaves the machine that generated it.

The broker publishes that URL through `/config` rather than the manifest writing it down: the
correct value depends on which deployment answered, and `LANES_LINK_BROKER_ORIGIN` would otherwise
need a second override to match.

**`auth.refresh_token: 'optional'` says a response without a refresh token is the success.** The
two readings are opposite and neither is guessable from the response: Google omitting one means the
grant already existed and the connection would die in an hour; Slack omitting one is what a
long-lived user token looks like. The default stays `required`, and the refusal names the vendor
from the manifest rather than saying "Google" as it used to.

**A pasted token stays, as a route `--auth` selects.** A fourth entry in `method.ts`'s chooser
rather than a flag of its own, because ADR-038 had already made "which way in" one question. Written into the same ref in the same blob shape the
browser path writes, so nothing downstream learns there are two paths.

## Consequences

**The app has to be publicly distributed, and that is the step this all rests on.** A Slack app is
created in a workspace, and by default it can only ever be installed there — every other workspace
is refused with `invalid_team_for_non_distributed_app`. Activating public distribution decouples it:
one app, one client id, one secret, installable by any workspace. It is self-serve and immediate,
and it is not the same thing as an App Directory listing, which needs a review and which this does
not want. Worth stating plainly because the mental model it displaces — "an app belongs to a
workspace, so a shared app cannot work" — is the obvious one and is the reason this ADR looked
impossible for longer than it was.

An admin can still refuse the app for their own workspace, on Enterprise Grid especially. That is
not a reason to register a second app; it is what the pasted-token route above exists for.

**Slack's scope-disclosure gate exists now.** ADR-033 recorded its absence as permanent: what a
pasted token can do is chosen in the vendor's console and cannot be read back. Asking for scopes in
a browser is what makes `confirmScopes` apply, and seven of Slack's twenty are flagged broad. That
consequence in ADR-033 now describes GitHub only.

**Slack joins the `credentials.exchange-is-local: NOT-GUARANTEED` row**, on the brokered path, for
the same reason Google is in it.

**A broker outage cannot interrupt an agent here.** ADR-028 warned that a shared client "can fail in
the middle of an agent's work rather than only at setup", because refresh runs while serving. Slack
issues no refresh token unless token rotation is enabled on the app, so its broker is consulted at
`connect` and never again. That is what makes the shipped-client fallback a convenience rather than
a necessity.

**`connect` is still CLI-only and the server still never participates.** No `/callback` route, no
pending-authorization state, no consent moved to a server. [ADR-025](025-connecting-an-account-from-a-deployed-endpoint.md)
is untouched, and so is [ADR-007](007-control-plane-exclusions.md).

**`Bun.serve` does not refuse a port another listener holds.** Found while building the fixed
callback: it binds anyway, within one process or across two, with or without `reusePort: false`, and
the kernel then splits connections between the listeners. Recorded rather than guarded, because the
relay removed the fixed port and with it the only way two `connect` runs could land on the same
number. It is a live hazard for anything here that ever pins a port again.

**What this is not.** It is not a claim that DCR is unnecessary. `registration: dynamic` remains the
best case and the one that costs nothing; this is what to do when a vendor has decided against it.
Nor does it retire the pasted token: ADR-033's mechanism is what GitHub still uses and what Slack
falls back to.
