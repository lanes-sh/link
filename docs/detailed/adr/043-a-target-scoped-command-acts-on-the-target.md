# ADR-043: A target-scoped command acts on the target, and every profile behind it

**Status:** accepted, amended by [ADR-052](052-a-target-owns-its-workspace.md) · **Amends** [ADR-037](037-a-command-names-what-it-acts-on.md) ·
**Follows from** [ADR-009](009-one-endpoint-per-workspace.md)

## Context

ADR-037 removed every way of resolving a profile or a target other than naming one. It was
right, and the transcript it was written from is still the argument for it: a flag silently
ignored, a fallback picked up one command later, and a mistake surfacing with nothing
connecting it to its cause.

It was applied uniformly, and uniformity is where it over-reached. Asking someone to name a
profile before `lanes link status` will tell them anything produces this:

```console
$ lanes link status
error  --profile is required. Every command names the profile it acts on, and
nothing else selects one.

$ lanes link status --profile personal --target cloud
error  Target "cloud" is not declared by profile "personal" (have: local)
```

Both refusals are correct. Neither answers the question that was asked, which was *is my
deployment still there*. The second is worse than unhelpful: it reports the absence of a
declaration as though the deployment were gone, when the service was running the whole time.

The mismatch is that ADR-009 gives a workspace **one endpoint serving every profile in it**.
`status`, `deploy` and `sync targets` all act on that endpoint. Naming one profile does not
select their subject — it describes a slice of it — so the command has to either widen back
out internally or answer for less than it was asked about. `deploy` did the latter, which is
why putting two profiles behind one URL took two deploys and a target the second profile did
not declare.

## Decision

A third selection level, `target`, beside `none`, `profile` and `profile+target`.

A command at that level names a target and acts on **every profile declaring it**. `--profile`
stays accepted and narrows the set; it does not select it. `status`, `deploy` and
`sync targets` move there. Everything acting on one account — `connect`, `token rotate`,
`secrets set`, `policy allow` — stays at `profile+target` and is unchanged.

**This is not the inference ADR-037 removed.** That was a chain: a flag, then an environment
variable, then a key in a file, resolving to one profile out of several, where the operator
could not see from the command line which one they had got. This derives a *complete set* from
the config — every profile declaring the target, which is exactly the set the endpoint will try
to open — and prints it. Nothing is chosen from among candidates and nothing is hidden.

Two things a derived set cannot settle, and both are refused rather than guessed:

- **Whose bearer token opens the endpoint.** One token reaches every profile behind it, so this
  decides who gets in. With more than one candidate and nothing recorded, `deploy` refuses and
  prints the command that names one. The answer is written to the deployment index (ADR-044) and
  asked once.
- **A first deploy.** A target no profile declares has no set to derive from, so `--profile` is
  still required — and creating cloud resources for a profile nobody named is precisely what
  ADR-037 was protecting against.

The refusal at this level lists what the *workspace* declares and which profiles declare each,
rather than one profile's adapters:

```console
$ lanes link status
error  --target is required. This command acts on a target, and every profile
that declares it.

  Targets in ~/.lanes-link
    local    every profile
    cloud    personal
```

## Consequences

The state that motivated this becomes visible in one line. A target declared by one profile and
not its sibling is invisible from inside either, and it is what a vanished deployment looks
like from the outside:

```console
$ lanes link status --target cloud
Profiles
  personal  cloud declared  7 connection(s)
  work      not declared    —
```

The workspace view opens no store and makes no network call. That is what lets it answer for a
target whose stores are unreachable — a summary needing the deployment to be healthy cannot
report that it is not. `--profile` still opens a runtime and gives reconcile state.

`deploy` gains a preflight it did not need while it sent one profile: credential references are
flat, so two profiles deployed into one project share a namespace, and the collision is silent
until one profile is reading the other's account.

The cost is that `Requires` is no longer a two-axis question with a uniform answer, and someone
adding a command has a third option to think about. The table in `src/cli/selection.ts` is the
whole rule, and `selection.test.ts` reads the dispatch files to check nothing was added without
appearing in it.


## Amended by ADR-052

The third selection level stands, and so does the argument for it. What changed is where the set
comes from.

"Every profile *declaring* the target" is now "every profile *in* the target's workspace"
([ADR-052](052-a-target-owns-its-workspace.md)). A profile declares no target, so the
disagreement this decision made visible — one profile declaring `cloud` and its sibling not —
cannot occur, and the `status` output above no longer has a "not declared" column to print.

The two things `deploy` still refuses to guess are unchanged: whose bearer token opens the
endpoint, and a first deploy naming a target nothing has created yet.

One row moves the other way. `target list` was `profile`-level because a target was declared per
profile; the registry is workspace-level, so it needs nothing. `profile list`, `profile add` and
`profile remove` move *up* to `target`, because a profile lives inside one and there is no longer
a single directory holding them all.
