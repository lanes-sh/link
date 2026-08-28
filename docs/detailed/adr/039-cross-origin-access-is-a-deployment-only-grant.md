# ADR-039: Cross-origin access is a deployment-only grant, and a preflight is never refused for want of a credential

**Status:** accepted · **Follows from** [ADR-018](018-the-gate-is-in-the-application.md) ·
**Constrained by** the loopback guard in `src/server/rebinding.ts`

## Context

This endpoint had no CORS handling of any kind. No `Access-Control-*` header was ever sent and no
`OPTIONS` was ever handled, so a preflight fell past the discovery routes to the bearer gate and was
answered with a `401`.

That is not a strict policy. It is a category error, and the reason is in the CORS specification
rather than in anything here: a preflight is sent with credentials stripped. No `Authorization`
header, no cookie, by construction. So gating one behind the credential check refuses every
browser-origin client *before* it has any opportunity to present the credential the refusal is
asking it for. There is no client behaviour that recovers from it, and nothing in the response says
what happened — the browser reports a CORS failure, and the endpoint's log records a rejected
request with `reason: missing`, which is exactly what it records for an ordinary unauthenticated
call.

The gap survived because nothing had asked. Every client `docs/clients.md` names connects from a
server: `claude mcp add` and Codex are local processes, and a claude.ai or ChatGPT connector performs
its fetches in the vendor's backend, not in the page. A browser-origin MCP client is the case nobody
had, so the missing header was never the reason for a failure anyone reported.

## Decision

**Answer a preflight, and answer it before the auth gate.** `204`, carrying whatever grant applies,
and never a `401`.

**The wrapper goes at `serve()`, not in the router.** That is where the policy is decided, and the
two belong together: cross-origin access is a property of the address this endpoint is bound to,
exactly as `allowedHostnames` is. Both derived from the same `loopback`, in one function, rather
than an invariant spread across two files.

It is also what makes the ordering safe. A preflight answered in the wrapper never reaches the
rebinding guard inside the router — and does not need to, because a policy exists only off loopback,
which is precisely where that guard is inert. Wrapping inside the router instead would have meant
hoisting the guard out to keep it first, and a reader would then have had to hold both files at once
to see why the order was right.

**Only for a routable deployment. Never on loopback.** This is the part worth recording, because it
looks like an omission and is a constraint.

`src/server/rebinding.ts` already answers the browser question for a local endpoint, and answers it
*no*. `rebindingRefusal` validates `Origin` as well as `Host`, and the note there states the threat
precisely: an endpoint on `127.0.0.1` is reachable by any page its owner happens to be visiting, and
what such a page reaches is everything that answers before authentication — `/health`, the discovery
documents, `/register`, and the `/authorize` consent form **that asks the owner for their token**.

A CORS grant and an `Origin` refusal on the same request are two answers to one question. So the
policy is built only for a host that is not loopback, and no configuration can override that: the
field described below is read, and then discarded, for a loopback bind. A reader who later notices
that `lanes link start` cannot be given an allowed origin should read this paragraph rather than
close the gap.

**Within a deployment, the default grant is `*`, and there is no setup step.**

| Paths | Grant | Why |
|---|---|---|
| the authorization surface — both discovery documents, `/register`, `/token`, `/authorize` | `*`, always | unauthenticated by design; that is what makes discovery work at all. Never narrowed, because a client that cannot read these cannot find out that it needs a token |
| `/mcp`, `/attachments` | `*` unless `auth.allowed_origins` names origins | see below |
| `/health`, `/reload` | nothing | no browser client needs them, and where the answer is not obvious the cheaper mistake is refusing |

**The wildcard on the credentialed surface is the decision worth arguing, so here is the argument.**
An allowlist there was the first design, and default deny made it feel obviously right. What it
actually bought was a required setup step per user in exchange for narrowing a surface that was not
exposed. Three things are true together on a deployment:

1. **It is already reachable by anyone.** `access: public` is what a connector needs (ADR-018), so
   any server on the internet can post to `/mcp` today and read the refusal. CORS never gated
   *sending* — it gates whether a *page* may read the reply, and an attacker with a server needs no
   page. The only thing a hostile page adds is the victim's IP address.
2. **The credential is never ambient.** It is an `Authorization` header a page must already possess,
   never a cookie a browser attaches on its own. So what a hostile page gains is an unauthenticated
   request, and what it learns from reading the answer is a `401` available from anywhere.
3. **`Access-Control-Allow-Credentials` is never sent, and with `*` cannot be** — the specification
   refuses the combination outright. The one header that would make a wildcard dangerous is
   unreachable from here rather than merely omitted.

So the wildcard grants a browser exactly what `curl` already has. Naming origins still narrows, for
anyone who wants it; absent means `*`, because a default nobody can skip is a default that is wrong.

**None of that holds on loopback**, which is the other half of why loopback has no policy. There the
endpoint is *not* publicly reachable, and public reachability is the premise the whole argument above
rests on — a page reaching `127.0.0.1` is stealing exactly the thing a deployment has already given
away.

**`WWW-Authenticate` is exposed.** Without it a browser client receives the `401` and cannot read the
`resource_metadata` pointer inside it — which is the whole discovery handshake ADR-036 exists to
make work. A refusal a client cannot read the recovery from is the failure mode that ADR reversed,
arriving by a different route. `Retry-After` is exposed for the same reason on the rate-limit
refusal.

**Where an allowlist *is* configured, an unlisted origin gets `204` with no grant, not a `403`.** The
browser refuses the call on the absence of the header, which is the mechanism CORS actually uses; a
distinct status would let a page map which paths exist without being allowed to call any of them. A
listed origin is echoed rather than answered with `*`, so `Vary: Origin` goes with it — a shared cache
would otherwise hand one origin's grant to another.

## Consequences

**Nothing changes for any client that exists today.** A caller sending no `Origin` — every local
registration, every SDK, `curl` — gets byte-identical responses, because the grant is computed only
when there is an origin to grant to. That is the whole of the compatibility claim: a deployment's
`/mcp` *does* now answer a page that asks, which is the point.

**An origin is not a permission.** Being allowed to *attempt* a call is all this decides; what a
caller may do if it obtains a credential is still decided per capability, per call, by the profile's
policy. Worth stating because "allowed origin" reads like an authorization concept and is not one —
and because the wildcard would be alarming if it were one.

**A leaked token is usable from a browser now, where before it needed a server.** That is the real
cost of the wildcard, stated plainly. It is an amplification rather than a new capability — a token
that has escaped is already usable from anywhere — and the alternative bought protection against it
only for the users who completed a setup step, which is not the users who leak tokens.

**The header list is fixed rather than reflected.** `Access-Control-Request-Headers` is not echoed
back, because echoing grants whatever was asked for and this endpoint knows which headers it reads.
The cost is that adding a header the endpoint reads means adding it in `cors.ts` too, and forgetting
fails in the browser only — which is why the list names the envelope's `mcp-method` and `mcp-name`
with the reason attached.

**A `0.0.0.0` bind now behaves differently from `127.0.0.1`.** It always did — `allowedHostnamesFor`
returns nothing for it, so the rebinding guard is already off — and this makes the difference wider
by making CORS available there. That asymmetry is inherent to what the guard protects rather than new
here, but it is now a second consequence of the same choice of bind address.

## What this does not do

**It does not make this endpoint usable from a browser.** It removes the reason it could not be. A
page still needs a credential, and the only paths to one are an owner pasting a token or completing
the authorization flow — neither of which a page can do on its own behalf.

**It does not add CORS to the stdio surface**, which has no origin, no headers, and no browser.
