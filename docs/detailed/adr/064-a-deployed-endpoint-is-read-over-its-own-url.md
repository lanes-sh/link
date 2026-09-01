# ADR-064: A deployed endpoint is read over its own URL, and pairing stops meaning a certificate

**Status:** accepted · **Amends** [ADR-063](063-one-origin-may-read-a-loopback-endpoint.md) ·
**Constrained by** [ADR-039](039-cross-origin-access-is-a-deployment-only-grant.md),
[ADR-054](054-the-surface-in-front-of-the-gate.md)

## Context

ADR-063 gave the dashboard a surface to read and was careful about what it was giving away. Its
five properties — one named origin, a credential that cannot call a tool, nothing ambient, reads
only, TLS — were each answering a specific sentence in ADR-039, which refuses cross-origin access
on loopback and had anticipated exactly this decision being reopened.

It was also explicit that a deployed endpoint was not in scope, and said why:

> a deployed endpoint is already reachable by URL and `lanes link pair` refuses to provision one

That refusal shipped in two places. `pair` threw for a non-loopback `instance.host`, and
`openReadListener` returned `null` for a non-loopback bind before reading a single credential —
the latter for a sharp reason recorded in its own comment: a deployed revision that asked Secret
Manager for refs no IAM binding covered got a **403**, not a 404, the rejection escaped the try
block wrapping only `serveRead`, and the revision never went healthy.

**What that argument actually establishes is narrower than what it was used for.** Read it again
and every clause is about the *certificate*: pairing "would mean installing a certificate for an
address this machine does not answer on". That is true, and it is still true. A deployed endpoint
terminates TLS with a certificate a browser already trusts, so there is nothing to install and
nobody to ask.

But the certificate was never the point of pairing. The point is a credential that reads a
workspace and an address to present it to, and a deployed endpoint has both — it simply had no
way to hand either to a browser. So half the people running this could see their connections,
their profiles and their audit log in the dashboard, and the half who had done the thing the
product recommends for reaching an endpoint from a phone could not. That is the same shape of gap
ADR-053 named when the served page was local-only, and it is closed the same way: by looking at
what the audience needs rather than at where the last decision left them.

## Decision

**The read routes are one implementation, bound two ways.**

```
loopback    https://127.0.0.1:7338/state     a second listener, TLS via mkcert
deployed    https://<service>/state          the endpoint's own port and certificate
```

`src/server/read/routes.ts` decides four of ADR-063's five properties and both binds go through
it. The fifth — TLS — belongs to the bind rather than to the routes, which is why it is the one
that differs: Cloud Run routes exactly one port, so a second listener is not available there and
is not needed.

**Four constraints carry over unchanged, and one is tightened.**

- **One origin, named, never `*`.** This is the tightening, and it is worth stating because
  "stricter is safer" would be a bad reason and is not the reason. `cors.ts` justifies a wildcard
  on the credentialed surface with three conjuncts, and all three hold here: the endpoint is
  already publicly reachable, the credential is never ambient, and `Access-Control-Allow-Credentials`
  is never sent. A wildcard would be *safe*. What it was buying, in `cors.ts`'s own words, was the
  absence of "a required setup step per user" — and there is no setup step here to avoid. The
  consumer is one known product surface and `READ_ORIGINS` is already a compile-time constant, so
  naming it costs nothing. It also buys something real: a pairing token reads every connection,
  profile and audit entry, and ADR-063 says plainly that "read only" is not "harmless". Named, a
  token that leaks through a screenshot has to be replayed from `lanes.sh`.
- **A credential that cannot call a tool**, and the routes never pass through
  `options.authenticator`. One shared check would make the MCP bearer able to open the dashboard
  and the pairing token able to call a tool.
- **Never ambient**, **reads only**: unchanged, and now tested on both binds.

**`lanes link pair` refuses the certificate, not the pairing.** For a workspace declaring a
deployment it skips `ensureCertificate` entirely, mints the token into that workspace's store,
resolves the address the platform assigned, and prints
`…/dashboard/link#pair=<token>&at=<url>`. The address rides in the fragment beside the token
rather than in a query parameter, for the token's reason and one of its own: a query parameter
would put a workspace's public address in a Lanes access log.

A link with no `at=` is a local one, so every link minted before this decision still works.

**A deploy binds the token, and creates it empty.** `PAIR_TOKEN_REF` joins `readableRefs`
unconditionally — for every deploy, paired or not. This is the whole of the fix for the failure
ADR-063 recorded, and it turns on the difference between two error codes: Secret Manager answers
a *missing binding* with 403 and a *secret that exists with no version* with 404, and the adapter
throws on the first and returns `null` for the second. Bound, the never-paired case becomes an
ordinary `401 {error:'unpaired'}` instead of a revision that will not boot.

Deciding it by asking whether a workspace is paired is the thing that cannot happen: that means
opening a credential store inside `readableRefs`, which `--dry-run` reaches and must not do.

It is deliberately **not** in `rotatableRefs`. The revision never writes this token — minting is
`lanes link pair`, from the operator's machine — and `secretVersionAdder` here would let a
compromised revision issue itself a credential that reads the whole workspace. The cert and key
refs are absent for a different reason: nothing on a deployed endpoint reads them.

**The read paths are metered.** ADR-054's four costly pre-gate paths gain a fifth kind. `/health`
without a credential is free because a platform probe sends exactly that; `/state` gets no such
exemption, because nothing legitimate calls it without a credential and so there is no free
request to protect.

## What this costs, stated plainly

**A credential that reads the whole workspace now exists on a public URL.** On loopback the
surface was unreachable to anyone not already at the machine. Here it is reachable by anyone, and
what stands in front of it is a 256-bit token, a named origin, and a rate limit. That is the same
posture `/mcp` has had since ADR-018 and it is a real widening of what a leaked pairing token can
do — which is why `pair` says out loud what the token reads, and why rotating it is one command.

**A rotation takes up to five seconds to be refused.** `GcpSecretManagerStore` holds nothing
between calls, so verifying per request would be a network round trip per poll — and per *wrong*
guess, which is ADR-054's hazard exactly. So the deployed bind caches for five seconds, the same
window and the same trade `BearerAuthenticator` already takes over a stronger credential. A token
rotated *in* still works on its first presentation, because a mismatch against a cached value
buys exactly one re-read. A token rotated *away* keeps reading until the window ends. `pair
--rotate` says so on a deployed workspace rather than repeating loopback's unqualified promise.

**A full-workspace read from the internet leaves no trace in the log it is reading.** The read
surface records nothing about itself, which was defensible when the only caller was someone
already standing at the machine and is less so now. Not changed here, and named rather than left
implied.

**`src/cli/commands/operate/pair.ts` was cut in half.** The certificate machinery moved to
`pair-certificate.ts`. That is the seam the file-size budget pointed at rather than a split by
line count: it is the half of pairing that only loopback has.

## What this does not do

It does not add CORS to `/mcp`, on loopback or anywhere. It does not make the read surface
reachable on a loopback bind — `serve()` discards it there exactly as it discards `cors`, and a
test drives that, because a deployment-only grant that leaked onto `127.0.0.1` is precisely what
ADR-039 refuses. It does not let the dashboard change anything: every mutation is still a command
the owner runs. And it does not send anything to Lanes — the page runs in the owner's browser and
the fetch goes to their own endpoint.
