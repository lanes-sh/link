# ADR-015: one package under `src/`, and the test that replaces the package graph

**Status:** accepted · **Supersedes** the repository-structure section of
[`init.md`](../init.md), which described `apps/`, `packages/`, and `providers/` as three roots.

## Decision

**One package.** No workspaces, no `apps/`, no `packages/`. Thirteen components under `src/`,
each named for the question it answers, with cross-component imports through the package.json
`imports` map — `#policy`, `#stores/state`, `#providers/google/gmail`.

**A provider owns all of its vendor knowledge**, in one folder: the manifest, the scopes it
requests, what it redacts, the setup walkthrough, and any vendored specification.

**`src/architecture.test.ts` asserts what the layout means** — dependency direction, no vendor
name in the code a request passes through, and a file-size budget.

## Why the workspaces went

They were doing one useful job — enforcing dependency direction — and three unhelpful ones.

The unhelpful ones: the folder layout was dictated by npm mechanics rather than by what the code
is, so `apps/server` and `packages/mcp` were one component split in two because one of them
happened to be an entry point. `packages/core` accumulated five unrelated things because a
component with no name is where things go when nowhere else fits. And every worktree needed its
own `bun install` because the workspace symlinks are repo-relative, which is a per-branch tax on
a repository whose contributing guide asks for a worktree per change.

None of the thirteen packages was published. All were `private: true` with `workspace:*`
dependencies on each other, which is a build-tool arrangement standing in for a design.

## What replaced the useful job

An architecture test, and it is stricter than what it replaced. `dependencies` could only say
"this package may reach that package"; the test says which *file* may reach which component, and
it can also say things a package graph cannot express at all — that no vendor name appears in the
transports, and that a file over four hundred lines is a prompt to look for the seam in it.

The cost is honest and worth stating: a resolution error is unmissable and a failing test can be
deleted. The mitigation is that the test explains each rule where it is written, and that the
concessions are a named list rather than a relaxed threshold — a file on the known-long list is
visible debt, where a limit raised to 500 would be invisible.

## Why vendor knowledge moved

[ADR-008](008-connectors.md) already said it: **protocol code, not vendor code**. The rule held
for the connectors and quietly failed everywhere else. Twelve providers shared one 619-line file;
what each Google scope permits was a table in the CLI, which is where it is *displayed*; the
script that vendors Google's OpenAPI specs was in `scripts/`, three directories from the specs it
writes.

Worse, three facts about Apple were compiled into transports that also serve Fastmail, Dropbox,
and Syncthing: a 90-day CalDAV window named for iCloud's limit, `.icloud` placeholder files, and
an app-specific-password explanation printed on any authentication failure. Each is now a declared
field — `dav.max_range_days`, `fs.placeholder`, `setup.troubleshooting` — set by the provider that
knows it. The transport knows *that* something happened; the provider knows *why* and what to say.

## Why the vault and the credential store merged, and how far

They had two implementations of one encrypted-document format: the same AES-256-GCM envelope, the
same write-then-rename, the same key resolution, the same decrypt refusal, differing in a magic
string. Two implementations of a format is two chances to get a format wrong.

They now share `src/secrets/document.ts` and the adapters, and they share **nothing else** —
separate documents, separate keys, separate environment variables. That boundary is
[`security.md`](https://lanes.sh/docs/link/security)'s central claim: system credentials authorise Lanes Link itself and
are unreachable from MCP, while a vault item belongs to the owner and an agent may be granted one
under policy. Sharing the code that seals a document is the opposite of sharing the key that opens
it.

Forcing one *interface* over both was considered and rejected. A system credential is a ref and a
string; a vault item carries a description and belongs to a connection, because each becomes its
own `vault.get.<id>` capability ([ADR-012](012-owner-layer-primitives.md) §3). Unifying them would
have meant a new on-disk format and a migration, to make two genuinely different things look alike.

## Why deployments became folders

Adding a target used to mean editing three `switch` statements two hundred lines apart inside the
CLI's runtime assembly — and it meant the CLI, whose job is a terminal, knew what Cloud Run was.
`src/deployments/target.ts` is the single mapping now, and each deployment folder carries only what
is genuinely its vendor's.

Adapters stay protocol-named per [ADR-013](013-one-cloud-host.md). That is why `azure/` is a README
rather than a stub: two of the three backends it would need already exist, and saying which one
does not is more useful than an empty folder.

## What this does not change

Nothing about the dispatch path, the policy model, discovery filtering, or the audit guarantee.
Every behavioural change is listed in the commits that made it, and the list is short: `header`
auth resolution restored to what it always did, owner connections defaulting to `main`, memory
losing a redundant key prefix, `.meta` sidecars no longer written for inferable types, and three
iCloud constants becoming declared fields.

## The on-disk workspace

The same reasoning applied outward. `data/` interleaved every profile's files in one flat listing,
and a memory entry sat at `data/personal/files/memory/memory/entry/<id>.md` — five levels, a
repeated name, and a sidecar recording a content type the extension already carried.

One directory per profile now, and the blob root is that directory: `data/personal/memory/main/<id>.md`.
`lanes link migrate` moves an existing workspace and rewrites the paths its profile YAML had written down.
It deliberately does not rename an existing connection — `memory.memory` keeps its id, because that
id appears in the database and in audit history, and `main` is the default for the next connection
rather than a rewrite of the last one.
