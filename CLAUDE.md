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

## Never run `lanes link` from a worktree without `LANES_LINK_HOME`

`resolveWorkspaceRoot` (`src/profile/workspace.ts`) checks `LANES_LINK_HOME`, then
walks ancestors for `lanes-link.yaml`, then falls back to `~/.lanes-link`. A worktree has neither
of the first two — so a verification command run from one writes into the operator's real
workspace, which holds their live profiles, credentials, state, and audit log. `lanes link profile add
--default` will silently repoint every other command they run.

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

## Where things are

One package, one `src/`, thirteen components. Cross-component imports go through the
package.json `imports` map: `#policy`, `#stores/state`, `#providers/google/gmail`. There
are no workspace packages and no `apps/` or `packages/` — see the layout table in
[`docs/detailed/architecture.md`](docs/detailed/architecture.md).

`src/architecture.test.ts` asserts the three rules the layout expresses: dependency
direction between components, no vendor name in the code a request passes through, and a
file-size budget. It replaces what thirteen `package.json` files used to enforce. Read it
before deciding a rule is in your way.

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
