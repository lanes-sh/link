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

### Pairing becomes two steps

The token `lanes link pair` mints opens the exchange and nothing else.

```
GET  /pair/challenge   → a nonce
POST /pair/session     → nonce + assertion → a session naming the subject
```

Every other path takes the session, which carries the subject and the profiles
whose `members:` name it. The workspace token still names a workspace; it simply
stops being an answer to a question about a person.

**Nothing new verifies the assertion.** `Federation` already does it for the
endpoint's own consent flow (ADR-062), and it is handed in narrowed to the half
that answers *who*. `profilesFor` is deliberately not taken: the live generation
is already the right answer to which profiles name a subject, and a second
resolver would be a second answer waiting to disagree with the first. The
audience is this surface's own address, never the MCP one, so a statement minted
to open the dashboard cannot be replayed into an authorization at `/mcp`.

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
run again and the link re-opened. That is the shape of the fix rather than a
price paid for it: the old token is the thing being withdrawn, and a grace
window would be a window in which it still opened everything.

**A profile whose `members:` is empty disappears from the dashboard.** It was
already unreachable over MCP — empty is nobody, not everybody — but the dashboard
read every profile regardless, so this is the first release where an untouched
one vanishes from a page its owner was reading. `pair` warns at mint time,
naming the profiles and the command that fixes them, because that is the last
moment before somebody opens the link and finds a shorter list.

**`profile members remove` still does not end a live session.** The window is the
session TTL rather than a token rotation, which is shorter than what ADR-060
states for an OAuth token but is not zero. `lanes link pair --rotate` closes it
now.

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

**Send the assertion on every request instead of minting a session.** Its
lifetime is sixty seconds, which crosses one redirect and not one working
session, so the page would re-mint continuously. Verifying JWKS per request would
also cost a deployed endpoint a network round trip on every read.

**A grace period for old pairing tokens.** The vulnerability stays open for
exactly as long as the grace lasts, on the credential whose reach is the problem.
