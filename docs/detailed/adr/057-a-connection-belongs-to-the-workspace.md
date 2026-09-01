# ADR-057: A connection belongs to the workspace, and a profile selects it

**Status:** accepted · **Supersedes** [ADR-003](003-auth-model.md)'s granularity argument ·
**Amends** [ADR-009](009-one-endpoint-per-workspace.md), [ADR-030](030-a-profile-owns-its-skills-and-manifests.md) ·
**Follows from** [ADR-052](052-a-target-owns-its-workspace.md)

## Context

A connection has lived inside one profile since M1. `profiles/<name>.yaml` carries a
`connections:` array, and a sibling profile cannot see a row in it. ADR-009 stated the boundary as
an invariant — profiles share no database and no credential store — and ADR-030 finished the job
by moving skills and manifests in beside them.

The isolation is real. What it costs is that **authorising an account and deciding what may be
done with it are the same act**, and only one of the two is a property of the account.

An owner who wants a mailbox read by one agent and written by another authorises the mailbox
twice. Two OAuth round trips, two refresh tokens, two grants the vendor lists on its security
page, and revoking one does not revoke the other. Every further combination — a third profile
that reads mail and edits the calendar — is another full pass through a browser. The workspace
this was written against holds fifteen connections across seven vendors; a second profile wanting
half of them costs seven browser sign-ins to express a permission change.

Two smaller things point the same way.

**The credential store was never actually per profile on a deployment.** `credentialRef` is
`gmail/main`, flat within one target's store, and `deploy` carries a `collidingRefs` preflight
precisely because two profiles deployed into one project share that namespace. ADR-043 records
what the collision does: it is "silent until one profile is reading the other's account". So the
boundary a profile claims is, on the path that matters most, enforced by a refusal at deploy time
rather than by the model.

**A profile is a statement about scope, not about inventory.** "Personal assistant — read my mail,
edit my calendar" describes what may be done. It does not describe which accounts exist, and it
was never the natural place to record that a mailbox was authorised.

## Decision

**Connections move up to the workspace.**

```
~/.lanes-link/
├── lanes-link.yaml         the workspace registry
├── connections.yaml        every authorised account in this workspace
└── profiles/<name>.yaml    which of them, and what may be done with each
```

`connections.yaml` carries the `connectionSchema` rows unchanged, and `oauth_apps` with them — a
registered client is a property of an account, not of a selection.

**A profile names connections in `grants:`**, one row per connection.
[ADR-058](058-a-grant-names-a-connection.md) covers the scopes half; this decision is only about
where a connection lives.

**One credential store per workspace**, at `data/credentials.enc`. Refs are unique by
construction, so `collidingRefs` and its preflight are deleted rather than kept as a guard for a
state that can no longer occur.

**Provider manifests move with them**, to `data/providers.d/`. This reverses half of ADR-030 and
follows from it rather than contradicting it: a manifest *defines a connection* — a host, an
OpenAPI document, and the credential refs that reach them — so once connections are
workspace-level, a manifest scoped to one profile describes something that does not live there.

## Why this is not the retreat it looks like

ADR-030's argument was about *content*: a work incident-review skill "is a description of how a
particular employer runs incidents", and is exactly as private as the knowledge it operates on.
That argument is untouched. It is answered by
[ADR-059](059-the-owner-layer-is-instances.md), which keeps memory, skills and entities as
instances a profile chooses — so two profiles can still share nothing, deliberately, by choosing
different ones.

ADR-009's "a note written through `personal` is simply absent in `work`" survives for the same
reason. What does not survive is the claim that a *refresh token* is private to a profile, and
that claim was already false on a deployment.

## What this costs, stated plainly

**The workspace is now the only isolation boundary.** Before, `rm -r data/work` was the whole
answer to "what could work reach". It is not any more: removing a profile removes a selection, and
the accounts outlive it. That is the correct answer for an account — you did not stop having the
mailbox — but "remove the work profile" no longer means "revoke what work could reach", and
`profile remove` therefore prints the connections that outlive it rather than letting the
difference go unnoticed.

**Two profiles referencing one connection share one credential.** They share its rate limit, its
reconcile state, and its revocation: `disconnect` takes the account away from every profile
naming it. `disconnect` consequently reports which profiles reference the row and refuses without
`--yes`, where before it could only ever affect the one profile it was run against.

**A leaked workspace is a wider leak than a leaked profile was.** One credential document now
holds every account rather than one profile's share. It is the same document, under the same key,
in the same place — but it is worth saying that the blast radius of the file grew, because the
`data/<profile>/` split used to bound it and no longer does.

## Consequences

**`connect` and `disconnect` become workspace-scoped.** Both drop `--profile`: there is no profile
to write into. A newly connected account belongs to the workspace and is reachable from no profile
until one grants it, which is default deny arriving one step earlier than before.

**The deploy preflight goes.** `collidingRefs` existed for two profiles sharing a namespace. There
is one namespace now, and a duplicate id is refused at config load by the schema rather than
minutes into a rollout.

**A profile file gets shorter and says only what it is for** — a name, a description, a set of
grants, and the people who may use it. That is what makes ADR-058 and
[ADR-060](060-a-caller-is-a-person.md) expressible; neither would fit in a file that was also an
account inventory.

**Migration has one interesting case**, and it is not the common one: two profiles each holding a
row that is spelled `gmail.main` but names a different account. Keyed on `(provider, account)` the
common case merges silently; the divergent case suffixes the id and reports the rename, because
picking either row would be the silent wrong answer this project keeps refusing to give.

## What this does not do

It does not make a connection reachable by default — a connection with no grant is not advertised
and not callable, which is ADR-003's default deny unchanged. It does not merge the credential
store with the vault; ADR-022's separation is untouched and is the one thing here that must never
be collapsed. And it does not give a profile any way to authorise an account itself: connecting
remains a control-plane act performed by the owner in a terminal (ADR-007, ADR-019).
