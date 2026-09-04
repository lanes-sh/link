# ADR-069: A pairing token may write the owner's own data

**Status:** accepted · **Narrows** [ADR-063](063-one-origin-may-read-a-loopback-endpoint.md),
[ADR-064](064-a-deployed-endpoint-is-read-over-its-own-url.md) ·
**Follows from** [ADR-007](007-control-plane-exclusions.md),
[ADR-050](050-the-owner-layer-is-granted-by-default.md)

## Context

ADR-063 opened one origin onto a loopback endpoint and ADR-064 finished the sentence for a
deployed one. Both list the same five constraints, and the fourth is stated without qualification:

> **Reads only, ever.** Editing a connection or a profile from a browser would put control-plane
> mutation behind a CORS grant, and ADR-007 is not moving for a convenience.

`src/server/read/routes.ts` enforces it by answering `404` to every method that is not `GET`, and
the dashboard's Connections and Profiles tabs render their Save, Rename and Disconnect controls
disabled, which is the honest state rather than an unfinished one.

The sentence is right about what it names. It is broader than what it argues. Read the clause
again: *editing a connection or a profile*. Both are configuration, both authorise future agent
behaviour, and ADR-007 excludes them for that reason. Neither is what the endpoint mostly holds.

**What it mostly holds is the owner's own material.** Memory entries, tasks, assets, skills and
entities: five stores that carry no account, no credential and no grant, that arrive granted to
every new profile precisely because there is nothing behind them to protect (ADR-050), and that
any agent the owner has connected already writes over MCP through `lanes_memory.write`,
`lanes_tasks.add`, `lanes_assets.store`, `lanes_skills.manage.write` and `lanes_entities.write`.

There has been nowhere for a person to look at any of it. `lanes link memory list` is the whole
surface, and the audience ADR-063 moved to the web dashboard for is the audience least likely to
be at a terminal. Worse, the one operation a person actually needs on accumulated memory is the
one an agent should be slowest to perform: reading what has piled up and deleting what is wrong.

## Decision

**The pairing token reads and writes the owner's own data. It still cannot touch the control
plane.**

A `/data` prefix joins `/state` and `/audit` behind the same pairing credential, the same single
named origin, and the same non-ambient header:

```
GET    /data/:store?profile=&query=&limit=
GET    /data/:store/:id?profile=
POST   /data/:store?profile=
PUT    /data/:store/:id?profile=
DELETE /data/:store/:id?profile=
GET    /data/assets/:name/content?profile=
```

`:store` is a closed list: `memory`, `tasks`, `assets`, `skills`, `entities`, `vault`.

**Five stores are writable. The vault is names only, in both directions.** ADR-007 makes reading a
raw credential value CLI-only, and that does not move for a browser any more than it moved for an
agent. A vault listing carries the item ids and their descriptions and no value under any key; a
write to `vault` is refused with the same `404` this surface gives every unroutable path, because
a distinguishable refusal would confirm the shape of what is here.

**`identity` and `setup` are not on the list.** Identity is configuration and changed in the CLI
(ADR-007), and it is the one fact that stops an agent signing as the wrong person. Setup describes
the others rather than holding anything.

**Policy does not gate this, and the grants still scope it.** `lanes link memory write` does not
consult the profile's write bundle today, because the CLI is the owner rather than an agent, and a
pairing token is the same kind of credential: it is minted by a person at a terminal who already
holds the workspace. What the grants decide is which connection *exists* to address, since
`ownerConnection` derives its candidates from them. A profile granting no memory connection has
nothing to write to and says so.

**Every write is audited, in the same log and the same vocabulary as an agent's.** The capability
recorded is the one that would have done it over MCP, so a dashboard delete and an agent delete
are one search rather than two. Identifiers are kept and content is withheld, which is the rule
the write path already follows everywhere else.

**The profile is named on every request and never defaulted.** Owner data has been per-profile
since ADR-066, and a default would let a page write to a profile the person was not looking at.

## What this costs, plainly

**A pairing token stops being read-only.** ADR-063 already said "read only is not harmless" about
a credential that returns every connection, every profile and the whole audit log. It is now a
credential that can also destroy the owner's memory. It rotates with one command, it is refused
the moment it does, and `--print` is still the way to look at the link without minting one.

**An existing pairing token gains this silently.** The token carries no version; the endpoint
decides what it may do. Somebody who paired before this release has a credential sitting in a
browser's `localStorage` that becomes write-capable the first time they run a newer endpoint, with
nothing on either side announcing it. That cannot be fixed by the token, so it is handled by
saying it: in the release note, in the prompt `lanes link pair` asks before minting one, and in
`lanes link status`, which reports the pairing and should report what it can now do.

Requiring a re-pair to unlock writes was considered and rejected. It would mean a second token
kind, a second thing to rotate, and a version marker inside a credential whose entire security
story is that it is opaque and compared in constant time. The honest disclosure is cheaper and
does not leave two credentials able to do each other's job, which is the failure ADR-063's second
constraint exists to prevent.

**The blast radius is one workspace's owner data.** Not a credential, because the vault is closed
in both directions and `credentials.not-agent-reachable` is unaffected. Not another origin,
because the named echo, the `Vary: Origin`, and the deliberate absence of
`access-control-allow-credentials` are untouched. Not the endpoint, because `/mcp` gains no CORS,
no route, and no change to the rebinding guard.

## What this does not do

It does not move ADR-007. Policy, tokens, credential writing, connection creation, configuration
mutation and audit mutation are exactly as unreachable as they were, from a browser and from an
agent, and `src/dispatch/control-plane.test.ts` still holds them up.

It does not make the disabled controls on Connections and Profiles work. They stay disabled, and
they stay disabled for the reason ADR-063 gave.

It does not add an upload. `lanes link assets add` resolves a source, records where it came from
and annotates the audit event with a digest of what arrived; reproducing that over HTTP is its own
decision and has not been made here. Assets are listed, previewed and deleted.

It does not put the store inside `server`. The dependency direction in
`src/architecture.test.ts` gives `server` no reach into `#providers` or `#audit`, and this does
not widen that table: `src/server/read/data.ts` declares the narrow interface it needs and
`src/cli/data/` satisfies it, which is the same split `readRoutes` already makes for `AuditTail`.
