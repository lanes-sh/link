# ADR-050: The owner layer is granted by default

**Status:** accepted · **Amends** [ADR-012](012-owner-layer-primitives.md) ·
**Relates to** [ADR-014](014-owner-layer-is-managed.md),
[ADR-003](003-auth-model.md), [ADR-007](007-control-plane-exclusions.md)

## Context

A fresh profile granted one thing:

```yaml
connections:
  - { id: main, provider: setup, account: Setup }
policy:
  allow: [setup.*]
```

Memory, skills and the vault each needed `lanes link connect <them>` before they existed at all.
Not because connecting *did* anything — none of the three has an account, a credential, an OAuth
app, or a vendor — but because a provider is enabled by having a connection row, and nothing wrote
one. The quickstart said so out loud:

> Memory, skills, and the vault hold your material rather than an account, so they need no
> credential and no browser. **One command each:**

Three commands, whose entire effect was two lines of YAML apiece. Tasks and assets (ADR-051) would
have made it five, and five is where a setup step stops reading as caution and starts reading as
an oversight — the paragraph explaining that these need no credential sits directly above the
three commands you must run to get them.

The cost was not only typing. An endpoint someone had pointed a client at, without reading that
section, served no memory: the agent had nowhere to put what it was told to remember, and
`tools/list` said nothing about why. The observed failure mode is an agent inventing a procedure
to fix it, which is the same failure ADR-019 describes for a missing `setup` surface.

## Decision

**A new profile is created with the whole owner layer declared and granted**, and a profile that
predates it is repaired on the next `start`, `connect` or `deploy`.

```yaml
connections:
  - { id: main, provider: memory, account: Memory }
  - { id: main, provider: tasks, account: Tasks }
  - { id: main, provider: assets, account: Assets }
  - { id: main, provider: skills, account: Skills }
  - { id: main, provider: vault, account: Vault }
  - { id: main, provider: setup, account: Setup }
policy:
  allow: [memory.*, tasks.*, assets.*, skills.*, vault.*, setup.*]
```

`identity` is deliberately not among them, for the reason ADR-042 gives: a profile that declares
no identity has nothing for the surface to report, and a tool answering "nothing declared" on
every fresh install would spend instructions budget to say so. It arrives with the first
`identity add`.

## Why this does not weaken default deny

Default deny is ADR-003's, and what it is for is stated there: **nothing reaches an account before
its owner says so.** Every provider in this list holds no account. There is no OAuth app, no
credential ref, no vendor, no third party — and nothing to reach until the owner has put something
there themselves. The rule is intact because the thing it protects is not in scope.

Three narrower points, because "granted by default" invites reading more into it than is there:

- **The grant is not new.** `lanes link connect memory` wrote `memory.*` — the whole namespace,
  writes included, since `grant.ts` grants per provider and not per capability. Nothing is now
  expressible that one command did not already express. What changed is that the command was
  ceremony.
- **A vault read is still per item.** `vault.*` grants `put` and `remove`. A `vault.get.<id>`
  capability exists only for an item already in the store, and only after a restart, so a write
  cannot hand itself a read — ADR-012 §3 is untouched, and a fresh vault grants no reads at all
  because it holds nothing.
- **A `deny` still wins, and is now the way off.** Deleting a row no longer works: the next
  command puts it back. That is not new either — it has been true of `setup` since ADR-019 — and
  the three narrowings worth knowing are in the template's own comments:
  `deny: [memory.write]`, `deny: [skills.manage.*]`, `deny: [vault.put, vault.remove]`.

## What was considered and rejected

**Reads only, writes on request.** Grant `memory` read but not `memory.write`, and so on. It
preserves the letter of ADR-012 §2 and defeats the purpose: "remember this" is the request that
brings someone here, and an endpoint that can be asked to remember and cannot is worse than one
that says nothing. The write grant is also precisely what a `deny` line takes back, in one place,
visibly.

**Skills invocable but not authorable by default** — `deny: [skills.manage.*]` in the template.
This is the strongest of the rejected options and the argument for it is real: a skill an agent
writes is instructions an agent is later handed, which ADR-014 §1 treats as a grant worth
governing. It was rejected on parity: `connect skills` already granted authoring, so shipping the
deny would have made the default *narrower* than the command it replaces, and someone reading the
release note would reasonably conclude that authoring had been withdrawn. The narrowing stays one
documented line for anyone who wants it.

**Repair on `connect` and `deploy` only**, as `setup` was. It reaches nobody who is already set
up: those are the two commands you stop running once your accounts are connected. `start` is the
one an existing install runs daily, which makes it the only path by which this decision reaches an
existing workspace at all.

## Consequences

The repair writes config, so it is CLI-side by construction — `ensureOwnerLayer` and its
workspace walker live in `#cli/config-repair.ts`, not in `startEndpoint`, which the container
entrypoint shares. A deployed revision holds `objectViewer` on `profiles/` (ADR-023) and could not
write this even if the code let it. That is ADR-007's line, unmoved.

`doctor` reports a surface whose row or rule is missing, and skips one covered by a `deny` — off
is not missing.

The template and the repair must write a row in one spelling. Two spellings of one row is how a
template and its repair drift apart, and `config-edit.test.ts` asserts that a fresh profile needs
no repair, which is the check that catches it.
