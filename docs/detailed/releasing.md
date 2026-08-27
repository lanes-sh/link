# The development lifecycle

How a change gets from a branch to a version somebody installs. [`local-development.md`](local-development.md)
covers working *in* the tree; this page covers the branches around it and the one workflow that
publishes.

The whole of it is four moves:

```
branch → PR → develop → PR → main → npm
```

`main` is what is published. `develop` is where reviewed work accumulates between releases. They
are meant to be **identical trees** once a release lands — the last step of a release is what makes
that true, and it is the step most easily forgotten.

## The branches

| | |
|---|---|
| `main` | What `npm install @lanes-sh/link` gets. Protected: pull request, passing `ci`, no force-push. The only bypass is an organisation admin. |
| `develop` | The integration branch. Unprotected, so a push works — but work still arrives by pull request, because the reasoning in the commit message is the review. |
| feature branches | One per change, in its own worktree. See [CLAUDE.md](../../CLAUDE.md). |

Nothing is ever pushed to `main` by CI. It cannot be: the ruleset requires a pull request and the
built-in `GITHUB_TOKEN` cannot be added to its bypass list. Doing it anyway would mean storing an
App key or a personal access token with write access to `main` — a larger credential than the npm
token this project deliberately does not have.

## Ordinary work

```console
$ git worktree add .worktrees/<name> -b <name>
$ cd .worktrees/<name>
$ bun install
$ bun test && bun run typecheck      # the baseline, before changing anything
```

Then the change, then the same two commands, then a pull request into `develop`. `ci` runs both
gates again where a reviewer can see them. Merge when it is green.

That is the whole of ordinary work. A release is a separate act, taken deliberately, described
below.

## What a release is

One workflow, [`.github/workflows/release.yml`](../../.github/workflows/release.yml), fires on a
push to `main` and does exactly one of two things. Which one is decided by a single question:
**does the version in `package.json` already have a tag?**

| `package.json` | Meaning | What the run does |
|---|---|---|
| tagged (`v0.4.0` exists) | already published | **propose** — pushes a `release/next` branch carrying a patch bump, and links the pull request that opens it |
| untagged | somebody set it deliberately | **publish** — runs both gates, `npm publish --provenance`, then cuts the tag and the GitHub release |

So the same file both proposes a release and performs one, and never both. You do not tag anything
by hand, and there is no stored npm credential — publishing authenticates over OIDC as this
repository.

**The filename is load-bearing.** npm's trusted publisher for this package names `release.yml`.
Renaming the file makes every publish fail to authenticate, with an error about OIDC rather than
about the rename.

It also only fires for a merge that can change the tarball. The `paths` filter is `src/**`,
`bin/**`, `instructions/**`, `package.json`, `bun.lock` — the same list as `files` in
`package.json`, and the two should stay in step. A docs-only or CI-only merge to `main` starts no
release run at all, which is why a typo fix does not spend a version number.

## Cutting a patch

Merge the work to `main` and let the workflow propose it:

1. PR `develop` → `main`, merge it.
2. The release run takes the **propose** path and pushes `release/next` with the patch bump. Its
   commit message is the release note, so GitHub pre-fills the pull request's title and body from
   it — opening the release is one click. The run summary links straight there.
3. Merge that pull request. That push takes the **publish** path.
4. Fast-forward `develop`, below.

The workflow does not open the pull request for you on purpose: that needs "Allow GitHub Actions to
create and approve pull requests", and the approving half of that permission would let a workflow
satisfy the review this repository requires.

## Cutting a minor or a major

The judgement that something earns more than a patch is made in review, beside the change that
earns it — so you set the version yourself, and you set it **on `develop`, before the merge to
`main`**.

```console
$ git switch develop && git pull --ff-only
$ bun install --frozen-lockfile
$ bun test && bun run typecheck        # green before the bump, or there is nothing to release
```

Edit the one line in `package.json` — no other file in the repository names a version; the README
badge reads npm live. Then commit it with the release note as the message:

```console
$ git commit -m "Release 0.4.0" -m "$(cat <<'NOTE'
Merging this to main publishes 0.4.0 to npm.

Since v0.3.2:

- <one line per change, from git log --no-merges --pretty=format:'- %s'>

Why this earns a minor rather than the workflow's patch bump. The version is set
here, on develop, so the push to main arrives untagged and publishes directly.
NOTE
)"
$ git push origin develop
```

Two `-m` arguments, not one: passing the whole note as a single string runs the subject and the
first body line together into one 60-character subject, which is what happened to `Release 0.3.1`.

Then PR `develop` → `main`, wait for `ci`, and merge. `main` requires an approval, so a solo
release is `gh pr merge <n> --admin --merge`. **That merge is the irreversible step** — it publishes,
and the registry does not give a version back.

### Why the version goes on `develop` and not on a release branch

Because of what the alternative leaves behind. Merge `develop` to `main` with a tagged version and
the propose path runs: the bump lands on `release/next`, which merges into `main` only. `develop` is
then behind by a version commit forever, and every later comparison between the two branches is
noise. Setting it on `develop` first means the push to `main` arrives untagged, publishes directly,
and both branches hold the same tree.

## After the release: fast-forward `develop`

`main` now carries the merge commit `develop` lacks. The trees are already identical, so this is a
fast-forward and not a merge:

```console
$ git fetch origin
$ git push origin origin/main:refs/heads/develop
```

Verify it, both directions, because "0 ahead" alone does not prove they match:

```console
$ git rev-list --count origin/main..origin/develop     # 0
$ git rev-list --count origin/develop..origin/main     # 0
```

This is the operator's step to remember: the workflow is designed around `main` alone and says
nothing about `develop`.

## Verifying a release actually shipped

```console
$ gh run list --workflow release.yml --limit 1        # conclusion: success
$ npm view @lanes-sh/link version                     # the version you set
$ gh release view v<version> --json tagName,url
```

Read the run's step list rather than the tail of `gh run watch`: that tail prints annotations, and
an annotation from an *earlier* run appears there looking like a failure in this one. A run whose
steps are all `success` succeeded.

Two things will look wrong and are not:

- **The release pull request shows `ci` as never reporting.** GitHub does not run workflows on
  branches it pushed itself, so a proposed release needs an admin merge. Both gates run again inside
  `release.yml` against the exact tree being published, which is the run that matters.
- **`push the next release` is skipped in the run.** That is the propose step, correctly skipped on
  a publish run. It is how you confirm the publish path was taken.

## If a release goes wrong

- **Publish failed, nothing tagged.** Publish runs *before* the tag for this reason: a failure
  leaves the repository untouched and the run repeatable. Fix and re-run. Tagging first would leave
  a tag claiming a version nobody can install, which the next run reads as released and skips
  forever after.
- **Published a version you did not mean to.** It cannot be reclaimed. Set the next version
  deliberately and release again.
- **`develop` is behind `main` by a version commit.** The propose path ran when a deliberate version
  was wanted. Fast-forward, as above.
