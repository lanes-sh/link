# Working in this repository

[`CONTRIBUTING.md`](CONTRIBUTING.md) is the substance — the two commands that must pass, the
list of things that will be pushed back on, and why commit messages carry the reasoning. Read
it. This file covers only what an agent gets wrong that a human reading that file would not.

## Work on a branch, in a worktree

Implementation goes on a new branch in its own worktree. Never on `main` — it is the checkout
the operator has open, and unreviewed work landing there mixes into the files they are reading.

```console
$ git worktree add .worktrees/<name> -b <name>
$ cd .worktrees/<name>
$ bun install
$ bun test          # establish the baseline before changing anything
```

`.worktrees/` is already in `.gitignore`. The `bun install` is not optional: a fresh worktree
has no `node_modules`. Getting a green baseline first is what makes a later failure
attributable.

Work lands by pull request into `develop`, squashed — `gh pr merge <n> --squash --delete-branch`.
Both `develop` and `main` require a passing `ci` and an approval, so a solo merge adds `--admin`.
The one pull request that is not squashed is the release; see below.

## Never run `lanes link` from a worktree without `LANES_LINK_HOME`

`resolveWorkspaceRoot` (`src/profile/workspace.ts`) checks `LANES_LINK_HOME`, then
walks ancestors for `lanes-link.yaml`, then falls back to `~/.lanes-link`. A worktree has neither
of the first two — so a verification command run from one writes into the operator's real
workspace, which holds their live profiles, credentials, state, and audit log. Worse than reading
it: `lanes link deploy` and `lanes link sync targets` both *write* there — one uploads config to a
bucket and records the deployment, the other merges a remote copy into their profiles.

```console
$ export LANES_LINK_HOME=/tmp/lanes-link-scratch
$ lanes link start --port 7401     # the usual port is already serving the real endpoint
```

Nothing in the output distinguishes the scratch workspace from the real one except the path it
prints, so check it. A `/health` response naming a profile you did not create means you are
talking to their server.

## Anything touching a real account is the operator's call

`lanes link connect` opens a browser, grants scopes against a real Google or iCloud account, and
writes credentials. Running it changes something outside the repository that a `git checkout`
cannot undo. Get to a green `bun test` unattended, then stop and ask.

## A release publishes, and npm does not give a version back

