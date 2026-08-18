# ADR-025: Connecting an account from a deployed endpoint

**Status:** proposed — the first record here that is not yet a decision. It exists because the
argument against it has an expiry date that has arguably passed, and because the next person to
ask should find the case already made rather than reconstruct it. Nothing in the codebase depends
on this; the read-only surface of [ADR-019] is what shipped.

## The question

Can the owner add a Google account by asking a chat client, rather than by pasting a line into a
terminal?

Today, no. [ADR-007] excludes connection creation and credential writing from the MCP surface,
[ADR-005] puts the OAuth exchange in the CLI over a loopback redirect, and [ADR-019] tabulates the
consequence plainly: for `oauth` providers an agent "emits the one command for the person who owns
the browser". [ADR-023] then backed the exclusion with an IAM condition, so the deployed revision
holds `roles/storage.objectViewer` on `profiles/` and could not write a connection even if the code
allowed it.

## Why this is worth reopening

**The stated reason for refusing agent-driven OAuth is about a loopback listener, and a deployed
endpoint has none.** ADR-019 §"Why the CLI became drivable" gives the mechanism:

> `connect` would open a browser and block on a loopback listener for five minutes; an agent's
> shell times out first, taking the listener with it, and leaves no token and no explanation.

Every clause there is about a CLI process holding `127.0.0.1:<port>` inside a shell somebody else
owns. A Cloud Run service has a public HTTPS origin, terminates TLS at the front door, and already
serves an HTML consent page at `/authorize` for inbound MCP-client authorization
(`src/server/oauth.ts:130-140`). The failure ADR-019 describes cannot occur there, because there is
no ephemeral listener and no shell to outlive it.

ADR-005's "why the CLI and not the server" is narrower than it first reads, too. Its argument is
that loopback "works identically whether the instance is local or on Cloud Run" and needs no
inbound path — a claim about what the *CLI* costs, not a claim that the server performing it would
be wrong.

**The remaining objection is the real one, and it is not about mechanism.** ADR-007's unifying
sentence is that each excluded operation authorises *future agent behaviour*, so the decision must
originate outside the agent. Connecting an account is squarely that: it is the act that grants
every later call. That argument is untouched by Cloud Run having a public origin.

So the honest framing is not "ADR-019 was wrong" but: the mechanical objection has expired, and
what is left is the authorisation objection, which has to be answered on its own.

## The shape it would take

A consent URL is not a credential, and clicking it is the owner acting outside the agent. That is
the seam worth arguing over:

1. A capability returns a URL and nothing else. It stores no credential and grants nothing.
2. The owner opens it, in their browser, under their own Google session, and consents.
3. The endpoint receives the callback on its own HTTPS origin, exchanges the code, writes the
   refresh token, and adds the connection row.
4. The new connection is served after the config is re-read.

Whether step 1 is meaningfully "outside the agent" is the whole question. The consent screen names
the account and the scopes, and the person clicking it is the owner — which is the same checkpoint
[ADR-018] already calls "the closest thing to a control plane" on the endpoint. Against that: the
agent chose the moment, the provider, and the scopes, and a person approving a screen an agent
put in front of them is a weaker checkpoint than a person typing a command they composed.

## What it would cost

Not a small change, and the cost is mostly in guarantees rather than code:

- **[ADR-007]'s connection-creation exclusion** would no longer hold as written. The seven
  unanchored patterns in `src/dispatch/control-plane.test.ts:33-41` are a mechanical expression of
  it — `/(^|[._])(connect|authorize|oauth)/i` refuses any capability that could be named for this,
  so the test would have to be amended rather than worked around. That table is deliberately the
  kind of thing you cannot edit by accident.
- **[ADR-023]'s IAM condition** grants the revision `objectViewer` on `profiles/`
  (`src/deployments/gcp/provision.ts:235-243`). Writing a connection means widening that to
  `objectAdmin`, which removes the enforcement ADR-023 moved there precisely because image
  immutability no longer provided it.
- **"A running instance never mutates its own configuration"** would stop being true. This is the
  sentence ADR-007 ends on and the one ADR-023 was careful to preserve while moving its mechanism.
- **A config-reload story.** `src/server/endpoint.ts:86-104` opens one runtime per profile at boot
  and holds it, and `ProviderRegistry.replace` says in its own docstring that it is not a general
  hot-reload facility. A connection written at runtime is not served until the revision restarts —
  so either the flow ends with "redeploy", which loses most of its point, or reload becomes its own
  decision about what policy a call is evaluated against between two requests.
- **An OAuth redirect URI on the deployment**, which ADR-005 lists as a cost the loopback flow
  exists to avoid: a public callback route, a registered "Web application" client rather than the
  current "Desktop app", and a redirect URI that changes with the service URL.
- **A second OAuth flow to maintain.** The CLI's would have to stay for local and first-run use, so
  this adds a path rather than replacing one.

## What would have to be built

- A `/callback` route. The served endpoint has none — `src/server/index.ts:196-314` serves
  `/health`, `/mcp`, `/attachments`, and the inbound-authorization routes, and everything else 404s.
- Pending-authorization state, keyed and expiring, in the state store.
- The IAM change above, and a migration for deployments provisioned under the current conditions.
- A decision about `--accept-broad-scopes`, which ADR-019 already calls "a document, not a control".

## Recommendation

Do not build it yet. Ship the read-only repair first — a client that answers *"you have
you@example.com and other@example.com; run `lanes link connect gmail --profile personal`"* closes
most of the ergonomic gap, and it is what the surface was designed to do. The remaining friction is
one pasted line, against the guarantees listed above.

Revisit if that line turns out to be the thing people do not do. The argument to beat is the
authorisation one, not the loopback one.

[ADR-005]: ./005-oauth-connection-flow.md
[ADR-007]: ./007-control-plane-exclusions.md
[ADR-018]: ./018-the-gate-is-in-the-application.md
[ADR-019]: ./019-describing-setup-is-not-performing-it.md
[ADR-023]: ./023-the-workspace-is-not-in-the-image.md
