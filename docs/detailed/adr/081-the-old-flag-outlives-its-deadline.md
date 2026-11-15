# ADR-081: `--target` outlives the deadline ADR-061 set it, because the app now updates this CLI

**Status:** accepted · **Amends** [ADR-061](061-a-workspace-is-the-only-word.md) ·
**Follows from** [ADR-065](065-the-app-provisions-this-cli.md)
**Date:** 2026-11-15

## Context

ADR-061 renamed `--target` to `--workspace` and was explicit about the alias it left behind:
accepted for **one minor**, warning on use, and the warning names the release that removes it.
`normaliseWorkspace` landed in 0.8.0. This is 0.17.0. That is eight minors against a promise of
one, and the warning has been naming a release that keeps not arriving.

The reason to remove it has not weakened. ADR-061's own argument is the house rule — one concept
with two names is the defect this repository names everywhere else, in a config key, a ceiling, a
reserved row — and a warning that has printed for eight minors has demonstrably not moved its
callers. Removal is also no longer a silent failure: `unknown-flags.ts` would answer
`Unknown flag "--target"` with the list of what the command does accept.

What changed is the cost of being wrong, and it changed in the direction nobody planned for.

ADR-061 named the desktop app as the reason for the alias: it spells the flag in argument arrays
and in a persisted, serde-mirrored settings field. At the time that argued for one minor's grace
while the app caught up. **ADR-065 then made the app install and update this CLI on its own
lifecycle**, at launch, gated only on Auto-Update. So the app can now be given a newer CLI
*without anyone deciding to*, and the failure ADR-061 was buying time against — "breaks the app
for anyone who updates the CLI first" — stopped being a sequencing risk somebody could avoid and
became automatic.

The app still spells it. `lanes link connect <provider> --profile <p> --target <t>`,
`lanes link mcp add <client> --profile <p> --target <t>`, and
`lanes link start --profile <p> --target <t>` are all constructed with the old word, and its own
tests assert those strings. Removing the flag in this release would break the settings page for
every user whose CLI updated before their app did, which after ADR-065 is the ordinary case rather
than the careless one.

## Decision

**`--target` stays, and this records why rather than letting the deprecation warning keep making a
promise nothing is keeping.**

The deadline moves to a condition instead of a number: the flag is removed in the first minor
*after* the desktop app has stopped emitting it and that app version is the one being installed.
Those two ship in one train — the app's change first, this repository's second — which is the
ordering [the cross-repository release](https://lanes.sh/docs/link/releasing) already requires for
anything the app depends on.

The warning text changes to stop naming "the next minor", because that sentence has been false for
seven releases and a warning nobody can act on teaches people to ignore warnings.

**Not folded in: the command words.** `target`, `target list`, `target show` and `sync targets`
are a separate alias with no deadline attached — `selection.ts` says "the old word, kept so nothing
anyone has typed breaks, but nothing prints it any more". A grep makes them look like one job and
they are two decisions. This one is about the flag.

## What this costs, stated plainly

Two spellings of one concept, in a repository that treats that as a defect, for at least one more
release and with no date on it. That is the thing ADR-061 was right about and it is not made less
true by being inconvenient.

What is bought is that the house rule does not get enforced on users by breaking a settings page
they did not touch. The honest framing is that ADR-061 set a deadline it did not control: the work
that has to happen first is in another repository, and nothing here can do it.

The second cost is precedent — an alias that survives its deadline once is easier to keep the next
time. The condition above is written to be checkable rather than aspirational, so that the next
person can answer "is it time yet" by grepping one repository instead of re-litigating this.
