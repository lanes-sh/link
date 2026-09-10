# ADR-077: The workspace lives under the Lanes home

**Status:** accepted · **Amends** [ADR-052](052-a-target-owns-its-workspace.md) and
[ADR-037](037-a-command-names-what-it-acts-on.md) on the last step of the root-resolution chain
only — `LANES_LINK_HOME` and the ancestor walk are unchanged

## Context

`~/.lanes` is where Lanes keeps things on a machine, and it predates this CLI. The desktop app owns
`auth.json`, `settings.json`, `database.db` and `integrations.json` there, and `#auth/lanes/session.ts`
put the signed-in session beside them for the reason its docstring gives: it is not workspace state,
and it must not be uploaded to a bucket on the next deploy.

The workspace was the one thing outside it, at `~/.lanes-link`. Nothing chose that. It is what a
single-word product name produces when the directory is created before there is a second thing to sit
beside — and the cost is that one product has two conventions, so a reader has two directories to know
about and neither name says the other exists.

There is a second cost, and it is the expensive one.

**Running this CLI out of a checkout reached the operator's real workspace.** The chain was
`LANES_LINK_HOME`, then an ancestor holding a registry, then `~/.lanes-link`. A worktree has neither of
the first two, so a verification command run from one resolved to live profiles, credentials, state and
an audit log — and `deploy` and `sync targets` both *write* there, one uploading config to a bucket and
the other merging a remote copy into somebody's profiles.

The remedy was a house rule: export `LANES_LINK_HOME` before running anything from a worktree. It has a
section in `CLAUDE.md` and three test files carry docstrings explaining that they pin the variable
because otherwise the suite reads real credentials. A rule that works exactly as often as it is
remembered, defended by prose, in a repository where the thing being protected is an encrypted
credential store.

## Decision

**The workspace root is `~/.lanes/link`, and a checkout gets `~/.lanes-dev/link`.**

The dev split moves the whole Lanes home rather than just the workspace, so a `lanes auth login` while
testing a branch cannot sign the operator out of the install they actually use. `~/.lanes-dev/credentials.json`
is the session in dev; `~/.lanes/credentials.json` is the session otherwise.

**Dev mode is detected, not configured.** The signal is `tsconfig.json` at the install root, which is in
neither `package.json`'s `files` array nor the Dockerfile's `COPY` — so it exists in a checkout and
nowhere else. `LANES_LINK_DEV=0|1` overrides in both directions.

The obvious alternative — is the install root under `node_modules`, which is what `updatePlan` asks —
was rejected on one case. `bun link` symlinks the *directory* `node_modules/@lanes-sh/link` at a
checkout, and `bin/lanes` resolves its own path logically rather than with `-P`, so a bun-linked
checkout has an install root containing `node_modules`. Deciding where somebody's credentials live on a
resolver detail is not a trade worth making; a file that is either in the tarball or not is. `.git` was
the other candidate and is rejected for the reason `updatePlan` already gives against it: a tarball
could carry one and a shallow export could lack it.

**`~/.lanes-link` is recognised, never written.** The same rule `LEGACY_WORKSPACE_FILE` follows, for
the same reason: a root that cannot be found cannot be migrated, and a workspace that stops resolving
the moment its owner upgrades is a wall with no door. `resolveWorkspaceRoot` returns it when a
workspace is there and this is not a checkout.

**The move runs from `update` and from `doctor --fix`, and from nowhere else.** The alternative — the
first command to notice the old root moves it — relocates the directory holding somebody's credentials,
audit log and every profile they have. A `status` that quietly did that is one they cannot audit
afterwards, and nothing is lost by waiting, because the old root goes on resolving until it moves.

## What the resolution chain is now

```
1. LANES_LINK_HOME              explicit; a path or a gs:// bucket (ADR-023)
2. ancestor workspaces.yaml     or lanes-link.yaml — a per-repository workspace
3. ~/.lanes/link                when a workspace is there
4. ~/.lanes-link                when one is there instead, and this is not a checkout
5. ~/.lanes/link                otherwise, so a fresh install creates it
```

