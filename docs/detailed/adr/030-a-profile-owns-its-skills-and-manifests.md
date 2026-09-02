# ADR-030: a profile owns its skills and its manifests

**Status:** accepted; its isolation restored by [ADR-066](066-a-profile-owns-its-data-again.md), its manifests still the workspace's (ADR-057) · **Supersedes [ADR-012](012-owner-layer-primitives.md) §1's storage
location and part of [ADR-014](014-owner-layer-is-managed.md) §2** · **Restores
[ADR-009](009-one-endpoint-per-workspace.md)'s "profiles share nothing"**

## Context

ADR-009 says what a profile is, in one line under *What survives*:

> **Profiles still share no database and no credential store.** What one holds is invisible to
> another; a note written through `personal` is simply absent in `work`.

Two things were outside that. Skills lived at `<workspace>/skills/`, placed there by ADR-012 §1
and kept there by ADR-014 §2 when the other two owner stores moved into the profile. Custom
provider manifests lived at `<workspace>/providers/`, placed there by ADR-008 before profiles
had a data directory to hold anything.

`profile/layout.ts` defended the first in a comment:

> Skills stay workspace-wide rather than per-profile, which is how they have always loaded:
> every profile sees every skill, and policy still gates `skills.<name>` per profile. A
> procedure is not private to a profile the way its knowledge is.

## The argument, and why it does not hold

**"Policy still gates it" is a smaller claim than it sounds.** Policy decides who may *invoke*
`skills.<name>`. It never decided who could see that the skill existed, and — since ADR-014 gave
`skills.manage.get` a real read path — it is the only thing standing between a granted agent in
one profile and the full text of a procedure written in another. The isolation was one policy
line deep in a system whose other four owner stores are isolated by not sharing bytes at all.

**"A procedure is not private the way its knowledge is" describes a skill that does not exist.**
A useful procedure names things: which mailbox to file into, which people to copy, which of the
owner's conventions apply. A work incident-review skill is a description of how a particular
employer runs incidents. The distinction between a procedure and the knowledge it operates on is
not one the file format makes and not one an owner would recognise.

**ADR-014 §1 already conceded the shape of this.** It made authoring a skill a grant worth
governing, on the reasoning that a skill *is* instructions an agent will later be handed. That
argument does not stop at the write. Something worth a separate capability to write is not
something to hand every profile by default on read.

**A manifest is infrastructure.** It names a host, an OpenAPI document, and the credential refs
that reach them. Two profiles exist precisely when those differ.

## Decision

**`data/<profile>/skills.d/` and `data/<profile>/providers.d/`.** One profile, one directory,
with no exceptions left in it — `rm -r data/work` remains the whole answer to "remove the work
profile's data", and now it is also the whole answer to "what could work reach".

Both names carry a dot, which `profile/layout.ts` requires of every reserved name under the blob
root: a provider is namespaced `<provider>/<connection>` there and a provider id is
`[a-z][a-z0-9_]*`, so a dotted name is one no provider can be scoped onto. For skills this is not
hypothetical. `skills` is a real provider id, so `data/<profile>/skills/` is exactly the prefix
its own connection blobs would occupy.

Nothing changes about how either is read. The skills store was already handed a `BlobStore` and
never knew where it was rooted; the manifest loader gained a profile and a path from `layout`.

## What this costs, stated plainly

**A deploy now reaches into `data/`, which it has never done.** `isWorkspaceConfig` sent the
whole of `skills/` and `providers/` and none of `data/` — and that exclusion is what keeps the
encrypted credential store and its key file out of a bucket. Skills that do not go up are the
regression ADR-014 §2 fixed, so the allowlist now names two directories inside the tree it
otherwise refuses. It matches them by whole path segment: `data/personal/skills.detour/` is not
`skills.d`, and the thing on the other side of that boundary is a decryptable credential
document. `deployments/deploy.test.ts` holds both halves.

**The IAM write grant needed an exclusion, where it had only unions.** `objectsUnder('data/')`
now includes a profile's manifests, and ADR-007 says a deployed instance never mutates its own
configuration. So the condition is `objectsUnder('data/') && !<manifests>`, anchored to the
profile segment rather than matched loosely, and the manifests move to the read binding.
`deployments/grants.test.ts` evaluates the shipped expression rather than scanning it for
prefixes, because an exclusion is the clause a substring scan reads straight past.

**`data/` is gitignored, and skills were not.** An operator keeping procedures in version control
loses that. Not repaired by un-ignoring a path here: this repository is public and doubles as a
workspace during development, so a negation would invite committing a real one. The trade is
recorded in `configuration.md` rather than worked around.

**There is no migration.** A skill or manifest left at the old workspace-root path loads for
nobody — not silently for everybody, which is the failure worth ruling out, and
`cli/runtime/scoping.test.ts` pins it. This follows `layout.ts`'s existing position on the
`data/` reshuffle that preceded it: machinery to move an old layout is more code than the thing
it moves and has to keep working forever. Moving them is one `mv` per profile that should see
them, and the profile that should see them is a question only the owner can answer — copying to
all of them would be a guess that then diverges.

## What is unchanged

- **Authoring is still not in the default bundle** (ADR-014 §1), and reading a skill's body is
  still in the author bundle rather than the read one (ADR-012 §1's surviving half).
- **`skills.<name>` still merges across profiles** on the MCP surface, the way every other
  capability does (ADR-009). Two profiles with a `triage` skill are one prompt whose `profile`
  enum lists both, dispatching to whichever store the caller named.
- **A manifest still cannot shadow a built-in**, and `skills`, `memory` and `vault` are still
  reserved provider ids.
