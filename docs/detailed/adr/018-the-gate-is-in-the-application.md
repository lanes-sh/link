# ADR-018: the gate is in the application, and this endpoint issues its own tokens

**Status:** accepted · **Amends** [ADR-003](003-auth-model.md), whose bearer token remains the
mechanism for every local client and is no longer the only one.

## Decision

A deployed instance is protected **inside the application**, not by the platform's front door.
`deploy.access` defaults to `iam` for a target with no application gate; a target reached by a
remote MCP client declares `access: public` and an `auth.authorization` block, and the endpoint
refuses everything that arrives without a token it issued or verified.

`auth.authorization.mode` has two values:

| Mode | Who issues tokens | What the operator sets up |
|---|---|---|
| `self` | this endpoint | nothing |
| `oidc` | an issuer you already run | an OAuth client, a redirect URI, a client id in the credential store |

`self` is the default in the documentation and the one `deploy` proposes.

## Why not Cloud Run IAM

This is the decision that gets re-litigated on first seeing `--allow-unauthenticated` in a deploy
plan, so it is written down.

Cloud Run IAM authenticates a caller holding a **Google-signed identity token** for this service,
issued to a principal with `roles/run.invoker`. Claude and ChatGPT connectors send an OAuth bearer
token they obtained from an authorization server the resource advertised. These are not the same
credential and one cannot be turned into the other at the client: there is no setting in either
product that makes it mint a Google identity token, and there will not be, because the client does
not know it is talking to Google.

So `access: iam` and remote MCP access are mutually exclusive. IAM is correct for a service other
cloud workloads call and produces nothing but 403s for a service a person calls from their phone.
Keeping the flag, keeping `iam` as the default, and moving the gate one layer in is the only
arrangement where both cases are expressible.

The layer that moved in is not weaker. Everything that reaches `/mcp` presents a credential this
endpoint checks, and the check happens before the MCP handler is constructed — which was already
true for the bearer token and is now true for two more kinds.

## Why this endpoint issues its own tokens

The cheaper implementation, by a wide margin, is to publish protected-resource metadata pointing at
somebody else's authorization server and validate what comes back. It is perhaps a fifth of the
code, and it was the first design.

It was rejected because it moves the cost onto **every user's setup**. Delegating to Google means
each person deploying this creates an OAuth client in their own project, registers Claude's callback
URL against it, and pastes a client id and secret into a connector's advanced settings before
anything works — the most expensive step in the product, paid once per user, to save implementation
work paid once by us. Google supports neither dynamic client registration nor client-ID metadata
documents, so nothing about that is automatable, and ChatGPT, which needs dynamic registration, very
likely cannot use it at all.

Issuing our own inverts that. A client registers itself, the operator approves once with the token
they already have, and no console is involved. `oidc` stays available for anyone who would rather
their existing identity provider be the one saying who you are — the config seam costs a
discriminated union, and `authorization_servers` in the metadata document was always going to be a
value rather than a constant.

## Why this is not the admin API ADR-007 excludes

[ADR-007](007-control-plane-exclusions.md) says a deployed instance never mutates its own
configuration and exposes no admin API. Issuing a token writes a row, and so do the audit log,
connection status, and every provider cursor. None of it is configuration: no policy changes, no
credential is written, no connection is authorised, and nothing here can grant a capability the
config did not already declare. What an approved client may do is decided by the same policy, per
capability, per call, as everything else.

The consent screen is the closest thing to a control plane, and what it accepts is proof of holding
the endpoint token — a credential the CLI already issued. It grants no permission; it attests that
the person approving is the person who deployed this.

## Consequences

**Registration is open.** Anyone who can reach the endpoint can register a client, which yields an
identifier and nothing else — no client gets a token without an approval performed by hand with a
credential only the operator has. Requiring authentication to register would mean a pre-registered
client id pasted into a console, which is the setup step this whole mode exists to remove.

**Tokens are runtime state.** They live in the database, hashed, so a dump yields no working
credential. Deleting a profile's database logs every connector out and they authorise again; nothing
about what *should* exist is lost, which is the rule for anything stored there.

**`auth` may now import `stores`.** Recorded in `src/architecture.test.ts` with its reason. The
direction is downward and `secrets` already depends on `stores`, so no cycle appears.

**`/health` no longer names profiles to an anonymous caller.** It answers `{status: "ok"}` so a
platform probe and a deploy can wait on it, and returns the profile list only to a caller holding a
token. On a public URL that list was an inventory of what the instance holds, published to anyone
who asked; the two callers it was published for both hold a token already.

**Approval is all-or-nothing.** An approved client resolves to the same owner principal the bearer
token yields, so scopes are not a permission axis here — policy is. Delegated principals stay out of
scope; the dispatch path already takes a principal rather than assuming the owner, so they are
additive rather than a rewrite.