Steps 3 and 4 test for a **marker file**, never for the directory. That is not pedantry: `~/.lanes`
belongs to the desktop app, so `~/.lanes/link` can come into existence without a workspace in it, and
an interrupted move leaves exactly that. A directory test would prefer the empty new root, report "no
profiles here", and strand the intact old one from the command that migrates it — with the migration
itself then refusing, because two roots exist. The failure would be permanent and the repair path would
be the one that was blocked.

## What the migration refuses

Everything is checked before the first byte moves, which is `migrateWorkspace`'s rule and matters more
here than usual: the thing being moved is the only remaining description of where somebody's accounts
live.

- **A checkout**, because applying it from one would move the real workspace into a scratch home — the
  accident dev mode exists to prevent, reached from the other side.
- **`LANES_LINK_HOME` set**, because an explicit root is a decision and in a container it is a bucket.
- **Both roots holding different things**, because merging two workspaces is not reversible. Both are
  reported and neither is touched. Where the new root already holds everything the old one does, that
  is not two workspaces — it is an interrupted copy, and the rerun finishes it.
- **A live endpoint**, by the pid check `readEndpointRecord` already does. A running `start` holds the
  old path, and moving out from under it leaves a process serving a directory nobody can find.
- **A target naming an absolute path inside the old root.** This is the one that would have been
  silent. `credentials.path`, `storage.path` and `vault.path` are optional, and `workspacePath` honours
  an absolute path verbatim — so a relative one travels with the directory while an absolute one goes
  on naming a location the migration has just emptied. For `credentials.path` that is the encrypted
  credential store.

`rename` does the move where both paths are on one volume, which under `$HOME` they nearly always are:
atomic, no window in which a reader sees half a workspace, nothing left to delete. On `EXDEV` it is
copy, read back, delete, in that order — the order that survives interruption, because a crash after
the copy leaves both and the rerun finishes, where a crash after a delete leaves neither.

Not a key-by-key drain through `workspaceFiles()`, which is the other obvious way and is wrong four
times over: the filesystem blob store's `list` skips `.meta` sidecars, so content types are silently
dropped; it returns files only, so empty directories do not survive; `entry.isDirectory()` is false for
a symlinked directory; and a drain has an observable half-state where `rename` has none.

## Consequences

**A new component.** `#home` answers where Lanes keeps things, and it imports nothing. `#profile`
resolves the workspace root and `#auth` resolves the session path, and `auth` may not import `profile`
— so the alternative to a leaf both may reach is the same directory spelled in two files, which is the
failure `layout.ts` records for a filename and would be worse for a credential store. `installRoot`
moved there too: it is a fact about the install, and dev mode is the question that needs it.

**The house rule retires.** "Never run `lanes link` from a worktree without `LANES_LINK_HOME`" existed
only because the fallback reached real credentials. It cannot now.

**And the one it costs.** Proving a fix against a real deployment deliberately ran the CLI from a
worktree with `LANES_LINK_HOME` unset, because the point was to reach a real target. That now resolves
to `~/.lanes-dev/link`, so the step has to say what it means — `LANES_LINK_DEV=0`, or an explicit
`LANES_LINK_HOME`. This is the safer default making the dangerous thing explicit rather than the other
way round, which is the trade the whole decision is.

**Two sessions in dev.** A contributor testing a branch signs in once more, because `start` requires a
session for a local endpoint (ADR-060). That is the price of a dev run being unable to sign the
operator out of their real one, and it was taken knowingly.

**A cross-repository contract.** ADR-065 records that the desktop app runs this CLI from the home
directory and relies on the walk landing on `~/.lanes-link`. It lands on `~/.lanes/link` now, which is
correct once migrated and is a change the app repository has to be told about; nothing on this side can
assert it.
