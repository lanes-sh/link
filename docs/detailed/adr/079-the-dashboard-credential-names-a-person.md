# ADR-079: The dashboard's credential names a person, and deny is the default it fails to

**Status:** accepted · **Completes** [ADR-068](068-a-credential-names-a-person.md) ·
**Narrows** [ADR-069](069-a-pairing-token-may-write-the-owners-own-data.md),
[ADR-063](063-one-origin-may-read-a-loopback-endpoint.md),
[ADR-064](064-a-deployed-endpoint-is-read-over-its-own-url.md) ·
**Amends** [ADR-060](060-a-caller-is-a-person.md)

## Context

A workspace member who is not the owner, and whom no profile's `members:` names,
opened `lanes.sh/dashboard/link` and read the workspace's profiles and the memory
inside them.

This endpoint has two front doors and only one of them asked who was calling.

| Surface | Credential | Names a person? | Member-filtered? |
|---|---|---|---|
| `/mcp` | OAuth code, or a `llk_` static token | yes (ADR-060, ADR-068) | yes, `mayReach` |
| `/state`, `/audit`, `/data` | the pairing token | **no** | **no** |

`PairingCredential.verify()` returned a boolean. It answered *is this the
workspace's token*, never *who is holding it*, so there was no principal to
filter on and nothing downstream filtered. `readState` described every profile
the endpoint served, each with its `members:` roster and every capability its
grants reached. `/data` took `profile` off the query string, checked only that
the endpoint served it, and handed it to the store — across `GET`, `POST`, `PUT`
and `DELETE`, because ADR-069 made five of those stores writable. So this was
never only disclosure: whoever held the token could edit and delete the memory,
tasks, assets, skills and entities of every profile in the workspace.

**The reasoning that allowed it is stated in ADR-069 and is not an oversight:**

> a pairing token is the same kind of credential: it is minted by a person at a
> terminal who already holds the workspace.

`lanes link pair` printed the same thing to the operator's face. Both are true of
a solo operator, which is who the endpoint was built for. Neither survives a
second member: the dashboard is a multi-tenant surface reached from a browser
somebody else may sign into, and the credential behind it was not.

ADR-068 had already met this exact shape and named it. The static `llk_` token
resolved to `ownerPrincipal` with `profiles: undefined`, and

> it was the one credential here that answered **what may I open** without ever
> answering **who are you**.

It was not the only one. It was the only one anybody had looked at.

**And the check itself failed open.** `mayReach` read an unset profile list as
"all of them", so the widest possible answer was what a caller got when nobody
resolved the question. Two paths in `auth/remote.ts` produced exactly that over
HTTP: an issued OAuth token minted before subjects existed, and — not a legacy
path at all — every token an external OIDC issuer vouched for, whose verified
subject was discarded in favour of the owner.

## Decision

**A credential names a person. On every surface, and deny is what it fails to.**

### The dashboard signs in, with the credential `/mcp` already takes

There is no new credential and no new exchange. This endpoint already runs an
OAuth 2.1 authorization server in `self` mode (ADR-062) and already mints exactly
what the dashboard needs:

```
POST /register     → a client, registered dynamically
GET  /authorize    → 302 to lanes.sh; the person signs in
GET  /authorize/callback → the assertion comes back, verified against JWKS
POST /token        → an access token carrying { subject, profiles }
```

`IssuedToken` in `auth/oauth/store.ts` has carried `subject` and `profiles` since
ADR-060, resolved from `members:` at the moment the code is minted. `/state`,
`/audit` and `/data` now resolve their bearer through `endpointAuthenticator` —
the same chain `/mcp` and `/health` use — and filter on `mayReach`. The pairing
token stops being a credential: it tells the page which endpoint to ask, and on
loopback it records that somebody ran `pair`.

**The first draft of this ADR did add an exchange** — `/pair/challenge` for a
nonce, `/pair/session` for an assertion, an `llps_` session token, two new KV
namespaces, a `PairedCaller` beside `Principal` and a `reaches()` beside
`mayReach`. It was rejected on review, and the reason is worth keeping: a second
credential shape is a second set of rules to keep in step, and the reason given
for not reusing `OAuthStore` — that `auth.authorization` is "rarely declared" —
was simply out of date. The profile template has written `authorization: mode:
self` since 0.12. Every profile already had the server.

So the fix is subtraction. What closes the hole is that the surface asks *who is
calling*, and there was already exactly one place that answers.

### The browser is the first client that is a page

Two things follow, and both are small:

**`/register` and `/token` need CORS.** Every client before this was
server-side or native — a connector calls both from its own backend, and
`/authorize` and the callback are top-level navigations that carry no `Origin`.
A page's `fetch` is not exempt, so without a grant the flow fails at
registration with an opaque network error. They take `READ_ORIGINS`, the same
list the reads take, imported rather than restated.

**On loopback the authorization paths ride the TLS read port.** A page on
`https://lanes.sh` cannot fetch `http://127.0.0.1:7337/register` — mixed
content, which is the same reason the read listener exists at all — and
`rebinding.ts` refuses a foreign `Origin` on the MCP bind anyway (ADR-039),
correctly. So `serveRead` delegates them to the same `handleAuthorization` the
endpoint's router calls. One `OAuthStore` sits behind both ports, so which one
minted a token does not matter to what it opens, and the MCP listener keeps
serving its own copy for every client already registered against it.

