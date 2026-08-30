# ADR-041: memory and skills may live in a repository, and nothing else may

**Status:** accepted · **Settles a cost [ADR-030](030-a-profile-owns-its-skills-and-manifests.md)
recorded and declined to pay** · **Narrows, and does not reopen,
[ADR-013](013-one-cloud-host.md)'s "one target, one storage adapter"**

## Context

A target names an adapter set: where credentials are kept, and where bytes go. Everything a
profile holds rides the second of those — runtime state, the audit log, cached attachments,
memory entries, and skills — and until now the operator's only choice was which backend all of
them shared.

Four of those are artefacts of one installation. State can be deleted and rebuilt by reconcile
([ADR-021](021-no-database.md) says so in the file itself), the log is append-only machine
output, and both the credential store and the vault hold material whose entire value is that it
is not published.

Two of them are not artefacts at all. A memory entry is a Markdown file the owner wrote. A skill
is a procedure the owner wrote. They are documents, and documents want the things documents want:
history, diffs, review, and to be readable from more than one machine.

ADR-030 already noticed this and wrote it down as a cost it was accepting:

> **`data/` is gitignored, and skills were not.** An operator keeping procedures in version
> control loses that. Not repaired by un-ignoring a path here: this repository is public and
> doubles as a workspace during development, so a negation would invite committing a real one.
> The trade is recorded in `configuration.md` rather than worked around.

That reasoning holds — the fix is not a `.gitignore` negation in *this* repository. It says
nothing against a repository of the owner's own.

## Decision

**A target may declare a `knowledge:` block. It moves memory and skills into a GitHub repository,
over the API, and it can move nothing else.**

```yaml
targets:
  local:
    credentials: { adapter: file }
    storage:     { adapter: filesystem }
    knowledge:
      adapter: github
      repo: my-org/my-notes
      token_ref: knowledge/token
```

`lanes link knowledge use github --repo <owner/name> --migrate` writes that block, into every
target the profile declares, and moves what is already stored. `lanes link knowledge use local
--migrate` is the same thing backwards.

### 1. The credential store and the vault are excluded structurally

There is no field in `knowledgeTargetSchema` that could name either, and there is no flag that
adds one. This is deliberately not a default that could be overridden: a repository is a place to
publish, and `https://lanes.sh/docs/link/security` rests on those two documents not being published. A
schema with no such field cannot be talked into it by an operator following an example.

The audit log stays too, for a smaller but real reason: it is append-only and hash-chained
(ADR-020), and a repository is a thing whose history can be rewritten.

### 2. The API, not a clone

A clone would be faster, would work offline, and is the obvious answer. It fails on the property
that made skills go through `BlobStore` in the first place.

**A container filesystem is discarded on every revision.** ADR-014 §2 fixed exactly this for the
vault — a deployed instance wrote its vault to a container filesystem and every item in it was
thrown away by the next revision with no error to say so — and a clone re-introduces it for
memory. A deployed endpoint would either re-clone on every cold start or serve nothing.

It also needs a `git` binary, which the image does not carry, and it turns two writers on one
branch into a merge conflict rather than a `409` and a retry.

What the API buys beyond that is worth naming: an entry edited on github.com, or written by a
deployed endpoint, is visible to the local CLI on its next read, with nothing to pull.

### 3. The redirection happens on the store, not in the providers

Memory is not addressed by a name anything declares. `buildProviderContext` scopes the profile's
blob root to `memory/<connection>`, and `lanes link memory` reaches the same bytes by calling the
same two functions — which is what `commands/owner/memory.ts` exists to guarantee.

So "put memory somewhere else" is not a question the provider, the dispatcher, or the CLI can be
asked. `routeBlobStore` answers it once, on the root all three were handed: keys under `memory/`
go to the repository, everything else falls through. **No provider, no capability, and no CLI
command knows this feature exists**, and none of them can disagree about where an entry went.

### 4. The token is its own credential

