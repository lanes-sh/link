# ADR-054: The surface in front of the gate is metered, and does not name itself

**Status:** accepted · **Follows from** [ADR-018](018-the-gate-is-in-the-application.md),
[ADR-036](036-a-client-is-told-this-endpoint-keeps-it-signed-in.md),
[ADR-039](039-cross-origin-access-is-a-deployment-only-grant.md)

## Context

ADR-018 put the gate in the application, because a target a remote MCP client can reach has to
be `--allow-unauthenticated` at the platform: Cloud Run IAM admits only a caller holding a
Google-signed identity token for the service, and no agent harness can mint one. So a deployed
endpoint is a routable address that anybody can send a request to, and everything it does about
who is calling, it does itself.

That was reasoned about carefully for the paths *behind* the bearer check. A failed comparison
costs a re-read of the credential store — a Secret Manager call on a deployed target, and two of
them when the presented value does not match what the process cached, because a mismatch against
a cached value is what forces the re-read that makes a rotation take effect within five seconds.
`FAILED_AUTH_PER_MINUTE` exists for exactly that.

It was not reasoned about for the paths in *front* of it, and there are four:

| | what it costs, once, unauthenticated |
|---|---|
| `GET /health` with a credential | one credential-store read, two on a cache mismatch |
| `POST /register` | one object written to the workspace bucket, then two namespaces listed |
| `POST /authorize` | one credential-store read, per attempt at the owner's token |
| `POST /token` | bucket objects read and written |

The ceiling lived inside the `if (!outcome.ok)` branch of the request handler, which is reached
only after the 404 gate — so none of the four ever passed through it. `/health` in particular is
answered and returned several lines earlier, and it calls the authenticator on the way.

Two smaller things were wrong in the same region, and they are the same subject rather than a
second one.

**The limiter's key map was unbounded.** `callerKey` is the first `X-Forwarded-For` hop, which is
the only address that means anything on Cloud Run — the socket peer there is Google's frontend,
identical for every caller — and which anybody talking to the endpoint writes as they please.
`RateLimiter` had a `prune` that nothing called; the comment above the limiter said idle callers
were dropped so keys would not accumulate, and they were not.

**And the endpoint let the request decide its own name.** `publicOrigin` preferred
`X-Forwarded-Host` over `Host`. Four documents are built from it: both discovery documents, the
`resource_metadata` pointer on every `401` that ADR-036 made load-bearing, and the `action` of
the consent form that asks the owner to paste their endpoint token. The justification written
beside it is entirely about the *scheme* — Cloud Run terminates TLS, so a URL built from the
incoming request says `http` — and nothing ever needed the other header.

## Decision

**1. The pre-authentication surface is metered, and the meter is a property of the bind address.**

Two buckets, both taken on every costly request. One is keyed on the caller and stops a single
noisy client spending everything. The other is keyed on nothing at all, and is the one that
actually holds: a per-caller limit alone bounds only a caller who is not trying, because rotating
a header walks straight through it.

An endpoint-wide bucket has the failure mode that whoever spends it locks everyone else out,
which is precisely why the *failed-auth* ceiling is not keyed that way. The trade is different
here, and it is worth naming rather than assuming. What is behind these four paths is not the
owner's ability to use their endpoint — a client that has authorised holds a token and never
returns through them — it is a discovery document, a registration, and a consent screen. Losing
those for a minute is an authorization retried. Not losing them is a stranger's unbounded spend
against the credential store.

`/health` presented with **no** credential is deliberately free. It reads nothing, and it is what
a platform probe, `lanes link deploy` and `lanes link outputs` send; a health check that answers
`429` during an attack is an outage the attack did not have to cause.

Off on loopback, decided in the same three lines of `serve()` that decide CORS, the dashboard and
the rebinding allowlist — because it is the same kind of fact. What the ceiling protects is a
network call and an object in a bucket; on loopback both are a local file belonging to whoever is
already standing at the machine, and `rebinding.ts` refuses the one caller who is not.

**2. A limiter is bounded by construction, not by a caller remembering to prune it.**

Idle buckets go first, because dropping one costs nothing — an untouched bucket has refilled to
full, so re-creating it returns exactly what was discarded. Only when that is not enough is a live
caller evicted, oldest by last use, in batches so the sort is amortised rather than run per
request. Evicting a live caller does forgive what it had spent; that is the honest cost of a
bounded map, and it is why the endpoint-wide bucket above is not optional.

**3. The host is `Host`. `X-Forwarded-Host` is not read.**

Cloud Run sets `Host` and routes on it, so it is the one value a caller cannot invent without the
request going somewhere else, and a proxy that genuinely rewrites it — a domain mapping — rewrites
`Host` too. The scheme still comes from `X-Forwarded-Proto` because that is what the header is for
here, and it is checked against `http` and `https` rather than echoed.

`form-action` joins the page CSP as the second lock on the one form that carries the owner's
token. It has to be named explicitly: it does not fall back to `default-src`, so the `'none'`
already there said nothing about where a form may post.

**Amended.** It was written as `form-action 'self'`, and `'self'` alone cannot end an OAuth flow.
Chrome and Safari check this directive against the *redirect* a submission produces as well as
against the `action`, and the consent form exists to end in a 302 to the client that asked. So the
POST was accepted, the code was minted, and the browser then refused to deliver it — a page that
hangs on its spinner, with a console error naming this endpoint's own `/authorize` rather than the
blocked destination, because a violation report deliberately names the pre-redirect URL. Firefox
does not enforce it on redirects, so it failed in half the browsers and worked in the other half.
Whether the directive *should* apply to redirects has been open since
[w3c/webappsec-csp#8](https://github.com/w3c/webappsec-csp/issues/8); the browsers that ship it are
the ones that decide.

The consent page now names the redirect target of the request it is rendering, beside `'self'` —
taken from the request rather than from the registration, since a native client registers
`http://localhost/callback` and binds a port. This widens nothing that matters. The origin admitted
is the one already printed on the page as where the code will be sent, it has been checked against
the registration before the page renders and again before anything is minted, and `form-action`
only ever *refuses* a destination: the `action` that carries the token is still built server-side
from `Host`, so no source added here can move it.

## Consequences

A deployed endpoint has a bound on what an unauthenticated stranger can make it spend, which it
did not have. Combined with `max_instances`, which the rollout now always sends, the aggregate is
bounded too — `limits.requests_per_minute` has always been per instance, and with no ceiling on
instances the aggregate had no value at all.

The numbers are ordinary rate limits and not a security boundary; `#policy` says so about the
limits beside them and it is equally true here. Guessing the token is hopeless because it is 256
bits, not because it is slow.

A test drives the deployed behaviour by asking for the meter explicitly, because a harness binds
loopback where it is off. That is the same shape as every other property of the bind address and
it means the thing under test is the thing that ships.

An operator running an unusual proxy in front of the endpoint — one that rewrites `Host` and
expects `X-Forwarded-Host` to be honoured — will find the discovery documents naming the inner
hostname. That configuration was never supported and is not documented; a domain mapping, which
is, sets `Host` correctly.
