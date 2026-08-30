# ADR-036: A client is told this endpoint keeps it signed in

**Status:** accepted · **Completes** [ADR-035](035-a-replayed-refresh-token-must-not-log-the-owner-out.md) · **Follows from** [ADR-018](018-the-gate-is-in-the-application.md)

## Context

ADR-035 stopped the endpoint deleting a connector's live credentials. That removed the cause it
was responsible for, and the symptom did not fully go: a remote client still returned its owner
to the consent screen more often than a thirty-day refresh token can explain.

The endpoint has issued a refresh token on every grant since authorization worked at all. What
it never did was *say so*. Both discovery documents advertised one scope:

```json
"scopes_supported": ["mcp"]
```

A client's requested scope is not something it invents. The reference implementation derives it
from our documents, and looks in a specific one for a specific string:

```js
let effectiveScope = requestedScope || resourceMetadata?.scopes_supported?.join(" ") || clientMetadata.scope;
if (effectiveScope && authServerMetadata?.scopes_supported?.includes("offline_access") && …)
  effectiveScope = `${effectiveScope} offline_access`;
```

So the resource document decides what a fresh connector asks for, and the authorization-server
document decides whether offline access is appended to it. Advertising it in neither left a
client with no grounds to request, persist, or use the refresh token it was being handed. A
client with no grounds re-authorises, and re-authorising means a person in a browser.

Nothing was broken from either end, which is what made it survive so long. The endpoint issued
correct tokens and would have honoured a refresh; the client behaved correctly for a server that
had not offered to keep it signed in.

There was a second, smaller version of the same silence. Every `401` from this endpoint carried
an identical `WWW-Authenticate` value whatever the reason:

```
Bearer realm="lanes-link", resource_metadata="…/.well-known/oauth-protected-resource"
```

A caller whose credential was *rejected* and one carrying no credential at all were told the
same thing, and those want opposite responses — a refresh and an authorization.

## Decision

**Advertise `offline_access` in both documents.** They are load-bearing for different reasons
and neither substitutes for the other, so the same list goes in both and `SUPPORTED_SCOPES` is
the one place it is written down.

**Grant the intersection of what was asked for and what is supported.** `authorize` used to
record the requested scope verbatim and `#issue` echoed it back, so an unrecognised scope was
granted by echo. That was inert while `mcp` was the only scope; it stops being inert the moment
a second one means something.

The narrowing happens in `approve` as well as `authorize`, and `approve` is the one that
matters: the authorization request travels back through hidden form fields, so a caller can post
any scope it likes. Nothing round-tripped through that form is trusted — the client id and the
redirect URI are re-checked there for exactly the same reason.

An unrecognised scope is narrowed rather than refused. `invalid_scope` would turn an unexpected
token in some client's default string into a connector that cannot be added at all, and scope is
not what protects anything here — that is policy, per capability, per call.

**Say `invalid_token` when a credential was rejected, and nothing when none was sent.** RFC 6750
§3.1 for the first; §3 for the second, which asks a resource server not to send an error code to
a request carrying no authentication information — a client cannot refresh a token it does not
hold. `malformed` says nothing either, because `invalid_request` carries a SHOULD of a `400`
status and changing that path's status is a different question.

**`scope` is deliberately absent from the challenge.** RFC 6750 allows it, and the reference
client unions it into what it will request next, then computes
`forceReauthorization = isStrictScopeSuperset(union, tokens.scope)`. Every connector authorised
before this ADR holds a token scoped `mcp`, so advertising a wider scope there would mark a
working session as needing a step-up. That path only fires on a `403` this endpoint never sends,
so it is a trap laid for later rather than a bug today — and there is nothing to gain by laying
it.

**`deploy.min_instances`, defaulting to `0`.** Not a fix; a knob with a reason. The measured
cold start on the MCP path is under three seconds and the platform queues the request behind it,
so scaling to zero is invisible to a caller. One path is not a caller: a client refreshes when it
wakes after an idle gap, which is exactly when the instance is cold, and the reference client
*swallows* a network-level refresh failure and redirects to a browser without surfacing an error.
That correlation is structural rather than random. It ships at `0` because no refresh has
actually failed that way in the logs, and the flag is passed on every rollout including the zero
so that config decides and a raised value can be lowered again.

## Consequences

**An existing connector keeps its narrower grant until it re-authorises.** A token issued before
this is scoped `mcp`; `#refresh` carries `record.scope` forward, so it stays `mcp` for the life
of the chain. Nothing reads scope for authorization, so nothing changes for it — it simply does
not gain the announcement until the next time its owner adds it.

**A client that gates on the granted scope now has what it needs.** Whether any particular
client did gate on it is not something this repository can observe; what it can do is stop being
the reason one could not.

**`invalid_token` is not what makes the reference client refresh.** It refreshes because it holds
a refresh token, and reads only `resource_metadata` and `scope` off the challenge. The header is
sent because it is correct and because clients that are not that one exist — not because it is
load-bearing here. Saying otherwise would put a claim in this record that the reference
implementation contradicts.

## What this does not do

**It does not make a client refresh.** Everything here is the server's half: the offer, the
grant, and an accurate refusal. A connector that discards its own credentials, or never attempts
the refresh, is beyond anything the endpoint can say — and that has been observed too, with no
request reaching the endpoint at all. `https://lanes.sh/docs/link/clients` says how to tell that case apart.

**It does not adopt sender-constrained tokens.** DPoP (RFC 9449) is the stronger answer to
everything ADR-035 traded away, and would let rotation relax rather than tighten. No mainstream
MCP client implements it, so adopting it would be a property nothing could use. RFC 9700's
requirement is met the other way: a public client's refresh tokens here are rotated.

**It does not turn `min_instances` on.** The knob ships; the value does not change.
