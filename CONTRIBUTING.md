# Contributing

## Getting started

See [`docs/detailed/local-development.md`](docs/detailed/local-development.md). Short version: Bun 1.3.11+,
`bun install`, `bun test`. There is no build step.

## Before you open a pull request

```console
$ bun test
$ bun run typecheck
```

Both must pass. Add tests for what you changed.

## Adding a provider

Read [`docs/detailed/creating-a-provider.md`](docs/detailed/creating-a-provider.md). It should be sufficient on its
own — if it is not, that is a bug worth reporting.

## Things that will be pushed back on

**Adding a dependency without a reason that survives scrutiny.** This repository holds live OAuth
refresh tokens. The runtime dependency set is deliberately small, and `bunfig.toml` enforces a
seven-day release-age floor. Say in the commit message why the dependency earns its place.

**"Completing" the control-plane parity.** Policy changes, token management, credential writing,
config mutation, and audit mutation are CLI-only *by design* — see
[ADR-007](docs/detailed/adr/007-control-plane-exclusions.md). They will look like gaps when you audit the CLI
against the MCP surface. They are walls, and there is a test holding them up.

**Weakening default deny.** Including indirectly: registering a capability that is then refused on
call rather than filtering it out of discovery, or adding a policy operator beyond a trailing `.*`.

**Bun-specific APIs outside the two files that are allowed them** —
`src/deployments/adapters/sqlite.ts` and `src/server/index.ts`.

**Anything `src/architecture.test.ts` refuses.** It holds four rules: the
dependency direction between components, no vendor name in the code a request
passes through, a file-size budget, and no real address, project, or bucket
anywhere a reader can see. The first was enforced by thirteen
`package.json` files until they were collapsed into one; the test is what
replaced them. If one fails, the fix is almost never to relax the rule — and
where a concession is genuinely right, it goes in the named list in that file
rather than into a raised limit.

**Documentation that overstates a guarantee.** The table in [`docs/detailed/security.md`](docs/detailed/security.md)
is meant to be honest, including its one documented exception. If a change makes a guarantee weaker,
update the table in the same commit.

## Two layers of documentation

`README.md` and `docs/*.md` are the light layer: what to type, in order, for someone deciding whether
to use this. Keep them short and free of reasoning — a "why" belongs there only when the reader has to
make a decision from it.

[`docs/detailed/`](docs/detailed/) is the reference, and it is long on purpose. It records why each
decision was made, which is the part that is expensive to reconstruct. Depth belongs here.

Two tests hold the layers to the code, and both should stay green rather than be retargeted:
`src/readme.test.ts` asserts the README names a working `lanes link connect` command for every
provider, and `src/profile/docs.test.ts` parses the YAML examples out of the reference pages.

## Releasing

[`docs/detailed/releasing.md`](docs/detailed/releasing.md) is the whole lifecycle in order — the
branches, both release paths, the `develop` fast-forward that ends one, and how to verify a release
shipped. The short version:

You do not tag anything. Merging a change under `src/`, `bin/`, `instructions/`, `package.json`, or
`bun.lock` pushes a **`release/next`** branch carrying the patch bump, and the run summary links
straight to the pull request it opens — already titled and described, because the bump commit's
message is the release note. Merging that pull request publishes to npm and cuts the tag.

One workflow does both halves. Which half it runs is decided by whether the version in
`package.json` already has a tag: tagged means published, so propose the next patch; untagged means
somebody set it deliberately, so publish it.

For a **minor or major**, put the version you want in `package.json` in your own pull request. It
arrives on `main` with no tag behind it and is published as declared — so the judgement that
something earns more than a patch is made in review, beside the change that earns it.

Two things will look wrong and are not:

- **The release pull request shows `ci` as never reporting.** GitHub does not run workflows on
  branches it pushed itself, so it needs an admin merge. Both gates run again in `release.yml`
  against the exact tree being published, which is the run that matters — the registry does not give
  a version back.
- **The workflow does not open the pull request for you.** Doing that needs "Allow GitHub Actions to
  create and approve pull requests", and the approving half of that permission would let a workflow
  satisfy the review this repository requires. One click is cheaper than that.
- **Nothing is pushed to `main` by CI, ever.** A workflow cannot: the ruleset requires a pull
  request, and the built-in `GITHUB_TOKEN` cannot be added to its bypass list. Doing it anyway would
  mean storing a GitHub App key or a personal access token with write access to `main` — a larger
  credential than the npm token this project deliberately does not have. Publishing authenticates
  over OIDC instead, so there is no publish credential either.

## Commit messages

Say what changed and why the approach was chosen — especially where a simpler option was rejected.
The reasoning is the part that is expensive to reconstruct later.

## Reporting a vulnerability

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).