`knowledge/token`, and deliberately not the token a `lanes link connect github` connection holds.
That one talks to GitHub's MCP server and needs Contents **read**; this one writes and needs
Contents **write**. Two permissions, two lifetimes, two things to revoke separately — and
revoking an MCP connection must not quietly empty somebody's memory.

### 5. A public repository is refused, not warned about

`lanes link knowledge use github` reads the repository's visibility before it writes anything and
refuses a public one unless `--allow-public` says otherwise. A warning printed during a migration
is a warning read after the migration, and what is on the other side of it is every note the
owner has written plus every procedure naming their accounts and their colleagues — permanently,
and searchably.

### 6. Nothing is deleted until the destination has been read back

The migration is read, commit, **verify**, then delete. `commitFiles` reports what GitHub
answered; what this needs to know is what GitHub *stored*, which is a different question the
moment a tree is built against a base that moved. One extra request buys the right to remove the
only other copy. The config block is written last of all, so every failure above it leaves a
profile that still works.

### 7. An unreachable repository must not brick the profile

This one was found by writing the tests and is the least obvious. A knowledge store is a network
dependency whose failures are ordinary — an expired token, a spent rate limit, no connectivity.
The initial skills read happens inside `openRuntime`, so one of those took down **every** command
for that profile, including `lanes link doctor` and `lanes link knowledge use local`: the two
that diagnose the problem and undo it. A token expiring would have bricked the profile and hidden
the fix.

So a *remote* skills store that cannot be read comes back empty with a warning, the same trade
`Generation.refreshSkills` already made for the poll. A local directory that will not read still
fails, and a malformed skill still throws in either mode — that is a document the owner wrote and
wants to hear about.

## What this costs, stated plainly

- **Nothing works offline.** `lanes link memory list` on a plane fails. There is no local cache,
  and adding one would mean a second source of truth that can disagree with the repository.
- **`memory.search` is slower.** It reads every entry by design. The first search after a change
  is one tree request plus one blob read per changed entry, at concurrency 16; after that they are
  served from a cache keyed by content sha, which needs no expiry because a sha does not mean two
  things.
- **GitHub's rate limit is now one of this endpoint's own failure modes.** 5,000 requests an hour
  for a fine-grained token. The branch is polled with an `ETag` and GitHub answers `304`, which
  does not count against the limit, so an idle endpoint costs nothing — but a script writing
  memory in a loop will find the ceiling, and the error says so rather than blaming the token.
- **Every write is a commit**, so the repository's history is a record of what the owner and their
  agents stored, with timestamps. That is the feature, and it is also the disclosure: deleting an
  entry does not remove it from history.
- **`lanes link profile remove` no longer removes everything the profile could reach.** It plans
  against the target's declared storage, not the routed root, so it cannot delete a repository —
  which is the right answer and a surprising one, because `rm -r data/<profile>` used to be the
  whole of that question. The removal plan says so before the operator confirms.
- **A content type that the file extension cannot express is not preserved.** The other adapters
  store one; there is nowhere to put it here that is not a file in the owner's repository, listed
  beside their entries. The shared extension map covers every type anything writes.
- **`modifiedAt` is the branch tip's date**, the same for every entry in one listing. Per-file
  timestamps would be one request each. Nothing needs them: the skill fingerprint only needs it to
  change when the tree does, and memory uses it as a fallback for a hand-written file with no
  `updated_at` in its frontmatter.

## What is unchanged

- **The vault, the credential store, runtime state and the audit log** all stay on the target's
  own storage, and cannot be moved by this.
- **A profile that declares no `knowledge:` block behaves exactly as before** — the field is
  optional and absent, so every existing file loads unchanged.
- **`#stores/blobs/conformance.ts` still holds every adapter to one contract.** The GitHub store
  passes the same suite the filesystem, S3, and in-memory stores do, twice: bare, and under a path
  prefix. A key one target refuses is still not one another accepts.