Nothing validates the `resource` a client passes, and nothing needs to: the
audience an assertion is minted for is derived from the request's own origin on
both sides of the check, so a flow driven against the read port is internally
consistent.

### `EVERY_PROFILE` is a value, not an absence

`Principal.profiles` is required. Reaching the whole workspace has to be written
down, which makes it greppable: the legitimate holders are the stdio pipe, the
CLI and generation building, each its own proof. Nothing arriving over HTTP
carries it, and `auth/remote.ts` no longer imports `ownerPrincipal` at all.

- A subject-less issued token is **refused**. It used to be promoted to the
  owner so a token minted before 0.8.0 kept working until it expired; that
  kindness was a standing bypass of `members:` on the one credential that could
  not name a person. The cost of refusing is one re-authorisation.
- **OIDC resolves through `members:`.** `allowed_subjects` answers *may this
  token in*, not *what may it open*, and reading the first as the second made
  every subject an owner. A self-hoster runs `lanes link profile members add`
  once and gets everybody else's deny-by-default.

### What a session is told

- A profile that does not name the caller is **not described**, rather than
  described and greyed out — the same thing `mergeCapabilities` does to a tool's
  `profile` enum, so the dashboard hides what the dispatcher hides.
- `/data` answers a profile the caller is not on with the **same `404`** it gives
  an unknown path. A distinguishable refusal would confirm the profile is there,
  which is the one fact a caller who may not reach it has not earned.
- The audit tail is filtered **before** the `profile` argument narrows it, since
  an entry names the profile it happened in.
- A caller who reaches none of the profiles that exist is told about **no
  connections either**: a row carries an account name, and they have proved only
  that they signed in. A workspace holding no profiles *at all* keeps its
  listing, because there is nothing to be a member of yet and an empty answer
  there would be `connect` without `--profile` looking like it did nothing.

### The last enum

`lanes_tools_search` and `lanes_tools_call` register outside the loop over what
policy decided (ADR-075) and built their `profile` enum from the profile map
sitting beside it, so a member was handed a schema naming every profile the
endpoint served. Dispatch always refused the call; what leaked was that the
profile was there to ask about. It is filtered by `mayReach` like everything
else.

## What this costs

**Every pairing already in a browser stops working.** `lanes link pair` has to be
run again and the link re-opened, and then the person signs in. That is the shape
of the fix rather than a price paid for it: the old token is the thing being
withdrawn, and a grace window would be a window in which it still opened
everything.

**A profile declaring no `auth.authorization` cannot be signed in to at all.**
There is no authorization server for it, so there is nothing to register
against. Every profile `profile add` has ever written declares `mode: self`, so
this is only reachable by a hand edit or a profile old enough to predate the
template — and `doctor --fix` repairs it.

**A profile whose `members:` is empty disappears from the dashboard.** It was
already unreachable over MCP — empty is nobody, not everybody — but the dashboard
read every profile regardless, so this is the first release where an untouched
one vanishes from a page its owner was reading. `pair` warns at mint time,
naming the profiles and the command that fixes them, because that is the last
moment before somebody opens the link and finds a shorter list.

**`profile members remove` still does not end a live session.** Unchanged from
ADR-060, and now literally the same window rather than a second one beside it:
the dashboard holds an access token, so `lanes link token rotate` is what closes
it, exactly as for any other client.

## Alternatives rejected

**Mirror profile membership into the Lanes API and filter there.** The dashboard
would ask lanes.sh which profiles to show. It cannot: the browser talks to the
endpoint directly and Lanes never sees these rows, which is the whole of ADR-063
and ADR-064. Storing the membership centrally would also make Lanes the second
place that says who may reach what, with the endpoint still needing its own
check — two sources of truth for one sentence.

**Proxy the read surface through the Lanes API.** Stronger central audit, and it
ends the product's claim that this data does not transit Lanes. A deployed
endpoint behind a firewall also stops being reachable.

**Send the assertion on every request instead of minting a token.** Its lifetime
is sixty seconds, which crosses one redirect and not one working session, so the
page would re-mint continuously. Verifying JWKS per request would also cost a
deployed endpoint a network round trip on every read. This is what `/token`
already solves.

**A pairing-token → session exchange of its own.** The first draft, described
above. It duplicated the authorization-code flow with a nonce table, a session
table, a third credential prefix and a parallel principal type, and its stated
reason for not reusing the OAuth store no longer held. Two credentials also meant
two places to apply every future rule about who may reach what — and the bug
being fixed is precisely that one of two surfaces was not applying the rule.

**Keep the pairing token for loopback and use OAuth only when deployed.** Halves
the work and reinstates the thing being removed: two mechanisms, of which the
weaker one is the one running on the operator's own machine.

**A grace period for old pairing tokens.** The vulnerability stays open for
exactly as long as the grace lasts, on the credential whose reach is the problem.
