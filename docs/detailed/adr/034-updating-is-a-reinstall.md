# ADR-034: Updating is a reinstall, and only Bun performs it

**Status:** accepted · **Follows from** [ADR-015](015-one-package-under-src.md)

## Context

Publishing to npm made two machines able to run different versions of this CLI at the same time.
`lanes link version` answers which one is here — that is what it was added for. Nothing answered
whether it is the current one, and nothing fetched the current one.

The only upgrade affordance in the tree was a string. A config declaring a `contract` this binary
does not implement is refused with `Upgrade lanes-link.`, which names no command, and until now
there was no command to name.

What an update *is* here is unusually simple, and worth writing down before someone assumes
otherwise. There is no build step: `package.json` ships `src/` directly, `bin/lanes` resolves its
own symlink chain and execs Bun on `src/cli/lanes.ts` inside the installed package, and
`src/cli/version.ts` reads the version out of `package.json` at call time. So the code that runs is
the code the tarball contains. Updating is replacing that directory — there is no artifact to
rebuild, no binary to swap, no migration to run, and the symlink on the `PATH` never moves.

## Decision

**`lanes link update` re-runs the global install.** It compares the installed version against the
registry's `latest`, and on a newer one runs `bun install -g @lanes-sh/link`. `--check` reports and
exits without installing, non-zero when an update is available, so a build can gate on it.

**Bun is the only installer driven.** `bun install -g @lanes-sh/link` is the only install documented,
`engines.bun` requires Bun, and `bin/lanes` refuses to run without it. Inferring a package manager
would be machinery serving a case nothing tells anyone to create.

That leaves one case that does exist, because nothing *prevents* `npm i -g`: Bun installs into its
own global prefix, so updating an npm-installed copy with Bun writes a second copy elsewhere and
leaves `PATH` order to decide which answers. `update` detects that the install root is not under
Bun's prefix and says so before installing, then reads the version back off disk afterwards and
reports when the copy it is running from did not change. Both halves of that are the same fact seen
from either side, and neither is a guess.

**A checkout is refused rather than updated.** `bun link` puts a checkout on the same `PATH` entry a
published install would occupy. Installing from the registry over it would leave two copies of this
CLI with nothing to say which one ran. The discriminator is whether the install root sits under a
`node_modules` directory; in a checkout, `update` says `git pull` is the update and runs nothing.

**The registry is asked for eighteen bytes.** `registry.npmjs.org/-/package/<name>/dist-tags`
answers `{"latest":"0.2.0"}`. The packument at `registry.npmjs.org/<name>` carries every version ever
published with its full manifest, which is hundreds of kilobytes to answer the same question.

**Nothing updates itself, and nothing blocks on asking.** `doctor`, `start`, and `deploy` each print
one line when a newer release is out and nothing at all when the registry cannot be reached, on a
700 ms budget — the same one `endpointHealth` gives its probe. `check` is deliberately excluded: it
promises static validation with no external calls, and that promise is worth more than the notice.

## Consequences

A version check can never fail a command. Every path degrades to `unknown` and prints nothing: an
unparseable version, an unreachable registry, an answer that is not a version. `doctor` on a plane
reports what it always did.

`update` is the one place that knows how *this* copy updates, which is why the shared stale line
sends everyone to it rather than naming a remedy itself. In a published install the remedy is the
command it names; in a checkout that command says `git pull`. One funnel, one answer per install
shape.

A stale install is reported by the three commands most likely to be running when it matters, and by
no others. Nothing polls, nothing caches a check between runs, and no everyday path gains a network
call.

## What this does not do

It does not update a deployed endpoint. That is `lanes link deploy` rolling a revision from an image
tagged with a timestamp, and the revision carries no version stamp at all.

It does not migrate anything. `SUPPORTED_CONTRACT` is unchanged, and the workspace layout has no
migration machinery by design — a config declaring a contract this binary does not implement is
still refused rather than guessed at.

It does not install a chosen version, and there is no rollback flag. Revisions and the registry both
keep every published version; nothing has needed to name one yet.

It does not stop, restart, or detect a running endpoint. `start` is a foreground process with no PID
file, and two workspaces can bind the same port, so an endpoint answering is not evidence that
*this* profile's endpoint answered. After a successful install `update` states the fact instead — a
running endpoint serves the old code until it is restarted — which is true without asking anything.
