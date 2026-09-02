# ADR-059: The owner layer is instances, and two profiles may share one

**Status:** accepted, storage half reversed by [ADR-066](066-a-profile-owns-its-data-again.md) · **Amends** [ADR-009](009-one-endpoint-per-workspace.md)'s "profiles share
nothing", [ADR-014](014-owner-layer-is-managed.md), [ADR-030](030-a-profile-owns-its-skills-and-manifests.md),
[ADR-050](050-the-owner-layer-is-granted-by-default.md) · **Follows from**
[ADR-057](057-a-connection-belongs-to-the-workspace.md)

## Context

Memory, tasks, assets, skills, vault and entities are providers with no vendor, no credential and
no account. What they have is bytes, and ADR-030 put those bytes inside the profile —
`data/<profile>/memory/main/<id>.md` — which is what made ADR-009's "profiles share no database"
true without exceptions.

ADR-057 moves every *account* up to the workspace. That leaves the owner layer as the only thing
still declared inside a profile, and it cannot stay there: a profile is now a selection of
connections, and `memory` is reached exactly the way `gmail` is — a `connection` argument, a
capability, a policy decision. A surface that is a connection at the MCP boundary and not one in
the config is two models for one thing.

There is a second reason, and it is the one an owner feels. A note taken while doing work is
useful when reading personal mail — "the flight is booked on the other card" does not belong to a
profile. Under ADR-030 the only way to have it in both places is to write it twice, and the two
copies then diverge. The isolation was chosen deliberately and it is right for a *work* note in a
*personal* profile; it is wrong for the large middle where the same person is the same person.

## Decision

**An owner-layer surface is a connection like any other, and there may be more than one.**

```yaml
# connections.yaml
- { id: main, provider: memory,   account: Memory }
- { id: acme, provider: memory,   account: Memory (Acme) }
- { id: main, provider: entities, account: Entities }
- { id: main, provider: vault,    account: Vault }
```

```yaml
# profiles/personal.yaml            # profiles/work.yaml
grants:                             grants:
  - { connection: memory.main,        - { connection: memory.acme,
      allow: [memory.*] }                 allow: [memory.*] }
```

Bytes follow the connection rather than the profile:

```
data/
├── memory/main/<id>.md      shared by every profile granting memory.main
├── memory/acme/<id>.md
├── vault/<id>.enc           one sealed document per vault connection
├── skills.d/<id>/<name>/    one directory per skills connection
└── providers.d/             the operator's own manifests (ADR-057)
```

**Sharing is a choice the owner makes, and separation is still available.** Two profiles granting
`memory.main` genuinely share it — one note, one place, visible from both. Two profiles granting
different instances share nothing at all, which is ADR-030's isolation, obtained by naming rather
than by structure.

**`identity` stays out of this.** It is not a store; it is a block in the profile YAML, edited in
the CLI, read through one capability (ADR-042). A profile declares who *it* is written as, and two
profiles exist precisely because that answer differs. Nothing about it becomes an instance.

**The default is unchanged in effect.** A new workspace gets one instance of each of the six, and
a new profile is created granting all of them, exactly as ADR-050 arranged — `ensureOwnerLayer`
moves from repairing a profile to repairing a workspace and a profile together. Someone who wants
two memories creates the second deliberately; nobody is asked to think about it to get started.

## Two of them may only be granted once per profile

`skills` and `vault` are instances like the rest, and a workspace may hold as
many as anyone makes. A **profile** may grant one of each, refused at load if it
grants two.

That is not a limitation of the store. It comes from the surface, and from the
protocol rather than from a choice made here. Every other owner-layer tool takes
a `connection` argument, so two memory instances are two routes through one tool
and the caller names which. These two have nowhere to put that:

- **A skill is surfaced as a prompt** (ADR-012), and a prompt is selected by name
  with no arguments to route on. Two `triage` skills in one profile would be one
  name for two procedures.
- **A vault item becomes its own `vault.get.<id>` capability**, and capability
  ids are flat for the same reason. Two instances holding `stripe_key` would be
  one capability naming two secrets — the worst of the three collisions, because
  the wrong answer is a credential.

Refusing at load names both rows. Resolving at call time would let one win
silently, which for the vault is indistinguishable from working.

Someone who wants two sets of procedures has two profiles, and that is now cheap:
neither of them re-authorises an account to get there.

## What this costs, stated plainly

**ADR-009's invariant is now a default rather than a guarantee.** "A note written through
`personal` is simply absent in `work`" is true only while the two name different instances, and
the shipped default names the same one. Anyone reading that sentence should read this decision
next, which is why ADR-009 is amended rather than left to age.

**A shared skill is a shared instruction.** ADR-014 §1 treats authoring a skill as a grant worth
governing, because a skill is instructions an agent will later be handed. Two profiles on one
`skills` instance means an agent writing under one authors a procedure the other is offered. That
is the intended behaviour and it is the sharpest edge here; the narrowing is one documented line,
`deny: [skills.manage.*]` on the row, and the template says so where it already says the other
two.

**`rm -r data/<profile>` is gone as a concept.** ADR-030's "one profile, one directory" was worth
having and does not survive: a profile owns no bytes at all now. What replaces it is
`lanes link disconnect memory.acme`, which removes an instance and every profile's grant on it,
and reports which profiles it emptied.

**Migrating two profiles that both hold `memory.main` cannot merge them.** Interleaving two sets
of notes is not reversible and not reviewable. The second becomes `memory.<profile>` and the
rename is reported, which leaves the owner with two instances and one `lanes link` command if they
did want them joined.

## Why this is not a reversal of ADR-030

ADR-030's argument is that a procedure "names things: which mailbox to file into, which people to
copy, which of the owner's conventions apply", so it is exactly as private as the knowledge it
operates on. That is still true, and this decision does not contradict it — it changes what
expresses it. Under ADR-030 privacy came from the file path, and the owner had no say. Here it
comes from which instance a profile is granted, and the owner has exactly the say the argument
implies they should.

The half of ADR-030 that does not survive is the reasoning about *manifests*, and that is handled
in ADR-057 rather than here.

## What this does not do

It does not give an agent any way to create an instance — that is `lanes link connect memory
--id acme` in a terminal, and ADR-007's wall is unmoved. It does not change what any capability
does or what `vault.get.<id>` means. It does not merge the vault into the credential store, which
remains the one collapse this project will not make (ADR-022). And it does not make the number of
instances visible to a caller: `setup_overview` reports the connections a profile can reach, as it
always has, and a `memory` instance the profile was not granted is absent rather than listed as
denied.