[The development lifecycle](https://lanes.sh/docs/link/releasing) is the lifecycle end to end — the two
paths `release.yml` takes, and the verification that a release shipped. What an agent gets wrong:

- **Set the version on `develop`, before the pull request to `main`.** A merge whose version is
  already tagged runs the *propose* path, which puts the bump on a side branch that merges into
  `main` only — `develop` is then behind by a version commit. Untagged publishes directly, and both
  branches end up on the same tree. This is the whole reason a minor is not just a merge.
- **The merge to `main` is the irreversible step.** It publishes to npm under this repository's
  OIDC identity. Get the branch green and the pull request open unattended; do not merge a release
  the operator has not asked for.
- **Squash every pull request except the release one.** `gh pr merge <n> --squash
  --delete-branch` for work landing in `develop`. The `develop` → `main` release pull request is
  the exception and must be `--merge`: a squash writes a new commit onto `main`, `develop`'s tip
  stops being an ancestor, and the fast-forward below is then rejected as non-fast-forward even
  though the trees are identical. Rebase-merging is disabled for the same reason.
- **A release is finished when `develop` and `main` are 0/0, not when npm has the version.**
  Fast-forward with `git push origin origin/main:refs/heads/develop`, then check
  `git rev-list --count` in *both* directions. Nothing in the workflow does it for you.
- **Never tag or `npm publish` by hand.** The workflow owns both, in that order, for a reason a
  manual run reverses.

## Never write a real address, project, or bucket into this repository

This repository is public. The shortest path to a passing test or a convincing doc example is
to paste the account you are actually working with, and that account is the operator's — a
live mailbox, a real Google Cloud project, a storage bucket in a global namespace. It reads as
harmless while you are writing it and it is indexed forever once pushed.

It has already happened once: forty-five occurrences across thirteen files had to be scrubbed
before the first public push, and because they were also in the commit history, the fix was to
discard eighty-nine commits.

Use a domain nobody can register — `example.com`, `example.org`, `example.net`, or anything
under `.test`, `.example`, `.invalid`. For a project, bucket, or service account in a doc
example, use a name that reads as a placeholder: `my-project`, `your-bucket`, `<project-id>`.
Prose about a domain is fine (`a personal @gmail.com cannot enrol`) — it is an address *at* one
that is not.

`src/architecture.test.ts` fails the build on both. It reads every `.ts`, `.md`, `.json`, and
`.yaml` file in the repository, so there is nowhere to put one where the check does not look.

## Where things are

One package, one `src/`, thirteen components. Cross-component imports go through the
package.json `imports` map: `#policy`, `#stores/state`, `#providers/google/gmail`. There
are no workspace packages and no `apps/` or `packages/` — see the layout table in
[Architecture](https://lanes.sh/docs/link/architecture).

A command whose subject is the *endpoint* — `status`, `deploy`, `sync targets` — names a
`--target` and acts on every profile declaring it; `--profile` narrows that set rather than
selecting it (ADR-043). Everything acting on one account still names both. The table in
`src/cli/selection.ts` is the whole rule, and `selection.test.ts` reads the dispatch files to
check a new command cannot be added without appearing in it.

## The owner layer is seven ids, and `tasks` is not Google's

`RESERVED_PROVIDER_IDS` is `memory`, `tasks`, `assets`, `skills`, `vault`, `setup`, `identity`. Two
things an agent gets wrong here:

- **`tasks` is the built-in task list; Google Tasks is `google_tasks`.** The rename was forced —
  `buildRegistry` registers the owner layer before `PROVIDERS`, so a manifest holding a reserved id
  throws rather than being shadowed (ADR-051). Its redaction keys carry Google's whole operationId
  (`tasks.tasks.patch`) because `shortenName` strips the *provider id* and the API namespaces under
  its own name. A key that misses does not error; it withholds every argument and reads exactly like
  working redaction.
- **A profile arrives with all of them granted except `identity`** (ADR-050). So there is no
  `lanes link connect memory` step to suggest, and a surface that is missing was denied on purpose.
  `ensureOwnerLayer` in `src/cli/config-repair.ts` repairs an older profile from `start`, `connect`
  and `deploy`; the template in `config-edit.ts` and that repair must write a row in **one**
  spelling, which `config-edit.test.ts` checks by asserting a fresh profile needs no repair.

`src/architecture.test.ts` asserts the four rules the layout expresses: dependency
direction between components, no vendor name in the code a request passes through, a
file-size budget, and no real identifiers anywhere a reader can see. It replaces what
thirteen `package.json` files used to enforce. Read it before deciding a rule is in your
way.

## Adding an operation to a Google provider

It is a data change, not code: an entry in `SELECTION` in
[`src/providers/google/specs/vendor.ts`](src/providers/google/specs/vendor.ts), then
`bun run vendor:google`. Two things bite, and both are silent:

- **Schema size is not spec size.** `mcp-from-openapi` inlines `$ref`s, so an operation whose
  request body is a wide union expands enormously — `sheets.spreadsheets.batchUpdate` measured
  2,469 KB against a 45 KB whole-Drive baseline. The `opaque` list in that script is the remedy,
  and `src/cli/tools.test.ts` holds the per-tool size budget (64 KB) so it fails loudly.
  `src/providers/google/specs/specs.test.ts` checks something different — that every vendored
  operation is reachable under the scopes the manifest requests.
- **`base_url` shape varies per API.** Drive puts the version in the server
  (`https://www.googleapis.com/drive/v3`); Sheets and Docs put it in the path
  (`https://sheets.googleapis.com` + `/v4/spreadsheets/...`). Copying the wrong one 404s every
  call.

New write capabilities need a `redact` block on the manifest. The default withholds every
value, which makes a write log useless — it records that something changed without recording
what. Keep identifiers, withhold the user's content.

Where `redact` cannot express it, `context.audit.annotate` can. `gmail.send_message` and
`icloud_mail.send_message` both use it: `attachments` is an argument that may literally *be* a
file, so keeping it verbatim would put base64 in the log. They record the resolved facts instead
— filename, size, type, SHA-256, and origin. See ADR-017.

One capability here is code rather than data: `gmail.send_message`, because sending means handing
Gmail a whole assembled RFC 2822 message and no OpenAPI document describes composing one. That is
what `defineProviderWithCapabilities` is for, and it is meant to stay rare — read ADR-017 before
reaching for it.
